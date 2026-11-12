// The server comparison of the two stock feeds (DEC-0050; docs/runbooks/feed-agreement.md, "Server comparison"):
// the paired rule at its boundaries, the spread, bars and volume measures, the percentiles, the day's report on
// synthetic days (a full day, a half day, a day without its edition), the sampler's guards, and the routes.
import { describe, expect, it, vi } from "vitest";
import { BAR_MS, ENGINE_VERSION, sessionBounds } from "@/lib/desk-eval";
import { TRADE_STALE_MS } from "@/lib/entry-checks";
import { PreconditionFailed } from "@/lib/blob";
import {
  barsSection,
  type BarsInput,
  buildReport,
  type CompareReport,
  editionInForce,
  type FeedAnswer,
  type MinBar,
  minuteRule,
  pairOf,
  PAIR_WITHIN_MS,
  parseReport,
  parseSample,
  percentile,
  quotePairOf,
  type ReportInput,
  reportPath,
  REQUESTS_WITHIN_MS,
  RULES,
  type Sample,
  samplePath,
  type SnapRow,
  snapRows,
  spreadBp,
  timeMs,
} from "@/lib/feed-compare";
import { fetchMinuteBars, minuteBarsUrl } from "@/lib/feed-compare-bars";
import { CallLimiter, FetchStop } from "@/lib/feed-agreement-fetch";
import { askFeed, runFeedSample, type SampleDeps, sampleSymbols } from "@/lib/feed-compare-sample";
import { type BarsRead, readCompareReports, readCompareToday, readReportBars, runFeedReport, type ReportDeps } from "@/lib/feed-compare-report";
import { focusOptions } from "@/lib/fixture-variants";
import type { Options } from "@/lib/options";
import { fetchQuotes, resetQuoteCache } from "@/lib/quote";
import type { Bar2 } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, a Monday on EDT
const SYMS = E.focus!.items.map((i) => i.symbol);
/** What a minute asks for: the focus names, then SPY when it is not one of them. */
const ASKED = [...new Set([...SYMS, "SPY"])];
const ny = (day: string, hhmmss: string, offset = "-04:00") => Date.parse(`${day}T${hhmmss}${offset}`);
const on = (day: string, half = false): Options => ({ ...E, session: day, tickers: E.tickers.map((t) => ({ ...t, half_day: half })) }) as Options;

// ---- synthetic samples --------------------------------------------------------------------------------------------
/** A row whose quote is centred on the trade price and dated with it, unless `q` says otherwise. */
function row(p: number, t: number, q: Partial<{ bp: number; ap: number; t: number }> = {}): SnapRow {
  return {
    latestTrade: { p, t },
    latestQuote: { bp: q.bp ?? p - 0.01, bs: 1, ap: q.ap ?? p + 0.01, as: 2, t: q.t ?? t },
    minuteBar: null,
    dailyBar: { v: 1000 },
  };
}
function answer(finished: number, rows: Record<string, SnapRow> | null, status: number | null = 200): FeedAnswer {
  return { started: finished - 100, finished, status, rows };
}
function sample(at: number, iex: FeedAnswer, sip: FeedAnswer, symbols = ["SPY"], board: Sample["board_feed"] = "sip"): Sample {
  return { v: 1, at, symbols, board_feed: board, iex, sip };
}
const T0 = ny(S, "10:00:00");

describe("the minute rule and the trade pair", () => {
  const ok = (iexFin: number, sipFin: number, iexT = iexFin - 1000, sipT = sipFin - 1000) =>
    sample(T0, answer(iexFin, { SPY: row(500, iexT) }), answer(sipFin, { SPY: row(500.05, sipT) }));

  it("counts a pair when both answered, within 2 s, each trade fresh, the two trades within 5 s", () => {
    expect(pairOf(ok(T0, T0 + 500), "SPY")).toEqual({ ok: true, iex: 500, sip: 500.05, gapMs: 500 });
  });

  it("requests 2.000 s apart count; 2.001 s apart is apart (either order)", () => {
    expect(REQUESTS_WITHIN_MS).toBe(2000);
    expect(pairOf(ok(T0, T0 + 2000), "SPY").ok).toBe(true);
    expect(pairOf(ok(T0, T0 + 2001), "SPY")).toEqual({ ok: false, reason: "apart" });
    expect(pairOf(ok(T0 + 2001, T0), "SPY")).toEqual({ ok: false, reason: "apart" });
    expect(minuteRule(ok(T0, T0 + 2001))).toBe("apart");
  });

  it("a trade exactly TRADE_STALE_MS old counts; one ms older is stale, on its own side", () => {
    expect(pairOf(ok(T0, T0, T0 - TRADE_STALE_MS, T0 - TRADE_STALE_MS), "SPY").ok).toBe(true);
    expect(pairOf(ok(T0, T0, T0 - TRADE_STALE_MS - 1, T0), "SPY")).toEqual({ ok: false, reason: "stale_iex" });
    expect(pairOf(ok(T0, T0, T0, T0 - TRADE_STALE_MS - 1), "SPY")).toEqual({ ok: false, reason: "stale_sip" });
    expect(pairOf(ok(T0, T0, T0 - TRADE_STALE_MS - 1, T0 - TRADE_STALE_MS - 1), "SPY")).toEqual({ ok: false, reason: "stale_both" });
  });

  it("staleness is judged against each request's own finish", () => {
    // sip finished 1.5 s after iex; its trade is TRADE_STALE_MS before its own finish: fresh (and 4.99 s from iex's)
    expect(pairOf(ok(T0, T0 + 1500, T0 - 3490, T0 + 1500 - 5000), "SPY").ok).toBe(true);
  });

  it("the two trades 5.000 s apart pair; 5.001 s apart is trades_apart", () => {
    expect(PAIR_WITHIN_MS).toBe(5000);
    expect(pairOf(ok(T0, T0, T0 - 1000, T0 - 6000), "SPY")).toMatchObject({ ok: true, gapMs: 5000 });
    expect(pairOf(ok(T0, T0, T0 - 1000, T0 - 6001), "SPY")).toEqual({ ok: false, reason: "trades_apart" });
    expect(pairOf(ok(T0, T0, T0 - 6001, T0 - 1000), "SPY")).toEqual({ ok: false, reason: "trades_apart" });
  });

  it("names each failure: both, iex, sip, apart, a missing symbol, a bad price", () => {
    const good = answer(T0, { SPY: row(500, T0) });
    expect(pairOf(sample(T0, answer(T0, null, 500), answer(T0, null, null)), "SPY")).toEqual({ ok: false, reason: "both_failed" });
    expect(pairOf(sample(T0, answer(T0, null, 500), good), "SPY")).toEqual({ ok: false, reason: "iex_failed" });
    expect(pairOf(sample(T0, good, answer(T0, null, 429)), "SPY")).toEqual({ ok: false, reason: "sip_failed" });
    expect(pairOf(sample(T0, good, answer(T0, null, 200)), "SPY")).toEqual({ ok: false, reason: "sip_failed" }); // 200 with an unreadable body
    expect(pairOf(sample(T0, good, answer(T0 + 3000, {})), "SPY")).toEqual({ ok: false, reason: "apart" });
    expect(pairOf(sample(T0, good, answer(T0, {})), "SPY")).toEqual({ ok: false, reason: "missing_symbol" });
    expect(pairOf(sample(T0, good, answer(T0, { SPY: { ...row(500, T0), latestTrade: { p: 500, t: null } } })), "SPY")).toEqual({ ok: false, reason: "missing_symbol" });
    expect(pairOf(sample(T0, good, answer(T0, { SPY: { ...row(500, T0), latestTrade: { p: null, t: T0 } } })), "SPY")).toEqual({ ok: false, reason: "bad_price" });
    expect(pairOf(sample(T0, good, answer(T0, { SPY: row(0, T0) })), "SPY")).toEqual({ ok: false, reason: "bad_price" });
  });
});

