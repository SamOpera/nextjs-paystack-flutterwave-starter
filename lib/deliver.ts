// Where a paid order is delivered: send the receipt email, mark the order paid in your
// own database, grant access to the download, and so on.
//
// This runs only after the payment is verified, and normally once per order. It can run
// more than once if an earlier attempt threw or the server stopped partway through, so
// make each step safe to repeat: for example, send the receipt with the reference as the
// email provider's idempotency key, and update rows rather than insert duplicates.
//
// Throw if delivery didn't happen. The order is then retried, by the provider's webhook
// retries and by the reconciler, until this function returns without throwing.

import type { Fulfilled } from "./orders"

export async function deliverOrder(order: Fulfilled): Promise<void> {
  console.log(`Paid: ${order.reference} (${order.productId}, ${order.amountKobo} kobo)`)
}
