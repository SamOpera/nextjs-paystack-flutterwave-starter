// Secrets are read on the server only. None of these use the NEXT_PUBLIC_ prefix,
// so Next.js never sends them to the browser.

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`)
  return value
}

export function siteUrl(): string {
  return requireEnv("SITE_URL").replace(/\/+$/, "")
}

/**
 * An order reference that is unique, safe in a URL, and carries the product id, so
 * verification can look up the expected price from the reference alone.
 * Example: `starter-pack.mh2k9x4a3f9c1d2e`
 */
export function newReference(productId: string): string {
  const time = Date.now().toString(36)
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  return `${productId}.${time}${random}`
}

export function productIdFromReference(reference: string): string {
  return reference.split(".")[0] ?? ""
}