describe("the quote pair", () => {
  const q = (iexQt: number, sipQt: number, iexFin = T0, sipFin = T0) =>
    sample(T0, answer(iexFin, { SPY: row(500, iexFin, { t: iexQt }) }), answer(sipFin, { SPY: row(500, sipFin, { t: sipQt }) }));

  it("each quote at most 5 s older than its own finish: 5.000 s counts, 5.001 s is stale", () => {
    expect(quotePairOf(q(T0 - 5000, T0 - 5000), "SPY").ok).toBe(true);
    expect(quotePairOf(q(T0 - 5001, T0 - 1000), "SPY")).toEqual({ ok: false, reason: "stale_quote_iex" });
    expect(quotePairOf(q(T0 - 1000, T0 - 5001), "SPY")).toEqual({ ok: false, reason: "stale_quote_sip" });
    expect(quotePairOf(q(T0 - 5001, T0 - 5001), "SPY")).toEqual({ ok: false, reason: "stale_quote_both" });
    // judged against each request's own finish: sip finished 2 s later, its quote 5 s before that
    expect(quotePairOf(q(T0 - 1000, T0 + 2000 - 5000, T0, T0 + 2000), "SPY").ok).toBe(true);
  });

  it("the two quotes more than 5 s apart are quotes_apart; a missing or bad quote is named", () => {
    // iex finished 2 s after sip; iex's quote 1 s old (T0+1000), sip's 4.5 s old (T0-6500+... ) -> 7.5 s apart
    expect(quotePairOf(q(T0 + 2000 - 1000, T0 - 4500, T0 + 2000, T0), "SPY")).toEqual({ ok: false, reason: "quotes_apart" });
    expect(quotePairOf(q(T0 + 2000 - 1000, T0 - 4000, T0 + 2000, T0), "SPY").ok).toBe(true); // exactly 5 s apart
    const good = answer(T0, { SPY: row(500, T0) });
    expect(quotePairOf(sample(T0, good, answer(T0, { SPY: { ...row(500, T0), latestQuote: null } })), "SPY")).toEqual({ ok: false, reason: "missing_quote" });
    expect(quotePairOf(sample(T0, good, answer(T0, { SPY: row(500, T0, { bp: 0 }) })), "SPY")).toEqual({ ok: false, reason: "bad_quote" });
    expect(quotePairOf(sample(T0, answer(T0, null, 500), good), "SPY")).toEqual({ ok: false, reason: "iex_failed" });
  });
});

