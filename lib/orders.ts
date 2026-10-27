// Orders, kept idempotent: the callback, the webhook and the reconciler can all arrive
// for the same payment, sometimes more than once, and an order must only be fulfilled once.
//
// Two stores do the same job:
//   - Postgres, used whenever DATABASE_URL is set. The reference is the primary key,
//     so the database itself guarantees one fulfilment across every server instance.
//   - In memory, for local development and test-mode demos only. A serverless host
//     runs several instances and restarts them at any time, so memory can't promise
//     "once" in production. With live payment keys and no DATABASE_URL, the starter
//     refuses to take payments instead of failing silently.
//
// Every payment is recorded as pending before the shopper is sent to pay. If the
// provider's verify API is down for longer than its webhook retries last, the
// reconciler (lib/reconcile.ts) finds paid orders that were never fulfilled.

import type { Verdict } from "./verify"

export type Provider = "paystack" | "flutterwave"
export type Fulfilled = { reference: string; productId: string; amountKobo: number }
export type Pending = { reference: string; provider: Provider; productId: string; amountKobo: number }

/** Which pending payments are due for another check. Times are unix milliseconds. */
export type DueQuery = {
  now: number
  /** Leave fresh payments to the redirect and webhook. */
  minAgeMs: number
  /** Stop checking payments this old: the shopper most likely never paid. */
  maxAgeMs: number
  /** Don't re-check the same payment more often than this. */
  recheckAfterMs: number
  limit: number
}

export interface OrderStore {
  /** Records an order as fulfilled. Resolves true the first time, false on every repeat. */
  claim(order: Fulfilled): Promise<boolean>
  /** Records a payment the shopper is about to make. Repeats are ignored. */
  recordPending(payment: Pending, now: number): Promise<void>
  /** Pending payments that are not fulfilled yet and are due for a check, oldest check first. */
  due(query: DueQuery): Promise<{ reference: string; provider: Provider }[]>
  /** Notes that a pending payment was just checked. */
  markChecked(reference: string, now: number): Promise<void>
}

