// A payment that was claimed but never delivered must not be lost. These are the ways
// delivery can fail after a payment is verified, on both stores.

import { PGlite } from "@electric-sql/pglite"
import { afterAll, describe, expect, it } from "vitest"

import {
  CLAIM_LEASE_MS,
  DeliveryFailed,
  fulfilOnce,
  memoryStore,
  postgresStore,
  type OrderStore,
  type Query,
} from "../lib/orders"
import { reconcile } from "../lib/reconcile"
import type { Verdict } from "../lib/verify"

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 20, 8, 0)
const order = { reference: "starter-pack.abc123", productId: "starter-pack", amountKobo: 150_000 }
const verdict = { ok: true as const, ...order }
const due = (store: OrderStore, now: number) =>
  store.due({ now, minAgeMs: 0, maxAgeMs: 1e12, recheckAfterMs: 0, limit: 10 })

const dbs: PGlite[] = []
afterAll(async () => {
  await Promise.all(dbs.map((d) => d.close()))
})
async function database(): Promise<Query> {
  const db = new PGlite()
  dbs.push(db)
  return async (text, params) => db.query(text, params)
}
const stores: [string, () => Promise<OrderStore>][] = [
  ["memory", async () => memoryStore()],
  ["Postgres", async () => postgresStore(await database())],
]

/** A delivery that fails the first `failures` times, then succeeds. */
function flakyDelivery(failures: number) {
  const delivered: string[] = []
  let attempts = 0
  const deliver = async (o: { reference: string }) => {
    attempts++
    if (attempts <= failures) throw new Error("email provider timed out")
    delivered.push(o.reference)
  }
  return { deliver, delivered, attempts: () => attempts }
}

describe.each(stores)("delivery on the %s store", { timeout: 30_000 }, (_, makeStore) => {
  it("retries a delivery that threw, instead of treating the order as done", async () => {
    const store = await makeStore()
    const email = flakyDelivery(1)
    await expect(fulfilOnce(verdict, { store, deliver: email.deliver })).rejects.toBeInstanceOf(DeliveryFailed)
    // The provider's webhook retry comes straight back, and now delivery works.
    expect(await fulfilOnce(verdict, { store, deliver: email.deliver })).toBe(true)
    // After that, it is done for good.
    expect(await fulfilOnce(verdict, { store, deliver: email.deliver })).toBe(false)
    expect(email.delivered).toEqual([order.reference])
  })

  it("keeps a paid but undelivered order due, so the reconciler delivers it", async () => {
    const store = await makeStore()
    await store.recordPending({ ...order, provider: "paystack" }, T0)
    await expect(fulfilOnce(verdict, { store, deliver: flakyDelivery(99).deliver })).rejects.toThrow()
    // Every webhook retry also failed, and the provider gave up. The reconciler hasn't.
    expect(await due(store, T0 + 15 * MIN)).toEqual([{ reference: order.reference, provider: "paystack" }])

    const email = flakyDelivery(0)
    const settle = async (): Promise<Verdict> => {
      await fulfilOnce(verdict, { store, deliver: email.deliver })
      return verdict
    }
    const report = await reconcile({ store, settle, now: T0 + 15 * MIN })
    expect(report.fulfilled).toEqual([order.reference])
    expect(email.delivered).toEqual([order.reference])
    expect(await due(store, T0 + 999 * MIN)).toEqual([])
  })

  it("lets another caller take over if the server stopped mid-delivery", async () => {
    const store = await makeStore()
    expect(await store.claim(order, T0)).toBe(true) // ...and the process dies here
    expect(await store.claim(order, T0 + MIN)).toBe(false) // still within the lease
    expect(await store.claim(order, T0 + CLAIM_LEASE_MS + MIN)).toBe(true) // lease ran out
  })

  it("never delivers an order twice, however late a retry comes", async () => {
    const store = await makeStore()
    expect(await store.claim(order, T0)).toBe(true)
    await store.markDelivered(order.reference, T0)
    expect(await store.claim(order, T0 + 24 * 60 * MIN)).toBe(false)
    expect(await due(store, T0 + 15 * MIN)).toEqual([])
  })

  it("reports a failing delivery and carries on with the rest of the run", async () => {
    const store = await makeStore()
    for (const reference of ["a", "b"]) await store.recordPending({ ...order, reference, provider: "paystack" }, T0)
    const settle = async (_: unknown, reference: string): Promise<Verdict> => {
      const v = { ...verdict, reference }
      await fulfilOnce(v, {
        store,
        deliver: async () => {
          if (reference === "a") throw new Error("down")
        },
      })
      return v
    }
    const report = await reconcile({ store, settle, now: T0 + 15 * MIN })
    expect(report.failed).toEqual(["a"])
    expect(report.fulfilled).toEqual(["b"])
  })
})

describe("Postgres claims", { timeout: 30_000 }, () => {
  it("lets exactly one of several instances take over an expired claim", async () => {
    const query = await database()
    expect(await postgresStore(query).claim(order, T0)).toBe(true)
    const later = T0 + CLAIM_LEASE_MS + MIN
    const instances = [postgresStore(query), postgresStore(query), postgresStore(query)]
    const results = await Promise.all(instances.map((s) => s.claim(order, later)))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("upgrades an existing table and treats its old rows as delivered", async () => {
    const query = await database()
    // The table as it was before claims and deliveries were tracked separately.
    await query(
      `create table fulfilled_orders (
         reference text primary key, product_id text not null,
         amount_kobo integer not null, fulfilled_at timestamptz not null default now())`,
      []
    )
    await query(`insert into fulfilled_orders (reference, product_id, amount_kobo) values ($1, $2, $3)`, [
      order.reference,
      order.productId,
      order.amountKobo,
    ])
    const store = postgresStore(query)
    await store.recordPending({ ...order, provider: "paystack" }, T0)
    expect(await store.claim(order, T0 + 999 * MIN)).toBe(false)
    expect(await due(store, T0 + 15 * MIN)).toEqual([])
  })
})
