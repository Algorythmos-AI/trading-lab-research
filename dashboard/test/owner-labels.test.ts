// The owner's trade labels (DEC-0045 section 3, DEC-0049, EXP-0031 config.yaml `labels:`): the end-of-day replay, the
// label of each buy fill in the registered order, every no_record cause, the cautions at t0, the time-of-day rules,
// no look-ahead, determinism and the row's exact contents. Synthetic sessions and journals only: no network, no store,
// no real trade. Every expected value below is worked out by hand from the bars written here and the records.
import { describe, expect, it } from "vitest";
import { entryChecks, LEADERS } from "@/lib/entry-checks";
import { focusPlan } from "@/lib/focus-plan";
import type { Lot, Trade } from "@/lib/journal";
import { isHalfDay, type Options } from "@/lib/options";
import {
  boardFeedAt,
  cautionsAt as libCautionsAt,
  COUNTED_CAUTIONS,
  dayInputsAt,
  editionAt,
  evaluationTimes,
  EXP_0031_RULES,
  EXP_0033_RULES,
  LABEL_ROW_KEYS,
  labelFeed,
  labelPosition as libLabelPosition,
  labelRules,
  labelSession as libLabelSession,
  labelSessionBounds,
  LABELS,
  NO_RECORD_ORDER,
  replaySession as libReplaySession,
  SessionLabeller,
  sessionFills,
  stepAt,
  ZONE_EXTEND_MS,
  type BoardStamp,
  type EditionCopy,
  type LabelBar,
  type LabelEngine,
  type LabelMeta,
  type LabelPosition,
  type LabelRules,
  type Replay,
  type ReplayInput,
} from "@/lib/owner-labels";
import { BAR_MINUTES, CLOSE_GRACE_MS, FIRST_ENTRY_MIN, LUNCH_FROM_MIN, LUNCH_TO_MIN, atr2m, flatMinute, nameState, type NameState, type SideState } from "@/lib/trade-state";

/** The live engine files, passed as the injected engine (the release PR passes its frozen copy instead). */
const LIVE: LabelEngine = { nameState, focusPlan, entryChecks, atr2m, isHalfDay, LEADERS, CLOSE_GRACE_MS, BAR_MINUTES, FIRST_ENTRY_MIN, LUNCH_FROM_MIN, LUNCH_TO_MIN, flatMinute };
const R31 = EXP_0031_RULES;
const R33 = EXP_0033_RULES;

// ---- a dense synthetic session ------------------------------------------------------------------------------------
// 2026-11-12, a full Thursday on EST (UTC-5): 09:30 New York is 14:30Z, the close 16:00 is 21:00Z, 195 bars.
// 2026-11-27, the day after Thanksgiving, a half day in market-calendar.json: close 13:00, 105 bars.
const S = "2026-11-12";
const H = "2026-11-27";
const at = (hhmmss: string, day = S) => Date.parse(`${day}T${hhmmss}-05:00`);
const iso = (hhmmss: string, day = S) => new Date(at(hhmmss, day)).toISOString();
const OPEN = at("09:30:00");
const BAR = 2 * 60_000;

type OHLC = [number, number, number, number];
const bar = (k: number, [o, h, l, c]: OHLC, day = S, vol: number | null = 1000): LabelBar => {
  const start = at("09:30:00", day) + k * BAR;
  return { start, end: start + BAR, o, h, l, c, v: vol, vw: vol === null ? null : (h + l + c) / 3 };
};
const flat = (p: number): OHLC => [p, p, p, p];

/**
 * AMD: flat at 95, levels 100 (call) and 90 (put), ATR 2. The call plan: entry 100.02, stop 99.80, target 1 100.46.
 * The put plan: entry 89.98, stop 90.20, target 1 89.54. From bar `k` (default 14, 09:58 to 10:00) a break above 100,
 * a dip to 100.10 in bar k + 1 (the touch), bar k + 2 closing above the dip bar's close (the retest confirms: enter zone
 * for two slots, DEC-0052), target 1 reached by bar k + 4 (missed), and a close back at 95 (plan off). From bar `kPut`
 * (default 119, 13:28) the mirror below 90.
 */
function abcBars(k = 14, kPut: number | null = 119, day = S, n = 195): LabelBar[] {
  const path = new Map<number, OHLC>([
    [k, [95, 100.3, 95, 100.2]],
    [k + 1, [100.2, 100.3, 100.1, 100.25]],
    [k + 2, [100.25, 100.35, 100.2, 100.3]],
    [k + 3, [100.3, 100.4, 100.25, 100.3]],
    [k + 4, [100.3, 100.5, 100.25, 100.35]],
    [k + 5, [100.35, 100.35, 95, 95]],
  ]);
  if (kPut !== null) {
    path.set(kPut, [95, 95, 89.7, 89.8]);
    path.set(kPut + 1, [89.8, 89.9, 89.7, 89.75]);
    path.set(kPut + 2, [89.75, 89.8, 89.65, 89.7]);
    path.set(kPut + 3, [89.8, 89.8, 89.5, 89.8]);
    path.set(kPut + 4, [89.8, 95, 89.8, 95]);
  }
  return Array.from({ length: n }, (_, i) => bar(i, path.get(i) ?? flat(95), day));
}

/**
 * QQQ: flat at 490, levels 500 (call) and 480 (put), ATR 2. Bar `k` (default 35, 10:40 to 10:42) closes at 500.50 (a
 * break), bar k + 1 closes back at 499 (the call plan is off, and a failed break completes: a put, stop 500.80, live for
 * three bars while the price stays within one ATR of 500). Then flat at 499.
 */
function qqqBars(k = 35): LabelBar[] {
  const path = new Map<number, OHLC>([
    [k, [490, 500.8, 490, 500.5]],
    [k + 1, [500.5, 500.6, 498.8, 499]],
  ]);
  return Array.from({ length: 195 }, (_, i) => bar(i, path.get(i) ?? flat(i < k ? 490 : 499)));
}
const smhBars = (day = S, n = 195): LabelBar[] => Array.from({ length: n }, (_, i) => bar(i, flat(250), day));

type Item = NonNullable<Options["focus"]>["items"][number];
type Ticker = Options["tickers"][number];
const AMD_ITEM: Item = { symbol: "AMD", rank: 1, bias: "breakout", atr: 2, breakout_above: 100, hold_above: 90 };
const QQQ_ITEM: Item = { symbol: "QQQ", rank: 2, bias: "breakout", atr: 2, breakout_above: 500, hold_above: 480 };
const ticker = (symbol: string, halfDay = false) => ({ symbol, half_day: halfDay, levels: [], bars: [], expected_move: null });
/** An edition for `day`, built at 00:00 New York that day (before the open). */
function edition(day = S, items: Item[] = [AMD_ITEM, QQQ_ITEM], halfDay = false, tickers?: Partial<Ticker>[]): Options {
  return {
    schema: "stocksdelta/options",
    session: day,
    as_of: `${day}T05:00:00.000Z`,
    tickers: tickers ?? items.map((i) => ticker(i.symbol, halfDay)),
    focus: { items },
  } as unknown as Options;
}

/** Yesterday's range and five daily bars with the same range, so every caution can be decided. */
const daily = (hi: number, lo: number) => ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11"].map((d) => ({ d, o: lo, h: hi, l: lo, c: hi }));
const levels = (hi: number, lo: number) => [
  { name: "PDH", price: hi },
  { name: "PDL", price: lo },
];
/** AMD: PDH 110, PDL 80 (the middle third is 90 to 100); QQQ: PDH 505, PDL 440 (461.67 to 483.33). IVs given. */
function richEdition(abcIv = 0.3, qqqIv = 0.2): Options {
  return edition(S, [AMD_ITEM, QQQ_ITEM], false, [
    { symbol: "AMD", half_day: false, levels: levels(110, 80), bars: daily(110, 80), expected_move: { annual_iv: abcIv } },
    { symbol: "QQQ", half_day: false, levels: levels(505, 440), bars: daily(505, 440), expected_move: { annual_iv: qqqIv } },
  ] as unknown as Partial<Ticker>[]);
}

let seq = 0;
/** A long piece: opened and closed at New York times on `day`. */
function piece(symbol: string, kind: "call" | "put" | "stock", opened: string, closed: string, extra: Partial<Trade> = {}, day = S): Trade {
  const strike = extra.strike ?? (kind === "call" ? 102.5 : 87.5);
  return { id: `t${String(++seq).padStart(4, "0")}`, symbol, kind, strike, expiry: "2026-11-20", side: "long", qty: 1, opened_at: iso(opened, day), closed_at: iso(closed, day), entry: 1.37, exit: 1.61, multiplier: 100, pnl: 24, close: "order", ...extra };
}
const lot = (symbol: string, kind: "call" | "put", opened: string | null, extra: Partial<Lot> = {}): Lot => ({
  symbol,
  kind,
  strike: kind === "call" ? 102.5 : 87.5,
  expiry: "2026-11-20",
  side: "long",
  qty: 1,
  entry: 1.37,
  opened_at: opened === null ? null : iso(opened),
  ...extra,
});

/** A copy received at 00:00 New York on its session day (before the open). */
const copy = (e: Options, receivedAt = `${e.session}T05:00:00.000Z`): EditionCopy => ({ edition: e, receivedAt });
type In = Partial<ReplayInput> & { edition?: Options | null };
/** The replay's input; `edition` (a test shorthand) is the session's one stored copy, null for none. */
function input(over: In = {}): ReplayInput {
  const { edition: e, ...rest } = over;
  const editions = e === undefined ? [copy(edition(rest.session ?? S))] : e === null ? [] : [copy(e)];
  const session = rest.session ?? S;
  return {
    session,
    editions,
    bars: { AMD: abcBars(), QQQ: qqqBars(), SMH: smhBars() },
    requests: [{ complete: true }],
    barsFeed: "iex",
    barsFetchedAt: `${session}T21:30:00.000Z`,
    journal: { trades: [], open: [] },
    journalReadAt: `${session}T23:00:00.000Z`,
    ...rest,
    ...(rest.editions ? {} : { editions }),
  };
}

// The entry points, under EXP_0031_RULES unless a test names the rules. A "replay" here carries its labeller.
type TestReplay = Replay & { labeller: SessionLabeller };
function replaySession(inp: ReplayInput, eng: LabelEngine = LIVE, rules: LabelRules = R31): TestReplay {
  const labeller = new SessionLabeller(inp, eng, rules);
  const c = inp.editions[inp.editions.length - 1];
  const empty: Replay = { session: inp.session, bounds: labelSessionBounds(inp.session), halfDayMismatch: false, barsAvailable: inp.bars !== null, focus: [], names: {} };
  return { ...(c ? labeller.replayFor(c) : empty), labeller };
}
const labelPosition = (p: LabelPosition, r: TestReplay) => r.labeller.label(p);
const cautionsAt = (p: LabelPosition, inp: ReplayInput, eng: LabelEngine = LIVE, rules: LabelRules = R31) => libCautionsAt(p, inp, eng, rules);
function labelSession(inp: ReplayInput, eng: LabelEngine, meta: LabelMeta, rules: LabelRules = R31) {
  const run = libLabelSession(inp, eng, rules, meta);
  if (run.state !== "labelled") throw new Error(`not labelled: ${run.why}`);
  return run;
}

