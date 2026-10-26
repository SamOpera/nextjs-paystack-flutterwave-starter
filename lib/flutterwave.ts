// Flutterwave Standard (v3): https://developer.flutterwave.com/docs/collecting-payments/standard
// Unlike Paystack, Flutterwave amounts are in naira, so they are converted to kobo here.

import { CURRENCY, type Product } from "./catalog"
import { productIdFromReference } from "./env"
import type { PaymentFacts } from "./verify"

const API = "https://api.flutterwave.com/v3"

type Fetch = typeof fetch

export async function startFlutterwavePayment(
  input: { product: Product; email: string; reference: string; redirectUrl: string },
  secretKey: string,
  fetcher: Fetch = fetch
): Promise<string> {
  const response = await fetcher(`${API}/payments`, {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      tx_ref: input.reference,
      amount: input.product.priceKobo / 100,
      currency: CURRENCY,
      redirect_url: input.redirectUrl,
      customer: { email: input.email },
      meta: { product_id: input.product.id },
      customizations: { title: input.product.name },
    }),
  })
  const json = await response.json().catch(() => null)
  const link = json?.data?.link
  if (!response.ok || json?.status !== "success" || typeof link !== "string") {
    throw new Error(`Flutterwave could not start the payment: ${json?.message ?? response.status}`)
  }
  return link
}

/**
 * Asks Flutterwave what really happened, by our own reference. The `status` and
 * `transaction_id` in the redirect URL can be edited by anyone, so they are ignored.
 */
export async function verifyFlutterwavePayment(
  reference: string,
  secretKey: string,
  fetcher: Fetch = fetch
): Promise<PaymentFacts> {
  const response = await fetcher(
    `${API}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
    { headers: { authorization: `Bearer ${secretKey}` }, cache: "no-store" }
  )
  const json = await response.json().catch(() => null)
  const data = json?.data
  return {
    reference,
    succeeded:
      response.ok &&
      json?.status === "success" &&
      data?.status === "successful" &&
      data?.tx_ref === reference,
    amountKobo: Math.round(Number(data?.amount ?? 0) * 100),
    currency: String(data?.currency ?? ""),
    productId: productIdFromReference(reference),
  }
}
