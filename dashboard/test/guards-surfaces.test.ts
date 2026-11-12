// Once a bad-data guard is on and trips, the pause holds everywhere the name appears: the ladder shows no dot or
// distance at the suspect price, a kept entry notice goes at once, the manage card for an open trade says the data is
// suspect and shows nothing worked out from it, and the board's one paused line names the guard. Also the page's
// re-read of the switches (use-guards.ts): a failed read after a good one keeps the good switches and marks the slot.
// Every one of these is unchanged with every guard off (guards-off.test.ts holds that byte for byte).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManageCard } from "@/components/client/trade-manage";
import { TradeNowBoard } from "@/components/client/trade-now";
import { firstHold, nextHold } from "@/components/client/use-guards";
import { ENGINE_VERSION, type PageRecord, type ServerRecord } from "@/lib/desk-eval";
import { parsePagePost } from "@/lib/desk-page-run";
import { shadowSummary } from "@/lib/desk-shadow";
import { pageBody } from "@/lib/desk-shadow-client";
import { suspectQuote } from "@/lib/fixture-suspect";
import { SCRIPT_ANSWER_LAG_MS, SCRIPT_SYMBOLS, scriptBars, scriptQuote, stepInstant } from "@/lib/fixture-script";
import { focusOptions } from "@/lib/fixture-variants";
import { focusPlan } from "@/lib/focus-plan";
import { ladderLiveState, ladderLiveView, SUSPECT_CAPTION } from "@/lib/level-ladder";
import type { LiveQuote, Options } from "@/lib/options";
import { GUARD_REASONS, type GuardReason } from "@/lib/quote-guards";
import { manageView, type ManualNote, openTrades } from "@/lib/trade-manage";
import { type BoardInput, boardNotices, boardRows, type NoticeBook } from "@/lib/trade-now";
import { SERVER_SETTLE_MS } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session;
const ITEMS = E.focus!.items;
const ALL: GuardReason[] = [...GUARD_REASONS];

function atStep(step: number, bend: (s: string, q: LiveQuote) => LiveQuote = (_s, q) => q, over: Partial<BoardInput> = {}): BoardInput {
  const quotes: Record<string, LiveQuote> = {};
  for (const s of SCRIPT_SYMBOLS) quotes[s] = bend(s, scriptQuote(s, S, step)!);
  const at = stepInstant(S, step) + SCRIPT_ANSWER_LAG_MS;
  return {
    session: S,
    halfDay: false,
    items: ITEMS,
    tickers: E.tickers,
    quotes,
    trails: {},
    serverBars: Object.fromEntries(ITEMS.map((i) => [i.symbol, scriptBars(i.symbol, S, step)])),
    serverFetchedAt: Object.fromEntries(ITEMS.map((i) => [i.symbol, stepInstant(S, step) + SERVER_SETTLE_MS])),
    now: at + 1_000,
    receivedAt: at,
    dayLimitUsed: false,
    wonToday: false,
    ...over,
  };
}
const crossedQQQ = (s: string, q: LiveQuote) => (s === "QQQ" ? suspectQuote(q, "quote-crossed") : q);
const crossedAll = (_s: string, q: LiveQuote) => suspectQuote(q, "quote-crossed");

describe("the ladder", () => {
  const ladder = (step: number, guards?: readonly string[]) => {
    const input = atStep(step, crossedQQQ);
    return ladderLiveState({
      feed: { status: "ok", asOf: new Date(input.receivedAt!).toISOString(), receivedAt: input.receivedAt!, quotes: input.quotes },
      browserNow: input.now,
      symbol: "QQQ",
      session: S,
      halfDay: false,
      premarket: null,
      close: null,
      closeDate: null,
      ceiling: 752.86,
      floor: 748,
      atr: 2,
      move: null,
      ...(guards ? { guards } : {}),
    });
  };

  it("reads a guard-paused name as paused: no live dot at the suspect price, no distances, the suspect caption", () => {
    const live = ladder(3);
    expect(live.dot?.kind).toBe("live");
    expect(live.distances.length).toBeGreaterThan(0);
    expect(ladder(3, ["quote-crossed"])).toEqual({ dot: null, caption: SUSPECT_CAPTION, distances: [], from: null });
    // no guard given, or an empty list: as before
    expect(ladder(3, [])).toEqual(live);
  });

  it("outside the live board (before the open, after the close) a guard changes nothing: the guards run in the session only", () => {
    const base = { phase: "before" as const, today: null, fresh: false, ageS: null, premarket: 750, close: 748, closeDate: null, ceiling: 752, floor: 747, atr: 2, move: null };
    expect(ladderLiveView({ ...base, mode: "next", guards: ["quote-crossed"] })).toEqual(ladderLiveView({ ...base, mode: "next" }));
  });
});

