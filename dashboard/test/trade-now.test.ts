import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { actionableRow, alertMenuKey, alertMenuOutside, boardAlt, boardCollapsed, boardSide, parseBoardLog, TradeNowBoard } from "@/components/client/trade-now";
import { ladderBoardLine } from "@/components/client/ladder-live";
import { pausedAgeS } from "@/lib/level-ladder";
import { BARS_STALE_MS, type BarsFeed } from "@/lib/bars-feed";
import { type Bar2, type NameState, SERVER_SETTLE_MS } from "@/lib/trade-state";
import { focusOptions } from "@/lib/fixture-variants";
import { SCRIPT_ANSWER_LAG_MS, SCRIPT_SYMBOLS, scriptBars, scriptQuote, stepInstant } from "@/lib/fixture-script";
import type { LiveQuote, Options } from "@/lib/options";
import { focusPlan } from "@/lib/focus-plan";
import {
  barsInUse,
  boardAnnounce,
  boardNotices,
  type NoticeBook,
  RETELL_AFTER_MS,
  WITHDRAW_AFTER_MS,
  boardDay,
  type BoardInput,
  boardMode,
  nextEditionAt,
  refreshWords,
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
    serverFetchedAt: Object.fromEntries(ITEMS.map((i) => [i.symbol, stepInstant(S, step) + SERVER_SETTLE_MS])), // the script's bars are final
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
    // The next card follows the evening edition (built 21:52 UTC on weekdays), named in New York time.
    expect(boardMode(S, false, "ok", at("2026-10-13T14:00:00Z"))).toEqual({ kind: "old", line: "Focus card is for Mon 12 Oct: refreshed after the evening edition, Tue 13 Oct, 17:52 New York" });
    expect(boardMode(S, false, "ok", at("2026-10-12T20:05:00Z"))).toEqual({ kind: "next", line: "Session closed: the next focus card follows the evening edition, Mon 12 Oct, 17:52 New York" });
    // Across the November change: Friday after the build, so Monday's, an hour earlier in New York.
    expect(nextEditionAt(Date.parse("2026-10-30T22:00:00Z"))).toBe(Date.parse("2026-11-02T21:52:00Z"));
    expect(refreshWords(Date.parse("2026-10-30T22:00:00Z"))).toBe("the evening edition, Mon 2 Nov, 16:52 New York");
    expect(refreshWords(Date.parse("2026-10-30T21:00:00Z"))).toBe("the evening edition, Fri 30 Oct, 17:52 New York");
    expect(boardMode(S, false, "off", at("2026-10-12T14:30:00Z")).kind).toBe("off");
    expect(boardMode(S, false, "error", at("2026-10-12T14:30:00Z"))).toEqual({ kind: "off", line: "Live prices off: use the plans below" });
    expect(boardMode(S, false, "ok", at("2026-10-11T14:30:00Z"))).toEqual({ kind: "next", line: "Next session Mon 12 Oct: first entries from 09:35 New York" });
    expect(boardMode(S, false, "ok", at("2026-10-12T13:00:00Z")).kind).toBe("next");
    expect(boardMode(S, false, "ok", at("2026-10-12T20:05:00Z"))).toMatchObject({ kind: "next", line: expect.stringMatching(/^Session closed/) });
    expect(boardMode(S, true, "ok", at("2026-10-12T17:05:00Z")).kind).toBe("next"); // 13:05 on a half day
    expect(boardMode(S, false, "loading", at("2026-10-12T14:30:00Z")).kind).toBe("loading");
    expect(boardMode(S, false, "ok", at("2026-10-12T13:33:00Z"))).toEqual({ kind: "opening", line: "Opening range forming: first entries from 09:35 New York" });
    expect(boardMode(S, false, "ok", at("2026-10-12T13:35:00Z"))).toEqual({ kind: "live" }); // 09:35, the first entry
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

  it("counts trades against the cap, so a sell-half is one entry", () => {
    const at = (m: number) => `2026-10-12T14:${String(m).padStart(2, "0")}:00Z`;
    // Each buy of 2 is sold in two halves: two matched pieces of one position.
    const halves = (buys: number) =>
      ({
        as_of: "2026-10-12T14:59:00Z",
        open: [],
        trades: Array.from({ length: buys }, (_, i) =>
          [1, 2].map((k) => ({ id: `h${i}-${k}`, symbol: "QQQ", kind: "call", strike: 600 + i, expiry: "2026-10-12", side: "long", qty: 1, multiplier: 100, entry: 1, exit: 1.01, pnl: 1, opened_at: at(i * 5), closed_at: at(i * 5 + k), close: "order" })),
        ).flat(),
      }) as unknown as JournalDoc;
    expect(boardDay(halves(4), now).dayLimitUsed).toBe(false); // 8 pieces, 4 trades
    expect(boardDay(halves(5), now).dayLimitUsed).toBe(true);
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
    // AAPL (no trade) is not worth acting on: it is not listed, only counted
    expect(html).not.toContain('data-board-row="AAPL"');
    expect(html).not.toContain("NO TRADE");
    expect(html).toContain('data-board-hidden="1"');
    expect(html).toContain("1 more name watching");
    // no sentence is set in the mono font: only prices and the grid's values
    expect(html).not.toMatch(/font-mono[^"]*">Retest holding/);
    // the order: entry, then failed break
    expect(html.indexOf('data-board-row="QQQ"')).toBeLessThan(html.indexOf('data-board-row="SPY"'));
  });

  it("counts the cautions it does not show", () => {
    const rows = boardRows(atStep(3, { now: Date.parse("2026-10-12T15:10:00Z"), receivedAt: Date.parse("2026-10-12T15:09:59Z"), wonToday: true }), true);
    // at 11:10 the quotes are stale: every row pauses; draw the entry row's state by hand instead
    expect(rows[0]!.state!.state).toBe("paused");
    const entry = boardRows(atStep(3, { wonToday: true }), true)[0]!;
    const busy: BoardRow = { ...entry, state: { ...entry.state!, cautions: entry.state!.cautions.slice(0, 2), moreCautions: 2 } };
    expect(draw({ kind: "live" }, [busy])).toContain("+2 more");
  });

  it("lists a get-ready as one line, and says so when nothing is worth acting on", () => {
    for (const step of [1, 2, 4]) {
      const html = draw({ kind: "live" }, boardRows(atStep(step), true));
      expect(html).not.toContain('data-expanded="true"');
      expect(html).not.toContain("Runner plan");
    }
    // 10:22: both get-readies listed, AAPL counted
    const two = draw({ kind: "live" }, boardRows(atStep(2), true));
    expect(two).toContain("GET READY · CALL");
    expect(two.match(/data-board-row=/g)).toHaveLength(2);
    expect(two).toContain('data-board-hidden="1"');
    // 10:10 (all watching) and 10:41 (QQQ missed, the rest watching): no rows, one line
    for (const step of [1, 4]) {
      const html = draw({ kind: "live" }, boardRows(atStep(step), true));
      expect(html).not.toContain("data-board-row");
      expect(html).toContain("Nothing to act on: 3 names watching");
    }
  });

  it("keeps a row that holds an open form, whatever its state", () => {
    const rows = boardRows(atStep(4), true);
    const html = renderToStaticMarkup(
      createElement(TradeNowBoard, {
        mode: { kind: "live" },
        rows,
        now: Date.parse("2026-10-12T14:41:00Z"),
        paused: false,
        onOpen: () => undefined,
        rowExtra: (r: BoardRow) => (r.symbol === "QQQ" ? createElement("form", { "data-im-in-form": "QQQ" }) : null),
      }),
    );
    expect(html.match(/data-board-row=/g)).toHaveLength(1);
    expect(html).toMatch(/data-board-row="QQQ" data-board-state="watch"/);
    expect(html).toContain('data-im-in-form="QQQ"');
    expect(html).toContain('data-board-hidden="2"');
  });

  it("greys every row and says so when prices pause", () => {
    const rows = boardRows(atStep(3, { now: stepInstant(S, 3) + 60_000 }), true);
    const html = draw({ kind: "live" }, rows, true);
    expect(html).toContain(">paused<");
    expect(html).toContain("Prices paused: no entry is shown on old prices");
    // a paused row is never worth acting on: none is listed, and no number is shown
    expect(html).not.toContain("data-board-row");
    expect(html).not.toContain("data-board-grid");
    expect(html).not.toContain("Nothing to act on");
    expect(html).not.toContain("ENTER ZONE");
  });

  it("shows the trigger prices only before 10:00 and outside the session", () => {
    const rows = boardRows(atStep(0), false);
    const opening = draw({ kind: "opening", line: "Opening range forming: first entries from 09:35 New York" }, rows);
    expect(opening).toContain("Opening range forming: first entries from 09:35");
    expect(opening).toContain("Calls above 752.86 · Puts below 748.39");
    expect(opening).not.toContain("NO TRADE");
    const next = draw({ kind: "next", line: "Next session Mon 12 Oct: first entries from 09:35 New York" }, rows);
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

  it("folds into the rail before the open, unless a manage card is open", () => {
    for (const kind of ["next", "opening", "loading"] as const) {
      expect(boardCollapsed({ kind, line: "" }, 0)).toBe(true);
      expect(boardCollapsed({ kind, line: "" }, 1)).toBe(false);
    }
    expect(boardCollapsed({ kind: "live" }, 0)).toBe(false);
    expect(boardCollapsed({ kind: "off", line: "" }, 0)).toBe(false);
    expect(boardCollapsed({ kind: "old", line: "" }, 0)).toBe(false);
  });

  it("calls an entry, a get-ready and a live alternative worth acting on, and nothing paused", () => {
    expect(boardRows(atStep(3), true).map(actionableRow)).toEqual([true, true, false]);
    expect(boardRows(atStep(2), true).map(actionableRow)).toEqual([true, true, false]);
    expect(boardRows(atStep(1), true).some(actionableRow)).toBe(false);
    expect(boardRows(atStep(3, { now: stepInstant(S, 3) + 60_000 }), true).some(actionableRow)).toBe(false);
    expect(boardRows(atStep(0), false).some(actionableRow)).toBe(false);
  });

  it("keys notices on the entry and the failed break only", () => {
    const rows = boardRows(atStep(3), true);
    expect(rows.map((r) => noticeKey(r.state!) !== null)).toEqual([true, true, false]);
    expect(boardRows(atStep(4), true).every((r) => noticeKey(r.state!) === null)).toBe(true);
  });
});

// ---- the review's findings ------------------------------------------------------------------------------------------
const ny = (hms: string) => Date.parse(`${S}T${hms}-04:00`);

describe("a server bar still forming when the server read it", () => {
  // QQQ's call is above 752.86. The server read its bars at 10:21:45, mid-bar: its 10:20 bar then closed at 752.95.
  // The bar really closed at 752.70 (the page's own prices), so there is no break.
  const qqq = ITEMS.find((i) => i.symbol === "QQQ")!;
  const level = focusPlan(qqq).call!.level;
  const server: Bar2[] = [];
  for (let t = ny("09:30:00"); t < ny("10:20:00"); t += 120_000) server.push({ start: t, end: t + 120_000, o: 752.0, h: 752.3, l: 751.7, c: 752.0 });
  server.push({ start: ny("10:20:00"), end: ny("10:22:00"), o: 752.0, h: 752.95, l: 751.9, c: 752.95 });
  const quote: LiveQuote = { price: 752.75, at: new Date(ny("10:22:02")).toISOString(), open: 752, high: 752.95, low: 751.7, day: S, prev_close: 751, vwap: 752.1 };
  const input = (fetchedAt: number): BoardInput => ({
    session: S,
    halfDay: false,
    items: [qqq],
    tickers: E.tickers,
    quotes: { QQQ: quote },
    trails: {
      QQQ: [
        { at: ny("10:20:10"), p: 752.1 },
        { at: ny("10:21:44"), p: 752.95 },
        { at: ny("10:21:58"), p: 752.7 },
      ],
    },
    serverBars: { QQQ: server },
    serverFetchedAt: { QQQ: fetchedAt },
    now: ny("10:22:06"),
    receivedAt: ny("10:22:03"),
    dayLimitUsed: false,
    wonToday: false,
  });

  it("reads the trail's close for that slot, not the server's snapshot: no break", () => {
    expect(level).toBe(752.86);
    const st = boardRows(input(ny("10:21:45")), true)[0]!.state!;
    expect(st.call.brokeAt).toBeNull();
    expect(st.call.state).toBe("watch");
    expect(st.state).not.toBe("enter_zone");
  });

  it("uses the server's bar once it had settled when the server read it", () => {
    expect(boardRows(input(ny("10:22:00") + SERVER_SETTLE_MS), true)[0]!.state!.call.brokeAt).toBe(ny("10:22:00"));
  });

  it("uses no server bar for a name without a fetch time", () => {
    const st = boardRows({ ...input(ny("10:22:05")), serverFetchedAt: {} }, true)[0]!.state!;
    expect(st.call.brokeAt).toBeNull();
  });
});

describe("the session bars' age", () => {
  const ok = (receivedAt: number, failed = false): BarsFeed => ({ status: "ok", asOf: "x", bars: { SPY: [] }, fetchedAt: { SPY: 1 }, receivedAt, failed });

  it("uses the server's bars while they are fresh", () => {
    expect(barsInUse(ok(1_000), 1_000 + BARS_STALE_MS)).toEqual({ bars: { SPY: [] }, fetchedAt: { SPY: 1 }, delayed: false });
  });

  it("drops them, and says so, once they are older than BARS_STALE_MS or the last poll failed", () => {
    expect(barsInUse(ok(1_000), 1_001 + BARS_STALE_MS)).toEqual({ bars: {}, fetchedAt: {}, delayed: true });
    expect(barsInUse(ok(1_000, true), 2_000)).toEqual({ bars: {}, fetchedAt: {}, delayed: true });
    expect(barsInUse({ status: "error" }, 2_000)).toEqual({ bars: {}, fetchedAt: {}, delayed: true });
    expect(barsInUse(ok(1_000), null).delayed).toBe(true);
  });

  it("says nothing while loading or with the bars not configured", () => {
    expect(barsInUse({ status: "loading" }, 2_000)).toEqual({ bars: {}, fetchedAt: {}, delayed: false });
    expect(barsInUse({ status: "off" }, 2_000)).toEqual({ bars: {}, fetchedAt: {}, delayed: false });
  });

  it("falls back to the page's own prices: what the trail lacks reads as a gap, never an entry", () => {
    // step 3 without the server's bars and with no trail: QQQ's entry cannot be read
    const used = barsInUse(ok(0, true), 1);
    const rows = boardRows(atStep(3, { serverBars: used.bars, serverFetchedAt: used.fetchedAt }), true);
    expect(rows.some((r) => r.state!.state === "enter_zone")).toBe(false);
  });

  it("draws a muted line in the header while they are delayed", () => {
    const html = renderToStaticMarkup(
      createElement(TradeNowBoard, { mode: { kind: "live" }, rows: boardRows(atStep(3), true), now: Date.parse("2026-10-12T14:28:34Z"), paused: false, barsDelayed: true, onOpen: () => undefined }),
    );
    expect(html).toMatch(/text-muted-foreground[^"]*"[^>]*>Session bars delayed: states use this page&#x27;s prices only/);
    expect(draw({ kind: "live" }, boardRows(atStep(3), true))).not.toContain("Session bars delayed");
  });
});

describe("notices over a session", () => {
  const base = boardRows(atStep(3), true).find((r) => r.symbol === "QQQ")!.state!; // enter zone, call
  const watching = boardRows(atStep(1), true).find((r) => r.symbol === "QQQ")!.state!;
  const enterAt = (breakEnd: number): NameState => ({ ...base, call: { ...base.call, brokeAt: breakEnd } });
  const empty: NoticeBook = { seen: null, kept: [] };

  it("keys an entry on its break bar, so a new break at the same level is a new notice", () => {
    const first = enterAt(ny("10:28:00"));
    const again = enterAt(ny("11:42:00"));
    expect(noticeKey(first)).not.toBe(noticeKey(again));
    expect(noticeKey(first)).toContain(String(ny("10:26:00"))); // the break bar's start
    let b = boardNotices(empty, S, [watching]).book; // opened while watching: nothing told
    const r1 = boardNotices(b, S, [first]);
    expect(r1.fresh).toEqual([first]);
    b = boardNotices(r1.book, S, [watching]).book; // the entry failed
    const r2 = boardNotices(b, S, [again]);
    expect(r2.fresh).toEqual([again]);
    expect(r2.book.kept).toEqual([again]);
  });

  it("keys a live alternative on the bar that completed it", () => {
    const spy = boardRows(atStep(3), true).find((r) => r.symbol === "SPY")!.state!;
    expect(spy.alt).not.toBeNull();
    const later: NameState = { ...spy, alt: { ...spy.alt!, at: spy.alt!.at + 40 * 120_000 } };
    expect(noticeKey(spy)).toContain(String(spy.alt!.at));
    expect(noticeKey(later)).not.toBe(noticeKey(spy));
  });

  it("withdraws a notice once its state has gone, and never brings it back", () => {
    const first = enterAt(ny("10:28:00"));
    let b = boardNotices(empty, S, [watching]).book;
    b = boardNotices(b, S, [first]).book;
    expect(b.kept).toEqual([first]);
    b = boardNotices(b, S, [watching]).book;
    expect(b.kept).toEqual([]);
    // the same break back in the zone: already told, and the old notice does not reappear
    const back = boardNotices(b, S, [{ ...first, line: "newer" }]);
    expect(back.fresh).toEqual([]);
    expect(back.book.kept).toEqual([]);
  });

  it("with the board's clock: a one-render blip neither rings the entry again nor loses it", () => {
    const first = enterAt(ny("10:28:00"));
    const t0 = ny("10:28:05");
    let b = boardNotices(empty, S, [watching], t0).book;
    const r1 = boardNotices(b, S, [first], t0 + 1_000);
    expect(r1.fresh).toEqual([first]);
    b = boardNotices(r1.book, S, [watching], t0 + 2_000).book; // one bars poll failed: off the board for a moment
    expect(b.kept).toEqual([first]); // kept (not shown: the board shows only live keys)
    const back = boardNotices(b, S, [first], t0 + 3_000);
    expect(back.fresh).toEqual([]);
    expect(back.book.kept).toEqual([first]);
    // gone for longer than WITHDRAW_AFTER_MS: withdrawn
    let g = boardNotices(back.book, S, [watching], t0 + 4_000).book;
    g = boardNotices(g, S, [watching], t0 + 4_000 + WITHDRAW_AFTER_MS).book;
    expect(g.kept).toEqual([]);
  });

  it("with the board's clock: a break bar that shifts by one slot is the same entry; a new break past the window rings", () => {
    const t0 = ny("10:28:05");
    let b = boardNotices(empty, S, [watching], t0).book;
    const r1 = boardNotices(b, S, [enterAt(ny("10:28:00"))], t0 + 1_000);
    expect(r1.fresh).toHaveLength(1);
    // the bars switched source and the break now reads one bar later: not told again, but shown with the live state
    const shifted = enterAt(ny("10:30:00"));
    const r2 = boardNotices(r1.book, S, [shifted], t0 + 60_000);
    expect(r2.fresh).toEqual([]);
    expect(r2.book.kept).toEqual([shifted]);
    // a genuinely new break later in the session, past the retest window: told
    b = boardNotices(r2.book, S, [watching], t0 + 120_000).book;
    const later = enterAt(ny("11:42:00"));
    expect(boardNotices(b, S, [later], t0 + RETELL_AFTER_MS + 120_000).fresh).toEqual([later]);
  });

  it("comes back as the same book when nothing changed", () => {
    const b = boardNotices(empty, S, [watching]).book;
    expect(boardNotices(b, S, [watching]).book).toBe(b);
  });
});

describe("the alerts bell", () => {
  it("claims every Escape while open, and gives the focus back to the bell only when it was in the menu", () => {
    expect(alertMenuKey("Escape", true)).toEqual({ close: true, refocus: true });
    // the focus elsewhere: the menu still closes (and the cockpit stays), the focus is left where it is
    expect(alertMenuKey("Escape", false)).toEqual({ close: true, refocus: false });
    expect(alertMenuKey("Enter", true)).toEqual({ close: false, refocus: false });
  });

  it("closes on a click outside and gives the focus back to the bell, unless the click lands on another control", () => {
    expect(alertMenuOutside(true, false)).toEqual({ close: false, refocus: false });
    expect(alertMenuOutside(false, false)).toEqual({ close: true, refocus: true });
    expect(alertMenuOutside(false, true)).toEqual({ close: true, refocus: false });
  });
});

// ---- the Now hero's pure parts ---------------------------------------------------------------------------------------
describe("the Now hero", () => {
  it("shows the entry's three numbers, a get-ready's plan, and none on paused prices", async () => {
    const { heroTiles } = await import("@/components/client/now-hero");
    const [qqq] = boardRows(atStep(3), true);
    expect(heroTiles(qqq!, rowView(qqq!.state!), false)).toEqual({ enter: "~752.95", stop: "752.01 or −25%", target: "754.83", plan: false });
    expect(heroTiles(qqq!, rowView(qqq!.state!), true)).toBeNull();
    const ready = boardRows(atStep(2), true)[0]!;
    expect(ready.state!.state).toBe("get_ready");
    expect(heroTiles(ready, rowView(ready.state!), false)).toMatchObject({ plan: true });
    const aapl = boardRows(atStep(3), true)[2]!;
    expect(heroTiles(aapl, rowView(aapl.state!), false)).toBeNull();
    const stale = boardRows(atStep(3, { now: stepInstant(S, 3) + 60_000 }), true)[0]!;
    expect(heroTiles(stale, rowView(stale.state!), false)).toBeNull();
  });

  it("never shows a reassuring manage word on paused prices", async () => {
    const { heroManage } = await import("@/components/client/now-hero");
    for (const action of ["hold", "trail", "sell_half"] as const) {
      expect(heroManage({ action, tone: "good", line: "Holding" }, false).word).not.toBe("CHECK");
      expect(heroManage({ action, tone: "good", line: "Holding" }, true)).toEqual({ word: "CHECK", tone: "warn", line: "Prices paused: manage this one on your platform" });
    }
    expect(heroManage({ action: "exit", tone: "bad", line: "Below the stop: exit" }, true).word).toBe("EXIT");
  });
});

// ---- the second review's findings ----------------------------------------------------------------------------------
/** A name's board read, as useBoardRow gives it. */
const read = (row: BoardRow, paused = false) => ({ row, view: row.state ? rowView(row.state) : null, paused });
/** A row paused on its own: its quote went stale while the others' did not. */
const pausedRow = (row: BoardRow): BoardRow => ({ ...row, state: { ...row.state!, state: "paused", line: "Prices paused: check your platform" } });

describe("the side the board points at", () => {
  it("is an entry's or a get-ready's side only", () => {
    const [qqq] = boardRows(atStep(3), true);
    expect(qqq!.state!.state).toBe("enter_zone");
    expect(boardSide(read(qqq!))).toBe("call");
    const ready = boardRows(atStep(2), true)[0]!;
    expect(ready.state!.state).toBe("get_ready");
    expect(boardSide(read(ready))).toBe(ready.state!.side);
  });

  it("is none while prices are paused, the whole board's or the name's own", () => {
    const [qqq] = boardRows(atStep(3), true);
    expect(boardSide(read(qqq!, true))).toBeNull();
    const stale = boardRows(atStep(3, { now: stepInstant(S, 3) + 60_000 }), true)[0]!;
    expect(stale.state!.state).toBe("paused");
    expect(boardSide(read(stale))).toBeNull();
    expect(boardAlt(read(stale))).toBeNull();
    expect(boardSide(null)).toBeNull();
  });

  it("is none for a live alternative, whose numbers are not either plan strip's: the alternative is named instead", () => {
    // SPY at 10:28: the call plan is off, the failed break put at the ceiling (779.40) is live
    const spy = boardRows(atStep(3), true).find((r) => r.symbol === "SPY")!;
    expect(spy.state!.state).toBe("plan_off");
    expect(boardSide(read(spy))).toBeNull();
    expect(boardAlt(read(spy))).toEqual({ kind: "failed_break", side: "put" });
    expect(boardAlt(read(spy, true))).toBeNull();
    // the same alternative on a watching row
    const watching: BoardRow = { ...spy, state: { ...spy.state!, state: "watch" } };
    expect(rowView(watching.state!).badge.alt).toBe("failed_break");
    expect(boardSide(read(watching))).toBeNull();
    expect(boardAlt(read(watching))).toEqual({ kind: "failed_break", side: "put" });
    // an entry has no alternative to name
    expect(boardAlt(read(boardRows(atStep(3), true)[0]!))).toBeNull();
  });

  it("tells a screen reader what the ladder draws, never a side it does not dim", () => {
    expect(ladderBoardLine("call", null)).toBe("The call side is highlighted; the put side is dimmed.");
    expect(ladderBoardLine(null, { kind: "failed_break", side: "put" })).toBe("The failed break put is live now on the board; no side is dimmed.");
    expect(ladderBoardLine(null, null)).toBe("No side is highlighted.");
  });
});

describe("a name paused on its own", () => {
  it("is named apart with what to do, never counted as watching", () => {
    // 10:10: all three watching, then QQQ's prices pause on their own
    const rows = boardRows(atStep(1), true).map((r) => (r.symbol === "QQQ" ? pausedRow(r) : r));
    const html = draw({ kind: "live" }, rows);
    expect(html).toContain('data-board-paused="1"');
    expect(html).toContain("QQQ: prices paused, check your platform");
    expect(html).toContain("Nothing to act on: 2 names watching");
    expect(html).not.toContain("3 names watching");
  });

  it("beside an entry: the entry listed, the paused name named, the rest counted", () => {
    const rows = boardRows(atStep(3), true).map((r) => (r.symbol === "SPY" ? pausedRow(r) : r));
    const html = draw({ kind: "live" }, rows);
    expect(html).toMatch(/data-board-row="QQQ" data-board-state="enter_zone"/);
    expect(html).not.toContain('data-board-row="SPY"');
    expect(html).toContain("SPY: prices paused, check your platform");
    expect(html).toContain('data-board-hidden="1"');
    expect(html).toContain("1 more name watching");
  });

  it("all paused but one: no watching line at all", () => {
    const rows = boardRows(atStep(1), true).map((r) => (r.symbol === "AAPL" ? r : pausedRow(r)));
    const html = draw({ kind: "live" }, rows);
    expect(html).toContain("SPY, QQQ: prices paused, check your platform");
    expect(html).toContain("Nothing to act on: 1 name watching");
    const all = boardRows(atStep(1), true).map(pausedRow);
    const none = draw({ kind: "live" }, all.slice(0, 2));
    expect(none).toContain("SPY, QQQ: prices paused");
    expect(none).not.toContain("watching");
  });
});

describe("the Today log read back from this browser", () => {
  it("keeps only well-formed lines: a side of call, put or none, and a known tone", () => {
    const good = { at: 1, symbol: "QQQ", word: "ENTER ZONE", side: "call", tone: "good" };
    const raw = JSON.stringify([
      good,
      { ...good, side: null, tone: "neutral" },
      { ...good, side: "long" },
      { ...good, side: undefined },
      { ...good, tone: "purple" },
      { ...good, tone: 3 },
      { ...good, at: "10:28" },
      { ...good, at: null },
      { ...good, symbol: 7 },
      null,
      "QQQ",
      [good],
    ]);
    expect(parseBoardLog(raw)).toEqual([good, { ...good, side: null, tone: "neutral" }]);
    expect(parseBoardLog("{not json")).toEqual([]);
    expect(parseBoardLog(JSON.stringify({ at: 1 }))).toEqual([]);
    expect(parseBoardLog(null)).toEqual([]);
  });
});

describe("the paused age", () => {
  const now = ny("10:30:00");
  const q = (at: string, day = S) => ({ day, price: 752, at: new Date(ny(at)).toISOString().replace(/\.\d+Z$/, "Z") });
  it("is the older of the feed's answer and the last trade, as the ladder's caption reads it", () => {
    // the feed answered 5 s ago, the last trade was 40 s ago: 40
    expect(pausedAgeS(now, now - 5_000, { ...q("10:29:20") }, S)).toBe(40);
    // the feed stopped 90 s ago, the last trade 40 s ago: 90 (the old hero said 90 only past the feed's limit)
    expect(pausedAgeS(now, now - 90_000, q("10:29:20"), S)).toBe(90);
    // a quote from another day, or no clock: not known
    expect(pausedAgeS(now, now - 5_000, q("10:29:20", "2026-10-09"), S)).toBeNull();
    expect(pausedAgeS(null, now, q("10:29:20"), S)).toBeNull();
    expect(pausedAgeS(now, null, q("10:29:20"), S)).toBeNull();
    expect(pausedAgeS(now, now, undefined, S)).toBeNull();
  });
});

describe("the hero before the live mode", () => {
  it("draws the #1 name's triggers full size before the open, greyed with prices off, and none for an old card", async () => {
    const { heroTriggers } = await import("@/components/client/now-hero");
    expect(heroTriggers("next")).toBe("full");
    expect(heroTriggers("opening")).toBe("full");
    expect(heroTriggers("loading")).toBe("full");
    expect(heroTriggers("off")).toBe("grey");
    expect(heroTriggers("old")).toBe("none");
  });
});
