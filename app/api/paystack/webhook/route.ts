// Paystack calls this server-to-server, even if the shopper closes the tab before the
// redirect. Set the URL in Dashboard > Settings > API Keys & Webhooks:
//   https://your-site.com/api/paystack/webhook

import { requireEnv } from "@/lib/env"
import { settle } from "@/lib/settle"
import { isValidPaystackSignature } from "@/lib/signature"

export async function POST(request: Request) {
  // The signature covers the exact bytes Paystack sent, so read the raw body first.
  const rawBody = await request.text()
  const signature = request.headers.get("x-paystack-signature")
  if (!isValidPaystackSignature(rawBody, signature, requireEnv("PAYSTACK_SECRET_KEY"))) {
    return new Response("Invalid signature", { status: 401 })
  }

  let event: { event?: string; data?: { reference?: unknown } } | null = null
  try {
    event = JSON.parse(rawBody)
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }
  const reference = event?.data?.reference
  if (event?.event === "charge.success" && typeof reference === "string") {
    // Even a signed event is checked against the verify API before fulfilling.
    try {
      const verdict = await settle("paystack", reference)
      if (!verdict.ok) console.warn(`Paystack ${reference} not fulfilled: ${verdict.reason}`)
    } catch (error) {
      // Could not verify right now. A non-200 answer makes Paystack retry later.
      console.error(error)
      return new Response("Verification unavailable", { status: 503 })
    }
  }
  // Always answer 200 to a valid event, or Paystack keeps retrying it.
  return new Response("ok")
}
