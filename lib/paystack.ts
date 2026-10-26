// Paystack: https://paystack.com/docs/api/transaction/
// Amounts are in kobo. All calls use the secret key, so they only run on the server.

import { CURRENCY, type Product } from "./catalog"
import { productIdFromReference } from "./env"
import type { PaymentFacts } from "./verify"

const API = "https://api.paystack.co"

type Fetch = typeof fetch

export async function startPaystackPayment(
  input: { product: Product; email: string; reference: string; callbackUrl: string },
  secretKey: string,
  fetcher: Fetch = fetch
): Promise<string> {
  const response = await fetcher(`${API}/transaction/initialize`, {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      amount: input.product.priceKobo,
      currency: CURRENCY,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: { product_id: input.product.id },
    }),
  })
  const json = await response.json().catch(() => null)
  const url = json?.data?.authorization_url
  if (!response.ok || !json?.status || typeof url !== "string") {
    throw new Error(`Paystack could not start the payment: ${json?.message ?? response.status}`)
  }
  return url
}

/** Asks Paystack what really happened to a payment. Never trust the redirect alone. */
export async function verifyPaystackPayment(
  reference: string,
  secretKey: string,
  fetcher: Fetch = fetch
): Promise<PaymentFacts> {
  const response = await fetcher(
    `${API}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { authorization: `Bearer ${secretKey}` }, cache: "no-store" }
  )
  const json = await response.json().catch(() => null)
  const data = json?.data
  return {
    reference,
    // The reference Paystack returns must be the one we asked about.
    succeeded:
      response.ok && json?.status === true && data?.status === "success" && data?.reference === reference,
    amountKobo: Number(data?.amount ?? 0),
    currency: String(data?.currency ?? ""),
    productId: productIdFromReference(reference),
  }
}
