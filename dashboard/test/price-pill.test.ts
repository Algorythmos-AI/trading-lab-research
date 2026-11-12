import { describe, expect, it } from "vitest";
import { pricePill, regularSessionOpen, type PriceStatus } from "@/lib/price-pill";
import { FEED_STALE_MS } from "@/lib/trade-state";

// Thursday 2026-11-12 is a full session (09:30 to 16:00 New York, UTC-5).
const at = (iso: string) => Date.parse(iso);
const OPEN = at("2026-11-12T14:30:00Z");
const MID = at("2026-11-12T16:00:00Z");
const ok = (receivedAt: number, over: Partial<PriceStatus> = {}): PriceStatus => ({ status: "ok", source: "sip", receivedAt, retrying: false, ...over });

describe("regularSessionOpen", () => {
  it("is open from the open to just before the close, and shut around them", () => {
    expect(regularSessionOpen(OPEN - 1)).toBe(false);
    expect(regularSessionOpen(OPEN)).toBe(true);
    expect(regularSessionOpen(at("2026-11-12T20:59:59Z"))).toBe(true);
    expect(regularSessionOpen(at("2026-11-12T21:00:00Z"))).toBe(false);
  });
  it("is shut on a weekend and a holiday, and shuts early on a half day", () => {
    expect(regularSessionOpen(at("2026-11-14T16:00:00Z"))).toBe(false); // Saturday
    expect(regularSessionOpen(at("2026-11-26T16:00:00Z"))).toBe(false); // Thanksgiving
    expect(regularSessionOpen(at("2026-11-27T17:59:00Z"))).toBe(true); // half day, before 13:00 New York
    expect(regularSessionOpen(at("2026-11-27T18:00:00Z"))).toBe(false);
  });
});

describe("pricePill", () => {
  it("says live with the feed and the seconds since the last answer", () => {
    const p = pricePill(ok(MID - 2_400), MID);
    expect(p).toMatchObject({ state: "live", full: "Prices live · SIP · 2 s", short: "Live 2s" });
    expect(p.title).toMatch(/polled every 2 s, not streaming/);
    expect(pricePill(ok(MID, { source: "iex" }), MID).full).toBe("Prices live · IEX · 0 s");
    expect(pricePill(ok(MID, { source: null }), MID).full).toBe("Prices live · 0 s");
  });
  it("is live at exactly the board's limit and paused one second past it", () => {
    expect(pricePill(ok(MID - FEED_STALE_MS), MID).state).toBe("live");
    const late = pricePill(ok(MID - FEED_STALE_MS - 1_000), MID);
    expect(late).toMatchObject({ state: "paused", full: "Prices paused · 21 s", short: "Paused 21s" });
    expect(late.title).toMatch(/check your platform/);
  });
  it("is paused while the poll waits to retry, however recent the last answer", () => {
    expect(pricePill(ok(MID - 1_000, { retrying: true }), MID).state).toBe("paused");
  });
  it("is paused, with no age, when no answer ever arrived", () => {
    expect(pricePill({ status: "error", source: null, receivedAt: null, retrying: true }, MID)).toMatchObject({ state: "paused", full: "Prices paused", short: "Paused" });
  });
  it("says connecting before the first answer", () => {
    expect(pricePill({ status: "loading", source: null, receivedAt: null, retrying: false }, MID)).toMatchObject({ state: "connecting", full: "Prices connecting" });
  });
  it("never says live outside the regular session", () => {
    for (const now of [OPEN - 60_000, at("2026-11-12T21:00:00Z"), at("2026-11-14T16:00:00Z")]) {
      expect(pricePill(ok(now - 1_000), now)).toMatchObject({ state: "closed", full: "Market closed", short: "Closed" });
    }
  });
  it("says the prices are off when the page is not reading them, in or out of the session", () => {
    const off: PriceStatus = { status: "off", source: null, receivedAt: null, retrying: false };
    expect(pricePill(off, MID).state).toBe("off");
    expect(pricePill(off, OPEN - 60_000).full).toBe("Live prices off");
  });
  it("never shows a negative age when the clocks disagree", () => {
    expect(pricePill(ok(MID + 5_000), MID).full).toBe("Prices live · SIP · 0 s");
  });
});
