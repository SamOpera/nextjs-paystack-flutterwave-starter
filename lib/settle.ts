// The single path from "a provider says something happened" to "the order is paid".
// Used by both the browser return (callback) and the server-to-server webhook.

import { requireEnv } from "./env"
import { verifyFlutterwavePayment } from "./flutterwave"
import { fulfilOnce, type Provider } from "./orders"
import { verifyPaystackPayment } from "./paystack"
import { checkPayment, type Verdict } from "./verify"

export type { Provider }

export async function settle(provider: Provider, reference: string): Promise<Verdict> {
  const facts =
    provider === "paystack"
      ? await verifyPaystackPayment(reference, requireEnv("PAYSTACK_SECRET_KEY"))
      : await verifyFlutterwavePayment(reference, requireEnv("FLW_SECRET_KEY"))

  const verdict = checkPayment(facts)
  if (verdict.ok) await fulfilOnce(verdict)
  return verdict
}

/** Where to send the shopper after a payment, based on the verdict. */
export function resultPath(verdict: Verdict): string {
  const status = verdict.ok ? "paid" : "failed"
  return `/result?status=${status}&ref=${encodeURIComponent(verdict.reference)}`
}
