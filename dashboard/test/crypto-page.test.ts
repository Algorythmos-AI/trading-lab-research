// The crypto desk is closed (DEC-0036): one static page, drawn from no snapshot, that says so in SAFE terms only.
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deskNote } from "@/lib/desk-state";

const { default: CryptoPage, metadata } = await import("@/app/crypto/page");

const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("the crypto page with the desk closed", () => {
  it("says the desk is closed, since when, by which record, and the record's counts", () => {
    expect(deskNote("crypto")).toEqual({ state: "closed", since: "2026-10-24", record: "DEC-0036" });
    const html = renderToString(CryptoPage());
    const out = text(html);
    expect(metadata.title).toBe("Crypto");
    expect(html).toMatch(/<h1[^>]*>Crypto<\/h1>/);
    expect(out).toContain("The crypto desk is closed.");
    expect(out).toContain("Closed on 24 October 2026 (DEC-0036)");
    expect(out).toContain("Gate C1: 12 registered trials and 6 challengers, 0 passed.");
  });

  it("shows no digit but the date, the record id and the gate's counts, and nothing that looks like a reading", () => {
    const html = renderToString(CryptoPage());
    const out = text(html)
      .replace("24 October 2026", "")
      .replace("DEC-0036", "")
      .replace("Gate C1: 12 registered trials and 6 challengers, 0 passed.", "");
    expect(out).not.toMatch(/\d/);
    expect(out).not.toContain("—");
    expect(out).not.toMatch(/\$|USD|AUD|BTC|ETH|Kraken|sleeve|trend|break|dip|harvest/i); // no money, no venue, no setup names
    expect(out).not.toMatch(/All clear|Needs a look|Action needed|Status (green|amber|red)/);
    expect(html).not.toMatch(/<table|data-slot="badge"|role="status"|<a /);
  });
});
