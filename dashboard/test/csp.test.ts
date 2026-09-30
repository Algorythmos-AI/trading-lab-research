import { describe, expect, it } from "vitest";
import vercel from "../vercel.json";
import { buildCsp, newNonce } from "@/proxy";

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? "";

describe("content security policy", () => {
  it("allows scripts only by nonce (plus what they load), never inline", () => {
    const csp = buildCsp("abc123", false);
    const script = directive(csp, "script-src");
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("adds eval only in development (React's dev tooling needs it)", () => {
    expect(directive(buildCsp("n", true), "script-src")).toContain("'unsafe-eval'");
  });

  it("makes a fresh 128-bit nonce each time", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
    expect(atob(a)).toHaveLength(16);
  });

  it("vercel.json no longer sets a page CSP (it would be combined with the nonce one) and denies all on /api", () => {
    const rules = vercel.headers as { source: string; headers: { key: string; value: string }[] }[];
    const csp = rules.flatMap((r) =>
      r.headers.filter((h) => h.key === "Content-Security-Policy").map((h) => ({ source: r.source, value: h.value })),
    );
    expect(csp).toEqual([
      { source: "/api/(.*)", value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
    ]);
  });
});
