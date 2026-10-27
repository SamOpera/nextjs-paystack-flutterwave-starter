// Run by Vercel Cron (see vercel.json). Re-verifies pending payments that were never
// fulfilled, for example because the provider was down longer than its webhook retries.
// Vercel sends `Authorization: Bearer <CRON_SECRET>`; anything else is turned away.

import { isCronAuthorized } from "@/lib/cronAuth"
import { reconcile } from "@/lib/reconcile"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET, process.env.NODE_ENV)) {
    return new Response("Unauthorized", { status: 401 })
  }
  try {
    const report = await reconcile()
    if (report.fulfilled.length) console.log(`Reconciled ${report.fulfilled.length} paid order(s)`, report.fulfilled)
    return Response.json(report)
  } catch (error) {
    console.error(error)
    return new Response("Reconcile failed", { status: 500 })
  }
}
