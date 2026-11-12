// Where the board's event line is drawn (DEC-0042, note of 2026-11-12): in the status rail while the board is folded
// into it (before the open, while connecting, after the close), inside the board once it is drawn, and never in both.
// The calendar here is the repo's own with two synthetic earnings rows added on days the fixtures never use.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DoneTodayContext, type DoneToday } from "@/components/client/done-today";
import { StatusRail } from "@/components/client/status-rail";
import { BoardContext, TradeNow, type Board } from "@/components/client/trade-now";
import { FROZEN_NOW, focusOptions } from "@/lib/fixture-variants";
import { SCRIPT_ANSWER_LAG_MS, SCRIPT_STEPS, SCRIPT_SYMBOLS, scriptBars, scriptQuote, stepInstant } from "@/lib/fixture-script";
import { nyInstant, type LiveQuote, type Options } from "@/lib/options";
import { type BoardInput, boardMode, boardRows } from "@/lib/trade-now";
import { SERVER_SETTLE_MS } from "@/lib/trade-state";
import type { ManageView } from "@/lib/trade-manage";
import optionsJson from "./fixtures/options.v1.json";

vi.mock("@/lib/market-calendar.json", async (importOriginal) => {
  const real = ((await importOriginal()) as { default: { earnings: unknown[] } }).default;
  return {
    default: {
      ...real,
      earnings: [
        ...real.earnings,
        { date: "2026-12-04", symbol: "MSFT", when: "bmo", quality: "confirmed" },
        { date: "2026-12-04", symbol: "AAPL", when: "amc", quality: "confirmed" },
      ],
    },
  };
});

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, the fixtures' day

/** New York wall clock on a day, "HH:MM" or "HH:MM:SS", as an instant. */
const at = (day: string, t: string) => {
  const [h, m, s = 0] = t.split(":").map(Number);
  return nyInstant(day, h! * 60 + m!)! + s * 1000;
};

/** A page board for `session` at `now`, its mode worked out as the page does; live rows from the fixture script. */
function board(session: string, now: number | null, names: readonly string[], feed: "ok" | "loading" | "off" = "ok", managed: readonly string[] = []): Board {
  const items = names.map((symbol, i) => ({ ...E.focus!.items[i % E.focus!.items.length]!, symbol, rank: i + 1 }));
  const mode = now === null ? ({ kind: "loading", line: "Connecting to live prices" } as const) : boardMode(session, false, feed, now);
  let rows: Board["rows"] = [];
  if (mode.kind === "live" && session === S) {
    const step = 3;
    const quotes: Record<string, LiveQuote> = {};
    for (const s of SCRIPT_SYMBOLS) quotes[s] = scriptQuote(s, S, step)! as LiveQuote;
    const t = stepInstant(S, step) + SCRIPT_ANSWER_LAG_MS;
    const input: BoardInput = {
      session: S,
      halfDay: false,
      items: E.focus!.items,
      tickers: E.tickers,
      quotes,
      trails: {},
      serverBars: Object.fromEntries(E.focus!.items.map((i) => [i.symbol, scriptBars(i.symbol, S, step)])),
      serverFetchedAt: Object.fromEntries(E.focus!.items.map((i) => [i.symbol, stepInstant(S, step) + SERVER_SETTLE_MS])),
      now: t + 1_000,
      receivedAt: t,
      dayLimitUsed: false,
      wonToday: false,
    };
    rows = boardRows(input, true);
  }
  const views = managed.map((symbol) => ({ id: `t-${symbol}`, key: `t-${symbol}`, symbol, side: "call", action: "hold", tone: "good", line: "Holding" }) as unknown as ManageView);
  return {
    on: true,
    session,
    halfDay: false,
    items,
    ticker: (s) => E.tickers.find((t) => t.symbol === s),
    premarket: {},
    closeDate: null,
    ageS: {},
    mode,
    now,
    rows,
    states: rows.map((r) => r.state!).filter(Boolean),
    paused: false,
    barsDelayed: false,
    manage: { cards: null, rowExtra: () => null, notices: null, views, provisional: 0, journalLive: true } as unknown as Board["manage"],
    notices: [],
    dropNotice: () => undefined,
    log: [],
    spoken: "",
    doneFor: () => false,
    maskFor: () => null,
  };
}

const DONE: DoneToday = {
  read: { status: "ok", view: { done: false, day: null, at: null, canUndo: false, undoLeftS: 0 } },
  done: false,
  stale: false,
  busy: false,
  failed: null,
  canUndo: false,
  mark: async () => true,
  undo: async () => true,
  clearFailed: () => undefined,
  setPolling: () => undefined,
};

const draw = (b: Board, node: ReactNode) =>
  renderToStaticMarkup(createElement(DoneTodayContext.Provider, { value: DONE }, createElement(BoardContext.Provider, { value: b }, node))).replaceAll("&#x27;", "'");
/** The rail and the board as the page draws them, one after the other. */
const page = (b: Board) => ({ rail: draw(b, createElement(StatusRail, { day: null })), board: draw(b, createElement(TradeNow)) });
const count = (html: string) => html.split("data-board-events=").length - 1;

