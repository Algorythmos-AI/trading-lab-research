import { describe, expect, it } from "vitest";
import type { ChainResponse } from "@/lib/chain";
import { occSymbol as fixtureOcc } from "@/lib/fixture-variants";
import { fillStop } from "@/lib/manage-stop";
import {
  chainMatches,
  checkedAgeMs,
  CROSSED,
  type ContractFeed,
  type ContractQuote,
  FAILED,
  heldContract,
  type HeldLot,
  heldLines,
  heldValue,
  inOptionSession,
  judgeQuote,
  type LiveQuote,
  lotsContract,
  MAX_SPREAD_SHARE,
  NO_ASK,
  NO_BID,
  NO_QUOTE,
  NO_QUOTE_TODAY,
  NOT_OPRA,
  notAvailable,
  occSymbol,
  OFF,
  OPRA_REFUSED,
  OUTSIDE_SESSION,
  parseOccSymbol,
  QUOTE_AHEAD,
  quoteLine,
  quoteToday,
  SHOWN_AGAIN,
  ticketCheck,
  tooOld,
  tooWide,
  VALUE_MAX_AGE_MS,
  WAITING,
  ZERO_BID,
} from "@/lib/option-value";
import { OWNER_FEES } from "@/lib/owner-positions";
import { roundTripCents } from "@/lib/ticket";

// The live option value and the ticket's price check (option-value.ts): one contract named exactly, a value only on a
// fresh, sane OPRA quote in the regular session, at the bid with fees in, and every guard at its boundary.

// Answers are served at 2026-10-12T16:00:00Z, Monday 12:00 New York, a full session, unless a test says otherwise.
const OCC = "SPY261016C00660000";
const FEES = roundTripCents(OWNER_FEES);

const lot = (o: Partial<HeldLot> = {}): HeldLot => ({ symbol: "SPY", kind: "call", side: "long", strike: 660, expiry: "2026-10-16", qty: 2, entry: 1.2, ...o });
const chain = (contracts: { kind: "call" | "put"; strike: number }[], date = "2026-10-16", symbol = "SPY"): Pick<ChainResponse, "symbol" | "expiries"> => ({
  symbol,
  expiries: [
    {
      date,
      contracts: contracts.map((c) => ({ ...c, bid: 1, ask: 1.1, last: null, at: null, iv: null, delta: null, volume: null, bid_size: null, ask_size: null })),
    },
  ],
});
const quote = (o: Partial<ContractQuote> = {}): ContractQuote => ({ bid: 1.2, ask: 1.25, bid_size: 10, ask_size: 12, quote_at: "2026-10-12T15:40:00Z", last: 1.22, last_at: "2026-10-12T15:40:00Z", ...o });
/** The device's wall clock when the request went out: any value, since only differences on it count. */
const WALL = 5_000_000;
const ok = (
  q: ContractQuote | null = quote(),
  o: { feed?: "opra" | "indicative"; fallback?: "opra-refused"; sentPerf?: number; sentWall?: number; asOf?: string; servedAt?: string; fixture?: boolean } = {},
): ContractFeed => ({
  status: "ok",
  sentPerf: o.sentPerf ?? 1_000,
  sentWall: o.sentWall ?? WALL,
  answer: {
    as_of: o.asOf ?? "2026-10-12T16:00:00.000Z",
    served_at: o.servedAt ?? o.asOf ?? "2026-10-12T16:00:00.000Z",
    feed: o.feed ?? "opra",
    delay_min: o.feed === "indicative" ? 15 : 0,
    ...(o.fallback ? { fallback: o.fallback } : {}),
    contracts: q ? { [OCC]: q } : {},
    missing: q ? [] : [OCC],
    ...(o.fixture ? { fixture: true as const } : {}),
  },
});
const judge = (feed: ContractFeed, o: { perfNow?: number | null; wallNow?: number | null; shownPerf?: number | null; occ?: string } = {}) =>
  judgeQuote({
    feed,
    occ: o.occ ?? OCC,
    perfNow: o.perfNow === undefined ? 2_000 : o.perfNow,
    wallNow: o.wallNow === undefined ? WALL + 1_000 : o.wallNow,
    shownPerf: o.shownPerf ?? null,
  });
const why = (r: ReturnType<typeof judgeQuote>) => (r.ok ? "ok" : r.why);

