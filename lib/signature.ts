import { createHmac, timingSafeEqual } from "node:crypto"

/** Constant-time string comparison, so an attacker can't guess a signature byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Paystack signs every webhook with HMAC SHA-512 of the raw request body, keyed with
 * your secret key, in the `x-paystack-signature` header.
 */
export function isValidPaystackSignature(
  rawBody: string,
  signature: string | null,
  secretKey: string
): boolean {
  if (!signature) return false
  const expected = createHmac("sha512", secretKey).update(rawBody).digest("hex")
  return safeEqual(expected, signature)
}

/**
 * Flutterwave sends the secret hash you set in its dashboard in the `verif-hash` header.
 */
export function isValidFlutterwaveHash(hash: string | null, secretHash: string): boolean {
  return !!hash && safeEqual(hash, secretHash)
}