const META: LabelMeta = { engineVersion: "e-test" };
/** One stamp a minute over the regular session, :00 of each minute, every one reading sip and answering ok. */
const hhmm = (t: number) => {
  const m = nyTimeMin(t);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}`;
};
const nyTimeMin = (t: number) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
};
/** A stamp's key, as window.board_feed.path writes it. */
const stampKey = (t: number, day = S) => `desk/feeds/board/${day}/${hhmm(t)}.json`;
/** One stamp a minute over the regular session, :00 of each minute, every one reading sip and answering ok. */
const sipStamps = (day = S, over: (m: number) => Partial<BoardStamp> = () => ({})): BoardStamp[] =>
  Array.from({ length: 390 }, (_, m) => {
    const t = at("09:30:00", day) + m * 60_000;
    return { key: stampKey(t, day), feed: "sip" as const, answered: "ok" as const, at: new Date(t).toISOString(), deployment: "dpl_a", ...over(m) };
  });

/** The label of one fill placed alone in the journal: the replay runs with that fill's own trade. */
function labelAlone(symbol: string, kind: "call" | "put", t0: string, over: In = {}, day = S) {
  const tr = piece(symbol, kind, t0, "15:40:00", {}, day);
  const inp = input({ session: day, ...over, journal: { trades: [tr], open: [] } });
  return labelPosition({ symbol, kind, t0: tr.opened_at }, replaySession(inp, LIVE));
}
/** The one row of a journal holding one fill. */
function rowAlone(symbol: string, kind: "call" | "put", t0: string, over: In = {}) {
  const tr = piece(symbol, kind, t0, "15:40:00");
  const rows = labelSession(input({ ...over, journal: { trades: [tr], open: [] } }), LIVE, META).rows;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const without = (bars: readonly LabelBar[], ...ks: number[]) => bars.filter((b) => !ks.includes((b.start - OPEN) / BAR));

// ---- the replay itself --------------------------------------------------------------------------------------------
describe("the replay", () => {
  const r = replaySession(input(), LIVE);

  it("evaluates once per 2-minute bar at the bar's end + 5 s, 09:32:05 to 16:00:05, from evaluationTimes", () => {
    const steps = r.names.AMD!.steps;
    expect(steps).toHaveLength(195);
    expect(steps.map((s) => s.now)).toEqual(evaluationTimes(labelSessionBounds(S)!, LIVE, R31));
    expect(steps[0]!.now).toBe(at("09:32:05"));
    expect(steps.at(-1)!.now).toBe(at("16:00:05"));
    expect(steps.at(-1)!.until).toBe(Infinity);
  });

  it("gives the call side of AMD: get ready 10:00:05, enter zone 10:04:05 to 10:08:05 (two slots), missed, then plan off", () => {
    const st = (t: string) => r.names.AMD!.sides.call.find((x) => x.from <= at(t) && at(t) < x.until)!.state;
    expect(st("10:00:05")).toBe("get_ready");
    expect(st("10:02:05")).toBe("get_ready"); // touched, waiting for the confirming close
    expect(st("10:04:04")).toBe("get_ready");
    expect(st("10:04:05")).toBe("enter_zone");
    expect(st("10:08:04")).toBe("enter_zone");
    expect(st("10:08:05")).toBe("missed");
    expect(st("10:12:05")).toBe("plan_off");
  });

  it("gives the put side of AMD enter zone 13:34:05 to 13:36:05 (target 1 in the next slot)", () => {
    const st = (t: string) => r.names.AMD!.sides.put.find((x) => x.from <= at(t) && at(t) < x.until)!.state;
    expect(st("13:32:05")).toBe("get_ready");
    expect(st("13:34:05")).toBe("enter_zone");
    expect(st("13:36:04")).toBe("enter_zone");
    expect(st("13:36:05")).toBe("missed");
  });

  it("reads a side as no_trade while its row is no_trade or paused (before 09:35, lunch, after 15:10)", () => {
    const st = (t: string) => r.names.AMD!.sides.call.find((x) => x.from <= at(t) && at(t) < x.until)!.state;
    expect(stepAt(r.names.AMD!, at("09:34:00"))!.state.state).toBe("no_trade");
    expect(st("09:34:00")).toBe("no_trade");
    expect(st("12:00:00")).toBe("no_trade");
    expect(st("15:20:00")).toBe("no_trade");
  });

  it("keeps the QQQ failed break live for three evaluations, 10:44:05 to 10:50:05", () => {
    const alt = (t: string) => stepAt(r.names.QQQ!, at(t))!.state.call.alt;
    expect(alt("10:42:05")).toBeNull();
    expect(alt("10:44:05")).toMatchObject({ kind: "failed_break", side: "put", level: 500, stop: 500.8 });
    expect(alt("10:48:05")).not.toBeNull();
    expect(alt("10:50:05")).toBeNull();
  });

  it("evaluates over a slot with no bar: the evaluation is there, its bars carry the gap", () => {
    const g = replaySession(input({ bars: { AMD: without(abcBars(), 30), QQQ: qqqBars(), SMH: smhBars() } }), LIVE);
    expect(stepAt(g.names.AMD!, at("10:32:05"))).toMatchObject({ now: at("10:32:05"), bars: { complete: true, gaps: 1 } });
    // 10:31: the evaluation of 10:30:05 read bars to 10:30 only, so no gap yet (the plan is off: off_plan)
    expect(labelAlone("AMD", "call", "10:31:00", { bars: { AMD: without(abcBars(), 30), QQQ: qqqBars(), SMH: smhBars() } })).toEqual({ label: "off_plan", reason: null });
    expect(labelAlone("AMD", "call", "10:33:00", { bars: { AMD: without(abcBars(), 30), QQQ: qqqBars(), SMH: smhBars() } })).toEqual({ label: "no_record", reason: "bars_gap" });
  });
});

// ---- the labels, each by hand ---------------------------------------------------------------------------------------
describe("each label on the synthetic session", () => {
  it("in_zone at the first instant of the enter_zone interval (10:04:05.000)", () => {
    expect(labelAlone("AMD", "call", "10:04:05.000")).toEqual({ label: "in_zone", reason: null });
  });

  it("in_zone at the last instant before until + 60 s (10:09:04.999; until is 10:08:05)", () => {
    expect(ZONE_EXTEND_MS).toBe(60_000);
    expect(labelAlone("AMD", "call", "10:09:04.999")).toEqual({ label: "in_zone", reason: null });
  });

  it("not in zone exactly at until + 60 s (10:09:05.000): the side is missed then, so off_plan", () => {
    expect(labelAlone("AMD", "call", "10:09:05.000")).toEqual({ label: "off_plan", reason: null });
  });

  it("early in a get_ready interval (10:03:00), and in the grace before the next evaluation (10:04:02)", () => {
    expect(labelAlone("AMD", "call", "10:03:00")).toEqual({ label: "early", reason: null });
    expect(labelAlone("AMD", "call", "10:04:02")).toEqual({ label: "early", reason: null });
  });

  it("alt: a put on QQQ while the failed break (a put) is live; a call at the same t0 is off_plan", () => {
    expect(labelAlone("QQQ", "put", "10:45:00")).toEqual({ label: "alt", reason: null });
    expect(labelAlone("QQQ", "call", "10:45:00")).toEqual({ label: "off_plan", reason: null });
    expect(labelAlone("QQQ", "put", "10:51:00")).toEqual({ label: "off_plan", reason: null });
  });

  it("alt is masked like the side state: the same failed break formed in lunch is off_plan", () => {
    // bar 60 (11:30 to 11:32) breaks 500, bar 61 closes back at 499: the alternative completes at 11:34, in lunch
    const bars = { AMD: abcBars(), QQQ: qqqBars(60), SMH: smhBars() };
    const r = replaySession(input({ bars, journal: { trades: [] } }), LIVE);
    const s = stepAt(r.names.QQQ!, at("11:35:00"))!.state;
    expect(s.state).toBe("no_trade");
    expect(s.call.alt).toMatchObject({ kind: "failed_break", side: "put" }); // the engine has it; the board shows none
    expect(labelAlone("QQQ", "put", "11:35:00", { bars })).toEqual({ label: "off_plan", reason: null });
    expect(labelAlone("QQQ", "put", "10:45:00")).toEqual({ label: "alt", reason: null });
  });

  it("alt from a sweep and reclaim, which needs the bars' own ATR (atr2m): without it the sweep is not looked for", () => {
    // bars with a 1.00 range, then bar 20 (10:10 to 10:12) reaches 100.50 and closes at 99.90: atr2m is 1.32, a sweep
    // needs 0.33 past the level; the alternative is a put, stop 100.50, live while the price stays near 100
    const swept = Array.from({ length: 195 }, (_, i) => bar(i, i < 20 ? [95, 95.5, 94.5, 95] : i === 20 ? [95, 100.5, 95, 99.9] : [99.9, 99.95, 99.85, 99.9]));
    const bars = { AMD: swept, QQQ: qqqBars(), SMH: smhBars() };
    expect(labelAlone("AMD", "put", "10:13:00", { bars })).toEqual({ label: "alt", reason: null });
    const tr = piece("AMD", "put", "10:13:00", "10:30:00");
    const noAtr: LabelEngine = { ...LIVE, atr2m: () => null };
    const r = replaySession(input({ bars, journal: { trades: [tr] } }), noAtr);
    expect(labelPosition({ symbol: "AMD", kind: "put", t0: tr.opened_at }, r)).toEqual({ label: "off_plan", reason: null });
  });

  it("off_plan after the plan went off (10:30)", () => {
    expect(labelAlone("AMD", "call", "10:30:00")).toEqual({ label: "off_plan", reason: null });
  });

  it("not_focus for a symbol not in the edition", () => {
    expect(labelAlone("XYZ", "call", "10:05:00")).toEqual({ label: "not_focus", reason: null });
  });

  it("reads a call on the call side and a put on the put side", () => {
    expect(labelAlone("AMD", "call", "10:05:00").label).toBe("in_zone");
    expect(labelAlone("AMD", "put", "10:05:00").label).toBe("off_plan");
    expect(labelAlone("AMD", "put", "13:35:00").label).toBe("in_zone");
    expect(labelAlone("AMD", "call", "13:35:00").label).toBe("off_plan");
  });
});

describe("the day's inputs from the journal", () => {
  const mine = () => piece("AMD", "call", "10:05:00", "10:20:00");
  const label = (trades: Trade[], open: Lot[] = []) => {
    const m = trades.at(-1)!;
    return labelPosition({ symbol: "AMD", kind: "call", t0: m.opened_at }, replaySession(input({ journal: { trades, open } }), LIVE)).label;
  };

  it("five earlier entries make the board say no trade; a buy sold in two parts is one entry", () => {
    const early = ["09:36:00", "09:38:00", "09:40:00", "09:42:00", "09:44:00"].map((t, i) => piece("ZZZ", "call", t, "09:50:00", { strike: 10 + i }));
    expect(label([...early, mine()])).toBe("off_plan");
    const parts = [...early.slice(0, 3), piece("ZZZ", "call", "09:44:00", "09:50:00", { strike: 20 }), piece("ZZZ", "call", "09:44:00", "09:52:00", { strike: 20 })];
    expect(dayInputsAt({ trades: parts }, S, at("10:04:05")).dayLimitUsed).toBe(false);
    expect(label([...parts, mine()])).toBe("in_zone");
    // an open lot bought that day is a buy fill too
    const lots = [lot("ZZZ", "call", "09:46:00", { strike: 30 })];
    expect(label([...early.slice(0, 4), mine()], lots)).toBe("off_plan");
  });

  it("the day's loss: pieces closed before now summing to −$100 end the day; −$99.99 does not", () => {
    const lost = [piece("ZZZ", "call", "09:36:00", "09:40:00", { pnl: -60 }), piece("ZZZ", "put", "09:41:00", "09:50:00", { pnl: -40 })];
    expect(dayInputsAt({ trades: lost }, S, at("10:04:05"))).toEqual({ wonToday: false, dayLimitUsed: true });
    expect(label([...lost, mine()])).toBe("off_plan");
    const almost = [piece("ZZZ", "call", "09:36:00", "09:40:00", { pnl: -60 }), piece("ZZZ", "put", "09:41:00", "09:50:00", { pnl: -39.99 })];
    expect(label([...almost, mine()])).toBe("in_zone");
    // a loss closed after now does not count yet
    expect(dayInputsAt({ trades: lost }, S, at("09:45:00")).dayLimitUsed).toBe(false);
  });

  it("wonToday reaches the cautions (winner) and nothing else: nameState reads it for no state", () => {
    const won = piece("ZZZ", "call", "09:36:00", "09:38:00", { pnl: 15 });
    expect(dayInputsAt({ trades: [won] }, S, at("10:04:05")).wonToday).toBe(true);
    const tr = mine();
    const a = labelSession(input({ edition: richEdition(), journal: { trades: [tr] } }), LIVE, META).rows[0]!;
    const b = labelSession(input({ edition: richEdition(), journal: { trades: [won, tr] } }), LIVE, META).rows.find((x) => x.symbol === "AMD")!;
    expect(a).toMatchObject({ label: "in_zone", cautions: [] });
    expect(b).toMatchObject({ label: "in_zone", cautions: ["winner"] });
  });
});

// ---- every no_record cause ------------------------------------------------------------------------------------------
describe("no_record, each cause on its own", () => {
  it("the edition is missing (none, or one for another session)", () => {
    expect(labelAlone("AMD", "call", "10:05:00", { edition: null })).toEqual({ label: "no_record", reason: "edition_missing" });
    expect(labelAlone("AMD", "call", "10:05:00", { edition: edition("2026-11-11") })).toEqual({ label: "no_record", reason: "edition_missing" });
  });

  it("the edition was published after t0; t0 equal to its as_of is allowed", () => {
    const e = { ...edition(), as_of: iso("10:05:00") } as Options;
    expect(labelAlone("AMD", "call", "10:04:59.999", { edition: e })).toEqual({ label: "no_record", reason: "edition_after_t0" });
    expect(labelAlone("AMD", "call", "10:05:00.000", { edition: e })).toEqual({ label: "in_zone", reason: null });
    expect(labelAlone("AMD", "call", "10:05:00", { edition: { ...edition(), as_of: null } as Options })).toEqual({ label: "no_record", reason: "edition_time_unknown" });
  });

  it("the calendar and the edition disagree on a half day: every row of the session, focus or not", () => {
    const e = edition(S, [AMD_ITEM, QQQ_ITEM], true);
    expect(labelAlone("AMD", "call", "10:05:00", { edition: e })).toEqual({ label: "no_record", reason: "half_day_mismatch" });
    expect(labelAlone("XYZ", "call", "10:05:00", { edition: e })).toEqual({ label: "no_record", reason: "half_day_mismatch" });
    const half = { AMD: abcBars(15, null, H, 105), QQQ: [], SMH: [] };
    expect(labelAlone("AMD", "call", "10:05:00", { edition: edition(H), bars: half }, H)).toEqual({ label: "no_record", reason: "half_day_mismatch" });
  });

  it("the session's bars could not be had (DEC-0049 point 1)", () => {
    expect(labelAlone("AMD", "call", "10:05:00", { bars: null })).toEqual({ label: "no_record", reason: "bars_unavailable" });
  });

  it("the symbol's bars start after the open", () => {
    const bars = { AMD: without(abcBars(), 0), QQQ: qqqBars(), SMH: smhBars() };
    expect(labelAlone("AMD", "call", "10:05:00", { bars })).toEqual({ label: "no_record", reason: "bars_start_late" });
  });

  it("a gap before t0 (bar 10, 09:50 to 09:52)", () => {
    const bars = { AMD: without(abcBars(), 10), QQQ: qqqBars(), SMH: smhBars() };
    expect(labelAlone("AMD", "call", "10:05:00", { bars })).toEqual({ label: "no_record", reason: "bars_gap" });
  });

  it("a gap after the bar holding t0 does not cause it, nor does a missing bar holding t0 itself", () => {
    const bars = { AMD: without(abcBars(), 30), QQQ: qqqBars(), SMH: smhBars() };
    expect(labelAlone("AMD", "call", "10:05:00", { bars })).toEqual({ label: "in_zone", reason: null });
    const bars2 = { AMD: without(abcBars(), 17), QQQ: qqqBars(), SMH: smhBars() };
    expect(labelAlone("AMD", "call", "10:05:00", { bars: bars2 })).toEqual({ label: "in_zone", reason: null });
  });

  it("SMH's bars incomplete when the leader check needs them (QQQ), and not otherwise (AMD)", () => {
    const gap = { AMD: abcBars(), QQQ: qqqBars(), SMH: without(smhBars(), 5) };
    expect(labelAlone("QQQ", "put", "10:45:00", { bars: gap })).toEqual({ label: "no_record", reason: "leader_bars_gap" });
    expect(labelAlone("AMD", "call", "10:05:00", { bars: gap })).toEqual({ label: "in_zone", reason: null });
    const late = { AMD: abcBars(), QQQ: qqqBars(), SMH: without(smhBars(), 0) };
    expect(labelAlone("QQQ", "put", "10:45:00", { bars: late })).toEqual({ label: "no_record", reason: "leader_bars_start_late" });
  });

  it("the side carries brokeEarlier at t0 (the session opened above a call level of 94)", () => {
    const e = edition(S, [{ ...AMD_ITEM, breakout_above: 94 }, QQQ_ITEM]);
    expect(labelAlone("AMD", "call", "09:50:00", { edition: e })).toEqual({ label: "no_record", reason: "side_broke_earlier" });
  });

  it("the side carries gap at t0 (an engine whose side says gap: unreachable with complete bars, so stubbed)", () => {
    const eng: LabelEngine = { ...LIVE, nameState: (n) => script(n.now.getTime(), nameState(n), { [at("10:04:05")]: { call: { gap: true } } }) };
    const tr = piece("AMD", "call", "10:05:00", "10:20:00");
    const r = replaySession(input({ journal: { trades: [tr] } }), eng);
    expect(labelPosition({ symbol: "AMD", kind: "call", t0: tr.opened_at }, r)).toEqual({ label: "no_record", reason: "side_gap" });
  });

  it("not a session in the calendar (a Saturday)", () => {
    expect(labelAlone("AMD", "call", "10:05:00", { edition: edition("2026-11-14") }, "2026-11-14")).toEqual({ label: "no_record", reason: "not_a_session" });
  });
});

/** The live NameState with chosen fields of a side replaced at chosen evaluations; the row is kept live (watch). */
function script(now: number, live: NameState, plan: Record<number, Partial<Record<"call" | "put", Partial<SideState>>> & { row?: NameState["state"] }>): NameState {
  const p = plan[now];
  if (!p) return live;
  const { row, ...sides } = p as { row?: NameState["state"]; call?: Partial<SideState>; put?: Partial<SideState> };
  return { ...live, state: row ?? "watch", call: { ...live.call, ...(sides.call ?? {}) }, put: { ...live.put, ...(sides.put ?? {}) } };
}
const ALT_CALL = { kind: "failed_break" as const, side: "call" as const, level: 90, stop: 89.5, entry: 90.5, at: at("10:20:00") };

// ---- the order ------------------------------------------------------------------------------------------------------
describe("the registered order: a fill satisfying two labels gets the earlier", () => {
  it("is the records' order", () => {
    expect(LABELS).toEqual(["no_record", "not_focus", "in_zone", "early", "alt", "off_plan"]);
  });

  it("no_record before not_focus: a non-focus symbol on a session with no edition", () => {
    expect(labelAlone("XYZ", "call", "10:05:00", { edition: null })).toEqual({ label: "no_record", reason: "edition_missing" });
  });

  it("no_record before in_zone: a gap before a t0 that is otherwise in zone", () => {
    const bars = { AMD: without(abcBars(), 10), QQQ: qqqBars(), SMH: smhBars() };
    expect(labelAlone("AMD", "call", "10:05:00", { bars }).label).toBe("no_record");
  });

  it("not_focus before in_zone: AMD dropped from the focus items, its bars and ticker kept", () => {
    const e = edition(S, [AMD_ITEM, QQQ_ITEM]);
    (e.focus as { items: Item[] }).items = [QQQ_ITEM];
    expect(labelAlone("AMD", "call", "10:05:00", { edition: e })).toEqual({ label: "not_focus", reason: null });
  });

  it("in_zone before early: t0 in an enter_zone's 60 s extension and in the get_ready interval after it", () => {
    const eng: LabelEngine = {
      ...LIVE,
      nameState: (n) => script(n.now.getTime(), nameState(n), { [at("10:20:05")]: { call: { state: "enter_zone" } }, [at("10:22:05")]: { call: { state: "get_ready" } } }),
    };
    const tr = piece("AMD", "call", "10:22:30", "10:40:00");
    const r = replaySession(input({ journal: { trades: [tr] } }), eng);
    expect(labelPosition({ symbol: "AMD", kind: "call", t0: tr.opened_at }, r).label).toBe("in_zone");
    expect(labelPosition({ symbol: "AMD", kind: "call", t0: iso("10:23:05.000") }, r).label).toBe("early");
  });

  it("early before alt: t0 in a get_ready interval with an alternative of its own kind live", () => {
    const eng: LabelEngine = { ...LIVE, nameState: (n) => script(n.now.getTime(), nameState(n), { [at("10:22:05")]: { call: { state: "get_ready" }, put: { alt: ALT_CALL } } }) };
    const tr = piece("AMD", "call", "10:23:00", "10:40:00");
    const r = replaySession(input({ journal: { trades: [tr] } }), eng);
    expect(labelPosition({ symbol: "AMD", kind: "call", t0: tr.opened_at }, r).label).toBe("early");
  });

  it("alt before off_plan: the QQQ failed break (real bars, above)", () => {
    expect(labelAlone("QQQ", "put", "10:45:00").label).toBe("alt");
  });
});

// ---- the clock ------------------------------------------------------------------------------------------------------
describe("t0 at the edges of the day", () => {
  it("before the first evaluation (09:31): no state holds t0, so off_plan (\"off_plan: none of the above\")", () => {
    expect(labelAlone("AMD", "call", "09:31:00")).toEqual({ label: "off_plan", reason: null });
  });

  it("before the first evaluation the edition checks still come first", () => {
    expect(labelAlone("AMD", "call", "09:31:00", { edition: null })).toEqual({ label: "no_record", reason: "edition_missing" });
    expect(labelAlone("AMD", "call", "09:31:00", { edition: edition("2026-11-11") })).toEqual({ label: "no_record", reason: "edition_missing" });
    expect(labelAlone("AMD", "call", "09:31:00", { edition: { ...edition(), as_of: iso("09:31:30") } as Options })).toEqual({ label: "no_record", reason: "edition_after_t0" });
  });

  it("before 09:35 (09:34): the row is no_trade, so the side is no_trade (labels.side_state), so off_plan", () => {
    expect(labelAlone("AMD", "call", "09:34:00")).toEqual({ label: "off_plan", reason: null });
  });

  it("grid consequence: a t0 at 09:35:30 after a breakout in the first minutes is off_plan (no evaluation at 09:35:00)", () => {
    // The session's first bar cannot carry a break (the engine needs the close before it), so the break is in bar 1
    // (09:32 to 09:34) and the dip that holds in bar 2 (09:34 to 09:36). The evaluation at 09:34:05 is before 09:35, so
    // its row is no_trade, and it holds until 09:36:05: at 09:35:30 the label is off_plan; from 09:36:05, early (the dip
    // touched; DEC-0052's retest cannot confirm before the 2-minute ATR has its 15 bars, about 10:00).
    const bars = { AMD: abcBars(1, null), QQQ: qqqBars(), SMH: smhBars() };
    const times = evaluationTimes(labelSessionBounds(S)!, LIVE, R31);
    expect(times.slice(0, 3)).toEqual([at("09:32:05"), at("09:34:05"), at("09:36:05")]);
    expect(times).not.toContain(at("09:35:00"));
    expect(labelAlone("AMD", "call", "09:35:30", { bars })).toEqual({ label: "off_plan", reason: null });
    expect(labelAlone("AMD", "call", "09:36:05", { bars })).toEqual({ label: "early", reason: null });
  });

  it("in lunch on a full day: the same break at 11:40 that is in zone on a half day is off_plan (side_state)", () => {
    // the retest confirms at the 11:46 close: in zone from 11:46:05 on the half day
    const bars = { AMD: abcBars(65, null), QQQ: qqqBars(), SMH: smhBars() };
    expect(labelAlone("AMD", "call", "11:47:00", { bars })).toEqual({ label: "off_plan", reason: null });
    const half = { AMD: abcBars(65, null, H, 105), QQQ: Array.from({ length: 105 }, (_, i) => bar(i, flat(490), H)), SMH: smhBars(H, 105) };
    expect(labelSessionBounds(H)).toMatchObject({ halfDay: true, close: at("13:00:00", H) });
    expect(labelAlone("AMD", "call", "11:47:00", { bars: half, edition: edition(H, [AMD_ITEM, QQQ_ITEM], true) }, H)).toEqual({ label: "in_zone", reason: null });
  });

  it("after 15:10 on a full day, and after 12:10 on a half day: no_trade rows, so off_plan", () => {
    expect(labelAlone("AMD", "call", "15:20:00")).toEqual({ label: "off_plan", reason: null });
    const half = { AMD: abcBars(82, null, H, 105), QQQ: Array.from({ length: 105 }, (_, i) => bar(i, flat(490), H)), SMH: smhBars(H, 105) };
    expect(labelAlone("AMD", "call", "12:20:00", { bars: half, edition: edition(H, [AMD_ITEM, QQQ_ITEM], true) }, H)).toEqual({ label: "off_plan", reason: null });
  });

  it("a half day's replay ends at 13:00:05 and reads its completeness against the 13:00 close", () => {
    const half = { AMD: abcBars(65, null, H, 105), QQQ: Array.from({ length: 105 }, (_, i) => bar(i, flat(490), H)), SMH: smhBars(H, 105) };
    const r = replaySession(input({ session: H, edition: edition(H, [AMD_ITEM, QQQ_ITEM], true), bars: half }), LIVE);
    expect(r.names.AMD!.steps).toHaveLength(105);
    expect(r.names.AMD!.steps.at(-1)!.now).toBe(at("13:00:05", H));
    expect(r.names.AMD!.steps.at(-1)!.bars).toEqual({ complete: true, gaps: 0 });
  });

  it("refuses a fill whose t0 is not on the replay's day", () => {
    const r = replaySession(input(), LIVE);
    expect(() => labelPosition({ symbol: "AMD", kind: "call", t0: iso("10:05:00", "2026-11-13") }, r)).toThrow(RangeError);
  });
});

// ---- one row per buy fill -------------------------------------------------------------------------------------------
describe("one row per buy fill, keyed by contract and t0", () => {
  const rows = (trades: Trade[], open: Lot[] = []) => labelSession(input({ journal: { trades, open } }), LIVE, META);
  const keys = (r: ReturnType<typeof rows>) => r.rows.map((x) => [x.symbol, x.kind, x.strike, x.t0, x.label]);

  it("a lot bought at 10:05 and still held: one row on its session", () => {
    expect(keys(rows([], [lot("AMD", "call", "10:05:00")]))).toEqual([["AMD", "call", 102.5, iso("10:05:00"), "in_zone"]]);
  });

  it("buy A at 10:00 still held and buy B at 14:00 sold at 14:30, one contract: two rows, 10:00 and 14:00", () => {
    const r = rows([piece("AMD", "call", "14:00:00", "14:30:00")], [lot("AMD", "call", "10:00:00")]);
    expect(keys(r)).toEqual([
      ["AMD", "call", 102.5, iso("10:00:00"), "off_plan"],
      ["AMD", "call", 102.5, iso("14:00:00"), "off_plan"],
    ]);
  });

  it("a buy sold in parts is one row, and so is one partly sold and partly held", () => {
    const sold = [piece("AMD", "call", "10:05:00", "10:20:00"), piece("AMD", "call", "10:05:00", "10:30:00")];
    expect(keys(rows(sold))).toEqual([["AMD", "call", 102.5, iso("10:05:00"), "in_zone"]]);
    expect(keys(rows(sold.slice(0, 1), [lot("AMD", "call", "10:05:00")]))).toHaveLength(1);
  });

  it("two buys at different times are two rows", () => {
    const r = rows([piece("AMD", "put", "10:03:00", "10:04:30"), piece("AMD", "put", "13:35:00", "13:50:00")]);
    expect(keys(r)).toEqual([
      ["AMD", "put", 87.5, iso("10:03:00"), "off_plan"],
      ["AMD", "put", 87.5, iso("13:35:00"), "in_zone"],
    ]);
  });

  it("a short piece and a stock piece have no row", () => {
    expect(rows([piece("AMD", "call", "10:05:00", "10:20:00", { side: "short" }), piece("AMD", "stock", "10:05:00", "10:20:00", { strike: null, multiplier: 1 })]).rows).toEqual([]);
  });

  it("a lot with no opened_at has no row and is counted; a fill of another day has none", () => {
    const r = rows([piece("AMD", "call", "10:05:00", "10:20:00", {}, "2026-11-13")], [lot("AMD", "call", null), lot("AMD", "put", "10:05:00", { side: "short" })]);
    expect(r).toEqual({ state: "labelled", rows: [], summary: { fills: 0, lotsWithoutTime: 1 } });
  });

  it("a fill the verdict will later leave out (cost 0, a gap day) still gets a row", () => {
    const zero = piece("AMD", "call", "10:05:00", "10:20:00", { entry: 0, pnl: 161 });
    const r = labelSession(input({ journal: { trades: [zero], open: [], gaps: [{ date: S, kind: "close-without-open", symbol: "AMD" }] } as ReplayInput["journal"] }), LIVE, META);
    expect(r.rows.map((x) => x.label)).toEqual(["in_zone"]);
    expect(sessionFills({ trades: [zero] }, S).fills).toHaveLength(1);
  });
});

// ---- the cautions at t0 ---------------------------------------------------------------------------------------------
describe("the cautions at t0 (HYP-0049), in the row", () => {
  it("counts exactly the record's checks", () => {
    expect(COUNTED_CAUTIONS).toEqual(["range", "gap", "leader", "iv", "late", "winner"]);
  });

  it("two known cautions: a put in zone at 13:35 on a name with IV 90% (iv, late), sorted", () => {
    expect(rowAlone("AMD", "put", "13:35:00", { edition: richEdition(0.9) })).toMatchObject({ label: "in_zone", cautions: ["iv", "late"], unknown: 0 });
  });

  it("none: a call in zone at 10:05, every check decided", () => {
    expect(rowAlone("AMD", "call", "10:05:00", { edition: richEdition() })).toMatchObject({ label: "in_zone", cautions: [], unknown: 0 });
  });

  it("an unknown leader check: SMH bars without volume (QQQ, alt at 10:45)", () => {
    const novol = { AMD: abcBars(), QQQ: qqqBars(), SMH: smhBars().map((b) => ({ ...b, v: null })) };
    expect(rowAlone("QQQ", "put", "10:45:00", { edition: richEdition(), bars: novol })).toMatchObject({ label: "alt", cautions: [], unknown: 1 });
    expect(rowAlone("QQQ", "put", "10:45:00", { edition: richEdition() })).toMatchObject({ label: "alt", cautions: [], unknown: 0 });
  });

  it("are null on a no_record or not_focus row", () => {
    expect(rowAlone("XYZ", "call", "10:05:00")).toMatchObject({ label: "not_focus", cautions: null, unknown: null });
    expect(rowAlone("AMD", "call", "10:05:00", { edition: null })).toMatchObject({ label: "no_record", cautions: null, unknown: null });
  });

  it("never include the desk-only before10 caution", () => {
    const c = cautionsAt({ symbol: "AMD", kind: "call", t0: iso("09:40:00") }, input({ edition: richEdition() }), LIVE)!;
    expect(c.cautions).not.toContain("before10" as never);
  });
});

// ---- no look-ahead --------------------------------------------------------------------------------------------------
/** mulberry32, the experiment's own portable generator, for a reproducible property test. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

describe("no look-ahead", () => {
  it.each([
    ["EXP_0031_RULES", R31],
    ["EXP_0033_RULES", R33],
  ] as const)("under %s, changing or deleting any bar that ends after t0's evaluation never changes the label, nor after t0 the cautions", (_name, rules) => {
    const rand = rng(20261112);
    const base = input({ edition: richEdition(0.5), stamps: sipStamps() });
    const baseReplay = replaySession(base, LIVE, rules);
    const windows: [string, string][] = [
      ["10:00:00", "10:14:00"],
      ["10:40:00", "10:52:00"],
      ["13:28:00", "13:42:00"],
    ];
    const positions: LabelPosition[] = Array.from({ length: 240 }, (_, i) => {
      const [from, to] = i % 3 === 0 ? (["09:30:00", "16:00:00"] as const) : windows[i % windows.length]!;
      const t = at(from) + Math.floor(rand() * (at(to) - at(from)));
      return { symbol: rand() < 0.5 ? "AMD" : "QQQ", kind: rand() < 0.5 ? "call" : "put", t0: new Date(t).toISOString() };
    });
    const baseLabels = positions.map((p) => labelPosition(p, baseReplay));
    const baseCautions = positions.map((p) => cautionsAt(p, base, LIVE, rules));
    expect(new Set(baseLabels.map((l) => l.label)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(baseCautions.map((c) => JSON.stringify(c))).size).toBeGreaterThanOrEqual(2);
    const evalOf = (p: LabelPosition) => stepAt(baseReplay.names[p.symbol]!, Date.parse(p.t0))?.now ?? -Infinity;
    let labels = 0;
    let cautions = 0;
    for (let trial = 0; trial < 24; trial++) {
      const cut = baseReplay.names.AMD!.steps[Math.floor(rand() * 195)]!.now + Math.floor(rand() * BAR);
      const mutate = (bars: readonly LabelBar[]) =>
        bars.flatMap((b) => {
          if (b.end <= cut) return [b];
          const u = rand();
          if (u < 0.3) return [];
          if (u < 0.7) {
            const m = 1 + (rand() - 0.5) * 0.2;
            return [{ ...b, o: b.o * m, h: Math.max(b.o, b.c) * m * 1.01, l: Math.min(b.o, b.c) * m * 0.99, c: b.c * m * (1 + (rand() - 0.5) * 0.01), v: rand() < 0.2 ? null : b.v }];
          }
          return [b];
        });
      const changedInput = { ...base, bars: { AMD: mutate(base.bars!.AMD!), QQQ: mutate(base.bars!.QQQ!), SMH: mutate(base.bars!.SMH!) } };
      const changed = replaySession(changedInput, LIVE, rules);
      positions.forEach((p, i) => {
        const why = `${p.symbol} ${p.kind} ${p.t0} cut ${new Date(cut).toISOString()}`;
        if (evalOf(p) <= cut) {
          labels++;
          expect(labelPosition(p, changed), why).toEqual(baseLabels[i]);
        }
        if (Date.parse(p.t0) <= cut) {
          cautions++;
          expect(cautionsAt(p, changedInput, LIVE, rules), why).toEqual(baseCautions[i]);
        }
      });
    }
    expect(labels).toBeGreaterThan(1000);
    expect(cautions).toBeGreaterThan(1000);
  }, 60_000);
});

// ---- the row --------------------------------------------------------------------------------------------------------
describe("the label row", () => {
  const trades = [
    piece("AMD", "call", "10:05:00", "10:20:00", { entry: 1.37, exit: 1.61, pnl: 24 }),
    piece("QQQ", "put", "10:45:00", "11:00:00", { strike: 475, entry: 2.13, exit: 1.79, pnl: -34 }),
    piece("XYZ", "call", "13:00:00", "13:10:00", { strike: 33, entry: 0.71, exit: 0.93, pnl: 22 }),
  ];
  const meta: LabelMeta = { engineVersion: "e-0123456789ab" };
  const run = (rules: LabelRules = R31) => labelSession(input({ edition: richEdition(), journal: { trades }, stamps: sipStamps(), barsFeed: rules.feed, barsFetchedAt: "2026-11-12T21:45:00.000Z" }), LIVE, meta, rules).rows;

  it("replaying twice gives identical rows", () => {
    const a = run();
    const b = run();
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("holds exactly these keys", () => {
    const rows = run();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(Object.keys(r)).toEqual([...LABEL_ROW_KEYS]);
    expect([...LABEL_ROW_KEYS]).toEqual(["format", "experiment", "symbol", "kind", "strike", "expiry", "t0", "session", "label", "reason", "cautions", "unknown", "edition_copy_received_at", "covering_stamp_key", "feed", "engine_version", "bars_fetched_at"]);
    expect(rows[0]).toEqual({
      format: 1,
      experiment: "EXP-0031",
      symbol: "AMD",
      kind: "call",
      strike: 102.5,
      expiry: "2026-11-20",
      t0: "2026-11-12T15:05:00.000Z",
      session: S,
      label: "in_zone",
      reason: null,
      cautions: [],
      unknown: 0,
      edition_copy_received_at: "2026-11-12T05:00:00.000Z",
      covering_stamp_key: null,
      feed: "iex",
      engine_version: "e-0123456789ab",
      bars_fetched_at: "2026-11-12T21:45:00.000Z",
    });
  });

  it("holds no R, P&L, price or level: no value of a row is any of them (strike and expiry are identity)", () => {
    const rows = run();
    const forbidden = new Set<number>();
    for (const list of Object.values(input().bars!)) for (const b of list) for (const v of [b.o, b.h, b.l, b.c, b.v, b.vw]) if (typeof v === "number") forbidden.add(v);
    for (const it of [AMD_ITEM, QQQ_ITEM]) {
      const p = focusPlan(it);
      for (const sp of [p.call, p.put]) for (const v of [sp?.level, sp?.entry, sp?.stop, sp?.target1]) if (typeof v === "number") forbidden.add(v);
      forbidden.add(it.atr!);
    }
    for (const v of [110, 80, 505, 440, 0.3, 0.2]) forbidden.add(v);
    for (const t of trades) {
      const cost = t.entry * t.multiplier * t.qty;
      const net = t.pnl - 1.11;
      for (const v of [t.entry, t.exit, t.pnl, cost, net, net / (0.25 * cost), net / 50, t.pnl / (0.25 * cost), t.pnl / 50]) forbidden.add(v);
    }
    for (const r of rows)
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === "number") {
          expect(["format", "strike", "unknown"]).toContain(k);
          if (k === "strike") expect(forbidden.has(v), `${k} = ${v}`).toBe(false);
        }
        if (typeof v === "string") for (const f of forbidden) expect(v === String(f) || v === f.toFixed(2), `${k} = ${v}`).toBe(false);
        if (Array.isArray(v)) for (const id of v) expect(COUNTED_CAUTIONS).toContain(id);
      }
  });

  it("under EXP-0033 carries the copy's receipt time and the key of the stamp that covered t0", () => {
    const rows = run(R33);
    expect(rows.map((r) => [r.symbol, r.edition_copy_received_at, r.covering_stamp_key])).toEqual([
      ["AMD", "2026-11-12T05:00:00.000Z", "desk/feeds/board/2026-11-12/1005.json"],
      ["QQQ", "2026-11-12T05:00:00.000Z", "desk/feeds/board/2026-11-12/1045.json"],
      ["XYZ", "2026-11-12T05:00:00.000Z", "desk/feeds/board/2026-11-12/1300.json"],
    ]);
  });

  it("stamps the experiment and the feed of its rules, whatever the site's feed setting says", () => {
    const before = process.env.ALPACA_FEED;
    process.env.ALPACA_FEED = "sip";
    try {
      expect(run().every((r) => r.feed === "iex" && r.experiment === "EXP-0031")).toBe(true);
      process.env.ALPACA_FEED = "iex";
      expect(run(R33).every((r) => r.feed === "sip" && r.experiment === "EXP-0033")).toBe(true);
    } finally {
      if (before === undefined) delete process.env.ALPACA_FEED;
      else process.env.ALPACA_FEED = before;
    }
    expect(() => labelFeed("opra")).toThrow(TypeError);
  });
});

// ---- EXP-0033's rules ---------------------------------------------------------------------------------------------
/** A fill alone in the journal, labelled under `rules`, with sip stamps over the whole session by default. */
function labelUnder(rules: LabelRules, symbol: string, kind: "call" | "put", t0: string, over: In = {}) {
  const tr = piece(symbol, kind, t0, "15:40:00");
  const inp = input({ stamps: sipStamps(), ...over, journal: { trades: [tr], open: [] } });
  return new SessionLabeller(inp, LIVE, rules).label({ symbol, kind, t0: tr.opened_at });
}
const nyCopy = (e: Options, hhmm: string) => copy(e, iso(hhmm));

describe("the rules objects", () => {
  it("are frozen, and only they are accepted by every entry point", () => {
    expect(Object.isFrozen(R31) && Object.isFrozen(R33)).toBe(true);
    expect(R31).toEqual({ experiment: "EXP-0031", feed: "iex", extraInstants: "none", edition: "stored", barsMissing: "no_record", boardFeed: "none" });
    expect(R33).toEqual({ experiment: "EXP-0033", feed: "sip", extraInstants: "board_boundaries", edition: "received_by_t0", barsMissing: "retry", boardFeed: "stamps" });
    const inp = input();
    const pos = { symbol: "AMD", kind: "call" as const, t0: iso("10:05:00") };
    for (const bad of [undefined, null, {}, { ...R31 }, { ...R33 }] as unknown as LabelRules[]) {
      expect(() => labelRules(bad)).toThrow(TypeError);
      expect(() => evaluationTimes(labelSessionBounds(S)!, LIVE, bad)).toThrow(TypeError);
      expect(() => editionAt(inp, at("10:05:00"), bad)).toThrow(TypeError);
      expect(() => libReplaySession(inp, inp.editions[0]!, LIVE, bad)).toThrow(TypeError);
      expect(() => new SessionLabeller(inp, LIVE, bad)).toThrow(TypeError);
      expect(() => libLabelPosition(pos, inp, LIVE, bad)).toThrow(TypeError);
      expect(() => libCautionsAt(pos, inp, LIVE, bad)).toThrow(TypeError);
      expect(() => libLabelSession(inp, LIVE, bad, META)).toThrow(TypeError);
    }
  });
});

describe("EXP-0033: the extra instants", () => {
  it("are 09:35:00, 11:30:00, 13:00:00 and 15:10:00 beside the grid on a full day, from the engine's boundary constants", () => {
    const t = evaluationTimes(labelSessionBounds(S)!, LIVE, R33);
    const grid = evaluationTimes(labelSessionBounds(S)!, LIVE, R31);
    expect(t.filter((x) => !grid.includes(x))).toEqual([at("09:35:00"), at("11:30:00"), at("13:00:00"), at("15:10:00")]);
    expect(t).toHaveLength(195 + 4);
    expect(t.indexOf(at("09:35:00"))).toBe(t.indexOf(at("09:34:05")) + 1);
    expect(evaluationTimes(labelSessionBounds(S)!, LIVE, R31)).not.toContain(at("09:35:00"));
  });

  it("on a half day are 09:35:00, 11:30:00 and 12:10:00 (the half day's flat minute); 13:00:00 is the close", () => {
    const t = evaluationTimes(labelSessionBounds(H)!, LIVE, R33);
    const grid = evaluationTimes(labelSessionBounds(H)!, LIVE, R31);
    expect(t.filter((x) => !grid.includes(x))).toEqual([at("09:35:00", H), at("11:30:00", H), at("12:10:00", H)]);
    expect(t).toHaveLength(105 + 3);
  });

  it("just after 12:10:00 on a half day: a get_ready from 12:08:05 is early under EXP-0031 and off_plan (flat) under EXP-0033", () => {
    // bar 78 (12:06 to 12:08) breaks 100; the half day's flat minute is 12:10 (50 minutes before the 13:00 close)
    const half = { AMD: abcBars(78, null, H, 105), QQQ: Array.from({ length: 105 }, (_, i) => bar(i, flat(490), H)), SMH: smhBars(H, 105) };
    const go = (rules: LabelRules) => {
      const tr = piece("AMD", "call", "12:10:02", "12:40:00", {}, H);
      const inp = input({ session: H, edition: edition(H, [AMD_ITEM, QQQ_ITEM], true), bars: half, stamps: sipStamps(H), journal: { trades: [tr] } });
      return new SessionLabeller(inp, LIVE, rules).label({ symbol: "AMD", kind: "call", t0: tr.opened_at });
    };
    expect(go(R31)).toEqual({ label: "early", reason: null });
    expect(go(R33)).toEqual({ label: "off_plan", reason: null });
  });

  it("09:35:30 after a breakout in bar 1: early from the 09:35:00 instant under EXP-0033, off_plan under EXP-0031", () => {
    // The 09:35:00 instant reads bars ended by then: bar 1 (09:32 to 09:34) closed above 100 after a close at 95, and the
    // dip of bar 2 has not ended, so the call side is get_ready, and the row is live from 09:35: early. Under EXP-0031
    // the 09:34:05 evaluation (row no_trade, before 09:35) holds to 09:36:05.
    const bars = { AMD: abcBars(1, null), QQQ: qqqBars(), SMH: smhBars() };
    expect(labelUnder(R33, "AMD", "call", "09:35:30", { bars })).toEqual({ label: "early", reason: null });
    expect(labelUnder(R31, "AMD", "call", "09:35:30", { bars })).toEqual({ label: "off_plan", reason: null });
    expect(labelUnder(R33, "AMD", "call", "09:34:59", { bars })).toEqual({ label: "off_plan", reason: null });
  });

  it("just after 11:30:00: a get_ready from 11:28:05 is early under EXP-0031 and off_plan (lunch) under EXP-0033", () => {
    const bars = { AMD: abcBars(58, null), QQQ: qqqBars(), SMH: smhBars() };
    expect(labelUnder(R31, "AMD", "call", "11:30:02", { bars })).toEqual({ label: "early", reason: null });
    expect(labelUnder(R33, "AMD", "call", "11:30:02", { bars })).toEqual({ label: "off_plan", reason: null });
    expect(labelUnder(R33, "AMD", "call", "11:29:59", { bars })).toEqual({ label: "early", reason: null });
  });

  it("just after 13:00:00: a break and dip in lunch are in zone from 13:00:00 under EXP-0033, off_plan under EXP-0031", () => {
    // bar 102 (12:54 to 12:56) breaks 100, bar 103 (12:56 to 12:58) dips to 100.10, and bar 104 (12:58 to 13:00)
    // closes above the dip bar's close: the retest confirms at 13:00 (DEC-0052)
    const bars = { AMD: abcBars(102, null), QQQ: qqqBars(), SMH: smhBars() };
    expect(labelUnder(R33, "AMD", "call", "13:00:02", { bars })).toEqual({ label: "in_zone", reason: null });
    expect(labelUnder(R31, "AMD", "call", "13:00:02", { bars })).toEqual({ label: "off_plan", reason: null });
  });

  it("just after 15:10:00: a get_ready from 15:08:05 is early under EXP-0031 and off_plan (flat) under EXP-0033", () => {
    const bars = { AMD: abcBars(168, null), QQQ: qqqBars(), SMH: smhBars() };
    expect(labelUnder(R31, "AMD", "call", "15:10:02", { bars })).toEqual({ label: "early", reason: null });
    expect(labelUnder(R33, "AMD", "call", "15:10:02", { bars })).toEqual({ label: "off_plan", reason: null });
  });
});

describe("EXP-0033: the edition in force at t0, by the store's receipt time", () => {
  // copy A received 08:55 (levels 100 / 90); copy B received 10:20 with the call level at 94, below the whole session
  const A = edition();
  const B = edition(S, [{ ...AMD_ITEM, breakout_above: 94 }, QQQ_ITEM]);
  const editions = [nyCopy(A, "08:55:00"), nyCopy(B, "10:20:00")];

  it("labels each fill against the copy received last by t0", () => {
    expect(labelUnder(R33, "AMD", "call", "10:03:00", { editions })).toEqual({ label: "early", reason: null }); // A
    expect(labelUnder(R33, "AMD", "call", "10:30:00", { editions })).toEqual({ label: "no_record", reason: "side_broke_earlier" }); // B
    expect(labelUnder(R33, "AMD", "call", "10:19:59.999", { editions })).toEqual({ label: "off_plan", reason: null }); // A, plan off
  });

  it("a receipt time equal to t0 is in force", () => {
    expect(labelUnder(R33, "AMD", "call", "10:20:00.000", { editions })).toEqual({ label: "no_record", reason: "side_broke_earlier" });
    expect(editionAt(input({ editions }), at("10:20:00"), R33)).toEqual({ copy: editions[1] });
  });

  it("no copy received by t0 inside the session is no_edition; a fill before the open is not_a_session", () => {
    const onlyLate = [nyCopy(B, "10:20:00")];
    expect(labelUnder(R33, "AMD", "call", "10:00:00", { editions: onlyLate })).toEqual({ label: "no_record", reason: "no_edition" });
    // the pre-market fill: no copy received yet and no stamp; t0 is not inside the regular session
    const inp = input({ editions: onlyLate, barsFeed: "sip", stamps: sipStamps(), journal: { trades: [piece("AMD", "call", "08:50:00", "09:40:00")] } });
    const run = libLabelSession(inp, LIVE, R33, META);
    expect(run.state === "labelled" && run.rows.map((r) => [r.label, r.reason, r.edition_copy_received_at, r.covering_stamp_key])).toEqual([["no_record", "not_a_session", null, null]]);
  });

  it("ignores as_of: a copy published (as_of) after t0 but received before it is in force; EXP-0031 reads as_of", () => {
    const late = { ...B, as_of: iso("11:00:00") } as Options;
    const eds = [nyCopy(A, "08:55:00"), nyCopy(late, "10:20:00")];
    expect(labelUnder(R33, "AMD", "call", "10:30:00", { editions: eds })).toEqual({ label: "no_record", reason: "side_broke_earlier" });
    expect(labelUnder(R31, "AMD", "call", "10:30:00", { editions: eds })).toEqual({ label: "no_record", reason: "edition_after_t0" });
  });

  it("replays each copy once and keeps the replays apart", () => {
    const s = new SessionLabeller(input({ editions, stamps: sipStamps() }), LIVE, R33);
    expect(s.replayFor(editions[0]!)).toBe(s.replayFor(editions[0]!));
    expect(s.replayFor(editions[0]!)).not.toBe(s.replayFor(editions[1]!));
  });

  it("a half-day disagreement with the copy in force is no_record", () => {
    expect(labelUnder(R33, "AMD", "call", "10:05:00", { edition: edition(S, [AMD_ITEM, QQQ_ITEM], true) })).toEqual({ label: "no_record", reason: "half_day_mismatch" });
  });
});

describe("EXP-0033: the board-feed stamps at t0", () => {
  const st = (hhmmss: string, over: Partial<BoardStamp> = {}): BoardStamp => ({ key: stampKey(at(hhmmss)), feed: "sip", answered: "ok", at: iso(hhmmss), deployment: "dpl_a", ...over });

  it("covered by a sip stamp in [t0 − 2 min, t0], both ends included", () => {
    const one = [st("10:00:00")];
    expect(boardFeedAt(one, at("10:00:00")).covered).toBe(true);
    expect(boardFeedAt(one, at("10:02:00")).covered).toBe(true);
    expect(boardFeedAt(one, at("10:02:00.001")).covered).toBe(false); // after the last stamp
    expect(boardFeedAt(one, at("09:59:59.999")).covered).toBe(false); // before the first
  });

  it("covered between two consecutive sip stamps, whatever their deployments; not when one does not read sip", () => {
    expect(boardFeedAt([st("10:00:00"), st("10:05:00", { deployment: "dpl_b" })], at("10:03:30")).covered).toBe(true);
    expect(boardFeedAt([st("10:00:00"), st("10:05:00", { feed: "iex" })], at("10:03:30")).covered).toBe(false);
  });

  it("names the stamp that covered t0: the latest sip stamp in the window, else the earlier of the bracketing pair", () => {
    expect(boardFeedAt([st("10:00:00"), st("10:01:00"), st("10:02:30")], at("10:02:00")).coveredBy).toBe(stampKey(at("10:01:00")));
    expect(boardFeedAt([st("10:00:00"), st("10:05:00")], at("10:03:30")).coveredBy).toBe(stampKey(at("10:00:00")));
    expect(boardFeedAt([st("10:00:00")], at("10:04:00")).coveredBy).toBeNull();
    // only stamps of t0's own New York day are read
    expect(boardFeedAt([{ ...st("10:00:00"), at: iso("10:00:00", "2026-11-11") }], at("10:01:00")).covered).toBe(false);
  });

  it("a stale answer is not ok", () => {
    const run = ["10:00:00", "10:05:00", "10:10:00"].map((t) => st(t, { answered: "stale" }));
    expect(boardFeedAt(run, at("10:11:00")).boardOff).toBe(true);
  });

  it("feed_unknown before the session's first stamp and after its last", () => {
    const stamps = [st("10:00:00"), st("10:01:00")];
    expect(labelUnder(R33, "AMD", "call", "09:59:00", { stamps })).toEqual({ label: "no_record", reason: "feed_unknown" });
    expect(labelUnder(R33, "AMD", "call", "10:04:05", { stamps })).toEqual({ label: "no_record", reason: "feed_unknown" });
    expect(labelUnder(R33, "AMD", "call", "10:03:00", { stamps })).toEqual({ label: "early", reason: null });
  });

  it("board_off after a run of 10 minutes or more without an ok answer whose last stamp is in [t0 − 2 min, t0]", () => {
    const run = (first: string) => [st("09:58:00"), st(first, { answered: "error" }), ...["10:02:00", "10:04:00", "10:06:00", "10:08:00", "10:10:00"].map((t) => st(t, { answered: "plan" }))];
    expect(boardFeedAt(run("10:00:00"), at("10:10:30")).boardOff).toBe(true); // exactly 10 minutes
    expect(boardFeedAt(run("10:00:00.001"), at("10:10:30")).boardOff).toBe(false); // just under
    expect(boardFeedAt(run("10:00:00"), at("10:12:00")).boardOff).toBe(true); // last stamp at t0 − 2 min
    expect(boardFeedAt(run("10:00:00"), at("10:12:00.001")).boardOff).toBe(false);
    expect(boardFeedAt(run("10:00:00"), at("10:09:59")).boardOff).toBe(false); // the run so far is under 10 minutes
    // in the labeller: a fill otherwise early
    const stamps = [...run("10:00:00"), st("10:12:00")];
    expect(labelUnder(R33, "AMD", "call", "10:03:00", { stamps })).toEqual({ label: "early", reason: null });
    expect(labelUnder(R33, "AMD", "call", "10:11:00", { stamps })).toEqual({ label: "no_record", reason: "board_off" });
  });

  it("stamps after t0 never change a board_off decision", () => {
    const before = [st("10:00:00", { answered: "error" }), st("10:05:00", { answered: "error" }), st("10:10:00", { answered: "error" })];
    const t0 = at("10:10:30");
    const want = boardFeedAt(before, t0).boardOff;
    expect(want).toBe(true);
    for (const after of [[], [st("10:11:00")], [st("10:11:00", { answered: "error" })], [st("10:20:00", { feed: "iex", answered: "ok" })]])
      expect(boardFeedAt([...before, ...after], t0).boardOff).toBe(want);
    const quiet = [st("10:00:00", { answered: "error" }), st("10:05:00", { answered: "error" })];
    for (const after of [[st("10:10:31", { answered: "error" })], [st("10:11:00")]]) expect(boardFeedAt([...quiet, ...after], t0).boardOff).toBe(false);
  });
});

describe("EXP-0033: bars not had or short are fetched again, not labelled", () => {
  const tr = () => piece("AMD", "call", "10:05:00", "10:20:00");
  const run = (bars: ReplayInput["bars"], rules: LabelRules = R33) => libLabelSession(input({ bars, barsFetchedAt: bars === null ? null : "2026-11-12T21:30:00.000Z", barsFeed: rules.feed, stamps: sipStamps(), journal: { trades: [tr()] } }), LIVE, rules, META);

  it("no bars: retry under EXP-0033, no_record bars_unavailable under EXP-0031", () => {
    expect(run(null)).toEqual({ state: "retry", why: "bars_unavailable" });
    const r = run(null, R31);
    expect(r.state === "labelled" && r.rows.map((x) => x.reason)).toEqual(["bars_unavailable"]);
  });

  it("full means every request finished paging and SMH has a bar ending at the close; a thin focus name is still full", () => {
    // AMD with no bar in its last three slots: labelled, not retried
    const thin = run({ AMD: without(abcBars(), 192, 193, 194), QQQ: qqqBars(), SMH: smhBars() });
    expect(thin.state === "labelled" && thin.rows.map((x) => [x.label, x.reason])).toEqual([["in_zone", null]]);
    // a request that hit the page cap
    const capped = libLabelSession(input({ requests: [{ complete: false }], barsFeed: "sip", stamps: sipStamps(), journal: { trades: [tr()] } }), LIVE, R33, META);
    expect(capped).toEqual({ state: "retry", why: "bars_not_full" });
    // SMH without a bar ending at the close
    expect(run({ AMD: abcBars(), QQQ: qqqBars(), SMH: without(smhBars(), 194) })).toEqual({ state: "retry", why: "bars_not_full" });
    // under EXP-0031 a capped request is bars that could not be had
    const r31 = libLabelSession(input({ requests: [{ complete: false }], journal: { trades: [tr()] } }), LIVE, R31, META);
    expect(r31.state === "labelled" && r31.rows.map((x) => x.reason)).toEqual(["bars_unavailable"]);
  });

  it("an empty slot inside a full answer is final: bars_incomplete for that name's later fills", () => {
    const r = run({ AMD: without(abcBars(), 10), QQQ: qqqBars(), SMH: smhBars() });
    expect(r.state === "labelled" && r.rows.map((x) => [x.experiment, x.feed, x.label, x.reason])).toEqual([["EXP-0033", "sip", "no_record", "bars_incomplete"]]);
  });
});

describe("EXP-0033: one stored reason, the first in labeller_rules.no_record_reasons", () => {
  it("is the record's order and set; EXP-0031 keeps its own", () => {
    expect(NO_RECORD_ORDER["EXP-0033"]).toEqual(["edition_missing", "not_a_session", "no_edition", "half_day_mismatch", "feed_unknown", "board_off", "bars_incomplete", "side_gap", "side_broke_earlier"]);
    expect(NO_RECORD_ORDER["EXP-0031"]).toEqual(["edition_missing", "edition_time_unknown", "edition_after_t0", "not_a_session", "half_day_mismatch", "bars_unavailable", "bars_start_late", "bars_gap", "leader_bars_start_late", "leader_bars_gap", "side_gap", "side_broke_earlier"]);
  });

  const mismatch = edition(S, [AMD_ITEM, QQQ_ITEM], true);
  const offRun = sipStamps(S, (m) => (m >= 20 && m <= 34 ? { answered: "error" as const } : {})); // 09:50 to 10:04 not ok
  const gapBars = { AMD: without(abcBars(), 10), QQQ: qqqBars(), SMH: smhBars() };
  const both = (sides: Partial<SideState>) => ({ ...LIVE, nameState: (n: Parameters<typeof nameState>[0]) => script(n.now.getTime(), nameState(n), { [at("10:04:05")]: { call: sides } }) });

  it("edition_missing before not_a_session: no copy at all, a fill before the open", () => {
    expect(labelUnder(R33, "AMD", "call", "08:00:00", { edition: null })).toEqual({ label: "no_record", reason: "edition_missing" });
  });
  it("not_a_session before no_edition: the only copy arrives at 10:20, the fill is at 08:50, with no stamp yet", () => {
    expect(labelUnder(R33, "AMD", "call", "08:50:00", { editions: [nyCopy(edition(), "10:20:00")] })).toEqual({ label: "no_record", reason: "not_a_session" });
    expect(labelUnder(R33, "AMD", "call", "16:00:00", {})).toEqual({ label: "no_record", reason: "not_a_session" }); // the close is outside [open, close)
  });
  it("no_edition before half_day_mismatch: the only copy (a half-day one) arrives after t0", () => {
    expect(labelUnder(R33, "AMD", "call", "10:05:00", { editions: [nyCopy(mismatch, "10:20:00")] })).toEqual({ label: "no_record", reason: "no_edition" });
  });
  it("half_day_mismatch before feed_unknown: a half-day copy on a full day, and no stamp", () => {
    expect(labelUnder(R33, "AMD", "call", "10:05:00", { edition: mismatch, stamps: [] })).toEqual({ label: "no_record", reason: "half_day_mismatch" });
  });
  it("feed_unknown before board_off: refused stamps that also answer error for 15 minutes", () => {
    const refused = sipStamps(S, () => ({ feed: "refused" as const, answered: "error" as const }));
    expect(labelUnder(R33, "AMD", "call", "10:05:00", { stamps: refused })).toEqual({ label: "no_record", reason: "feed_unknown" });
  });
  it("board_off before bars_incomplete: an outage to 10:04 and a gap in AMD's bars at 09:50", () => {
    expect(labelUnder(R33, "AMD", "call", "10:05:00", { stamps: offRun, bars: gapBars })).toEqual({ label: "no_record", reason: "board_off" });
    expect(labelUnder(R33, "AMD", "call", "10:05:00", { stamps: offRun })).toEqual({ label: "no_record", reason: "board_off" });
  });
  it("bars_incomplete before side_gap, and side_gap before side_broke_earlier (stubbed sides)", () => {
    const fill = (eng: LabelEngine, bars = input().bars) => {
      const tr = piece("AMD", "call", "10:05:00", "10:20:00");
      return new SessionLabeller(input({ bars, stamps: sipStamps(), journal: { trades: [tr] } }), eng, R33).label({ symbol: "AMD", kind: "call", t0: tr.opened_at });
    };
    expect(fill(both({ gap: true }), gapBars)).toEqual({ label: "no_record", reason: "bars_incomplete" });
    expect(fill(both({ gap: true, brokeEarlier: true }))).toEqual({ label: "no_record", reason: "side_gap" });
    expect(fill(both({ brokeEarlier: true }))).toEqual({ label: "no_record", reason: "side_broke_earlier" });
  });
  it("SMH's bars incomplete are bars_incomplete too under EXP-0033 (leader_bars_gap under EXP-0031)", () => {
    const bars = { AMD: abcBars(), QQQ: qqqBars(), SMH: without(smhBars(), 5) };
    expect(labelUnder(R33, "QQQ", "put", "10:45:00", { bars })).toEqual({ label: "no_record", reason: "bars_incomplete" });
    expect(labelUnder(R31, "QQQ", "put", "10:45:00", { bars })).toEqual({ label: "no_record", reason: "leader_bars_gap" });
  });
});

// ---- the final review round -----------------------------------------------------------------------------------------
/** A full EXP-0033 input: SIP bars by their own answer, sip stamps all session. */
const in33 = (over: In = {}) => input({ barsFeed: "sip", stamps: sipStamps(), ...over });
const rowsOf = (run: ReturnType<typeof libLabelSession>) => {
  if (run.state !== "labelled") throw new Error(`not labelled: ${run.why}`);
  return run.rows;
};

describe("the bars prove their own feed and fetch time", () => {
  const tr = piece("AMD", "call", "10:05:00", "10:20:00");
  it("a run whose bars came from another feed throws, under each rules object", () => {
    expect(() => libLabelSession(input({ barsFeed: "sip", journal: { trades: [tr] } }), LIVE, R31, META)).toThrow(/sip/);
    expect(() => libLabelSession(in33({ barsFeed: "iex", journal: { trades: [tr] } }), LIVE, R33, META)).toThrow(/iex/);
    expect(() => libLabelSession(input({ barsFeed: "opra" as never, journal: { trades: [tr] } }), LIVE, R31, META)).toThrow(TypeError);
  });
  it("the row's feed and bars_fetched_at are the answer's", () => {
    const [r] = rowsOf(libLabelSession(in33({ barsFetchedAt: "2026-11-12T21:41:07.123Z", journal: { trades: [tr] } }), LIVE, R33, META));
    expect([r!.feed, r!.bars_fetched_at]).toEqual(["sip", "2026-11-12T21:41:07.123Z"]);
    const [q] = rowsOf(libLabelSession(input({ barsFetchedAt: "2026-11-12T21:52:00.000Z", journal: { trades: [tr] } }), LIVE, R31, META));
    expect([q!.feed, q!.bars_fetched_at]).toEqual(["iex", "2026-11-12T21:52:00.000Z"]);
  });
  it("the meta is checked: an empty engine version throws; bars with no readable fetch time throw", () => {
    expect(() => libLabelSession(input({ journal: { trades: [tr] } }), LIVE, R31, { engineVersion: "" })).toThrow(TypeError);
    expect(() => libLabelSession(input({ journal: { trades: [tr] } }), LIVE, R31, { engineVersion: "  " })).toThrow(TypeError);
    expect(() => libLabelSession(input({ barsFetchedAt: null, journal: { trades: [tr] } }), LIVE, R31, META)).toThrow(/fetch time/);
    expect(() => libLabelSession(input({ barsFetchedAt: "soon", journal: { trades: [tr] } }), LIVE, R31, META)).toThrow(/fetch time/);
  });
});

describe("a focus name never fetched is not a full answer", () => {
  const DEF: Item = { symbol: "DEF", rank: 3, bias: "breakout", atr: 2, breakout_above: 100, hold_above: 90 };
  const A = edition();
  const B = edition(S, [AMD_ITEM, QQQ_ITEM, DEF]);
  const editions = [nyCopy(A, "08:55:00"), nyCopy(B, "10:20:00")];
  const tr = piece("DEF", "call", "10:30:00", "10:40:00");

  it("copy B adds DEF and the bars have no DEF key: retry", () => {
    expect(libLabelSession(in33({ editions, journal: { trades: [tr] } }), LIVE, R33, META)).toEqual({ state: "retry", why: "bars_not_full" });
  });
  it("a DEF key with an empty list is a full answer for a name that did not trade: bars_incomplete per fill", () => {
    const bars = { AMD: abcBars(), QQQ: qqqBars(), SMH: smhBars(), DEF: [] };
    expect(rowsOf(libLabelSession(in33({ editions, bars, journal: { trades: [tr] } }), LIVE, R33, META)).map((r) => [r.symbol, r.label, r.reason])).toEqual([["DEF", "no_record", "bars_incomplete"]]);
  });
});

describe("rows wait for a journal read after the close", () => {
  const tr = piece("AMD", "call", "10:05:00", "10:20:00");
  const close20 = at("16:20:00");
  for (const [name, rules, base] of [
    ["EXP-0033", R33, in33] as const,
    ["EXP-0031", R31, input] as const,
  ]) {
    it(`${name}: read 1 ms before close + 20 min is journal_not_current; at it, labelled`, () => {
      expect(libLabelSession(base({ journalReadAt: new Date(close20 - 1).toISOString(), journal: { trades: [tr] } }), LIVE, rules, META)).toEqual({ state: "retry", why: "journal_not_current" });
      expect(rowsOf(libLabelSession(base({ journalReadAt: new Date(close20).toISOString(), journal: { trades: [tr] } }), LIVE, rules, META))).toHaveLength(1);
      expect(libLabelSession(base({ journalReadAt: "not a time", journal: { trades: [tr] } }), LIVE, rules, META)).toEqual({ state: "retry", why: "journal_not_current" });
    });
  }
  it("on a half day the close is 13:00", () => {
    const half = { AMD: abcBars(65, null, H, 105), QQQ: Array.from({ length: 105 }, (_, i) => bar(i, flat(490), H)), SMH: smhBars(H, 105) };
    const trH = piece("AMD", "call", "11:47:00", "11:50:00", {}, H); // in zone from the 11:46 confirming close
    const inp = (readAt: string) => input({ session: H, edition: edition(H, [AMD_ITEM, QQQ_ITEM], true), bars: half, barsFeed: "sip", stamps: sipStamps(H), journalReadAt: readAt, journal: { trades: [trH] } });
    expect(libLabelSession(inp(new Date(at("13:20:00", H) - 1).toISOString()), LIVE, R33, META)).toEqual({ state: "retry", why: "journal_not_current" });
    expect(rowsOf(libLabelSession(inp(new Date(at("13:20:00", H)).toISOString()), LIVE, R33, META)).map((r) => r.label)).toEqual(["in_zone"]);
  });
});

describe("copies received at the same instant", () => {
  const A = edition();
  const B = edition(S, [{ ...AMD_ITEM, breakout_above: 94 }, QQQ_ITEM]);
  it("are chosen the same way whatever the store's order: the later as_of, then the canonical JSON", () => {
    const same = (x: Options, y: Options) => [nyCopy(x, "08:55:00"), nyCopy(y, "08:55:00")];
    const later = { ...B, as_of: iso("08:00:00") } as Options;
    const l1 = labelUnder(R33, "AMD", "call", "10:30:00", { editions: same(A, later) });
    const l2 = labelUnder(R33, "AMD", "call", "10:30:00", { editions: same(later, A) });
    expect(l1).toEqual(l2);
    expect(l1).toEqual({ label: "no_record", reason: "side_broke_earlier" }); // B's as_of is later
    // same as_of too: the copy whose canonical JSON sorts last, whatever its key order
    const keysReordered = JSON.parse(JSON.stringify({ focus: B.focus, tickers: B.tickers, as_of: B.as_of, session: B.session, schema: B.schema })) as Options;
    const t1 = labelUnder(R33, "AMD", "call", "10:30:00", { editions: same(A, B) });
    const t2 = labelUnder(R33, "AMD", "call", "10:30:00", { editions: same(keysReordered, A) });
    expect(t1).toEqual(t2);
    expect(labelUnder(R31, "AMD", "call", "10:30:00", { editions: same(A, B) })).toEqual(labelUnder(R31, "AMD", "call", "10:30:00", { editions: same(B, A) }));
  });
});

describe("a day with no regular session", () => {
  it("needs no bars: its fills are not_a_session and the run is labelled (Saturday, and Thanksgiving)", () => {
    for (const day of ["2026-11-14", "2026-11-26"]) {
      const tr = piece("AMD", "call", "10:05:00", "10:20:00", {}, day);
      const inp = input({ session: day, edition: edition(day), bars: null, barsFetchedAt: null, barsFeed: "sip", requests: [], stamps: [], journalReadAt: `${day}T15:00:00.000Z`, journal: { trades: [tr] } });
      expect(rowsOf(libLabelSession(inp, LIVE, R33, META)).map((r) => [r.label, r.reason])).toEqual([["no_record", "not_a_session"]]);
      // with no copy stored at all, the record's order puts edition_missing first
      expect(rowsOf(libLabelSession({ ...inp, editions: [] }, LIVE, R33, META)).map((r) => r.reason)).toEqual(["edition_missing"]);
    }
  });
});

describe("board_off reads adjacent stamps of the session's list", () => {
  it("documented consequence: error stamps at 10:00 and 10:19 with none between them are a 19-minute run, so board off", () => {
    const st = (t: string, answered: BoardStamp["answered"]) => ({ key: stampKey(at(t)), feed: "sip" as const, answered, at: iso(t), deployment: "dpl_a" });
    expect(boardFeedAt([st("09:59:00", "ok"), st("10:00:00", "error"), st("10:19:00", "error")], at("10:20:00"))).toMatchObject({ covered: true, boardOff: true });
  });
});

describe("the day cap counts option buy fills only", () => {
  const opt = (t: string, i: number) => piece("ZZZ", "call", t, "09:58:00", { strike: 10 + i });
  it("four option buys and one stock buy before now: not reached; five option buys: reached", () => {
    const four = ["09:36:00", "09:38:00", "09:40:00", "09:42:00"].map(opt);
    const stock = piece("ZZZ", "stock", "09:44:00", "09:58:00", { strike: null, multiplier: 1 });
    expect(dayInputsAt({ trades: [...four, stock] }, S, at("10:04:05")).dayLimitUsed).toBe(false);
    expect(dayInputsAt({ trades: [...four, opt("09:44:00", 9)] }, S, at("10:04:05")).dayLimitUsed).toBe(true);
    // a held option lot is a buy fill too
    expect(dayInputsAt({ trades: four, open: [lot("ZZZ", "call", "09:44:00", { strike: 30 })] }, S, at("10:04:05")).dayLimitUsed).toBe(true);
  });
});

describe("no look-ahead beyond the bars", () => {
  const tr = piece("AMD", "call", "10:05:00", "10:30:00");
  const pos = { symbol: "AMD", kind: "call" as const, t0: tr.opened_at };
  const t0 = Date.parse(tr.opened_at);
  const decide = (inp: ReplayInput, rules = R33) => {
    const s = new SessionLabeller(inp, LIVE, rules);
    const d = s.decide(pos);
    return { label: d.label, reason: d.reason, key: d.stampKey, received: d.copy?.receivedAt ?? null, cautions: s.cautions(pos) };
  };

  it("an edition copy received after t0 changes nothing", () => {
    const base = in33({ edition: richEdition(), journal: { trades: [tr] } });
    const want = decide(base);
    const B = edition(S, [{ ...AMD_ITEM, breakout_above: 94 }, QQQ_ITEM]);
    for (const late of [new Date(t0 + 1).toISOString(), iso("15:00:00")]) expect(decide({ ...base, editions: [...base.editions, copy(B, late)] })).toEqual(want);
  });

  it("stamps after t0 change no label, reason or covering_stamp_key while a stamp lies in [t0 − 2 min, t0]", () => {
    const base = in33({ edition: richEdition(), journal: { trades: [tr] } });
    const want = decide(base);
    expect(want.key).toBe("desk/feeds/board/2026-11-12/1005.json");
    const upTo = sipStamps().filter((x) => Date.parse(x.at) <= t0);
    for (const after of [[], sipStamps().filter((x) => Date.parse(x.at) > t0).map((x) => ({ ...x, answered: "error" as const })), sipStamps().filter((x) => Date.parse(x.at) > t0).map((x) => ({ ...x, feed: "iex" as const }))])
      expect(decide({ ...base, stamps: [...upTo, ...after] })).toEqual(want);
  });

  it("journal pieces opened or closed after t0 change no cautions and no day limit", () => {
    const base = in33({ edition: richEdition(), journal: { trades: [tr] } });
    const want = decide(base);
    const later = [
      piece("ZZZ", "call", "09:40:00", "10:06:00", { pnl: 50 }), // closed after t0: not a winner at t0
      piece("ZZZ", "put", "09:41:00", "10:07:00", { pnl: -150 }), // a loss closed after t0
      ...["10:05:01", "10:06:00", "10:07:00", "10:08:00", "10:09:00"].map((t, i) => piece("YYY", "call", t, "10:20:00", { strike: 40 + i })),
    ];
    const got = decide({ ...base, journal: { trades: [tr, ...later] } });
    expect(got).toEqual(want);
    expect(dayInputsAt({ trades: [tr, ...later] }, S, t0)).toEqual(dayInputsAt({ trades: [tr] }, S, t0));
  });
});

describe("EXP-0033: fills at the extra instants, to the millisecond", () => {
  const cases: [string, number, [string, string][]][] = [
    // bar 1 breaks: before the 09:35:00 instant the 09:34:05 row is no_trade; from it, get_ready
    ["09:35", 1, [["09:34:59.999", "off_plan"], ["09:35:00.000", "early"], ["09:35:00.001", "early"]]],
    // bar 58 breaks: get_ready from 11:28:05 until the 11:30:00 instant (lunch)
    ["11:30", 58, [["11:29:59.999", "early"], ["11:30:00.000", "off_plan"], ["11:30:00.001", "off_plan"]]],
    // bars 102 to 104 break, touch and confirm in lunch: in zone from the 13:00:00 instant
    ["13:00", 102, [["12:59:59.999", "off_plan"], ["13:00:00.000", "in_zone"], ["13:00:00.001", "in_zone"]]],
    // bar 168 breaks: get_ready from 15:08:05 until the 15:10:00 instant (flat)
    ["15:10", 168, [["15:09:59.999", "early"], ["15:10:00.000", "off_plan"], ["15:10:00.001", "off_plan"]]],
  ];
  for (const [instant, k, fills] of cases)
    it(`at ${instant}`, () => {
      const bars = { AMD: abcBars(k, null), QQQ: qqqBars(), SMH: smhBars() };
      for (const [t, want] of fills) expect(labelUnder(R33, "AMD", "call", t, { bars }).label, t).toBe(want);
    });
});

describe("the rules are the frozen objects themselves", () => {
  it("refuses Object.assign copies, a JSON round trip and Object.create", () => {
    for (const fake of [Object.assign({}, R33), JSON.parse(JSON.stringify(R33)), Object.create(R33), Object.assign({}, R31), Object.create(R31)]) {
      expect(() => labelRules(fake)).toThrow(TypeError);
      expect(() => libLabelSession(in33(), LIVE, fake, META)).toThrow(TypeError);
    }
  });
});
