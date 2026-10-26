// Fulfilment, kept idempotent: the callback and the webhook can both arrive for the
// same payment, sometimes more than once, and an order must only be fulfilled once.
//
// Two stores do the same job:
//   - Postgres, used whenever DATABASE_URL is set. The reference is the primary key,
//     so the database itself guarantees one fulfilment across every server instance.
//   - In memory, for local development and test-mode demos only. A serverless host
//     runs several instances and restarts them at any time, so memory can't promise
//     "once" in production. With live payment keys and no DATABASE_URL, the starter
//     refuses to fulfil instead of failing silently.

import type { Verdict } from "./verify"

export type Fulfilled = { reference: string; productId: string; amountKobo: number }

/** Records an order as fulfilled. Resolves true the first time, false on every repeat. */
export interface OrderStore {
  claim(order: Fulfilled): Promise<boolean>
}

/** The smallest piece of a Postgres client the store needs. */
export type Query = (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>

export const SCHEMA = `create table if not exists fulfilled_orders (
  reference    text primary key,
  product_id   text not null,
  amount_kobo  integer not null,
  fulfilled_at timestamptz not null default now()
)`

export function memoryStore(): OrderStore & { clear(): void } {
  const fulfilled = new Map<string, Fulfilled>()
  return {
    async claim(order) {
      // Check and write with no await in between, so within one process a racing
      // callback and webhook can't both pass.
      if (fulfilled.has(order.reference)) return false
      fulfilled.set(order.reference, order)
      return true
    },
    clear: () => fulfilled.clear(),
  }
}

export function postgresStore(query: Query): OrderStore {
  let ready: Promise<unknown> | null = null
  return {
    async claim(order) {
      ready ??= query(SCHEMA, []).catch((error) => {
        ready = null // let the next call try again
        throw error
      })
      await ready
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
  }
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
        "twice across serverless instances, so orders are not fulfilled until DATABASE_URL points " +
        "at Postgres. See 'Going to production' in the README."
    )
  }
}

/** Picks the store from the environment. Throws rather than run unsafely. */
export async function storeFromEnv(env: Record<string, string | undefined> = process.env): Promise<OrderStore> {
  if (env.DATABASE_URL) {
    const { default: postgres } = await import("postgres")
    // prepare: false keeps it working behind transaction poolers such as Supabase's.
    const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false })
    return postgresStore(async (text, params) => ({
      rows: await sql.unsafe(text, params as never[]),
    }))
  }
  if (env.NODE_ENV === "production" && usesLiveKeys(env)) throw new NoDatabaseError()
  return sharedMemory
}

const sharedMemory = memoryStore()
let store: Promise<OrderStore> | null = null

/** Returns true the first time a reference is fulfilled, false on every repeat. */
export async function fulfilOnce(verdict: Extract<Verdict, { ok: true }>): Promise<boolean> {
  store ??= storeFromEnv().catch((error) => {
    store = null
    throw error
  })
  const first = await (await store).claim({
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
