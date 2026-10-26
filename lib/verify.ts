// One rule for both providers: a payment counts only if the provider itself says it
// succeeded, for the right product, the full price and the right currency.
// Redirect query strings and client-side callbacks are never trusted on their own.

import { CURRENCY, findProduct } from "./catalog"

export type PaymentFacts = {
  /** The reference we created for this order. */
  reference: string
  /** True only when the provider's own verify API reports success. */
  succeeded: boolean
  /** Amount the provider says was charged, in kobo. */
  amountKobo: number
  currency: string
  /** Product id we stored in the payment metadata when it was created. */
  productId: unknown
}

export type Verdict =
  | { ok: true; reference: string; productId: string; amountKobo: number }
  | { ok: false; reference: string; reason: string }

export function checkPayment(facts: PaymentFacts): Verdict {
  const { reference } = facts
  if (!facts.succeeded) return { ok: false, reference, reason: "not successful" }

  const product = findProduct(facts.productId)
  if (!product) return { ok: false, reference, reason: "unknown product" }

  if (facts.currency !== CURRENCY) {
    return { ok: false, reference, reason: `wrong currency ${facts.currency}` }
  }
  // Less than the price is an underpayment. Do not accept "close enough".
  if (!Number.isInteger(facts.amountKobo) || facts.amountKobo < product.priceKobo) {
    return { ok: false, reference, reason: "amount below price" }
  }

  return { ok: true, reference, productId: product.id, amountKobo: facts.amountKobo }
}
