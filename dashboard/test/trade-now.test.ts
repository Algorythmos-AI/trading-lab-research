import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TradeNowBoard } from "@/components/client/trade-now";
import { focusOptions } from "@/lib/fixture-variants";
import { SCRIPT_ANSWER_LAG_MS, SCRIPT_SYMBOLS, scriptBars, scriptQuote, stepInstant } from "@/lib/fixture-script";
import type { LiveQuote, Options } from "@/lib/options";
import { focusPlan } from "@/lib/focus-plan";
import {
  boardAnnounce,
  boardDay,
  type BoardInput,
  boardMode,
  type BoardMode,
  type BoardRow,
  boardRows,
  noticeKey,
  noticeTitle,
  rowView,
  runnerLine,
  triggerLine,
} from "@/lib/trade-now";
import type { JournalDoc } from "@/lib/journal";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, a Monday on EDT
const ITEMS = E.focus!.items;

/** The board's input at a step of the fixture script, as the page would have it. */
function atStep(step: number, over: Partial<BoardInput> = {}): BoardInput {
  const quotes: Record<string, LiveQuote> = {};
  for (const s of SCRIPT_SYMBOLS) quotes[s] = scriptQuote(s, S, step)!;
  const at = stepInstant(S, step) + SCRIPT_ANSWER_LAG_MS;
  return {
    session: S,
    halfDay: false,
    items: ITEMS,
    tickers: E.tickers,
    quotes,
    trails: {},
    serverBars: Object.fromEntries(ITEMS.map((i) => [i.symbol, scriptBars(i.symbol, S, step)])),
    now: at + 1_000,
    receivedAt: at,
    dayLimitUsed: false,
    wonToday: false,
    ...over,
  };
}

const summary = (rows: BoardRow[]) => rows.map((r) => `${r.symbol}:${r.state?.state ?? "plan"}`);

