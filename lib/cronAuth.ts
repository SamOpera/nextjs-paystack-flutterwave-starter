import { safeEqual } from "./signature"

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Without a secret the
 * reconcile route only runs locally, so nobody can trigger it on a live site.
 */
export function isCronAuthorized(header: string | null, secret: string | undefined, nodeEnv: string | undefined): boolean {
  if (!secret) return nodeEnv !== "production"
  return !!header && safeEqual(header, `Bearer ${secret}`)
}
