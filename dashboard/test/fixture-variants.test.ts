import { describe, expect, it } from "vitest";
import { FIXTURE_OFFSET_ATR, flagsFromCookieHeader, parseFlags, partialOptions, poisonedOptions, tickPrice, VARIANT_FLAGS } from "@/lib/fixture-variants";
import {
  findingsOf,
  ladder,
  liveRead,
  liveState,
  mapView,
  moveBands,
  nearest,
  roomView,
  structureView,
  type LiveQuote,
  type Options,
  type OptionsTicker,
} from "@/lib/options";
import { validateOptionsEdition } from "@/lib/validate";
import optionsJson from "./fixtures/options.v1.json";

const base = optionsJson as unknown as Options;

/** The quote the fixture feed gives a name at one second of the minute (see quote-route.ts). */
function quoteAt(t: OptionsTicker, session: string, second: number): LiveQuote | null {
  const close = t.last?.close;
  if (typeof close !== "number") return null;
  const price = tickPrice(Math.round((close + FIXTURE_OFFSET_ATR * (t.atr14 ?? 0)) * 100) / 100, second);
  return {
    price,
    at: `${session}T15:00:${String(second).padStart(2, "0")}.000Z`,
    open: close,
    high: Math.max(price, close),
    low: Math.min(price, close),
    day: session,
    prev_close: close,
  };
}

/** True when any number anywhere in `value` is NaN or infinite. */
function hasBadNumber(value: unknown): boolean {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? "__BAD__" : v))?.includes("__BAD__") ?? false;
}

describe("fixture variant flags", () => {
  it("reads known flags from a cookie value and ignores the rest", () => {
    expect([...parseFlags("partial.quotes-tick")]).toEqual(["partial", "quotes-tick"]);
    expect([...parseFlags("partial.nonsense.<script>")]).toEqual(["partial"]);
    expect(parseFlags("").size).toBe(0);
    expect(parseFlags(null).size).toBe(0);
    for (const f of VARIANT_FLAGS) expect(parseFlags(f).has(f)).toBe(true);
  });

  it("finds the fx cookie among others, and only that cookie", () => {
    expect([...flagsFromCookieHeader("tl=1; fx=empty; other=fx")]).toEqual(["empty"]);
    expect([...flagsFromCookieHeader("fx=poison")]).toEqual(["poison"]);
    expect(flagsFromCookieHeader("notfx=empty; xfx=error").size).toBe(0);
    expect(flagsFromCookieHeader(null).size).toBe(0);
  });
});

describe("the partial edition", () => {
  const partial = partialOptions(base);

  it("is still a valid edition, so it is a state storage can really hold", () => {
    const r = validateOptionsEdition(partial);
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(validateOptionsEdition(base).ok).toBe(true);
  });

  it("leaves the fixture itself untouched", () => {
    expect(base.tickers[0]!.expected_move).not.toBeNull();
    expect(base.paper!.length).toBeGreaterThan(0);
  });

  it("covers every kind of missing data the page must survive", () => {
    const t = partial.tickers;
    expect(t.some((x) => x.expected_move == null)).toBe(true);
    expect(t.some((x) => x.atr14 == null)).toBe(true);
    expect(t.some((x) => (x.zones ?? []).length === 0)).toBe(true);
    expect(t.some((x) => (x.bars ?? []).length === 0)).toBe(true);
    expect(t.some((x) => x.last == null)).toBe(true);
    expect(t.some((x) => x.close_strength == null)).toBe(true);
    expect(partial.paper).toEqual([]);
    expect(partial.expected_move_check).toBeNull();
  });

  it("never turns a missing number into NaN or infinity in any view helper", () => {
    for (const e of [base, partial]) {
      expect(hasBadNumber(structureView(e.tickers)), "structureView").toBe(false);
      expect(hasBadNumber(findingsOf(e)), "findingsOf").toBe(false);
      for (const t of e.tickers) {
        const q = quoteAt(t, e.session, 0);
        const now = Date.parse(`${e.session}T15:00:05.000Z`);
        const views = {
          ladder: ladder(t),
          nearest: nearest(t),
          moveBands: moveBands(t),
          mapView: mapView(t),
          roomAtClose: typeof t.last?.close === "number" ? roomView(t, t.last.close) : null,
          roomLive: q ? roomView(t, q.price) : null,
          live: liveRead(t, q ?? undefined, e.session, now, now),
        };
        expect(hasBadNumber(views), `${t.symbol}: ${JSON.stringify(views).slice(0, 200)}`).toBe(false);
      }
    }
  });

  it("gives a name without a last bar no price, never a zero", () => {
    const t = partial.tickers.find((x) => x.last == null)!;
    const read = liveRead(t, undefined, partial.session, null, null);
    expect(read.price).toBeNull();
  });
});

describe("the poisoned edition", () => {
  it("is refused by the schema: it stands for a stored edition that has been corrupted", () => {
    const r = validateOptionsEdition(poisonedOptions(base));
    expect(r.ok).toBe(false);
    expect(base.paper!.every((p) => p !== null)).toBe(true);
  });
});

describe("the ticking fixture feed", () => {
  it("flips the price by exactly one cent every three seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((s) => tickPrice(338.56, s))).toEqual([338.56, 338.56, 338.56, 338.57, 338.57, 338.57, 338.56]);
    expect(tickPrice(0.29, 3)).toBe(0.3);
  });

  it("shows a flip to a page that polls every two seconds, whatever second it starts on", () => {
    for (let start = 0; start < 60; start++) {
      const seen = new Set([0, 2, 4].map((dt) => tickPrice(100, start + dt)));
      expect(seen.size, `polls from second ${start}`).toBe(2);
    }
  });

  it("moves the price without changing any name's state, so a row never moves and a layout shift is a real one", () => {
    let moved = 0;
    for (const t of base.tickers) {
      const first = quoteAt(t, base.session, 0)!;
      const state = liveState(t, first, base.session);
      for (let s = 1; s < 60; s++) {
        const q = quoteAt(t, base.session, s)!;
        expect(liveState(t, q, base.session), `${t.symbol} at second ${s}`).toBe(state);
        if (q.price !== first.price) moved++;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });
});