describe("measures", () => {
  it("percentiles interpolate linearly, as numpy does", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([4, 1, 3, 2], 0.95)).toBeCloseTo(3.85, 12); // numpy.percentile([1,2,3,4], 95)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1)).toBeCloseTo(1.9, 12);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1, 12);
  });

  it("a locked or crossed quote is counted, never given a spread; spreads only on quote pairs", () => {
    expect(spreadBp({ bp: 100, bs: 1, ap: 100, as: 1, t: 0 })).toBe("locked");
    expect(spreadBp({ bp: 100.01, bs: 1, ap: 100, as: 1, t: 0 })).toBe("crossed");
    expect(spreadBp({ bp: 99.99, bs: 1, ap: 100.01, as: 1, t: 0 })).toBeCloseTo(2, 9);
    expect(spreadBp({ bp: null, bs: 1, ap: 100, as: 1, t: 0 })).toBeNull();
    const at = T0;
    const s = sample(at, answer(at, { SPY: row(100, at, { bp: 100, ap: 100 }) }), answer(at, { SPY: row(100, at, { bp: 100.02, ap: 100 }) }));
    const s2 = sample(at + 60_000, answer(at + 60_000, { SPY: row(100, at + 60_000, { bp: 99.99, ap: 100.01 }) }), answer(at + 60_000, { SPY: row(100, at + 60_000, { bp: 99.995, ap: 100.005 }) }));
    // a stale sip quote: no spread on either feed that minute
    const s3 = sample(at + 120_000, answer(at + 120_000, { SPY: row(100, at + 120_000, { bp: 99, ap: 101 }) }), answer(at + 120_000, { SPY: row(100, at + 120_000, { bp: 99, ap: 101, t: at + 100_000 }) }));
    // requests apart: nothing of the minute counts
    const s4 = sample(at + 180_000, answer(at + 180_000, { SPY: row(100, at + 180_000, { bp: 98, ap: 102 }) }), answer(at + 183_000, { SPY: row(100, at + 183_000) }));
    const r = buildReport(input({ samples: [s, s2, s3, s4] }));
    expect(r.spread.locked_or_crossed).toEqual({ iex: 1, sip: 1 });
    expect(r.spread.iex_bp).toEqual({ median: expect.closeTo(2, 9), p95: expect.closeTo(2, 9), n: 1 });
    expect(r.spread.sip_bp.median).toBeCloseTo(1, 9);
    expect(r.prices.quote_pairs).toBe(2);
    expect(r.prices.quote_not_comparable).toMatchObject({ stale_quote_sip: 1, apart: 1 });
    expect(r.freshness.iex_trade_age_s.n).toBe(3); // the apart minute's ages are not measured
  });

  it("trade ages are measured from each request's start; a trade after the start is clamped to 0 and counted as clock skew", () => {
    const at = T0;
    const iex: FeedAnswer = { started: at, finished: at + 400, status: 200, rows: { SPY: row(100, at - 2000) } };
    const sip: FeedAnswer = { started: at + 400, finished: at + 700, status: 200, rows: { SPY: row(100, at + 600) } };
    const r = buildReport(input({ samples: [sample(at, iex, sip)] }));
    expect(r.freshness.iex_trade_age_s).toEqual({ median: 2, p95: 2, n: 1 });
    expect(r.freshness.sip_trade_age_s).toEqual({ median: 0, p95: 0, n: 1 });
    expect(r.freshness.clock_skew).toEqual({ iex: 0, sip: 1 });
  });

  it("settled 1-minute bars align only on an identical start; volume ratios only where both volumes are above zero", () => {
    const t = (hhmm: string) => ny(S, `${hhmm}:00`);
    const b = (at: string, c: number, v: number | null): MinBar => ({ t: t(at), o: c, h: c, l: c, c, v });
    const bars: BarsInput = {
      status: "ok",
      bars: {
        iex: { SPY: [b("10:00", 100, 50), b("10:01", 100, 0), b("10:03", 100, 10)], QQQ: [] },
        sip: { SPY: [b("10:00", 100.01, 200), b("10:01", 100, 300), b("10:02", 100, 300)], QQQ: [b("10:00", 400, 1)] },
      },
    };
    const r = barsSection(bars);
    expect(r).toMatchObject({ status: "ok", aligned: 2, only_sip: 2, only_iex: 1 });
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.volume_ratio_sip_over_iex).toEqual({ median: 4, p10: 4, p90: 4, n: 1 }); // the zero volume at 10:01 is left out
    expect(r.close_diff_bp.n).toBe(2);
    expect(r.close_diff_bp.p95).toBeCloseTo(0.95 * ((0.01 / 100.005) * 10_000), 6);
    expect(r.high_low_diff_bp.n).toBe(4);
    expect(barsSection({ status: "no_bars", why: "sip-plan" })).toEqual({ status: "no_bars", why: "sip-plan" });
  });

  it("keeps only the named fields, times as ms, and invents nothing", () => {
    const raw = {
      SPY: {
        latestTrade: { t: "2026-10-12T14:00:00.123456789Z", p: 500.1, s: 100, x: "V", c: ["@"] },
        latestQuote: { t: "2026-10-12T14:00:00.2Z", bp: 500, bs: 3, ap: 500.2, as: 4, bx: "V" },
        minuteBar: { t: "2026-10-12T13:59:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10, vw: 1.2, n: 4 },
        dailyBar: { v: 1e6, o: 9 },
        prevDailyBar: { c: 1 },
      },
      QQQ: { latestTrade: { p: "x" } },
    };
    const rows = snapRows(raw, ["SPY", "QQQ", "IWM"]);
    expect(rows.SPY).toEqual({
      latestTrade: { p: 500.1, t: Date.parse("2026-10-12T14:00:00.123Z") },
      latestQuote: { bp: 500, bs: 3, ap: 500.2, as: 4, t: Date.parse("2026-10-12T14:00:00.200Z") },
      minuteBar: { t: Date.parse("2026-10-12T13:59:00Z"), o: 1, h: 2, l: 0.5, c: 1.5, v: 10, vw: 1.2, n: 4 },
      dailyBar: { v: 1e6 },
    });
    expect(rows.QQQ).toEqual({ latestTrade: { p: null, t: null }, latestQuote: null, minuteBar: null, dailyBar: null });
    expect("IWM" in rows).toBe(false);
    expect(timeMs("nope")).toBeNull();
  });

  it("the edition in force at the open: the newest built at or before the open, else the earliest", () => {
    const open = ny(S, "09:30:00");
    const ed = (asOf: string, session = S) => ({ session, as_of: asOf });
    const a = ed("2026-10-09T21:00:00Z");
    const b = ed("2026-10-12T13:00:00Z");
    const late1 = ed("2026-10-12T15:00:00Z");
    const late2 = ed("2026-10-12T14:00:00Z");
    expect(editionInForce([a, b, late1], S, open)).toBe(b);
    expect(editionInForce([late1, late2, null], S, open)).toBe(late2);
    expect(editionInForce([ed("2026-10-12T13:30:00Z")], S, open)).toEqual(ed("2026-10-12T13:30:00Z")); // at the open
    expect(editionInForce([ed("2026-10-09T21:00:00Z", "2026-10-09"), null], S, open)).toBeNull();
  });
});

