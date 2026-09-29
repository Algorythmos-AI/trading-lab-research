import { createHmac, timingSafeEqual } from "node:crypto";

/** "sha256=" + hex(HMAC_SHA256(secret, `${ts}.` + body)). Matches wt.ops.publish.sign. */
export function sign(secret: string, ts: number | string, body: Uint8Array | string): string {
  const h = createHmac("sha256", secret);
  h.update(`${ts}.`, "utf8");
  h.update(typeof body === "string" ? Buffer.from(body, "utf8") : body);
  return `sha256=${h.digest("hex")}`;
}

export type VerifyResult =
  | { ok: true; ts: number }
  | { ok: false; reason: "missing" | "bad-timestamp" | "stale" | "bad-signature" };

const TS_RE = /^\d{1,15}$/;
const SIG_RE = /^sha256=([0-9a-fA-F]{64})$/;

export function verify(
  secret: string,
  tsHeader: string | null | undefined,
  sigHeader: string | null | undefined,
  body: Uint8Array | string,
  now: Date = new Date(),
  windowS = 300,
): VerifyResult {
  if (!secret || !tsHeader || !sigHeader) return { ok: false, reason: "missing" };
  const tsText = tsHeader.trim();
  if (!TS_RE.test(tsText)) return { ok: false, reason: "bad-timestamp" };
  const ts = Number(tsText);
  if (Math.abs(Math.floor(now.getTime() / 1000) - ts) > windowS) return { ok: false, reason: "stale" };
  const m = SIG_RE.exec(sigHeader.trim());
  if (!m?.[1]) return { ok: false, reason: "bad-signature" };
  const given = Buffer.from(m[1].toLowerCase(), "hex");
  const expected = Buffer.from(sign(secret, tsText, body).slice("sha256=".length), "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true, ts };
}