describe("the scripted morning", () => {
  it("walks QQQ through watch, get ready, enter zone and missed; SPY to a failed break; AAPL stays out", () => {
    expect(boardMode(S, false, "ok", atStep(0).now).kind).toBe("opening");
    expect(summary(boardRows(atStep(1), true))).toEqual(["SPY:watch", "QQQ:watch", "AAPL:no_trade"]); // nearer its trigger first
    expect(summary(boardRows(atStep(2), true))).toEqual(["SPY:get_ready", "QQQ:get_ready", "AAPL:no_trade"]);
    const three = boardRows(atStep(3), true);
    expect(summary(three)).toEqual(["QQQ:enter_zone", "SPY:plan_off", "AAPL:no_trade"]);
    // Past target 1 the call side is missed: the row watches the other side and says not to chase. SPY's failed break
    // has expired by then, so its row is back to watching both levels.
    const four = boardRows(atStep(4), true);
    expect(summary(four).sort()).toEqual(["AAPL:no_trade", "QQQ:watch", "SPY:watch"]);
    const q4 = four.find((r) => r.symbol === "QQQ")!.state!;
    expect(q4.call.state).toBe("missed");
    expect(q4.line).toContain("Calls past target 1 (754.83): don't chase");

    const [qqq, spy, aapl] = three;
    expect(qqq!.state!.side).toBe("call");
    expect(qqq!.state!.cautions.map((c) => c.word)).toContain("Semis against");
    expect(qqq!.runner).toMatch(/^Sell half at 754\.83, stop to 752\.95/);
    expect(spy!.state!.alt).toMatchObject({ kind: "failed_break", side: "put", level: 779.4 });
    expect(aapl!.state!.line).toBe("In the middle of yesterday's range: wait for 330.70 or 338.60");
  });

  it("reads each row as one headline, with the numbers apart and no 'testing' in a sentence", () => {
    const [qqq, spy, aapl] = boardRows(atStep(3), true).map((r) => rowView(r.state!));
    expect(qqq).toEqual({
      badge: { word: "ENTER ZONE", tone: "good", side: "call", alt: null },
      testing: false,
      headline: "Retest holding 752.86: call setup ready",
      grid: { enter: "~752.95", stop: "752.01 or −25%", target: "754.83" },
    });
    expect(spy!.badge).toEqual({ word: "FAILED BREAK", tone: "warn", side: "put", alt: "failed_break" });
    expect(spy!.testing).toBe(true);
    expect(spy!.headline).toBe("Call plan off at 779.40. Put under 779.40, stop above 780.00 (push high).");
    expect(spy!.grid!.stop).toBe("780.00 or −25%");
    expect(aapl!.badge).toEqual({ word: "NO TRADE", tone: "neutral", side: null, alt: null });
    for (const step of [1, 2, 3, 4])
      for (const r of boardRows(atStep(step), true)) expect(rowView(r.state!).headline).not.toMatch(/testing/i);
  });

  it("uses the red plan-off badge only with no live alternative", () => {
    const spy = boardRows(atStep(3), true).find((r) => r.symbol === "SPY")!.state!;
    const dead = rowView({ ...spy, alt: null, line: "Fell back below 779.40: call plan off" });
    expect(dead.badge).toEqual({ word: "PLAN OFF", tone: "bad", side: "call", alt: null });
    expect(dead.testing).toBe(false);
    expect(dead.grid).toBeNull();
    expect(noticeTitle(spy)).toBe("SPY: FAILED BREAK, put");
  });

  it("announces QQQ's entry and SPY's failed break once, and nothing that was there at the open", () => {
    const first = boardAnnounce(null, S, boardRows(atStep(2), true).map((r) => r.state!));
    expect(first.fresh).toEqual([]);
    const next = boardAnnounce(first.seen, S, boardRows(atStep(3), true).map((r) => r.state!));
    expect(next.fresh.map((s) => s.symbol).sort()).toEqual(["QQQ", "SPY"]);
    const again = boardAnnounce(next.seen, S, boardRows(atStep(3), true).map((r) => r.state!));
    expect(again.fresh).toEqual([]);
    expect(again.seen).toBe(next.seen);
    // opened at the entry: already there, so no notice
    expect(boardAnnounce(null, S, boardRows(atStep(3), true).map((r) => r.state!)).fresh).toEqual([]);
  });

  it("pauses every row when the feed stops answering", () => {
    const rows = boardRows(atStep(3, { now: stepInstant(S, 3) + 60_000 }), true);
    expect(rows.every((r) => r.state!.state === "paused")).toBe(true);
  });
});

describe("the header", () => {
  const at = (iso: string) => Date.parse(iso);
  it("says what the board can show", () => {
    expect(boardMode(S, false, "ok", at("2026-10-13T14:00:00Z"))).toEqual({ kind: "old", line: "Focus card is for Mon 12 Oct: refreshed after 08:54 Sydney" });
    expect(boardMode(S, false, "off", at("2026-10-12T14:30:00Z")).kind).toBe("off");
    expect(boardMode(S, false, "error", at("2026-10-12T14:30:00Z"))).toEqual({ kind: "off", line: "Live prices off: use the plans below" });
    expect(boardMode(S, false, "ok", at("2026-10-11T14:30:00Z"))).toEqual({ kind: "next", line: "Next session Mon 12 Oct: first entries from 10:00 New York" });
    expect(boardMode(S, false, "ok", at("2026-10-12T13:00:00Z")).kind).toBe("next");
    expect(boardMode(S, false, "ok", at("2026-10-12T20:05:00Z"))).toMatchObject({ kind: "next", line: expect.stringMatching(/^Session closed/) });
    expect(boardMode(S, true, "ok", at("2026-10-12T17:05:00Z")).kind).toBe("next"); // 13:05 on a half day
    expect(boardMode(S, false, "loading", at("2026-10-12T14:30:00Z")).kind).toBe("loading");
    expect(boardMode(S, false, "ok", at("2026-10-12T13:45:00Z"))).toEqual({ kind: "opening", line: "Opening range forming: first entries from 10:00 New York" });
    expect(boardMode(S, false, "ok", at("2026-10-12T14:30:00Z"))).toEqual({ kind: "live" });
  });

  it("writes the trigger prices and the runner", () => {
    const plan = focusPlan(ITEMS[1]!);
    expect(triggerLine(plan)).toBe("Calls above 752.86 · Puts below 748.39");
    expect(triggerLine({ call: null, put: null })).toBe("No trigger levels on the card");
    expect(runnerLine(plan.call, false)).toBe(
      "Sell half at 754.83, stop to 752.95, trail the rest under the 2-min EMA9 to 762.86 or 15:10. Needs 2 contracts within your $50 risk; otherwise skip.",
    );
    expect(runnerLine(plan.call, true)).toContain("or 12:10.");
    expect(runnerLine(null, false)).toBeNull();
  });
});