describe("the contract's OCC symbol", () => {
  it("is built from the name, expiry, kind and strike, as the fixture builds it", () => {
    expect(occSymbol("SPY", "2026-10-16", "call", 660)).toBe(OCC);
    expect(occSymbol("QQQ", "2026-10-19", "put", 602.5)).toBe("QQQ261019P00602500");
    expect(occSymbol("BRK.B", "2026-11-20", "call", 480)).toBe("BRKB261120C00480000");
    expect(occSymbol("SPY", "2026-10-16", "put", 0.5)).toBe(fixtureOcc("SPY", "2026-10-16", "put", 0.5));
  });

  it("is none for parts that cannot make one", () => {
    for (const [s, x, k] of [
      ["spy", "2026-10-16", 660],
      ["TOOLONGX", "2026-10-16", 660],
      ["SPY1", "2026-10-16", 660],
      ["SPY", "2026-06-31", 660],
      ["SPY", "2026-13-01", 660],
      ["SPY", "16-10-2026", 660],
      ["SPY", "2026-10-16", 0],
      ["SPY", "2026-10-16", -5],
      ["SPY", "2026-10-16", 660.0005],
      ["SPY", "2026-10-16", 100_000],
      ["SPY", "2026-10-16", NaN],
    ] as const)
      expect(occSymbol(s, x, "call", k), `${s} ${x} ${k}`).toBeNull();
  });

  it("parses strictly and round-trips", () => {
    expect(parseOccSymbol(OCC)).toEqual({ root: "SPY", expiry: "2026-10-16", kind: "call", strike: 660 });
    expect(parseOccSymbol("QQQ261019P00602500")).toEqual({ root: "QQQ", expiry: "2026-10-19", kind: "put", strike: 602.5 });
    for (const bad of ["", "SPY", "spy261016C00660000", "SPY261016X00660000", "SPY261316C00660000", "SPY260631C00660000", "SPY261016C0066000", "SPY261016C000660000", "SPY1261016C00660000", "SPY261016C00000000", " SPY261016C00660000", "SPY261016C00660000,"])
      expect(parseOccSymbol(bad), bad).toBeNull();
    const p = parseOccSymbol("QQQ261019P00602500")!;
    expect(occSymbol(p.root, p.expiry, p.kind, p.strike)).toBe("QQQ261019P00602500");
  });
});

describe("which contract a position names", () => {
  it("names one contract when every lot agrees, summing the contracts and their cost", () => {
    const r = lotsContract("SPY", "call", [lot(), lot({ qty: 1, entry: 1.5 })]);
    expect(r).toEqual({ ok: true, held: { occ: OCC, expiry: "2026-10-16", strike: 660, kind: "call", qty: 3, costCents: 39_000, paidCents: 130 } });
  });

  it("names none for a hand note the journal does not show, or a lot with no strike or expiry", () => {
    expect(lotsContract("SPY", "call", [])).toEqual({ ok: false, why: "no-contract" });
    expect(lotsContract("SPY", "call", [lot({ strike: null })])).toEqual({ ok: false, why: "no-contract" });
    expect(lotsContract("SPY", "call", [lot({ expiry: undefined })])).toEqual({ ok: false, why: "no-contract" });
    expect(lotsContract("SPY", "call", [lot({ strike: 0 })])).toEqual({ ok: false, why: "no-contract" });
  });

  it("names none when the lots name two contracts, or another kind than the card's", () => {
    expect(lotsContract("SPY", "call", [lot(), lot({ strike: 661 })])).toEqual({ ok: false, why: "two-contracts" });
    expect(lotsContract("SPY", "call", [lot(), lot({ expiry: "2026-10-23" })])).toEqual({ ok: false, why: "two-contracts" });
    expect(lotsContract("SPY", "put", [lot()])).toEqual({ ok: false, why: "two-contracts" });
  });

  it("names none unless the name is itself the OCC root, letter for letter", () => {
    expect(lotsContract("BRK.B", "call", [lot({ symbol: "BRK.B" })])).toEqual({ ok: false, why: "not-exact-root" });
    expect(lotsContract("spy", "call", [lot({ symbol: "spy" })])).toEqual({ ok: false, why: "not-exact-root" });
  });

  it("names none for a lot it cannot price", () => {
    for (const bad of [{ qty: 0 }, { qty: 1.5 }, { entry: 0 }, { entry: NaN }, { side: "short" }, { symbol: "QQQ" }])
      expect(lotsContract("SPY", "call", [lot(bad)]), JSON.stringify(bad)).toEqual({ ok: false, why: "bad-lot" });
  });

  it("needs the contract listed exactly once in this name's chain", () => {
    expect(heldContract("SPY", "call", [lot()], chain([{ kind: "call", strike: 660 }]))).toMatchObject({ ok: true, held: { occ: OCC } });
    expect(heldContract("SPY", "call", [lot()], chain([{ kind: "call", strike: 661 }]))).toEqual({ ok: false, why: "not-in-chain" });
    expect(heldContract("SPY", "call", [lot()], chain([{ kind: "put", strike: 660 }]))).toEqual({ ok: false, why: "not-in-chain" });
    expect(heldContract("SPY", "call", [lot()], chain([{ kind: "call", strike: 660 }], "2026-10-23"))).toEqual({ ok: false, why: "not-in-chain" });
    expect(heldContract("SPY", "call", [lot()], chain([{ kind: "call", strike: 660 }, { kind: "call", strike: 660 }]))).toEqual({ ok: false, why: "not-in-chain" });
    expect(heldContract("SPY", "call", [lot()], chain([{ kind: "call", strike: 660 }], "2026-10-16", "QQQ"))).toEqual({ ok: false, why: "not-in-chain" });
    expect(heldContract("SPY", "call", [lot()], null)).toEqual({ ok: false, why: "not-in-chain" });
    // The lots decide first: a chain never stands in for a contract the journal does not name.
    expect(heldContract("SPY", "call", [], chain([{ kind: "call", strike: 660 }]))).toEqual({ ok: false, why: "no-contract" });
    expect(chainMatches(chain([{ kind: "call", strike: 660 }, { kind: "call", strike: 660 }]), "2026-10-16", "call", 660)).toBe(2);
  });
});

