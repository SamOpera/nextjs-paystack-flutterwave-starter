// Flutterwave sends the shopper back here with ?status=...&tx_ref=...&transaction_id=...
// Anyone can type ?status=successful into a URL, so only tx_ref is used, and the
// payment is verified with Flutterwave by that reference.

import { siteUrl } from "@/lib/env"
import { resultPath, settle } from "@/lib/settle"

export async function GET(request: Request) {
  const reference = new URL(request.url).searchParams.get("tx_ref") ?? ""
  if (!reference) return Response.redirect(`${siteUrl()}/result?status=failed`, 303)

  try {
    const verdict = await settle("flutterwave", reference)
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
