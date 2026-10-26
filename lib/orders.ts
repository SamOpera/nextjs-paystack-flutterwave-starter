// Fulfilment, kept idempotent: the callback and the webhook can both arrive for the
// same payment, sometimes more than once, and an order must only be fulfilled once.
//
// This in-memory store is for the demo only. A serverless host can run several
// instances and restart them at any time, so in production replace it with your
// database and make `reference` a unique key (for example a UNIQUE column, or an
// INSERT ... ON CONFLICT DO NOTHING).

import type { Verdict } from "./verify"

type Fulfilled = { reference: string; productId: string; amountKobo: number; at: string }

const fulfilled = new Map<string, Fulfilled>()

/** Returns true the first time a reference is fulfilled, false on every repeat. */
export async function fulfilOnce(verdict: Extract<Verdict, { ok: true }>): Promise<boolean> {
  if (fulfilled.has(verdict.reference)) return false
  fulfilled.set(verdict.reference, {
    reference: verdict.reference,
    productId: verdict.productId,
    amountKobo: verdict.amountKobo,
    at: new Date().toISOString(),
  })
  // Deliver the goods here: send the receipt email, mark the order paid, etc.
  return true
}

/** For tests. */
export function resetOrders() {
  fulfilled.clear()
}
