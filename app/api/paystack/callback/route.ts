// Paystack sends the shopper back here with ?reference=... after checkout.
// The query string proves nothing, so the payment is verified with Paystack first.

import { siteUrl } from "@/lib/env"
import { resultPath, settle } from "@/lib/settle"

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const reference = params.get("reference") ?? params.get("trxref") ?? ""
  if (!reference) return Response.redirect(`${siteUrl()}/result?status=failed`, 303)

  try {
    const verdict = await settle("paystack", reference)
    return Response.redirect(`${siteUrl()}${resultPath(verdict)}`, 303)
  } catch (error) {
    // The provider could not be reached. The webhook will settle it later.
    console.error(error)
    return Response.redirect(
      `${siteUrl()}/result?status=pending&ref=${encodeURIComponent(reference)}`,
      303
    )
  }
}
