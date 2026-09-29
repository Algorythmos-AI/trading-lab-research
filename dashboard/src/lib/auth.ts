import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time check of an `Authorization: Bearer <secret>` header. Fails closed when the secret is unset. */
export function bearerMatches(header: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || !header) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