describe("the day from the journal", () => {
  const doc = (trades: { pnl: number; at: string }[], asOf: string): JournalDoc =>
    ({
      as_of: asOf,
      trades: trades.map((t, i) => ({ id: `t${i}`, symbol: "QQQ", kind: "call", qty: 1, entry: 1, exit: 1, pnl: t.pnl, opened_at: t.at, closed_at: t.at })),
      open: [],
    }) as unknown as JournalDoc;
  const now = new Date("2026-10-12T15:00:00Z");
  it("knows a winner closed today and the day's limit", () => {
    expect(boardDay(null, now)).toEqual({ dayLimitUsed: false, wonToday: null });
    expect(boardDay(doc([{ pnl: 20, at: "2026-10-12T14:40:00Z" }], "2026-10-12T14:59:00Z"), now)).toEqual({ dayLimitUsed: false, wonToday: true });
    expect(boardDay(doc([{ pnl: -120, at: "2026-10-12T14:40:00Z" }], "2026-10-12T14:59:00Z"), now)).toEqual({ dayLimitUsed: true, wonToday: false });
    // a journal that is not current cannot say
    expect(boardDay(doc([{ pnl: 20, at: "2026-10-12T14:40:00Z" }], "2026-10-12T11:00:00Z"), now).wonToday).toBeNull();
  });
});

// ---- the board, drawn ------------------------------------------------------------------------------------------------
const draw = (mode: BoardMode, rows: BoardRow[], paused = false) =>
  renderToStaticMarkup(createElement(TradeNowBoard, { mode, rows, now: Date.parse("2026-10-12T14:28:34Z"), paused, onOpen: () => undefined }));

