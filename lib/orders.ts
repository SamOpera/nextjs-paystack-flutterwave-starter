// Orders, kept idempotent: the callback, the webhook and the reconciler can all arrive
// for the same payment, sometimes more than once, and an order must only be fulfilled once.
//
// Claiming an order and delivering it are separate steps. A caller first claims the
// order, which only one caller can do at a time; then delivers it; then marks it
// delivered. If delivery throws, the claim is released so the provider's retry can take
// it at once. If the server dies mid-delivery, the claim expires after CLAIM_LEASE_MS.
// Until an order is marked delivered, the reconciler keeps checking it. So a paid order
// is never left claimed but undelivered, and delivery code must be safe to run again.
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

import { deliverOrder } from "./deliver"
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

/** How long a claim lasts before another caller may take over an undelivered order. */
export const CLAIM_LEASE_MS = 5 * 60_000

export interface OrderStore {
  /**
   * Claims an order for delivery. Resolves true if this caller should deliver it now:
   * the first claim, a released claim, or one whose lease ran out undelivered. False if
   * it is delivered already, or another caller is delivering it right now.
   */
  claim(order: Fulfilled, now?: number): Promise<boolean>
  /** Records that the order was delivered. Claims on it are refused from now on. */
  markDelivered(reference: string, now?: number): Promise<void>
  /** Gives up a claim after a failed delivery, so the next attempt can take it at once. */
  release(reference: string): Promise<void>
  /** Records a payment the shopper is about to make. Repeats are ignored. */
  recordPending(payment: Pending, now: number): Promise<void>
  /** Pending payments that are not delivered yet and are due for a check, oldest check first. */
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
  fulfilled_at timestamptz not null default now(),
  claimed_at   timestamptz,
  delivered_at timestamptz
)`

// Databases created before claims and deliveries were tracked separately gain the two
// columns. Their existing rows have no claimed_at, which is read as "delivered", the
// meaning those rows had.
export const MIGRATIONS = [
  `alter table fulfilled_orders add column if not exists claimed_at timestamptz`,
  `alter table fulfilled_orders add column if not exists delivered_at timestamptz`,
]

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
  const fulfilled = new Map<string, Fulfilled & { claimedAt: number; deliveredAt: number | null }>()
  const pending = new Map<string, Pending & { createdAt: number; lastCheckedAt: number | null; checks: number }>()
  return {
    async claim(order, now = Date.now()) {
      // Check and write with no await in between, so within one process a racing
      // callback and webhook can't both pass.
      const existing = fulfilled.get(order.reference)
      if (existing && (existing.deliveredAt !== null || existing.claimedAt > now - CLAIM_LEASE_MS)) return false
      fulfilled.set(order.reference, { ...order, claimedAt: now, deliveredAt: null })
      return true
    },
    async markDelivered(reference, now = Date.now()) {
      const existing = fulfilled.get(reference)
      if (existing) fulfilled.set(reference, { ...existing, deliveredAt: now })
    },
    async release(reference) {
      const existing = fulfilled.get(reference)
      if (existing && existing.deliveredAt === null) fulfilled.set(reference, { ...existing, claimedAt: 0 })
    },
    async recordPending(payment, now) {
      if (!pending.has(payment.reference)) pending.set(payment.reference, { ...payment, createdAt: now, lastCheckedAt: null, checks: 0 })
    },
    async due({ now, minAgeMs, maxAgeMs, recheckAfterMs, limit }) {
      return [...pending.values()]
        .filter(
          (p) =>
            fulfilled.get(p.reference)?.deliveredAt == null &&
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
      for (const migration of MIGRATIONS) await create(migration)
      await create(PENDING_SCHEMA)
    })().catch((error) => {
      ready = null // a real failure: let the next call try again
      throw error
    })
    await ready
  }
  const iso = (ms: number) => new Date(ms).toISOString()

  return {
    async claim(order, now = Date.now()) {
      await tables()
      // The primary key makes this atomic: of any number of racing claims, exactly one
      // returns a row, on any instance. An existing row is only taken over if it was never
      // delivered and its claim was released or has expired. Postgres re-checks that
      // condition after waiting on the row lock, so two takeovers can't both win.
      const { rows } = await query(
        `insert into fulfilled_orders (reference, product_id, amount_kobo, claimed_at)
         values ($1, $2, $3, $4)
         on conflict (reference) do update set claimed_at = excluded.claimed_at
           where fulfilled_orders.delivered_at is null
             and fulfilled_orders.claimed_at is not null
             and fulfilled_orders.claimed_at <= $5
         returning reference`,
        [order.reference, order.productId, order.amountKobo, iso(now), iso(now - CLAIM_LEASE_MS)]
      )
      return rows.length === 1
    },
    async markDelivered(reference, now = Date.now()) {
      await tables()
      await query(`update fulfilled_orders set delivered_at = $2 where reference = $1`, [reference, iso(now)])
    },
    async release(reference) {
      await tables()
      await query(
        `update fulfilled_orders set claimed_at = to_timestamp(0) where reference = $1 and delivered_at is null`,
        [reference]
      )
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
          where not exists (
                  select 1 from fulfilled_orders f
                   where f.reference = p.reference
                     and (f.delivered_at is not null or f.claimed_at is null)
                )
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
  // 42701: another instance added the same column first.
  return code === "23505" || code === "42710" || code === "42P07" || code === "42701"
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

/** Delivery threw. The claim was released, and the order will be delivered on a retry. */
export class DeliveryFailed extends Error {
  constructor(
    readonly reference: string,
    cause: unknown
  ) {
    super(`Delivery failed for ${reference}`, { cause })
  }
}

/**
 * Delivers a paid order once. Resolves true if this call delivered it, false if it was
 * delivered already or another call is delivering it right now. Throws DeliveryFailed if
 * delivery throws: the webhook then answers 503 so the provider retries, and the
 * reconciler keeps checking the order until it is delivered.
 */
export async function fulfilOnce(
  verdict: Extract<Verdict, { ok: true }>,
  options: { store?: OrderStore; deliver?: (order: Fulfilled) => Promise<void> } = {}
): Promise<boolean> {
  const store = options.store ?? (await orderStore())
  const order = { reference: verdict.reference, productId: verdict.productId, amountKobo: verdict.amountKobo }
  if (!(await store.claim(order))) return false
  try {
    await (options.deliver ?? deliverOrder)(order)
  } catch (error) {
    await store.release(order.reference).catch(() => {}) // if this fails too, the lease expires
    throw new DeliveryFailed(order.reference, error)
  }
  await store.markDelivered(order.reference)
  return true
}

/** For tests. */
export function resetOrders() {
  sharedMemory.clear()
  store = null
}