/** The smallest piece of a Postgres client the store needs. */
export type Query = (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>

export const SCHEMA = `create table if not exists fulfilled_orders (
  reference    text primary key,
  product_id   text not null,
  amount_kobo  integer not null,
  fulfilled_at timestamptz not null default now()
)`

export const PENDING_SCHEMA = `create table if not exists pending_payments (
  reference       text primary key,
  provider        text not null,
  product_id      text not null,
  amount_kobo     integer not null,
  created_at      timestamptz not null,
  last_checked_at timestamptz,
  checks          integer not null default 0
)`

export function memoryStore(): OrderStore & { clear(): void } {
  const fulfilled = new Map<string, Fulfilled>()
  const pending = new Map<string, Pending & { createdAt: number; lastCheckedAt: number | null; checks: number }>()
  return {
    async claim(order) {
      // Check and write with no await in between, so within one process a racing
      // callback and webhook can't both pass.
      if (fulfilled.has(order.reference)) return false
      fulfilled.set(order.reference, order)
      return true
    },
    async recordPending(payment, now) {
      if (!pending.has(payment.reference)) pending.set(payment.reference, { ...payment, createdAt: now, lastCheckedAt: null, checks: 0 })
    },
    async due({ now, minAgeMs, maxAgeMs, recheckAfterMs, limit }) {
      return [...pending.values()]
        .filter(
          (p) =>
            !fulfilled.has(p.reference) &&
            p.createdAt <= now - minAgeMs &&
            p.createdAt >= now - maxAgeMs &&
            (p.lastCheckedAt === null || p.lastCheckedAt <= now - recheckAfterMs)
        )
        .sort((a, b) => (a.lastCheckedAt ?? -1) - (b.lastCheckedAt ?? -1) || a.createdAt - b.createdAt)
        .slice(0, limit)
        .map(({ reference, provider }) => ({ reference, provider }))
    },
    async markChecked(reference, now) {
      const p = pending.get(reference)
      if (p) pending.set(reference, { ...p, lastCheckedAt: now, checks: p.checks + 1 })
    },
    clear: () => {
      fulfilled.clear()
      pending.clear()
    },
  }
}

export function postgresStore(query: Query): OrderStore {
  let ready: Promise<unknown> | null = null
  const create = async (statement: string) => {
    try {
      await query(statement, [])
    } catch (error) {
      // Several instances creating a table at the same moment: Postgres lets one
      // win and rejects the rest with a duplicate key on its own catalog (23505),
      // "type already exists" (42710) or "table already exists" (42P07). Either way
      // the table, and its key, now exist.
      if (!isAlreadyCreated(error)) throw error
    }
  }
  const tables = async () => {
    ready ??= (async () => {
      await create(SCHEMA)
      await create(PENDING_SCHEMA)
    })().catch((error) => {
      ready = null // a real failure: let the next call try again
      throw error
    })
    await ready
  }
  const iso = (ms: number) => new Date(ms).toISOString()

  return {
    async claim(order) {
      await tables()
      // The primary key makes this atomic: of any number of racing inserts, exactly
      // one returns a row, on any instance.
      const { rows } = await query(
        `insert into fulfilled_orders (reference, product_id, amount_kobo)
         values ($1, $2, $3)
         on conflict (reference) do nothing
         returning reference`,
        [order.reference, order.productId, order.amountKobo]
      )
      return rows.length === 1
    },
    async recordPending(payment, now) {
      await tables()
      await query(
        `insert into pending_payments (reference, provider, product_id, amount_kobo, created_at)
         values ($1, $2, $3, $4, $5)
         on conflict (reference) do nothing`,
        [payment.reference, payment.provider, payment.productId, payment.amountKobo, iso(now)]
      )
    },
    async due({ now, minAgeMs, maxAgeMs, recheckAfterMs, limit }) {
      await tables()
      const { rows } = await query(
        `select p.reference, p.provider
           from pending_payments p
          where not exists (select 1 from fulfilled_orders f where f.reference = p.reference)
            and p.created_at <= $1
            and p.created_at >= $2
            and (p.last_checked_at is null or p.last_checked_at <= $3)
          order by p.last_checked_at asc nulls first, p.created_at asc
          limit $4`,
        [iso(now - minAgeMs), iso(now - maxAgeMs), iso(now - recheckAfterMs), limit]
      )
      return rows as { reference: string; provider: Provider }[]
    },
    async markChecked(reference, now) {
      await tables()
      await query(`update pending_payments set last_checked_at = $2, checks = checks + 1 where reference = $1`, [
        reference,
        iso(now),
      ])
    },
  }
}

function isAlreadyCreated(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return code === "23505" || code === "42710" || code === "42P07"
}

/** Test keys can't move real money, so memory is acceptable for a test-mode demo. */
export function usesLiveKeys(env: Record<string, string | undefined>): boolean {
  const paystack = env.PAYSTACK_SECRET_KEY ?? ""
  const flutterwave = env.FLW_SECRET_KEY ?? ""
  return paystack.startsWith("sk_live_") || (flutterwave !== "" && !flutterwave.includes("_TEST"))
}

export class NoDatabaseError extends Error {
  constructor() {
    super(
      "Live payment keys are set but DATABASE_URL is not. The in-memory store can fulfil an order " +
        "twice across serverless instances and forgets pending payments on restart, so payments are " +
        "refused until DATABASE_URL points at Postgres. See 'Going to production' in the README."
    )
  }
}

/** Picks the store from the environment. Throws rather than run unsafely. */
export async function storeFromEnv(env: Record<string, string | undefined> = process.env): Promise<OrderStore> {
  if (env.DATABASE_URL) {
    const { default: postgres } = await import("postgres")
    // prepare: false keeps it working behind transaction poolers such as Supabase's.
    // onnotice: silence "already exists, skipping" from the create-if-not-exists.
    const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} })
    return postgresStore(async (text, params) => ({
      rows: await sql.unsafe(text, params as never[]),
    }))
  }
  if (env.NODE_ENV === "production" && usesLiveKeys(env)) throw new NoDatabaseError()
  return sharedMemory
}

const sharedMemory = memoryStore()
let store: Promise<OrderStore> | null = null

/** The store for this server process, picked once from the environment. */
export function orderStore(): Promise<OrderStore> {
  store ??= storeFromEnv().catch((error) => {
    store = null
    throw error
  })
  return store
}

/** Returns true the first time a reference is fulfilled, false on every repeat. */
export async function fulfilOnce(verdict: Extract<Verdict, { ok: true }>): Promise<boolean> {
  const first = await (await orderStore()).claim({
    reference: verdict.reference,
    productId: verdict.productId,
    amountKobo: verdict.amountKobo,
  })
  // if (first) deliver the goods here: send the receipt email, mark the order paid, etc.
  return first
}

/** For tests. */
export function resetOrders() {
  sharedMemory.clear()
  store = null
}
