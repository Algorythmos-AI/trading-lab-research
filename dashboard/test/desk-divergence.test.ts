// Where the server's shadow board and the open page can differ, built the way each really works: the page polls a
// price every 2 s, keeps the last few minutes of them, and gets the server's session bars late (its last bars poll,
// counted only once settled); the server reads settled bars and the snapshot at run time, a minute after the slot.
// Each case says either that the server is never at enter zone where the page as of the slot is not, or that the
// shadow summary counts the difference as critical.
import { describe, expect, it } from "vitest";
import { BAR_MS, ENGINE_VERSION, evaluateSlot, type PageRecord, serverRecord, stateRows } from "@/lib/desk-eval";
import { shadowSummary } from "@/lib/desk-shadow";
import { focusOptions } from "@/lib/fixture-variants";
import { focusPlan } from "@/lib/focus-plan";
import type { LiveQuote, Options, TrailPoint } from "@/lib/options";
import { TRAIL_MS } from "@/lib/options";
import { boardRows } from "@/lib/trade-now";
import { type Bar2, CLOSE_GRACE_MS, type NameState, SERVER_SETTLE_MS } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, EDT
const ny = (hhmmss: string) => Date.parse(`${S}T${hhmmss}-04:00`);
const OPEN = ny("09:30:00");
const SYMS = E.focus!.items.map((i) => i.symbol);
const QQQ = focusPlan(E.focus!.items.find((i) => i.symbol === "QQQ")!).call!;
const L = QQQ.level;
const T1 = QQQ.target1!;
/** The slot the cases are read at: QQQ broke at 10:00 to 10:02, dipped to the level 10:02 to 10:04, and the 10:04 to
 * 10:06 bar closed above the dip bar's close: the retest confirmed at the slot's close (DEC-0052). */
const END = ny("10:06:00");

type Over = { qqq?: (t: number, p: number | null) => number | null; extraHigh?: number };

/** One print every 2 s per name. QQQ: under the level, the break, the dip, then above the dip bar's close; `qqq` may bend it. */
function prints(sym: string, over: Over = {}): TrailPoint[] {
  const close = E.focus!.items.find((i) => i.symbol === sym)!.close!;
  const out: TrailPoint[] = [];
  for (let at = OPEN; at < ny("16:00:00"); at += 2_000) {
    let p: number | null = close;
    if (sym === "QQQ") {
      if (at < ny("10:00:00")) p = 750;
      else if (at < ny("10:02:00")) p = 750 + ((L + 1.5 - 750) * (at - ny("10:00:00"))) / 118_000;
      else if (at < ny("10:04:00")) p = at < ny("10:03:00") ? L + 0.3 : L + 1;
      else p = L + 1.1;
      p = over.qqq ? over.qqq(at, p) : p;
    }
    if (p !== null) out.push({ at, p: Math.round(p * 100) / 100 });
  }
  return out;
}

function barsOf(path: readonly TrailPoint[], before: number): Bar2[] {
  const by = new Map<number, Bar2>();
  for (const x of path) {
    if (x.at >= before) break;
    const start = Math.floor(x.at / BAR_MS) * BAR_MS;
    const b = by.get(start);
    if (b) {
      b.h = Math.max(b.h, x.p);
      b.l = Math.min(b.l, x.p);
      b.c = x.p;
    } else by.set(start, { start, end: start + BAR_MS, o: x.p, h: x.p, l: x.p, c: x.p });
  }
  return [...by.values()];
}

/** The snapshot at an instant: the last print before it, the session's high and low so far (and an odd print). */
function snapshot(path: readonly TrailPoint[], at: number, extraHigh?: number): LiveQuote {
  const seen = path.filter((x) => x.at <= at);
  const last = seen.at(-1)!;
  const high = Math.max(...seen.map((x) => x.p), ...(extraHigh !== undefined ? [extraHigh] : []));
  return { price: last.p, at: new Date(last.at).toISOString(), open: seen[0]!.p, high, low: Math.min(...seen.map((x) => x.p)), day: S, prev_close: null, vwap: null };
}

/** The page at `at`: its 2-second polls of the last TRAIL_MS, its quote, and the bars its last poll (10 s ago) got. */
function pageAt(at: number, over: Over = {}): NameState[] {
  const quotes: Record<string, LiveQuote> = {};
  const trails: Record<string, TrailPoint[]> = {};
  const serverBars: Record<string, Bar2[]> = {};
  const serverFetchedAt: Record<string, number> = {};
  const fetched = at - 10_000;
  for (const s of SYMS) {
    const path = prints(s, over);
    trails[s] = path.filter((x) => x.at <= at && x.at >= at - TRAIL_MS);
    quotes[s] = snapshot(path, at, s === "QQQ" ? over.extraHigh : undefined);
    serverBars[s] = barsOf(path, fetched);
    serverFetchedAt[s] = fetched;
  }
  const rows = boardRows({ session: S, halfDay: false, items: E.focus!.items, tickers: E.tickers, quotes, trails, serverBars, serverFetchedAt, now: at, receivedAt: at - 1_000, dayLimitUsed: false, wonToday: null }, true);
  return rows.map((r) => r.state).filter((x): x is NameState => x !== null);
}