describe("how long ago the answer was checked", () => {
  it("is its time in the server's cache plus the monotonic time since it arrived, never the quote's own time", () => {
    expect(checkedAgeMs({ as_of: "2026-10-12T16:00:00Z", served_at: "2026-10-12T16:00:01.500Z" }, 1_000, 3_000)).toBe(3_500);
    expect(checkedAgeMs({ as_of: "2026-10-12T16:00:00Z" }, 1_000, 3_000)).toBe(2_000);
    // a served time before the fetch is a bad stamp: it adds nothing
    expect(checkedAgeMs({ as_of: "2026-10-12T16:00:05Z", served_at: "2026-10-12T16:00:00Z" }, 1_000, 3_000)).toBe(2_000);
    expect(checkedAgeMs({ as_of: "2026-10-12T16:00:00Z" }, null, 3_000)).toBeNull();
    expect(checkedAgeMs({ as_of: "2026-10-12T16:00:00Z" }, 1_000, null)).toBeNull();
  });

  it("does not blank a quiet contract whose quote is an hour old", () => {
    expect(judge(ok(quote({ quote_at: "2026-10-12T15:00:00Z" })))).toMatchObject({ ok: true });
  });
});

describe("the regular option session", () => {
  const at = (iso: string) => Date.parse(iso);
  it("runs from 09:30 to the close by the market calendar", () => {
    expect(inOptionSession(at("2026-10-12T13:29:59Z"))).toBe(false); // 09:29:59
    expect(inOptionSession(at("2026-10-12T13:30:00Z"))).toBe(true); // 09:30
    expect(inOptionSession(at("2026-10-12T19:59:59Z"))).toBe(true); // 15:59:59
    expect(inOptionSession(at("2026-10-12T20:00:00Z"))).toBe(false); // 16:00
  });

  it("ends at 13:00 on a half day, and is shut on a weekend or a holiday", () => {
    expect(inOptionSession(at("2026-11-27T17:59:00Z"))).toBe(true); // 12:59 EST
    expect(inOptionSession(at("2026-11-27T18:00:00Z"))).toBe(false); // 13:00
    expect(inOptionSession(at("2026-10-10T16:00:00Z"))).toBe(false); // Saturday
    expect(inOptionSession(at("2026-11-26T16:00:00Z"))).toBe(false); // Thanksgiving
    expect(inOptionSession(null)).toBe(false);
    expect(inOptionSession(NaN)).toBe(false);
  });
});