describe("a kept enter-zone notice", () => {
  it("is withdrawn at once when its row turns paused by a guard; a pause for no fresh price keeps the 30 s keep", () => {
    const first = boardRows(atStep(2), true).map((r) => r.state!);
    let book: NoticeBook = boardNotices({ seen: null, kept: [] }, S, first, atStep(2).now).book;
    const entry = boardRows(atStep(3), true).map((r) => r.state!);
    const told = boardNotices(book, S, entry, atStep(3).now);
    expect(told.fresh.map((s) => `${s.symbol}:${s.state}`)).toContain("QQQ:enter_zone");
    book = told.book;
    const t = atStep(3).now + 2_000;
    // QQQ paused by its crossed quote: the notice goes now
    const guarded = boardRows(atStep(3, crossedQQQ, { guards: { on: ["quote-crossed"] }, now: t }), true).map((r) => r.state!);
    expect(guarded.find((s) => s.symbol === "QQQ")!.guards).toEqual(["quote-crossed"]);
    expect(boardNotices(book, S, guarded, t).book.kept.map((s) => s.symbol)).not.toContain("QQQ");
    // QQQ paused for no fresh price: the notice is kept for the keep
    const stale = boardRows(atStep(3, undefined, { now: t, receivedAt: t - 60_000 }), true).map((r) => r.state!);
    expect(stale.find((s) => s.symbol === "QQQ")!.state).toBe("paused");
    expect(boardNotices(book, S, stale, t).book.kept.map((s) => s.symbol)).toContain("QQQ");
  });
});

describe("the manage card for an open trade on a guard-paused name", () => {
  const QQQ = ITEMS.find((i) => i.symbol === "QQQ")!;
  const CALL = focusPlan(QQQ).call!;
  const clock = (step: number) => stepInstant(S, step) + SCRIPT_ANSWER_LAG_MS + 1_000;
  const note: ManualNote = { symbol: "QQQ", side: "call", price: scriptQuote("QQQ", S, 3)!.price, at: new Date(clock(3)).toISOString(), kind: "plan", plan: CALL };
  const view = (step: number, guards?: GuardReason[]) => {
    const [t] = openTrades(ITEMS, [], [note], S, [], null);
    return manageView(t!, {
      session: S,
      halfDay: false,
      quote: suspectQuote(scriptQuote("QQQ", S, step)!, "quote-crossed"),
      trail: [],
      serverBars: scriptBars("QQQ", S, step),
      serverFetchedAt: stepInstant(S, step) + SERVER_SETTLE_MS,
      now: clock(step),
      rowState: guards ? "paused" : "watch",
      ...(guards ? { guards } : {}),
      feed: "live",
    });
  };

  it("says CHECK with the guard's line, and shows nothing worked out from the suspect price, not even an EXIT", () => {
    // at step 5 the card would say EXIT on these prices
    expect(view(5).action).toBe("exit");
    for (const step of [3, 4, 5]) {
      const v = view(step, ["quote-crossed"]);
      expect(v).toMatchObject({ action: "check", tone: "warn", line: "Suspect data, the bid is above the ask: check your platform", price: null, stopAtEntry: false, trailText: "–", notWorkingText: "–" });
      // the plan's own stop and target 1 stay, unmoved; the flat time stays
      expect(v.m.stop).toBe(CALL.stop);
      expect(v.m.target1).toBe(CALL.target1);
      expect(v.m.trail).toBeNull();
      expect(v.flatAt).toBe("15:10");
      const html = renderToStaticMarkup(createElement(ManageCard, { v })).replaceAll("&#x27;", "'");
      expect(html).toContain('data-manage-action="check"');
      expect(html).toContain("Suspect data, the bid is above the ask: check your platform");
      expect(html).not.toContain("EXIT");
      expect(html).not.toContain("bg-bad-soft");
    }
  });
});

describe("the board's paused line", () => {
  it("with every name paused and any by a guard, names the guard; the others read as paused for old prices", () => {
    const draw = (input: BoardInput) => {
      const rows = boardRows(input, true);
      const paused = rows.every((r) => r.state!.state === "paused");
      return { paused, html: renderToStaticMarkup(createElement(TradeNowBoard, { mode: { kind: "live" }, rows, now: input.now, paused, onOpen: () => undefined })).replaceAll("&#x27;", "'") };
    };
    const all = draw(atStep(3, crossedAll, { guards: { on: ALL } }));
    expect(all.paused).toBe(true);
    expect(all.html).toContain("Prices paused. SPY: Suspect data, the bid is above the ask: check your platform.");
    expect(all.html).toContain("QQQ: Suspect data, the bid is above the ask: check your platform.");
    expect(all.html).not.toContain("no entry is shown on old prices");
    // QQQ by a guard, the others for no fresh price (their trades are old)
    const old = new Date(stepInstant(S, 3) - 300_000).toISOString();
    const mixed = draw(atStep(3, (s, q) => (s === "QQQ" ? { ...suspectQuote(q, "quote-crossed") } : { ...q, at: old }), { guards: { on: ALL } }));
    expect(mixed.paused).toBe(true);
    expect(mixed.html).toContain("Prices paused. QQQ: Suspect data, the bid is above the ask: check your platform.");
    expect(mixed.html).toMatch(/SPY, AAPL: no entry is shown on old prices\. Check your platform\.|AAPL, SPY: no entry is shown on old prices\. Check your platform\./);
    // no guard: the line as before
    const stale = draw(atStep(3, (_s, q) => ({ ...q, at: old })));
    expect(stale.html).toContain("Prices paused: no entry is shown on old prices. Check your platform.");
  });
});