/** The server's run a minute after the slot: the bars and the snapshot as upstream has them then. */
function serverAt(run: number, over: Over = {}, bend: (sym: string, b: Bar2[]) => Bar2[] = (_, b) => b) {
  const bars: Record<string, Bar2[]> = {};
  const snapshots: Record<string, LiveQuote> = {};
  for (const s of SYMS) {
    const path = prints(s, over);
    bars[s] = bend(s, barsOf(path, run));
    snapshots[s] = snapshot(path, run, s === "QQQ" ? over.extraHigh : undefined);
  }
  return evaluateSlot({ slot: { day: S, end: END }, edition: E, journal: null, done: false, bars, fetchedAt: Object.fromEntries(SYMS.map((s) => [s, run])), snapshots });
}

const RUN = END + SERVER_SETTLE_MS + 1_000;
const AS_OF = END + CLOSE_GRACE_MS;
const qqqCall = (rows: { symbol: string; side: string; state: string }[]) => rows.find((r) => r.symbol === "QQQ" && r.side === "call")?.state;
const pageCall = (states: NameState[]) => qqqCall(states.flatMap(stateRows));

describe("the base case: both say enter zone", () => {
  it("QQQ's retest holds at 10:06 on the page as of the slot and on the server", () => {
    expect(T1).toBeGreaterThan(L + 1.5);
    expect(pageCall(pageAt(AS_OF))).toBe("enter_zone");
    expect(qqqCall(serverAt(RUN).rows)).toBe("enter_zone");
  });
});

describe("where they diverge", () => {
  it("target 1 reached in the bar forming after the slot: the snapshot's high makes the server say missed, as the page", () => {
    const over: Over = { qqq: (t, p) => (t >= END + 2_000 && t < END + 4_000 ? T1 + 0.1 : p) };
    expect(pageCall(pageAt(AS_OF, over))).toBe("missed");
    expect(qqqCall(serverAt(RUN, over).rows)).toBe("missed");
  });

  it("a high past target 1 only the snapshot shows: the server says missed, as the page", () => {
    const over: Over = { extraHigh: T1 + 0.2 };
    expect(pageCall(pageAt(AS_OF, over))).toBe("missed");
    expect(qqqCall(serverAt(RUN, over).rows)).toBe("missed");
  });

  it("a stale last trade: the server reads the snapshot's trade time and pauses the name, as the page", () => {
    const over: Over = { qqq: (t, p) => (t > END - 118_000 ? null : p) };
    expect(pageCall(pageAt(AS_OF, over))).toBe("paused");
    const ev = serverAt(RUN, over);
    expect(qqqCall(ev.rows)).toBe("paused");
    expect(ev.day.stale).toBe(true);
  });

  it("a slot missing after QQQ's break degrades QQQ alone; SPY's gap before any break leaves SPY's rows", () => {
    const ev = serverAt(RUN, {}, (s, b) => (s === "QQQ" ? b.filter((x) => x.start !== ny("10:02:00")) : s === "SPY" ? b.filter((x) => x.start !== ny("09:40:00")) : b));
    expect(ev.status).toBe("ok");
    expect(ev.degraded_names).toEqual([{ symbol: "QQQ", reason: "bars-gap" }]);
    expect(ev.rows.filter((r) => r.symbol === "QQQ")).toEqual([]);
    expect(ev.rows.filter((r) => r.symbol === "SPY")).toHaveLength(2);
    expect(ev.rows.some((r) => r.state === "enter_zone")).toBe(false);
  });

  it("the price back through the level 3 s after the slot: the server still says enter zone, and the summary counts it critical", () => {
    const over: Over = { qqq: (t, p) => (t >= END + 2_000 ? L - 0.5 : p) };
    const asOf = pageAt(AS_OF, over);
    const atSettle = pageAt(END + SERVER_SETTLE_MS, over);
    expect(pageCall(asOf)).toBe("get_ready");
    const ev = serverAt(RUN, over);
    expect(qqqCall(ev.rows)).toBe("enter_zone"); // the server cannot know a print after the slot's close
    const server = serverRecord(ev, { day: S, end: END }, RUN, E);
    const page: PageRecord = {
      v: 1,
      engine: ENGINE_VERSION,
      source: "page",
      slot_end: new Date(END).toISOString(),
      received_at: new Date(RUN).toISOString(),
      hidden: false,
      as_of: new Date(AS_OF).toISOString(),
      bars_delayed: false,
      rows: asOf.flatMap(stateRows),
      rows_at_settle: atSettle.flatMap(stateRows),
    };
    const r = shadowSummary([S], [server], [page]);
    expect(r.critical).toEqual({ total: 1, byPage: { get_ready: 1, plan_off: 0, missed: 0, paused: 0, other: 0 } });
    expect(r.criticalAtSettle.total).toBe(1);
  });
});
