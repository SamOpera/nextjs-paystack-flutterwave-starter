import { PGlite } from "@electric-sql/pglite"
import { afterAll, describe, expect, it } from "vitest"

import { isCronAuthorized } from "../lib/cronAuth"
import { memoryStore, postgresStore, type OrderStore, type Pending, type Provider } from "../lib/orders"
import { reconcile } from "../lib/reconcile"
import { VerifyUnavailable, type Verdict } from "../lib/verify"

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 27, 8, 0)
const payment = (reference: string, provider: Provider = "paystack"): Pending => ({
  reference,
  provider,
  productId: "starter-pack",
  amountKobo: 150_000,
})

/** A fake provider: references in `paid` verify as paid; `down` makes verify unavailable. */
function provider(store: OrderStore, paid: string[], down: Provider[] = []) {
  const calls: string[] = []
  const settle = async (p: Provider, reference: string): Promise<Verdict> => {
    calls.push(reference)
    if (down.includes(p)) throw new VerifyUnavailable(503)
    if (!paid.includes(reference)) return { ok: false, reference, reason: "not successful" }
    await store.claim({ reference, productId: "starter-pack", amountKobo: 150_000 })
    return { ok: true, reference, productId: "starter-pack", amountKobo: 150_000 }
  }
  return { settle, calls }
}

const dbs: PGlite[] = []
afterAll(async () => {
  await Promise.all(dbs.map((d) => d.close()))
})
const stores: [string, () => Promise<OrderStore>][] = [
  ["memory", async () => memoryStore()],
  [
    "Postgres",
    async () => {
      const db = new PGlite()
      dbs.push(db)
      return postgresStore(async (text, params) => db.query(text, params))
    },
  ],
]

describe.each(stores)("reconciler on the %s store", { timeout: 30_000 }, (_, makeStore) => {
  it("fulfils a paid order whose redirect and webhooks were all lost", async () => {
    const store = await makeStore()
    await store.recordPending(payment("a"), T0)
    const { settle } = provider(store, ["a"])
    const report = await reconcile({ store, settle, now: T0 + 15 * MIN })
    expect(report).toMatchObject({ checked: 1, fulfilled: ["a"], notPaid: 0, unavailable: 0 })
    // Once fulfilled, it's never picked up again.
    expect(await store.due({ now: T0 + 999 * MIN, minAgeMs: 0, maxAgeMs: 1e12, recheckAfterMs: 0, limit: 10 })).toEqual([])
  })

  it("leaves orders the webhook already fulfilled alone", async () => {
    const store = await makeStore()
    await store.recordPending(payment("a"), T0)
    await store.claim({ reference: "a", productId: "starter-pack", amountKobo: 150_000 })
    const { settle, calls } = provider(store, ["a"])
    await reconcile({ store, settle, now: T0 + 15 * MIN })
    expect(calls).toEqual([])
  })

  it("gives fresh payments time, and gives up on old abandoned ones", async () => {
    const store = await makeStore()
    await store.recordPending(payment("fresh"), T0 + 10 * MIN)
    await store.recordPending(payment("old"), T0 - 4 * 24 * 60 * MIN)
    await store.recordPending(payment("due"), T0)
    const { settle, calls } = provider(store, [])
    await reconcile({ store, settle, now: T0 + 15 * MIN })
    expect(calls).toEqual(["due"])
  })

  it("keeps an unpaid checkout pending, re-checking it only after a wait", async () => {
    const store = await makeStore()
    await store.recordPending(payment("a"), T0)
    const { settle, calls } = provider(store, [])
    expect((await reconcile({ store, settle, now: T0 + 15 * MIN })).notPaid).toBe(1)
    await reconcile({ store, settle, now: T0 + 20 * MIN }) // too soon
    await reconcile({ store, settle, now: T0 + 50 * MIN }) // 35 min later: due again
    expect(calls).toEqual(["a", "a"])
  })

  it("stops calling a provider that's down, and catches up when it's back", async () => {
    const store = await makeStore()
    for (const r of ["p1", "p2", "p3"]) await store.recordPending(payment(r), T0)
    await store.recordPending(payment("f1", "flutterwave"), T0)
    const outage = provider(store, ["p1", "p2", "p3", "f1"], ["paystack"])
    const first = await reconcile({ store, settle: outage.settle, now: T0 + 15 * MIN })
    expect(outage.calls.filter((r) => r.startsWith("p"))).toHaveLength(1) // one try, then skip
    expect(first.fulfilled).toEqual(["f1"]) // the other provider still works
    const recovered = provider(store, ["p1", "p2", "p3"])
    const second = await reconcile({ store, settle: recovered.settle, now: T0 + 60 * MIN })
    expect(second.fulfilled.sort()).toEqual(["p1", "p2", "p3"])
  })

  it("records a payment once, however many times it's recorded", async () => {
    const store = await makeStore()
    await store.recordPending(payment("a"), T0)
    await store.recordPending(payment("a"), T0 + MIN)
    const due = await store.due({ now: T0 + 15 * MIN, minAgeMs: 0, maxAgeMs: 1e12, recheckAfterMs: 0, limit: 10 })
    expect(due).toEqual([{ reference: "a", provider: "paystack" }])
  })
})

describe("reconcile endpoint access", () => {
  it("accepts only Vercel Cron's secret in production", () => {
    expect(isCronAuthorized("Bearer s3cret-value-123456", "s3cret-value-123456", "production")).toBe(true)
    expect(isCronAuthorized("Bearer guess", "s3cret-value-123456", "production")).toBe(false)
    expect(isCronAuthorized(null, "s3cret-value-123456", "production")).toBe(false)
    expect(isCronAuthorized(null, undefined, "production")).toBe(false)
    expect(isCronAuthorized(null, undefined, "development")).toBe(true)
  })
})
