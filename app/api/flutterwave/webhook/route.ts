// Flutterwave calls this server-to-server. Set it in Dashboard > Settings > Webhooks:
//   URL:         https://your-site.com/api/flutterwave/webhook
//   Secret hash: the same value as FLW_SECRET_HASH

import { requireEnv } from "@/lib/env"
import { settle } from "@/lib/settle"
import { isValidFlutterwaveHash } from "@/lib/signature"

export async function POST(request: Request) {
  if (!isValidFlutterwaveHash(request.headers.get("verif-hash"), requireEnv("FLW_SECRET_HASH"))) {
    return new Response("Invalid hash", { status: 401 })
  }

  const event = await request.json().catch(() => null)
  const reference = event?.data?.tx_ref
  if (event?.event === "charge.completed" && typeof reference === "string") {
    // The webhook body is a hint; Flutterwave's verify API is the source of truth.
    try {
      const verdict = await settle("flutterwave", reference)
      if (!verdict.ok) console.warn(`Flutterwave ${reference} not fulfilled: ${verdict.reason}`)
    } catch (error) {
      // Could not verify right now. A non-200 answer makes Flutterwave retry later.
      console.error(error)
      return new Response("Verification unavailable", { status: 503 })
    }
  }
  return new Response("ok")
}
