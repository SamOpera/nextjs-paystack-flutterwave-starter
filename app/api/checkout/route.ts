// Starts a payment. The form sends a product id, an email and a provider. The price
// comes from the server-side catalog, and the reference is made here, never by the browser.

import { findProduct } from "@/lib/catalog"
import { newReference, requireEnv, siteUrl } from "@/lib/env"
import { startFlutterwavePayment } from "@/lib/flutterwave"
import { orderStore } from "@/lib/orders"
import { startPaystackPayment } from "@/lib/paystack"

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const backTo = (error: string) =>
  Response.redirect(`${siteUrl()}/?error=${encodeURIComponent(error)}`, 303)

export async function POST(request: Request) {
  const form = await request.formData()
  const product = findProduct(form.get("productId"))
  const email = String(form.get("email") ?? "").trim()
  const provider = form.get("provider")

  if (!product) return backTo("Choose a product.")
  if (!EMAIL.test(email)) return backTo("Enter a valid email address.")
  if (provider !== "paystack" && provider !== "flutterwave") {
    return backTo("Choose Paystack or Flutterwave.")
  }

  const reference = newReference(product.id)
  try {
    // Recorded before the shopper pays, so the reconciler can find this payment later
    // even if every redirect and webhook for it is lost.
    const store = await orderStore()
    await store.recordPending({ reference, provider, productId: product.id, amountKobo: product.priceKobo }, Date.now())

    const url =
      provider === "paystack"
        ? await startPaystackPayment(
            { product, email, reference, callbackUrl: `${siteUrl()}/api/paystack/callback` },
            requireEnv("PAYSTACK_SECRET_KEY")
          )
        : await startFlutterwavePayment(
            { product, email, reference, redirectUrl: `${siteUrl()}/api/flutterwave/callback` },
            requireEnv("FLW_SECRET_KEY")
          )
    // 303 turns the form POST into a GET on the provider's checkout page.
    return Response.redirect(url, 303)
  } catch (error) {
    console.error(error)
    return backTo("The payment could not be started. Please try again.")
  }
}
