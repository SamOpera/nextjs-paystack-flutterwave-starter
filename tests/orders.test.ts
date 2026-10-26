import { PGlite } from "@electric-sql/pglite"
import { afterAll, describe, expect, it } from "vitest"

import { NoDatabaseError, memoryStore, postgresStore, storeFromEnv, usesLiveKeys, type Query } from "../lib/orders"

// A real Postgres engine, in process. Each test gets its own database.
const databases: PGlite[] = []
async function freshDatabase(): Promise<Query> {
  const db = new PGlite()
  databases.push(db)
  return async (text, params) => db.query(text, params)
}
afterAll(async () => {
  await Promise.all(databases.map((db) => db.close()))
})

const order = { reference: "starter-pack.abc123", productId: "starter-pack", amountKobo: 500_000 }

// Starting the Postgres engine (WebAssembly) can take several seconds on a busy machine or CI runner.
describe("Postgres store", { timeout: 30_000 }, () => {
  it("creates its own table and fulfils a reference once", async () => {
    const store = postgresStore(await freshDatabase())
    expect(await store.claim(order)).toBe(true)
    expect(await store.claim(order)).toBe(false)
    expect(await store.claim({ ...order, reference: "starter-pack.other" })).toBe(true)
  })

  it("fulfils once across separate server instances racing on the same payment", async () => {
    // Three instances, as on a serverless host: each has its own store, one shared database.
    const query = await freshDatabase()
    const instances = [postgresStore(query), postgresStore(query), postgresStore(query)]
    const results = await Promise.all(instances.flatMap((s) => [s.claim(order), s.claim(order)]))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("records what was fulfilled", async () => {
    const query = await freshDatabase()
    await postgresStore(query).claim(order)
    const { rows } = await query("select reference, product_id, amount_kobo from fulfilled_orders", [])
    expect(rows).toEqual([{ reference: order.reference, product_id: "starter-pack", amount_kobo: 500_000 }])
  })
})

describe("why memory isn't enough in production", () => {
  it("separate instances with their own memory both fulfil the same order", async () => {
    const results = await Promise.all([memoryStore().claim(order), memoryStore().claim(order)])
    expect(results).toEqual([true, true]) // the double fulfilment the database prevents
  })
})

describe("choosing a store", () => {
  const live = { NODE_ENV: "production", PAYSTACK_SECRET_KEY: "sk_live_abc" }

  it("recognises live keys", () => {
    expect(usesLiveKeys({ PAYSTACK_SECRET_KEY: "sk_live_x" })).toBe(true)
    expect(usesLiveKeys({ FLW_SECRET_KEY: "FLWSECK-abc-X" })).toBe(true)
    expect(usesLiveKeys({ PAYSTACK_SECRET_KEY: "sk_test_x", FLW_SECRET_KEY: "FLWSECK_TEST-abc-X" })).toBe(false)
    expect(usesLiveKeys({})).toBe(false)
  })

  it("refuses live keys in production without a database", async () => {
    await expect(storeFromEnv(live)).rejects.toBeInstanceOf(NoDatabaseError)
  })

  it("allows memory for local development and test-mode demos", async () => {
    await expect(storeFromEnv({ NODE_ENV: "development", PAYSTACK_SECRET_KEY: "sk_live_abc" })).resolves.toBeDefined()
    await expect(
      storeFromEnv({ NODE_ENV: "production", PAYSTACK_SECRET_KEY: "sk_test_abc", FLW_SECRET_KEY: "FLWSECK_TEST-x" })
    ).resolves.toBeDefined()
  })
})
