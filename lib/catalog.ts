// The only place prices live. The browser sends a product id, never an amount,
// so nobody can change the price by editing the request.

export type Product = {
  id: string
  name: string
  description: string
  /** Price in kobo (1 naira = 100 kobo), so there is no floating-point money. */
  priceKobo: number
}

export const CURRENCY = "NGN"

export const PRODUCTS: Product[] = [
  {
    id: "starter-pack",
    name: "Starter pack",
    description: "A small test order to try the full checkout.",
    priceKobo: 1_500_00,
  },
  {
    id: "business-pack",
    name: "Business pack",
    description: "A bigger order, to see amounts checked on the server.",
    priceKobo: 25_000_00,
  },
]

export function findProduct(id: unknown): Product | undefined {
  return typeof id === "string" ? PRODUCTS.find((p) => p.id === id) : undefined
}

export function formatNaira(kobo: number): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: CURRENCY,
    maximumFractionDigits: 0,
  }).format(kobo / 100)
}