describe("whether a quote may be shown as live", () => {
  it("passes a fresh, two-sided OPRA quote in the session, in whole cents", () => {
    expect(judge(ok())).toEqual({ ok: true, q: { bidCents: 120, askCents: 125, midCents: 122.5, spreadCents: 5, checkedS: 1, sample: false } });
  });

  it("withholds while the route is off, failing, or has not answered", () => {
    expect(why(judge({ status: "off" }))).toBe(OFF);
    expect(why(judge({ status: "error" }))).toBe(FAILED);
    expect(why(judge({ status: "loading" }))).toBe(WAITING);
    expect(why(judge({ status: "idle" }))).toBe(WAITING);
    expect(why(judge(ok(), { perfNow: null }))).toBe(WAITING);
    expect(why(judge(ok(), { wallNow: null }))).toBe(WAITING);
  });

  it("withholds on the indicative feed, saying when opra was refused", () => {
    expect(why(judge(ok(quote(), { feed: "indicative" })))).toBe(NOT_OPRA);
    expect(why(judge(ok(quote(), { feed: "indicative", fallback: "opra-refused" })))).toBe(OPRA_REFUSED);
  });

  it("withholds an answer checked more than 10 s ago, and keeps one checked exactly 10 s ago", () => {
    expect(judge(ok(), { perfNow: 1_000 + VALUE_MAX_AGE_MS })).toMatchObject({ ok: true, q: { checkedS: 10 } });
    expect(why(judge(ok(), { perfNow: 1_000 + VALUE_MAX_AGE_MS + 1 }))).toBe(tooOld(10));
    // the server's cache counts too
    expect(why(judge(ok(quote(), { asOf: "2026-10-12T16:00:00Z", servedAt: "2026-10-12T16:00:02Z" }), { perfNow: 1_000 + 8_001 }))).toBe(tooOld(10));
  });

  it("blanks at once when the tab is shown again: only an answer to a request sent after it counts", () => {
    expect(why(judge(ok(quote(), { sentPerf: 1_000 }), { shownPerf: 1_500 }))).toBe(SHOWN_AGAIN);
    // sent before the tab was hidden, answered after it was shown again: still from before the gap
    expect(why(judge(ok(quote(), { sentPerf: 1_499 }), { shownPerf: 1_500, perfNow: 1_600 }))).toBe(SHOWN_AGAIN);
    expect(judge(ok(quote(), { sentPerf: 1_500 }), { shownPerf: 1_500 })).toMatchObject({ ok: true });
    expect(judge(ok(quote(), { sentPerf: 1_600 }), { shownPerf: 1_500 })).toMatchObject({ ok: true });
  });

  it("counts the time in flight: an answer to a request sent 11 s ago is old however new its arrival", () => {
    expect(why(judge(ok(quote(), { sentPerf: 1_000 }), { perfNow: 12_000 }))).toBe(tooOld(11));
  });

  it("withholds when the wall clock says more than 10 s passed, though the monotonic clock stood still (a computer asleep)", () => {
    expect(why(judge(ok(quote(), { sentPerf: 1_000 }), { perfNow: 1_000, wallNow: WALL + 3_600_000 }))).toBe(tooOld(3_600));
    expect(judge(ok(quote(), { sentPerf: 1_000 }), { perfNow: 1_000, wallNow: WALL + VALUE_MAX_AGE_MS })).toMatchObject({ ok: true });
    expect(why(judge(ok(quote(), { sentPerf: 1_000 }), { perfNow: 1_000, wallNow: WALL + VALUE_MAX_AGE_MS + 1 }))).toBe(tooOld(10));
  });

  it("judges the session on the answer's server time: the device clock hours off changes nothing", () => {
    const a = judge(ok(quote(), { sentWall: WALL }), { wallNow: WALL + 1_000 });
    const off = 7 * 3_600_000;
    expect(judge(ok(quote(), { sentWall: WALL + off }), { wallNow: WALL + off + 1_000 })).toEqual(a);
    expect(judge(ok(quote(), { sentWall: WALL - off }), { wallNow: WALL - off + 1_000 })).toEqual(a);
    expect(a).toMatchObject({ ok: true });
  });

  it("withholds an answer served outside the regular session", () => {
    expect(why(judge(ok(quote(), { asOf: "2026-10-12T20:00:00Z" })))).toBe(OUTSIDE_SESSION); // 16:00
    expect(why(judge(ok(quote(), { asOf: "2026-10-12T13:29:59Z" })))).toBe(OUTSIDE_SESSION); // 09:29:59
    expect(judge(ok(quote({ quote_at: "2026-10-12T13:30:00Z" }), { asOf: "2026-10-12T13:30:00Z" }))).toMatchObject({ ok: true }); // 09:30
  });

  it("needs a quote from today's session: a quiet one stands, yesterday's close, a missing time or one ahead does not", () => {
    // Friday's closing quote, checked at 09:30:05 on Monday
    expect(why(judge(ok(quote({ quote_at: "2026-10-09T19:59:59Z" }), { asOf: "2026-10-12T13:30:05Z" })))).toBe(NO_QUOTE_TODAY);
    // this morning's quote from before the open
    expect(why(judge(ok(quote({ quote_at: "2026-10-12T13:29:00Z" }), { asOf: "2026-10-12T13:30:05Z" })))).toBe(NO_QUOTE_TODAY);
    expect(judge(ok(quote({ quote_at: "2026-10-12T13:30:00Z" }), { asOf: "2026-10-12T13:30:05Z" }))).toMatchObject({ ok: true });
    // a quote from 09:31 checked at 11:00
    expect(judge(ok(quote({ quote_at: "2026-10-12T13:31:00Z" }), { asOf: "2026-10-12T15:00:00Z" }))).toMatchObject({ ok: true });
    expect(why(judge(ok(quote({ quote_at: null }))))).toBe(NO_QUOTE_TODAY);
    expect(why(judge(ok(quote({ quote_at: "soon" }))))).toBe(NO_QUOTE_TODAY);
    // up to 5 s ahead of the server's time is clock noise; more is not believed
    expect(judge(ok(quote({ quote_at: "2026-10-12T16:00:05Z" })))).toMatchObject({ ok: true });
    expect(why(judge(ok(quote({ quote_at: "2026-10-12T16:00:05.001Z" }))))).toBe(QUOTE_AHEAD);
    expect(quoteToday("2026-10-12T15:00:00Z", NaN)).toBe("none");
  });

  it("withholds a contract missing from the answer", () => {
    expect(why(judge(ok(null)))).toBe(NO_QUOTE);
    expect(why(judge(ok(), { occ: "SPY261016P00660000" }))).toBe(NO_QUOTE);
  });

  it("withholds one-sided, zero-bid and crossed quotes, and keeps a locked one", () => {
    expect(why(judge(ok(quote({ bid: null }))))).toBe(NO_BID);
    expect(why(judge(ok(quote({ ask: null }))))).toBe(NO_ASK);
    expect(why(judge(ok(quote({ ask: 0 }))))).toBe(NO_ASK);
    expect(why(judge(ok(quote({ bid: 0 }))))).toBe(ZERO_BID);
    expect(why(judge(ok(quote({ bid: 0.004 }))))).toBe(ZERO_BID);
    // rounded down, a bid of half a cent is no bid: never a zero spread against an ask of a cent
    expect(why(judge(ok(quote({ bid: 0.005, ask: 0.01 }))))).toBe(ZERO_BID);
    expect(why(judge(ok(quote({ bid: 1.26, ask: 1.25 }))))).toBe(CROSSED);
    expect(judge(ok(quote({ bid: 1.25, ask: 1.25 })))).toMatchObject({ ok: true, q: { spreadCents: 0 } });
  });

  it("rounds the bid down and the ask up to the cent", () => {
    expect(judge(ok(quote({ bid: 1.205, ask: 1.241 })))).toMatchObject({ ok: true, q: { bidCents: 120, askCents: 125, spreadCents: 5 } });
    // a quote of 1.5 cents both sides is 1 × 2 cents, a 67% spread, never a locked one
    expect(why(judge(ok(quote({ bid: 0.015, ask: 0.015 }))))).toBe(tooWide(67));
    expect(judge(ok(quote({ bid: 0.85, ask: 1.15 })))).toMatchObject({ ok: true, q: { bidCents: 85, askCents: 115 } });
  });

  it("withholds a spread over 30% of the mid, and keeps one at exactly 30%", () => {
    expect(MAX_SPREAD_SHARE).toBe(0.3);
    // bid 0.85, ask 1.15: spread 0.30 on a mid of 1.00 is exactly 30%
    expect(judge(ok(quote({ bid: 0.85, ask: 1.15 })))).toMatchObject({ ok: true, q: { spreadCents: 30, midCents: 100 } });
    // bid 0.85, ask 1.16: 31 on a mid of 100.5, over
    expect(why(judge(ok(quote({ bid: 0.85, ask: 1.16 }))))).toBe(tooWide(31));
  });
});