// ---- the settled 1-minute bars read -------------------------------------------------------------------------------
describe("the 1-minute bars read", () => {
  const bounds = sessionBounds(S)!;
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };
  const opts = (fetchImpl: typeof fetch, c = clock()) => ({ keys: { id: "a", secret: "b" }, clock: c, deadline: 60_000, limiter: new CallLimiter(), fetchImpl });

  it("names its feed, reads [open, close) raw, follows the pages, and keeps only bars inside the session", async () => {
    expect(minuteBarsUrl("https://data.alpaca.markets", "sip", ["SPY"], bounds, null)).toBe(
      `https://data.alpaca.markets/v2/stocks/bars?symbols=SPY&timeframe=1Min&start=${encodeURIComponent(new Date(bounds.open).toISOString())}&end=${encodeURIComponent(new Date(bounds.close).toISOString())}&feed=sip&limit=10000&adjustment=raw&sort=asc`,
    );
    const iso = (ms: number) => new Date(ms).toISOString();
    const pages = [
      { bars: { SPY: [{ t: iso(bounds.open - 60_000), o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: iso(bounds.open), o: 1, h: 2, l: 1, c: 2, v: 10 }] }, next_page_token: "p2" },
      { bars: { SPY: [{ t: iso(bounds.close - 60_000), o: 3, h: 3, l: 3, c: 3, v: 5 }, { t: iso(bounds.close), o: 9, h: 9, l: 9, c: 9, v: 9 }] }, next_page_token: null },
    ];
    const urls: string[] = [];
    const f = (async (url: string) => (urls.push(url), new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 }))) as unknown as typeof fetch;
    const got = await fetchMinuteBars("iex", ["SPY", "QQQ"], bounds, opts(f));
    expect(got.SPY).toEqual([
      { t: bounds.open, o: 1, h: 2, l: 1, c: 2, v: 10 },
      { t: bounds.close - 60_000, o: 3, h: 3, l: 3, c: 3, v: 5 },
    ]);
    expect(got.QQQ).toEqual([]);
    expect(urls.map((u) => new URL(u).searchParams.get("feed"))).toEqual(["iex", "iex"]);
    expect(new URL(urls[1]!).searchParams.get("page_token")).toBe("p2");
  });

  it("stops on a 403, a low SIP plan, no bars at all, or the budget; the report run maps each to its why", async () => {
    const answer = (status: number, body: unknown = { bars: {} }, headers: Record<string, string> = {}) => (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
    await expect(fetchMinuteBars("sip", ["SPY"], bounds, opts(answer(403)))).rejects.toMatchObject({ kind: "sip-not-entitled" });
    await expect(fetchMinuteBars("sip", ["SPY"], bounds, opts(answer(200, { bars: { SPY: [] } }, { "x-ratelimit-limit": "200" })))).rejects.toMatchObject({ kind: "sip-plan" });
    await expect(fetchMinuteBars("iex", ["SPY"], bounds, opts(answer(200)))).rejects.toBeInstanceOf(FetchStop);
    await expect(fetchMinuteBars("iex", ["SPY"], bounds, opts(answer(429, {}, { "retry-after": "120" })))).rejects.toMatchObject({ kind: "time-budget" });
    const read = await readReportBars(["SPY"], bounds, opts(answer(403)));
    expect(read.two).toEqual({ ok: false, final: true, why: "iex-refused" }); // iex 403: a refusal, named and final
    expect(read.one).toEqual({ ok: false, final: true, why: "iex-refused" });
    const plan = await readReportBars(["SPY"], bounds, opts(answer(200, { bars: { SPY: [] } }, { "x-ratelimit-limit": "200" })));
    expect(plan.one).toMatchObject({ ok: false, final: true }); // no bars on iex: final
    expect(["no-bars", "sip-plan"]).toContain((plan.one as { why: string }).why);
  });

  it("the report run's four reads share one call limiter", async () => {
    const limiter = new CallLimiter(3);
    const c = clock();
    const iso = (ms: number) => new Date(ms).toISOString();
    const f = (async (url: string) => {
      const tf = new URL(url).searchParams.get("timeframe");
      const bar = tf === "2Min" ? { t: iso(bounds.open), o: 1, h: 1, l: 1, c: 1, v: 1 } : { t: iso(bounds.open), o: 1, h: 1, l: 1, c: 1, v: 1 };
      return new Response(JSON.stringify({ bars: { SPY: [bar] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const read = await readReportBars(["SPY"], bounds, { keys: { id: "a", secret: "b" }, clock: c, deadline: 600_000, limiter, fetchImpl: f });
    expect(read.two.ok && read.one.ok).toBe(true);
    expect(c.now()).toBeGreaterThanOrEqual(60_000); // the fourth call waited for the shared limiter's minute
  });
});

// ---- the day's report ---------------------------------------------------------------------------------------------
function input(o: Partial<ReportInput> = {}): ReportInput {
  return { day: S, expected: 390, builtAt: T0, samples: [], unreadable: 0, afterClose: 0, signals: { status: "no_edition" }, bars: { status: "no_edition" }, ...o };
}
function flatBars(day: string, price: number): Bar2[] {
  const b = sessionBounds(day)!;
  const out: Bar2[] = [];
  for (let start = b.open; start + BAR_MS <= b.close; start += BAR_MS) out.push({ start, end: start + BAR_MS, o: price, h: price, l: price, c: price });
  return out;
}
function minuteBars(day: string, price: number, v: number): MinBar[] {
  const b = sessionBounds(day)!;
  const out: MinBar[] = [];
  for (let t = b.open; t < b.close; t += 60_000) out.push({ t, o: price, h: price, l: price, c: price, v });
  return out;
}
function daySamples(day: string, everyMin: number): Sample[] {
  const b = sessionBounds(day)!;
  const out: Sample[] = [];
  for (let at = b.open; at < b.close; at += everyMin * 60_000) {
    const f = at + 300;
    out.push(sample(at, answer(f, { SPY: row(500, f - 500) }), answer(f + 400, { SPY: row(500.1, f - 200) }), ["SPY"], "sip"));
  }
  return out;
}

interface FakeStore {
  files: Map<string, string>;
  deps: ReportDeps;
  barsCalls: number;
}
const NY_HHMM = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function reportDeps(now: number, opts: { edition?: Options | null; bars?: BarsRead; samples?: Sample[]; day?: string } = {}): FakeStore {
  const files = new Map<string, string>();
  const day = opts.day ?? S;
  for (const s of opts.samples ?? []) files.set(samplePath(day, NY_HHMM.format(new Date(s.at)).replace(":", "")), JSON.stringify(s));
  const f: FakeStore = {
    files,
    barsCalls: 0,
    deps: {
      now: () => now,
      dry: false,
      exists: async (p) => files.has(p),
      list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)),
      readText: async (p) => files.get(p) ?? null,
      loadEditions: async () => [opts.edition ?? null],
      fetchBars: async () => {
        f.barsCalls++;
        return opts.bars ?? { two: { ok: false, final: true, why: "upstream" }, one: { ok: false, final: true, why: "upstream" } };
      },
      write: async (p, body) => {
        if (files.has(p)) throw new PreconditionFailed();
        files.set(p, body);
      },
    },
  };
  return f;
}
const barsOf = (day: string): BarsRead => ({
  two: { ok: true, bars: { iex: Object.fromEntries(SYMS.map((s) => [s, flatBars(day, 100)])), sip: Object.fromEntries(SYMS.map((s) => [s, flatBars(day, 100)])) } },
  one: { ok: true, bars: { iex: Object.fromEntries(SYMS.map((s) => [s, minuteBars(day, 100, 10)])), sip: Object.fromEntries(SYMS.map((s) => [s, minuteBars(day, 100.02, 30)])) } },
});

describe("the day's report", () => {
  const after = ny(S, "16:30:00");

  it("builds once on a full day, from the samples, the bars and the replay", async () => {
    const f = reportDeps(after, { edition: E, bars: barsOf(S), samples: daySamples(S, 1) });
    const r = await runFeedReport(f.deps);
    expect(r).toMatchObject({ ok: true, outcome: "built", day: S, minutes: 390, signals: "ok", bars: "ok" });
    const rep = parseReport(f.files.get(reportPath(S))!)!;
    expect(rep).toMatchObject({ v: 1, day: S, engine: ENGINE_VERSION, rules: RULES, board_feed: { sip: 390, iex: 0, refused: 0 }, samples: { minutes: 390, expected: 390, unreadable: 0, after_close: 0 } });
    expect(rep.prices.pairs).toBe(390);
    expect(rep.prices.diff_bp).toMatchObject({ median: expect.closeTo((0.1 / 500.05) * 10_000, 9), n: 390 });
    expect(rep.prices.quote_mid_diff_bp).toMatchObject({ median: expect.closeTo((0.1 / 500.05) * 10_000, 9), n: 390 });
    expect(rep.prices.trade_gap_ms).toEqual({ median: 300, p95: 300, n: 390 });
    expect(rep.prices.share_over_1bp).toBe(1);
    expect(rep.freshness.iex_trade_age_s).toMatchObject({ median: expect.closeTo(0.4, 9), n: 390 });
    expect(rep.freshness.sip_trade_age_s).toMatchObject({ median: expect.closeTo(0.5, 9), n: 390 });
    expect(rep.bars).toMatchObject({ status: "ok", aligned: 390 * SYMS.length, only_sip: 0, only_iex: 0, volume_ratio_sip_over_iex: { median: 3, n: 390 * SYMS.length } });
    expect(rep.signals).toMatchObject({ status: "ok", iex_only: 0, sip_only: 0, disagreements: [] });
    if (rep.signals.status === "ok") expect(rep.signals.identical).toBe(rep.signals.comparable);
    expect(rep.limitations.length).toBeGreaterThan(0);
    // idempotent: the next tick finds the report and changes nothing
    const before = f.files.get(reportPath(S));
    expect(await runFeedReport(f.deps)).toEqual({ ok: true, outcome: "already-built", day: S });
    expect(f.files.get(reportPath(S))).toBe(before);
    expect(f.barsCalls).toBe(1);
  });

  it("a half day expects 210 minutes, is built from 13:20, and counts samples after the close apart", async () => {
    const H = "2026-11-27";
    const early = reportDeps(Date.parse(`${H}T13:19:00-05:00`), { day: H, edition: on(H, true), bars: barsOf(H), samples: daySamples(H, 1) });
    expect(await runFeedReport(early.deps)).toEqual({ ok: true, outcome: "too-early" });
    const late = sample(Date.parse(`${H}T13:00:30-05:00`), answer(Date.parse(`${H}T13:00:31-05:00`), {}), answer(Date.parse(`${H}T13:00:31-05:00`), {}));
    const f = reportDeps(Date.parse(`${H}T15:00:00-05:00`), { day: H, edition: on(H, true), bars: barsOf(H), samples: [...daySamples(H, 1), late] });
    expect(await runFeedReport(f.deps)).toMatchObject({ outcome: "built", minutes: 210, signals: "ok" });
    expect(parseReport(f.files.get(reportPath(H))!)!.samples).toEqual({ minutes: 210, expected: 210, unreadable: 0, after_close: 1 });
  });

  it("without that session's edition the signals and the bars read no_edition, and no bars are asked for", async () => {
    for (const edition of [null, on("2026-10-09")]) {
      const f = reportDeps(after, { edition, bars: barsOf(S), samples: daySamples(S, 5) });
      expect(await runFeedReport(f.deps)).toMatchObject({ outcome: "built", signals: "no_edition", bars: "no_edition", minutes: 78 });
      const rep = parseReport(f.files.get(reportPath(S))!)!;
      expect(rep.signals).toEqual({ status: "no_edition" });
      expect(rep.bars).toEqual({ status: "no_edition" });
      expect(f.barsCalls).toBe(0);
    }
  });

  it("no focus names: no_bars with why no_focus_names; each feed failure keeps its why", async () => {
    const empty = { ...E, focus: { ...E.focus!, items: [] } } as Options;
    const f = reportDeps(after, { edition: empty });
    await runFeedReport(f.deps);
    expect(parseReport(f.files.get(reportPath(S))!)!.signals).toEqual({ status: "no_bars", why: "no_focus_names" });
    expect(f.barsCalls).toBe(0);
    const plan = reportDeps(after, { edition: E, bars: { two: { ok: false, final: true, why: "sip-plan" }, one: { ok: false, final: true, why: "sip-not-entitled" } } });
    await runFeedReport(plan.deps);
    const rep = parseReport(plan.files.get(reportPath(S))!)!;
    expect(rep.signals).toEqual({ status: "no_bars", why: "sip-plan" });
    expect(rep.bars).toEqual({ status: "no_bars", why: "sip-not-entitled" });
  });

  it("a bars failure that may heal is retried until the 23:50 tick, which builds with no_bars; nothing after 23:59 UTC", async () => {
    const heal: BarsRead = { two: barsOf(S).two, one: { ok: false, final: false, why: "time-budget" } };
    const f = reportDeps(ny(S, "17:00:00"), { edition: E, bars: heal });
    expect(await runFeedReport(f.deps)).toMatchObject({ ok: false, outcome: "retry", why: "time-budget" });
    expect(f.files.has(reportPath(S))).toBe(false);
    const last = reportDeps(Date.parse(`${S}T23:50:00Z`), { edition: E, bars: heal });
    expect(await runFeedReport(last.deps)).toMatchObject({ outcome: "built", signals: "ok", bars: "no_bars" });
    expect(parseReport(last.files.get(reportPath(S))!)!.bars).toEqual({ status: "no_bars", why: "time-budget" });
    const late = reportDeps(Date.parse(`${S}T23:59:30Z`), { edition: E, bars: barsOf(S) });
    expect(await runFeedReport(late.deps)).toMatchObject({ outcome: "built" }); // a late 23:50 fire still builds
    const past = reportDeps(Date.parse(`${S}T23:59:59.999Z`) + 1, { edition: E, bars: heal });
    expect(await runFeedReport(past.deps)).toEqual({ ok: true, outcome: "past-deadline" });
  });

  it("does nothing outside production, before close + 20 min, or on a day without a session", async () => {
    expect(await runFeedReport({ ...reportDeps(after).deps, dry: true })).toEqual({ ok: true, outcome: "not-production" });
    expect(await runFeedReport(reportDeps(ny(S, "16:19:59")).deps)).toEqual({ ok: true, outcome: "too-early" });
    expect(await runFeedReport(reportDeps(ny("2026-10-11", "17:00:00")).deps)).toEqual({ ok: true, outcome: "idle" });
  });

  it("every not-comparable symbol-minute is counted under its reason", () => {
    const at = T0;
    const good = (f: number) => answer(f, { SPY: row(500, f), QQQ: row(400, f - TRADE_STALE_MS - 5) });
    const samples = [
      sample(at, answer(at, null, 503), good(at), ["SPY", "QQQ"]),
      sample(at + 60_000, good(at + 60_000), good(at + 63_000), ["SPY", "QQQ"]),
      sample(at + 120_000, good(at + 120_000), answer(at + 120_000, { SPY: row(500, at + 120_000), QQQ: row(400, at + 120_000) }), ["SPY", "QQQ", "IWM"]),
      sample(at + 180_000, answer(at + 180_000, null, null), answer(at + 180_000, null, 500), ["SPY"]),
    ];
    const r = buildReport(input({ samples, unreadable: 2 }));
    expect(r.prices.not_comparable).toEqual({ both_failed: 1, iex_failed: 2, sip_failed: 0, apart: 2, missing_symbol: 1, bad_price: 0, stale_iex: 1, stale_sip: 0, stale_both: 0, trades_apart: 0 });
    expect(r.prices.pairs).toBe(1);
    expect(r.prices.stale_only_iex).toBe(1);
    expect(r.samples).toEqual({ minutes: 4, expected: 390, unreadable: 2, after_close: 0 });
  });
});

describe("the reader", () => {
  it("reads the newest v1 reports without the replay's disagreements and counts the bad ones; today's minutes and board feeds", async () => {
    const files = new Map<string, string>();
    const good: CompareReport = buildReport(input({ samples: daySamples(S, 30) }));
    const withSignals: CompareReport = {
      ...good,
      signals: { status: "ok", edition_as_of: null, comparable: 10, identical: 9, identical_pct: 90, events_sip: 1, events_iex: 1, matched: 1, sip_only: 0, iex_only: 0, disagreements: [{ symbol: "SPY", side: "call", slot: "1000", sip: "watch", iex: "paused" }] },
    };
    files.set(reportPath(S), JSON.stringify(withSignals));
    expect(files.get(reportPath(S))).toContain("disagreements"); // kept in the stored file
    files.set(reportPath("2026-10-09"), JSON.stringify({ ...good, day: "2026-10-09" }));
    files.set(reportPath("2026-10-08"), JSON.stringify({ ...good, v: 2, day: "2026-10-08" }));
    files.set(reportPath("2026-10-07"), "not json");
    const samples = daySamples(S, 60);
    samples[0] = { ...samples[0]!, board_feed: "iex" };
    samples[1] = { ...samples[1]!, board_feed: "refused" };
    samples.forEach((s, i) => files.set(samplePath(S, String(1000 + i)), JSON.stringify(s)));
    files.set(samplePath(S, "1100"), "{}");
    files.set(samplePath(S, "1601"), JSON.stringify(sample(ny(S, "16:01:00"), answer(ny(S, "16:01:01"), {}), answer(ny(S, "16:01:01"), {}))));
    const deps = { list: async (p: string) => [...files.keys()].filter((k) => k.startsWith(p)), readText: async (p: string) => files.get(p) ?? null };
    const all = await readCompareReports(10, deps);
    expect(all.reports.map((r) => r.day)).toEqual([S, "2026-10-09"]);
    expect(all.reports[0]!.signals).toMatchObject({ status: "ok", comparable: 10 });
    expect("disagreements" in all.reports[0]!.signals).toBe(false);
    expect(JSON.stringify(all)).not.toContain("\"disagreements\"");
    expect(all.bad).toBe(2);
    expect((await readCompareReports(1, deps)).reports.map((r) => r.day)).toEqual([S]);
    expect(await readCompareToday(S, deps)).toEqual({ minutes: samples.length, after_close: 1, unreadable: 1, board_feed: { sip: samples.length - 2, iex: 1, refused: 1 } });
  });
});

// ---- the sampler --------------------------------------------------------------------------------------------------
const KEYS = { ALPACA_API_KEY_ID: "kid", ALPACA_API_SECRET_KEY: "ksecret" };
function snapshotBody(symbols: readonly string[], p: number, t: string) {
  return Object.fromEntries(symbols.map((s) => [s, { latestTrade: { p, t }, latestQuote: { bp: p - 0.01, bs: 1, ap: p + 0.01, as: 1, t }, minuteBar: { t, o: p, h: p, l: p, c: p, v: 5, vw: p, n: 1 }, dailyBar: { v: 9 } }]));
}
function sampleDeps(now: number, o: Partial<SampleDeps> = {}) {
  const files = new Map<string, string>();
  const urls: string[] = [];
  let clock = now;
  const deps: SampleDeps = {
    now: () => (clock += 100),
    dry: false,
    env: { ...KEYS, ALPACA_FEED: "sip" },
    fetchImpl: (async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      const syms = u.searchParams.get("symbols")!.split(",");
      return new Response(JSON.stringify(snapshotBody(syms, u.searchParams.get("feed") === "sip" ? 100.01 : 100, new Date(now).toISOString())), { status: 200 });
    }) as unknown as typeof fetch,
    loadEdition: async () => E,
    exists: async (p) => files.has(p),
    write: async (p, body) => {
      if (files.has(p)) throw new PreconditionFailed();
      files.set(p, body);
    },
    ...o,
  };
  return { deps, files, urls };
}

describe("the sampler", () => {
  it("in the session: one request on iex, then one on sip, written create-only under the NY day and minute", async () => {
    const f = sampleDeps(ny(S, "10:15:20"));
    const r = await runFeedSample(f.deps);
    expect(r).toEqual({ ok: true, outcome: "written", minute: "1015", iex: 200, sip: 200 });
    expect(f.urls.map((u) => new URL(u).searchParams.get("feed"))).toEqual(["iex", "sip"]);
    expect(f.urls.every((u) => new URL(u).pathname === "/v2/stocks/snapshots" && new URL(u).host === "data.alpaca.markets")).toBe(true);
    expect(new URL(f.urls[0]!).searchParams.get("symbols")).toBe(ASKED.join(","));
    const s = parseSample(f.files.get(samplePath(S, "1015"))!)!;
    expect(s.board_feed).toBe("sip");
    expect(s.iex.started).toBeLessThan(s.iex.finished);
    expect(s.iex.finished).toBeLessThanOrEqual(s.sip.started);
    expect(Object.keys(s.sip.rows!)).toEqual(ASKED);
    expect(s.sip.rows!.SPY!.latestTrade!.p).toBe(100.01);
    expect(s.iex.rows!.SPY!.latestTrade!.p).toBe(100);
    // the stored text holds no key
    expect(f.files.get(samplePath(S, "1015"))).not.toMatch(/ksecret|kid/);
  });

  it("a second run in the same minute is a duplicate and asks nothing upstream; a lost race is a duplicate too", async () => {
    const f = sampleDeps(ny(S, "10:15:20"));
    await runFeedSample(f.deps);
    const n = f.urls.length;
    expect(await runFeedSample(f.deps)).toEqual({ ok: true, outcome: "duplicate", minute: "1015" });
    expect(f.urls.length).toBe(n);
    const race = sampleDeps(ny(S, "10:16:00"), { exists: async () => false, write: async () => Promise.reject(new PreconditionFailed()) });
    expect(await runFeedSample(race.deps)).toEqual({ ok: true, outcome: "duplicate", minute: "1016" });
  });

  it("writes nothing and asks nothing outside production, outside the session, or on a closed day", async () => {
    for (const [now, extra, want] of [
      [ny(S, "10:15:00"), { dry: true }, { ok: true, outcome: "not-production" }],
      [ny(S, "09:29:59"), {}, { ok: true, outcome: "idle", why: "outside-hours" }],
      [ny(S, "16:00:00"), {}, { ok: true, outcome: "idle", why: "outside-hours" }],
      [Date.parse("2026-11-27T13:00:00-05:00"), {}, { ok: true, outcome: "idle", why: "outside-hours" }], // half day: closed at 13:00
      [ny("2026-10-11", "11:00:00"), {}, { ok: true, outcome: "idle", why: "closed-day" }],
    ] as const) {
      const f = sampleDeps(now, extra);
      expect(await runFeedSample(f.deps)).toEqual(want);
      expect(f.files.size).toBe(0);
      expect(f.urls).toEqual([]);
    }
    const h = sampleDeps(Date.parse("2026-11-27T12:59:30-05:00"));
    expect(await runFeedSample(h.deps)).toMatchObject({ outcome: "written", minute: "1259" });
  });

  it("without keys or with a data URL off Alpaca nothing is sent; a refused ALPACA_FEED is recorded as refused", async () => {
    const nk = sampleDeps(ny(S, "10:15:00"), { env: {} });
    expect(await runFeedSample(nk.deps)).toMatchObject({ ok: false, outcome: "no-keys" });
    expect(nk.urls).toEqual([]);
    const du = sampleDeps(ny(S, "10:15:00"), { env: { ...KEYS, ALPACA_DATA_URL: "https://evil.example" } });
    expect(await runFeedSample(du.deps)).toMatchObject({ ok: false, outcome: "data-url" });
    expect(du.urls).toEqual([]);
    const rf = sampleDeps(ny(S, "10:15:00"), { env: { ...KEYS, ALPACA_FEED: "delayed_sip" } });
    await runFeedSample(rf.deps);
    expect(parseSample(rf.files.get(samplePath(S, "1015"))!)!.board_feed).toBe("refused");
    const unset = sampleDeps(ny(S, "10:15:00"), { env: KEYS });
    await runFeedSample(unset.deps);
    expect(parseSample(unset.files.get(samplePath(S, "1015"))!)!.board_feed).toBe("iex");
  });

  it("a failing feed is recorded with its status and no rows; a thrown fetch, with no status; the sampler never throws", async () => {
    const f = sampleDeps(ny(S, "10:15:00"), {
      fetchImpl: (async (url: string) => {
        if (new URL(url).searchParams.get("feed") === "sip") throw Object.assign(new Error("t"), { name: "TimeoutError" });
        return new Response("nope", { status: 403 });
      }) as unknown as typeof fetch,
      loadEdition: async () => {
        throw new Error("store down");
      },
    });
    expect(await runFeedSample(f.deps)).toEqual({ ok: true, outcome: "written", minute: "1015", iex: 403, sip: null });
    const s = parseSample(f.files.get(samplePath(S, "1015"))!)!;
    expect(s.symbols).toEqual(["SPY"]); // no edition: SPY alone
    expect(s.iex).toMatchObject({ status: 403, rows: null });
    expect(s.sip).toMatchObject({ status: null, rows: null });
    const w = sampleDeps(ny(S, "10:15:00"), { write: async () => Promise.reject(new Error("boom")) });
    expect(await runFeedSample(w.deps)).toEqual({ ok: false, outcome: "write-failed", minute: "1015" });
    const thrown = sampleDeps(ny(S, "10:15:00"), { now: () => { throw new Error("clock"); } });
    expect(await runFeedSample(thrown.deps)).toEqual({ ok: false, outcome: "error" });
  });

  it("a 400 is asked again once without any symbol that is not a ticker, and the retry's answer is kept", async () => {
    let calls = 0;
    const f = sampleDeps(ny(S, "10:15:00"), {
      fetchImpl: (async (url: string) => {
        const u = new URL(url);
        if (u.searchParams.get("feed") === "iex" && calls++ === 0) return new Response("bad symbol", { status: 400 });
        return new Response(JSON.stringify(snapshotBody(u.searchParams.get("symbols")!.split(","), 100, new Date(ny(S, "10:15:00")).toISOString())), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runFeedSample(f.deps)).toMatchObject({ outcome: "written", iex: 200, sip: 200 });
    const s = parseSample(f.files.get(samplePath(S, "1015"))!)!;
    expect(s.iex.retried).toBe(true);
    expect(s.sip.retried).toBeUndefined();
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])).outcome)).toContain("symbol-rejected");
    const odd = await askFeed("iex", ["SPY", "bad sym"], { id: "a", secret: "b" }, "https://data.alpaca.markets", {
      now: () => 0,
      fetchImpl: (async (url: string) => {
        const syms = new URL(url).searchParams.get("symbols")!;
        return syms.includes("bad") ? new Response("", { status: 400 }) : new Response(JSON.stringify(snapshotBody(["SPY"], 1, new Date(0).toISOString())), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(odd).toMatchObject({ status: 200, retried: true });
    expect(Object.keys(odd.rows!)).toEqual(["SPY"]);
  });

  it("logs spy-only when the edition is missing or another day's", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runFeedSample(sampleDeps(ny(S, "10:15:00"), { loadEdition: async () => null }).deps);
    await runFeedSample(sampleDeps(ny(S, "10:16:00"), { loadEdition: async () => on("2026-10-09") }).deps);
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((l) => l.outcome === "spy-only");
    expect(lines.map((l) => l.edition)).toEqual(["missing", "stale"]);
  });

  it("asks for the focus names only when the edition is that day's", () => {
    expect(sampleSymbols(E, S)).toEqual(ASKED);
    expect(sampleSymbols(on("2026-10-09"), S)).toEqual(["SPY"]);
    expect(sampleSymbols(null, S)).toEqual(["SPY"]);
  });

  it("leaves fetchQuotes' cache untouched", async () => {
    resetQuoteCache();
    const now = new Date(ny(S, "10:15:00"));
    let quoteCalls = 0;
    const quoteFetch = (async () => (quoteCalls++, new Response(JSON.stringify(snapshotBody(["SPY"], 42, now.toISOString())), { status: 200 }))) as unknown as typeof fetch;
    const first = await fetchQuotes(["SPY"], { id: "a", secret: "b" }, now, quoteFetch, "https://data.alpaca.markets", { feed: "sip" });
    expect(quoteCalls).toBe(1);
    const f = sampleDeps(now.getTime());
    await runFeedSample(f.deps);
    await askFeed("sip", ["SPY"], { id: "a", secret: "b" }, "https://data.alpaca.markets", f.deps);
    const again = await fetchQuotes(["SPY"], { id: "a", secret: "b" }, now, quoteFetch, "https://data.alpaca.markets", { feed: "sip" });
    expect(quoteCalls).toBe(1); // served from its own cache, unchanged by the sampler's answers (100.01, not 42)
    expect(again.quotes).toEqual(first.quotes);
    resetQuoteCache();
  });
});

describe("the routes", () => {
  for (const [name, load] of [
    ["/api/cron/feeds", () => import("@/app/api/cron/feeds/route")],
    ["/api/cron/feeds-report", () => import("@/app/api/cron/feeds-report/route")],
  ] as const)
    it(`${name} refuses without the bearer CRON_SECRET, and runs nothing outside production`, async () => {
      vi.stubEnv("CRON_SECRET", "s3cret");
      vi.stubEnv("VERCEL_ENV", "preview");
      const { GET } = await load();
      for (const auth of [null, "Bearer wrong", "s3cret", "bearer s3cret"]) {
        const res = await GET(new Request(`https://desk.example${name}`, { headers: auth ? { authorization: auth } : {} }));
        expect(res.status).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
      const ok = await GET(new Request(`https://desk.example${name}`, { headers: { authorization: "Bearer s3cret" } }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, outcome: "not-production" });
      // idempotent: a second call is the same no-op
      expect(await (await GET(new Request(`https://desk.example${name}`, { headers: { authorization: "Bearer s3cret" } }))).json()).toEqual({ ok: true, outcome: "not-production" });
      vi.stubEnv("CRON_SECRET", "");
      expect((await GET(new Request(`https://desk.example${name}`, { headers: { authorization: "Bearer " } }))).status).toBe(401);
    });
});
