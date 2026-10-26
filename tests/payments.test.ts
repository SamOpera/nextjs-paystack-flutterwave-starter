import { createHmac } from "node:crypto"
import { beforeEach, describe, expect, it } from "vitest"

import { PRODUCTS } from "../lib/catalog"
import { newReference, productIdFromReference } from "../lib/env"
import { startFlutterwavePayment, verifyFlutterwavePayment } from "../lib/flutterwave"
import { fulfilOnce, resetOrders } from "../lib/orders"
import { startPaystackPayment, verifyPaystackPayment } from "../lib/paystack"
import { isValidFlutterwaveHash, isValidPaystackSignature } from "../lib/signature"
import { checkPayment } from "../lib/verify"

const starter = PRODUCTS[0]
const reference = newReference(starter.id)

/** A fake fetch that records the request and answers with the given JSON. */
const fakeFetch = (body: unknown, ok = true) => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok, json: async () => body } as Response
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

describe("references", () => {
  it("carry the product id and are unique", () => {
    expect(productIdFromReference(reference)).toBe(starter.id)
    expect(newReference(starter.id)).not.toBe(newReference(starter.id))
  })
})

describe("checkPayment", () => {
  const facts = {
    reference,
    succeeded: true,
    amountKobo: starter.priceKobo,
    currency: "NGN",
    productId: starter.id,
  }

  it("accepts a successful payment of the full price in naira", () => {
    expect(checkPayment(facts).ok).toBe(true)
  })

  it("rejects a payment the provider did not confirm", () => {
    expect(checkPayment({ ...facts, succeeded: false })).toMatchObject({ ok: false })
  })

  it("rejects an underpayment, even by one kobo", () => {
    expect(checkPayment({ ...facts, amountKobo: starter.priceKobo - 1 })).toMatchObject({
      ok: false,
      reason: "amount below price",
    })
  })

  it("rejects the wrong currency", () => {
    expect(checkPayment({ ...facts, currency: "USD" })).toMatchObject({ ok: false })
  })

  it("rejects an unknown product", () => {
    expect(checkPayment({ ...facts, productId: "free-stuff" })).toMatchObject({ ok: false })
  })
})

describe("Paystack", () => {
  it("starts a payment with the catalog price in kobo, not a client amount", async () => {
    const { fetcher, calls } = fakeFetch({
      status: true,
      data: { authorization_url: "https://checkout.paystack.com/abc" },
    })
    const url = await startPaystackPayment(
      { product: starter, email: "a@b.co", reference, callbackUrl: "https://x/cb" },
      "sk_test_x",
      fetcher
    )
    expect(url).toBe("https://checkout.paystack.com/abc")
    const sent = JSON.parse(String(calls[0].init?.body))
    expect(sent).toMatchObject({ amount: starter.priceKobo, currency: "NGN", reference })
  })

  it("verifies a real success", async () => {
    const { fetcher } = fakeFetch({
      status: true,
      data: { status: "success", reference, amount: starter.priceKobo, currency: "NGN" },
    })
    const verdict = checkPayment(await verifyPaystackPayment(reference, "sk_test_x", fetcher))
    expect(verdict.ok).toBe(true)
  })

  it("does not accept an abandoned payment", async () => {
    const { fetcher } = fakeFetch({
      status: true,
      data: { status: "abandoned", reference, amount: starter.priceKobo, currency: "NGN" },
    })
    expect(checkPayment(await verifyPaystackPayment(reference, "sk", fetcher)).ok).toBe(false)
  })

  it("does not accept a success for a different reference", async () => {
    const { fetcher } = fakeFetch({
      status: true,
      data: { status: "success", reference: "other", amount: starter.priceKobo, currency: "NGN" },
    })
    expect(checkPayment(await verifyPaystackPayment(reference, "sk", fetcher)).ok).toBe(false)
  })

  it("accepts only webhooks signed with the secret key", () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference } })
    const good = createHmac("sha512", "sk_test_secret").update(body).digest("hex")
    expect(isValidPaystackSignature(body, good, "sk_test_secret")).toBe(true)
    expect(isValidPaystackSignature(body, good, "another_key")).toBe(false)
    expect(isValidPaystackSignature(body + " ", good, "sk_test_secret")).toBe(false)
    expect(isValidPaystackSignature(body, null, "sk_test_secret")).toBe(false)
  })
})

describe("Flutterwave", () => {
  it("starts a payment in naira, converted from the catalog's kobo", async () => {
    const { fetcher, calls } = fakeFetch({
      status: "success",
      data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/abc" },
    })
    await startFlutterwavePayment(
      { product: starter, email: "a@b.co", reference, redirectUrl: "https://x/cb" },
      "FLWSECK_TEST",
      fetcher
    )
    const sent = JSON.parse(String(calls[0].init?.body))
    expect(sent).toMatchObject({ amount: starter.priceKobo / 100, currency: "NGN", tx_ref: reference })
  })

  it("verifies by our own reference, not the redirect's transaction id", async () => {
    const { fetcher, calls } = fakeFetch({
      status: "success",
      data: { status: "successful", tx_ref: reference, amount: starter.priceKobo / 100, currency: "NGN" },
    })
    const verdict = checkPayment(await verifyFlutterwavePayment(reference, "FLWSECK_TEST", fetcher))
    expect(verdict.ok).toBe(true)
    expect(calls[0].url).toContain(`tx_ref=${encodeURIComponent(reference)}`)
  })

  it("rejects an underpaid charge", async () => {
    const { fetcher } = fakeFetch({
      status: "success",
      data: { status: "successful", tx_ref: reference, amount: 100, currency: "NGN" },
    })
    expect(checkPayment(await verifyFlutterwavePayment(reference, "k", fetcher)).ok).toBe(false)
  })

  it("accepts only webhooks with the right secret hash", () => {
    expect(isValidFlutterwaveHash("my-secret-hash", "my-secret-hash")).toBe(true)
    expect(isValidFlutterwaveHash("guess", "my-secret-hash")).toBe(false)
    expect(isValidFlutterwaveHash(null, "my-secret-hash")).toBe(false)
  })
})

describe("fulfilment", () => {
  beforeEach(() => resetOrders())

  it("fulfils each order once, even if the callback and webhook both arrive", async () => {
    const verdict = { ok: true as const, reference, productId: starter.id, amountKobo: starter.priceKobo }
    expect(await fulfilOnce(verdict)).toBe(true)
    expect(await fulfilOnce(verdict)).toBe(false)
  })
})