describe("what the held contracts are worth", () => {
  const held = (lotsContract("SPY", "call", [lot(), lot({ qty: 1, entry: 1.5 })]) as { ok: true; held: Parameters<typeof heldValue>[0] }).held;
  const q: LiveQuote = { bidCents: 120, askCents: 125, midCents: 122.5, spreadCents: 5, checkedS: 3, sample: false };

  it("is at the bid, the mid second, with the owner's round-trip fees taken off", () => {
    const v = heldValue(held, q, true);
    // 3 contracts at the bid ($360) less their cost ($390) less 3 × fees
    expect(v.totalCents).toBe(36_000 - 39_000 - 3 * FEES);
    expect(v.perContractCents).toBe(Math.round((36_000 - 39_000 - 3 * FEES) / 3));
    expect(v.valueCents).toBe(12_000);
    expect(v.midValueCents).toBe(12_250);
    expect(FEES).toBe(111);
  });

  it("gives the position total only while the journal is current", () => {
    expect(heldValue(held, q, false).totalCents).toBeNull();
    expect(heldLines(heldValue(held, q, false)).total).toBeNull();
    expect(heldLines(heldValue(held, q, true)).total).toBe("−$33.33 on 3 contracts");
  });

  it("measures the bid against the −25% stop on the average price paid", () => {
    const stop = fillStop({ priceCents: 130, contracts: 3 }).stopCents;
    expect(heldValue(held, q, true)).toMatchObject({ stopCents: stop, toStopCents: 120 - stop });
    expect(heldLines(heldValue(held, q, true)).stop).toBe("Bid $0.22 above the −25% stop $0.98, from your journal average $1.30");
    const under = heldValue(held, { ...q, bidCents: 98, askCents: 100, midCents: 99 }, true);
    expect(under.toStopCents).toBe(0);
    expect(heldLines(under).stop).toBe("Bid at or under the −25% stop $0.98, from your journal average $1.30");
  });

  it("has no stop line for a fill too cheap for a stop", () => {
    const cheap = (lotsContract("SPY", "call", [lot({ entry: 0.02, qty: 1 })]) as { ok: true; held: Parameters<typeof heldValue>[0] }).held;
    const v = heldValue(cheap, { bidCents: 2, askCents: 3, midCents: 2.5, spreadCents: 1, checkedS: 0, sample: false }, true);
    expect(v.stopCents).toBeNull();
    expect(heldLines(v).stop).toBeNull();
  });

  it("reads plainly", () => {
    const l = heldLines(heldValue(held, q, true));
    expect(l.value).toBe("$120.00 a contract at the bid ($122.50 at the mid)");
    expect(l.pnl).toBe("−$11.11 a contract at the bid, fees in");
    expect(quoteLine(q)).toBe("$1.20 × $1.25 · spread $0.05 · OPRA · checked 3 s ago");
    // the fixture's answer is sample data, never OPRA
    expect(quoteLine({ ...q, sample: true })).toBe("$1.20 × $1.25 · spread $0.05 · sample data · checked 3 s ago");
    expect(judge(ok(quote(), { fixture: true }))).toMatchObject({ ok: true, q: { sample: true } });
    expect(notAvailable(NOT_OPRA)).toBe("Live option value not available: the option feed here is 15 minutes behind, not OPRA.");
  });
});

