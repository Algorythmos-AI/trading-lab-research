import { describe, expect, it } from "vitest";
import vectors from "./fixtures/hmac_vectors.json";
import { sign, verify } from "@/lib/hmac";

const at = (ts: number) => new Date(ts * 1000);

describe("HMAC signing (matches the Python publisher)", () => {
  it.each(vectors.map((v, i) => [i, v] as const))("reproduces vector %i exactly", (_i, v) => {
    expect(sign(v.secret, v.ts, Buffer.from(v.body, "utf8"))).toBe(v.signature);
    expect(sign(v.secret, v.ts, v.body)).toBe(v.signature);
  });

  it.each(vectors.map((v, i) => [i, v] as const))("verifies vector %i at its own timestamp", (_i, v) => {
    const r = verify(v.secret, String(v.ts), v.signature, Buffer.from(v.body, "utf8"), at(v.ts));
    expect(r).toEqual({ ok: true, ts: v.ts });
  });
});

describe("verify", () => {
  const v = vectors[0]!;
  const body = Buffer.from(v.body, "utf8");

  it("rejects a tampered body", () => {
    const r = verify(v.secret, String(v.ts), v.signature, Buffer.from(`${v.body} `, "utf8"), at(v.ts));
    expect(r).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects the wrong secret", () => {
    expect(verify("not-the-secret", String(v.ts), v.signature, body, at(v.ts))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("accepts the edges of the 300 s window and rejects just outside", () => {
    expect(verify(v.secret, String(v.ts), v.signature, body, at(v.ts + 300)).ok).toBe(true);
    expect(verify(v.secret, String(v.ts), v.signature, body, at(v.ts - 300)).ok).toBe(true);
    expect(verify(v.secret, String(v.ts), v.signature, body, at(v.ts + 301))).toEqual({ ok: false, reason: "stale" });
    expect(verify(v.secret, String(v.ts), v.signature, body, at(v.ts - 301))).toEqual({ ok: false, reason: "stale" });
  });

  it("honours a custom window", () => {
    expect(verify(v.secret, String(v.ts), v.signature, body, at(v.ts + 30), 10)).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects missing or malformed headers without throwing", () => {
    expect(verify(v.secret, null, v.signature, body, at(v.ts))).toEqual({ ok: false, reason: "missing" });
    expect(verify(v.secret, String(v.ts), undefined, body, at(v.ts))).toEqual({ ok: false, reason: "missing" });
    expect(verify("", String(v.ts), v.signature, body, at(v.ts))).toEqual({ ok: false, reason: "missing" });
    expect(verify(v.secret, "12.5", v.signature, body, at(v.ts))).toEqual({ ok: false, reason: "bad-timestamp" });
    expect(verify(v.secret, "-1", v.signature, body, at(v.ts))).toEqual({ ok: false, reason: "bad-timestamp" });
    expect(verify(v.secret, String(v.ts), "sha256=abc", body, at(v.ts))).toEqual({ ok: false, reason: "bad-signature" });
    expect(verify(v.secret, String(v.ts), v.signature.replace("sha256=", "md5="), body, at(v.ts))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("accepts an upper-case hex digest", () => {
    const upper = `sha256=${v.signature.slice(7).toUpperCase()}`;
    expect(verify(v.secret, String(v.ts), upper, body, at(v.ts)).ok).toBe(true);
  });
});
