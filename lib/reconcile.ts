// The safety net under the redirect and the webhook. If the provider's verify API is
// down for longer than its webhook retries last, a paid order could otherwise wait
// forever. A scheduled job calls reconcile(), which re-verifies every pending payment
// that still isn't fulfilled and settles it through the same settle() path, so it can
// never fulfil an order twice.

import { orderStore, type OrderStore, type Provider } from "./orders"
import { settle } from "./settle"
import { VerifyUnavailable, type Verdict } from "./verify"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const RECONCILE_DEFAULTS = {
  minAgeMs: 10 * MINUTE, // give the redirect and webhook time first
  maxAgeMs: 72 * HOUR, // after 3 days, an unpaid checkout was abandoned
  recheckAfterMs: 30 * MINUTE,
  limit: 50, // per run, to stay within the provider's rate limits
}

export type ReconcileReport = {
  checked: number
  fulfilled: string[]
  notPaid: number
  /** The verify API couldn't answer. These stay pending for the next run. */
  unavailable: number
}

type Settle = (provider: Provider, reference: string) => Promise<Verdict>

export async function reconcile(
  options: { now?: number; store?: OrderStore; settle?: Settle } & Partial<typeof RECONCILE_DEFAULTS> = {}
): Promise<ReconcileReport> {
  const now = options.now ?? Date.now()
  const store = options.store ?? (await orderStore())
  const settleOne = options.settle ?? settle
  const due = await store.due({ ...RECONCILE_DEFAULTS, ...options, now })

  const report: ReconcileReport = { checked: 0, fulfilled: [], notPaid: 0, unavailable: 0 }
  const down = new Set<Provider>()
  // One at a time, to be gentle with the provider's API.
  for (const { reference, provider } of due) {
    if (down.has(provider)) {
      report.unavailable++ // still down: don't spend the rest of this run on it
      continue
    }
    report.checked++
    try {
      const verdict = await settleOne(provider, reference)
      if (verdict.ok) report.fulfilled.push(reference)
      else report.notPaid++
    } catch (error) {
      if (!(error instanceof VerifyUnavailable)) throw error
      report.unavailable++
      down.add(provider)
    }
    await store.markChecked(reference, now)
  }
  return report
}