describe("the ticket's price check", () => {
  const q: LiveQuote = { bidCents: 120, askCents: 125, midCents: 122.5, spreadCents: 5, checkedS: 2, sample: false };

  it("warns when the typed price is above the ask or below the bid, and not at either", () => {
    expect(ticketCheck(126, 3, 4_500, q).warn).toBe("Your price is above the ask ($1.25).");
    expect(ticketCheck(119, 3, 4_500, q).warn).toBe("Your price is below the bid ($1.20).");
    expect(ticketCheck(125, 3, 4_500, q).warn).toBeNull();
    expect(ticketCheck(120, 3, 4_500, q).warn).toBeNull();
  });

  it("costs the spread × 100 × contracts plus the round-trip fees, against the planned risk", () => {
    const c = ticketCheck(122, 3, 4_500, q);
    expect(c.costCents).toBe(5 * 100 * 3 + 3 * FEES);
    expect(c.costShare).toBeCloseTo((1_500 + 333) / 4_500, 10);
    expect(c.costLine).toBe("A round trip at this spread: $15.00 spread + $3.33 fees = $18.33 on 3 contracts, 41% of the $45.00 planned risk.");
    expect(c.line).toBe("Live OPRA quote $1.20 × $1.25 · spread $0.05 · checked 2 s ago");
    expect(ticketCheck(122, 3, 4_500, { ...q, sample: true }).line).toBe("Live quote (sample data) $1.20 × $1.25 · spread $0.05 · checked 2 s ago");
    expect(ticketCheck(122, 1, 0, q).costShare).toBeNull();
  });
});