describe("TradeNowBoard", () => {
  it("draws the header with the New York time, the live mark and the testing link", () => {
    const html = draw({ kind: "live" }, boardRows(atStep(3), true));
    expect(html).toContain("Trade now");
    expect(html).toContain("10:28 New York");
    expect(html).toContain(">live<");
    expect(html).toContain('href="/strategies"');
    expect(html).toContain("Testing · not proven yet");
    expect(html).toContain("nothing here places an order");
  });

  it("expands the entry and the live alternative, each with its grid; the runner folded", () => {
    const html = draw({ kind: "live" }, boardRows(atStep(3), true));
    expect(html.match(/data-expanded="true"/g)).toHaveLength(2);
    expect(html).toMatch(/data-board-row="QQQ" data-board-state="enter_zone" data-expanded="true"/);
    expect(html).toContain("ENTER ZONE · CALL");
    expect(html).toContain("Retest holding 752.86: call setup ready");
    expect(html.match(/data-board-grid/g)).toHaveLength(2);
    expect(html).toContain(">Enter</dt>");
    expect(html).toContain(">~752.95</dd>");
    expect(html).toMatch(/>752\.01<span[^>]*>or −25%<\/span><\/dd>/);
    expect(html).toContain(">Target 1</dt>");
    expect(html).toContain("Semis against");
    // the runner sits closed behind its summary, with the Testing tag
    expect(html).toMatch(/<details[^>]*data-board-runner[^>]*><summary[^>]*>Runner plan <span data-testing-tag/);
    expect(html).not.toMatch(/<details[^>]*open/);
    // the alternative names the live idea, warn, with the Testing tag; no red plan-off badge
    expect(html).toContain("FAILED BREAK · PUT");
    expect(html).not.toContain("PLAN OFF · ");
    expect(html).toMatch(/data-board-row="SPY" data-board-state="plan_off" data-board-alt="failed_break"/);
    expect(html.match(/data-testing-tag/g)).toHaveLength(2); // the failed break's, and the runner's
    expect(html).toContain("NO TRADE");
    // no sentence is set in the mono font: only prices and the grid's values
    expect(html).not.toMatch(/font-mono[^"]*">Retest holding/);
    // the order: entry, failed break, no trade
    expect(html.indexOf('data-board-row="QQQ"')).toBeLessThan(html.indexOf('data-board-row="SPY"'));
    expect(html.indexOf('data-board-row="SPY"')).toBeLessThan(html.indexOf('data-board-row="AAPL"'));
  });

  it("counts the cautions it does not show", () => {
    const rows = boardRows(atStep(3, { now: Date.parse("2026-10-12T15:10:00Z"), receivedAt: Date.parse("2026-10-12T15:09:59Z"), wonToday: true }), true);
    // at 11:10 the quotes are stale: every row pauses; draw the entry row's state by hand instead
    expect(rows[0]!.state!.state).toBe("paused");
    const entry = boardRows(atStep(3, { wonToday: true }), true)[0]!;
    const busy: BoardRow = { ...entry, state: { ...entry.state!, cautions: entry.state!.cautions.slice(0, 2), moreCautions: 2 } };
    expect(draw({ kind: "live" }, [busy])).toContain("+2 more");
  });

  it("draws one line per name for watch, get ready and missed", () => {
    for (const step of [1, 2, 4]) {
      const html = draw({ kind: "live" }, boardRows(atStep(step), true));
      expect(html).not.toContain('data-expanded="true"');
      expect(html).not.toContain("Runner plan");
    }
    expect(draw({ kind: "live" }, boardRows(atStep(1), true))).toContain("WATCH</span>");
    expect(draw({ kind: "live" }, boardRows(atStep(2), true))).toContain("GET READY · CALL");
    expect(draw({ kind: "live" }, boardRows(atStep(4), true))).toContain("don&#x27;t chase");
  });

  it("greys every row and says so when prices pause", () => {
    const rows = boardRows(atStep(3, { now: stepInstant(S, 3) + 60_000 }), true);
    const html = draw({ kind: "live" }, rows, true);
    expect(html).toContain(">paused<");
    expect(html).toContain("Prices paused: no entry is shown on old prices");
    expect(html.match(/PRICES PAUSED<\/span>/g)).toHaveLength(3);
    expect(html).not.toContain("ENTER ZONE");
  });

  it("shows the trigger prices only before 10:00 and outside the session", () => {
    const rows = boardRows(atStep(0), false);
    const opening = draw({ kind: "opening", line: "Opening range forming: first entries from 10:00 New York" }, rows);
    expect(opening).toContain("Opening range forming: first entries from 10:00");
    expect(opening).toContain("Calls above 752.86 · Puts below 748.39");
    expect(opening).not.toContain("NO TRADE");
    const next = draw({ kind: "next", line: "Next session Mon 12 Oct: first entries from 10:00 New York" }, rows);
    expect(next).toContain("Next session Mon 12 Oct");
    expect(next.match(/data-board-state="plan"/g)).toHaveLength(3);
  });

  it("draws no rows with the live prices off or an old focus card", () => {
    const rows = boardRows(atStep(3), true);
    const off = draw({ kind: "off", line: "Live prices off: use the plans below" }, rows);
    expect(off).toContain("Live prices off: use the plans below");
    expect(off).not.toContain("data-board-row");
    const old = draw({ kind: "old", line: "Focus card is for Mon 12 Oct: refreshed after 08:54 Sydney" }, rows);
    expect(old).toContain("Focus card is for Mon 12 Oct");
    expect(old).not.toContain("data-board-row");
  });

  it("keys notices on the entry and the failed break only", () => {
    const rows = boardRows(atStep(3), true);
    expect(rows.map((r) => noticeKey(r.state!) !== null)).toEqual([true, true, false]);
    expect(boardRows(atStep(4), true).every((r) => noticeKey(r.state!) === null)).toBe(true);
  });
});