describe("folded before the open: the line is in the rail", () => {
  const D = "2026-12-04"; // a jobs report at 08:30; MSFT before the open and AAPL after the close (synthetic)

  it("07:59: the release ahead, MSFT before the open, AAPL after the close; the board itself is not drawn", () => {
    const b = board(D, at(D, "07:59"), ["MSFT", "AAPL"]);
    expect(b.mode.kind).toBe("next");
    const { rail, board: drawn } = page(b);
    expect(drawn).toBe("");
    expect(count(rail)).toBe(1);
    expect(rail).toContain('data-board-events-where="rail"');
    expect(rail).toContain("<span>Jobs report today at 08:30 New York</span>");
    expect(rail).toContain("<span>MSFT earnings were before today's open</span>");
    expect(rail).toContain("<span>AAPL earnings today after the close (16:00 New York)</span>");
  });

  it("08:00:00 exactly: in 30 min; 08:31: was at 08:30", () => {
    expect(page(board(D, at(D, "08:00:00"), [])).rail).toContain("<span>Jobs report at 08:30 New York, in 30 min</span>");
    expect(page(board(D, at(D, "08:31"), [])).rail).toContain("<span>Jobs report was at 08:30 New York today</span>");
  });

  it("while connecting (the feed's first answer not in), the line stays in the rail", () => {
    const b = board(D, at(D, "09:10"), ["MSFT"], "loading");
    expect(b.mode.kind).toBe("loading");
    const { rail, board: drawn } = page(b);
    expect(drawn).toBe("");
    expect(count(rail)).toBe(1);
  });

  it("the folded rail grows by the one line only: without events the rail is the same less that line", () => {
    const with_ = page(board(D, at(D, "08:10"), ["SPY"])).rail;
    const quiet = page(board("2026-12-03", at("2026-12-03", "08:10"), ["SPY"])).rail;
    expect(count(with_)).toBe(1);
    expect(count(quiet)).toBe(0);
    expect(with_.replace(/<p data-board-events.*?<\/p>/, "")).toBe(quiet.replaceAll("2026-12-03", "2026-12-04").replace(/<p data-board-events.*?<\/p>/, ""));
  });
});

describe("unfolded: the line is in the board, and in the board only", () => {
  const D = "2026-12-09"; // the Fed decision at 14:00, AVGO after the close (the repo's own rows)

  it("in the live mode it is drawn exactly once on the page, inside the board", () => {
    const b = board(D, at(D, "10:00"), ["AVGO"]);
    expect(b.mode.kind).toBe("live");
    const { rail, board: drawn } = page(b);
    expect(count(rail)).toBe(0);
    expect(count(drawn)).toBe(1);
    expect(drawn).toContain('data-board-events-where="board"');
    expect(drawn).toContain("<span>Fed decision today at 14:00 New York</span>");
    expect(drawn).toContain("<span>AVGO earnings today after the close (16:00 New York)</span>");
  });

  it("before the open with a manage card open the board is drawn, so the line moves into it", () => {
    const { rail, board: drawn } = page(board(D, at(D, "08:00"), ["AVGO"], "ok", ["AVGO"]));
    expect(count(rail)).toBe(0);
    expect(count(drawn)).toBe(1);
  });

  it("with live prices off the board is drawn, and the line with it", () => {
    const b = board(D, at(D, "10:00"), ["AVGO"], "off");
    expect(b.mode.kind).toBe("off");
    const { rail, board: drawn } = page(b);
    expect(count(rail) + count(drawn)).toBe(1);
    expect(count(drawn)).toBe(1);
  });
});

describe("after the close the board folds again and the line goes back to the rail", () => {
  it("16:30 on the Fed day: the release past, AVGO's report still named", () => {
    const D = "2026-12-09";
    const b = board(D, at(D, "16:30"), ["AVGO"]);
    expect(b.mode.kind).toBe("next");
    const { rail, board: drawn } = page(b);
    expect(drawn).toBe("");
    expect(count(rail)).toBe(1);
    expect(rail).toContain("<span>Fed decision was at 14:00 New York today</span>");
  });
});

describe("the fixtures draw no line in any state", () => {
  const names = E.focus!.items.map((i) => i.symbol);
  const cases: [string, Board][] = [
    ["frozen clock (live)", board(S, Date.parse(FROZEN_NOW), names)],
    ...SCRIPT_STEPS.map((_, step): [string, Board] => [`script step ${step}`, board(S, stepInstant(S, step), names)]),
    ["before the open", board(S, at(S, "08:00"), names)],
    ["opening range", board(S, at(S, "09:31"), names)],
    ["after the close", board(S, at(S, "16:30"), names)],
    ["connecting", board(S, Date.parse(FROZEN_NOW), names, "loading")],
    ["no clock yet", board(S, null, names)],
    ["prices off", board(S, Date.parse(FROZEN_NOW), names, "off")],
    ["a manage card open", board(S, Date.parse(FROZEN_NOW), names, "ok", ["QQQ"])],
    // feeds-late and the evening: an edition for the session before, and one for the session after, read on the fixture day.
    ["older edition", board("2026-10-09", Date.parse(FROZEN_NOW), names)],
    ["next edition", board("2026-10-13", at(S, "18:00"), names)],
  ];
  it("covers every board mode", () => {
    expect(new Set(cases.map(([, b]) => b.mode.kind))).toEqual(new Set(["live", "next", "opening", "loading", "off", "old"]));
  });
  for (const [what, b] of cases) {
    it(what, () => {
      const { rail, board: drawn } = page(b);
      expect(count(rail) + count(drawn)).toBe(0);
    });
  }
});