describe("the page's re-read of the switches", () => {
  const ok = (on: GuardReason[]) => ({ status: "ok" as const, on });
  it("a failed read after a good one keeps the good switches and marks them unsure; the next good read clears it", () => {
    let h = firstHold(["quote-crossed"], "ok");
    expect(h).toEqual({ on: ["quote-crossed"], good: true, unsure: false });
    h = nextHold(h, null);
    expect(h).toEqual({ on: ["quote-crossed"], good: true, unsure: true });
    h = nextHold(h, { status: "error", on: [] });
    expect(h).toEqual({ on: ["quote-crossed"], good: true, unsure: true });
    h = nextHold(h, ok([]));
    expect(h).toEqual({ on: [], good: true, unsure: false });
    const same = nextHold(h, ok([]));
    expect(same).toBe(h);
  });

  it("before any good read, a failure is every guard off, not unsure", () => {
    let h = firstHold(["quote-crossed"], "error");
    expect(h).toEqual({ on: [], good: false, unsure: false });
    h = nextHold(h, null);
    expect(h).toEqual({ on: [], good: false, unsure: false });
    h = nextHold(h, ok(["quote-crossed"]));
    expect(h).toEqual({ on: ["quote-crossed"], good: true, unsure: false });
    // no document is a good read of every guard off
    expect(firstHold([], "missing")).toEqual({ on: [], good: true, unsure: false });
  });

  it("a slot taken while unsure is sent marked, kept on the page's record, and counted as a switch mismatch", () => {
    const SLOT = Date.parse(`${S}T10:30:00-04:00`);
    const syms = ITEMS.map((i) => i.symbol);
    const rows = syms.flatMap((symbol) => (["call", "put"] as const).map((side) => ({ symbol, side, state: "watch" as const })));
    const snap = { rows, asOf: SLOT + 5_000, barsDelayed: false };
    const body = JSON.parse(pageBody(SLOT, { ...snap, guards: ["quote-crossed"], guardsUnsure: true }, [])) as Record<string, unknown>;
    expect(body.guards_unsure).toBe(true);
    body.rows_at_settle = rows;
    expect(pageBody(SLOT, { ...snap, guardsUnsure: false }, [])).toBe(pageBody(SLOT, snap, []));
    const post = parsePagePost(JSON.stringify(body), new Set(syms));
    expect(post).toMatchObject({ guards: ["quote-crossed"], guardsUnsure: true });
    expect(parsePagePost(JSON.stringify({ ...body, guards_unsure: false }), new Set(syms))).toBeNull();
    const srv = {
      v: 1,
      engine: ENGINE_VERSION,
      source: "server",
      status: "ok",
      reason: null,
      slot_end: new Date(SLOT).toISOString(),
      evaluated_at: new Date(SLOT + 65_000).toISOString(),
      session: S,
      edition_session: S,
      edition_as_of: null,
      board: "live",
      rows: rows.map((r) => ({ ...r, bar_end: new Date(SLOT).toISOString() })),
      degraded_names: [],
      snapshot_ok: true,
      day: { journal_current: false, break_today: false, day_limit_used: false, done: false, half_day: false, gap: false, broke_earlier: false, stale: false },
      guards: { v: 1, switches: "ok", on: ["quote-crossed"], names: [] },
    } as unknown as ServerRecord;
    const page: PageRecord = { v: 1, engine: ENGINE_VERSION, source: "page", slot_end: new Date(SLOT).toISOString(), received_at: new Date(SLOT + 61_000).toISOString(), hidden: false, as_of: new Date(SLOT + 5_000).toISOString(), bars_delayed: false, rows, rows_at_settle: rows, guards: ["quote-crossed"] };
    expect(shadowSummary([S], [srv], [page])).toMatchObject({ compared: 1, guardsMismatch: 0 });
    expect(shadowSummary([S], [srv], [{ ...page, guards_unsure: true }])).toMatchObject({ compared: 0, guardsMismatch: 1 });
  });
});
