import { type AltTrigger, bars2m, manage, type NameState, type NameStateName, SERVER_SETTLE_MS, TRADE_STALE_MS } from "@/lib/trade-state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImInForm, ManageCard, readNotes, writeNotes } from "@/components/client/trade-manage";
import { focusOptions } from "@/lib/fixture-variants";
import { SCRIPT_ANSWER_LAG_MS, scriptBars, scriptQuote, stepInstant } from "@/lib/fixture-script";
import { focusPlan } from "@/lib/focus-plan";
import type { Lot, Trade } from "@/lib/journal";
import { nyInstant, type Options } from "@/lib/options";
import {
  altPlan,
  CARD_ENTRY,
  cardFeed,
  cardPaused,
  type CardFeed,
  checkFill,
  checkFillTime,
  FILLS_LINE,
  formFromRow,
  formFromTrade,
  formMovedOn,
  hoursMin,
  manageNotices,
  type ManageView,
  manageView,
  type ManualNote,
  mergeNotices,
  mmss,
  movedOnLine,
  noteFromForm,
  noteKey,
  NOTE_MATCH_MS,
  OFF_LINE,
  UNMATCHED_LINE,
  openTrades,
  PAUSED_LINE,
  parseNotes,
  retiredNotes,
  shownNotices,
} from "@/lib/trade-manage";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12
const ITEMS = E.focus!.items;
const QQQ = ITEMS.find((i) => i.symbol === "QQQ")!;
const CALL = focusPlan(QQQ).call!;

const clock = (step: number) => stepInstant(S, step) + SCRIPT_ANSWER_LAG_MS + 1_000;
/** The note "I'm in" saves at step 3: QQQ's call at the live price, at the feed's clock. */
const note = (): ManualNote => ({ symbol: "QQQ", side: "call", price: scriptQuote("QQQ", S, 3)!.price, at: new Date(clock(3)).toISOString(), kind: "plan", plan: CALL });

/** A row's state as the board has it, with only what the manage code reads. */
const stateOf = (state: NameStateName, side: "call" | "put" | undefined, alt: AltTrigger | null = null) => ({ symbol: "QQQ", state, side, alt }) as unknown as NameState;
const entryState = stateOf("enter_zone", "call");
const FAILED_PUT: AltTrigger = { kind: "failed_break", side: "put", level: 779.4, stop: 780, entry: 779.1, at: 0 };

interface ViewOpts {
  rowState?: NameStateName | null;
  feed?: CardFeed;
  closed?: Trade[];
  asOf?: string | null;
  quote?: ReturnType<typeof scriptQuote> | null;
}

function viewAt(step: number, notes: ManualNote[] = [note()], lots: Lot[] = [], o: ViewOpts = {}) {
  const [t] = openTrades(ITEMS, lots, notes, S, o.closed ?? [], o.asOf ?? null);
  const quote = o.quote !== undefined ? o.quote : scriptQuote("QQQ", S, step);
  return manageView(t!, {
    session: S,
    halfDay: false,
    quote,
    trail: [],
    serverBars: scriptBars("QQQ", S, step),
    serverFetchedAt: stepInstant(S, step) + SERVER_SETTLE_MS, // the script's bars are final
    now: clock(step),
    rowState: o.rowState !== undefined ? o.rowState : "watch",
    feed: o.feed ?? "live",
  });
}

describe("the manage card on the scripted morning", () => {
  it("holds right after the entry, with the 5-minute check counting down", () => {
    const v = viewAt(3);
    expect(v.action).toBe("hold");
    expect(v.line).toBe(`Holding: stop ${CALL.stop!.toFixed(2)} · target 1 ${CALL.target1!.toFixed(2)}`);
    expect(v.notWorkingText).toMatch(/^(5:00|4:5\d)$/);
    expect(v.trailText).toBe("after target 1");
    expect(v.flatAt).toBe("15:10");
    expect(v.flatText).toBe("4 h 42 min");
  });

  it("says target 1 hit: sell half, once QQQ runs past it", () => {
    const v = viewAt(4);
    expect(v.action).toBe("sell_half");
    expect(v.tone).toBe("good");
    expect(v.line).toBe(`Target 1 hit: sell half, stop to ${note().price.toFixed(2)}`);
    expect(v.m.stop).toBe(note().price);
    expect(v.notWorkingText).toBe("done");
  });

  it("says exit once a 2-min close falls under the stop moved to the entry", () => {
    const v = viewAt(5);
    expect(v.action).toBe("exit");
    expect(v.tone).toBe("bad");
    expect(v.line).toBe(`Below the stop ${note().price.toFixed(2)}: exit`);
    const html = renderToStaticMarkup(createElement(ManageCard, { v }));
    expect(html).toContain("bg-bad-soft");
    expect(html).toContain("EXIT");
  });

  it("with the prices paused says to manage on the platform", () => {
    const v = viewAt(3, [note()], [], { rowState: "paused" });
    expect(v.action).toBe("check");
    expect(v.line).toBe("Prices paused: manage this one on your platform");
  });
});

describe("the manage card, drawn big and small", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const lot = (over: Partial<Lot> = {}): Lot => ({ symbol: "QQQ", kind: "call", strike: 753, expiry: S, side: "long", qty: 2, entry: 1.2, opened_at: new Date(clock(3)).toISOString(), ...over });
  const esc = (v: string) => v.replace(/[.$]/g, (m) => `\\${m}`);

  it("reads the fresh price only, and the held contract when the journal names it", () => {
    expect(viewAt(3).price).toBe(scriptQuote("QQQ", S, 3)!.price);
    expect(viewAt(3, [note()], [], { rowState: "paused" }).price).toBeNull();
    expect(viewAt(3, [note()], [], { feed: "off" }).price).toBeNull();
    expect(viewAt(3, [note()], [], { quote: null }).price).toBeNull();
    expect(viewAt(3, [], [lot()]).contract).toEqual({ expiry: S, strike: 753 });
    expect(viewAt(3, [], [lot({ strike: null })]).contract).toBeNull();
    // a note takes its own lot's contract
    expect(viewAt(3, [note()], [lot({ strike: 755 })]).contract).toEqual({ expiry: S, strike: 755 });
    expect(viewAt(3).contract).toBeNull();
  });

  it("draws the action word, the stop, the distance to it and the countdown big; the trail, the flat time and P&L small", () => {
    const html = renderToStaticMarkup(createElement(ManageCard, { v: viewAt(3) }));
    expect(html).toMatch(/data-manage-word[^>]*text-decision[^>]*>.*HOLD/);
    expect(html).toMatch(new RegExp(`data-manage-big="stop".*?text-price[^>]*>${esc(CALL.stop!.toFixed(2))}<`));
    const dist = (scriptQuote("QQQ", S, 3)!.price - CALL.stop!).toFixed(2);
    expect(html).toMatch(new RegExp(`data-manage-big="distance".*?QQQ to the stop.*?text-live[^>]*>${esc(`$${dist}`)}<`));
    expect(html).toMatch(/data-manage-big="not-working".*?text-live[^>]*>(5:00|4:5\d)</);
    expect(html).toContain('data-manage-small="trail"');
    expect(html).toContain('data-manage-small="flat"');
    expect(text(html)).toContain("P&amp;L see Webull");
    // no live option P&L, and no estimate without a chain answer
    expect(html).not.toContain("data-manage-option");
    expect(text(html)).not.toMatch(/\b(Buy|Order|Place)\b/);
  });

  it("shows no distance on a CHECK card, and says at the stop once the price is through it", () => {
    const paused = renderToStaticMarkup(createElement(ManageCard, { v: viewAt(3, [note()], [], { rowState: "paused" }) }));
    expect(paused).not.toContain('data-manage-big="distance"');
    expect(paused).toContain("CHECK");
    const exit = renderToStaticMarkup(createElement(ManageCard, { v: viewAt(5) }));
    expect(exit).toMatch(/data-manage-big="distance".*?>at the stop</);
  });

  it("puts the countdown small once it no longer runs", () => {
    const html = renderToStaticMarkup(createElement(ManageCard, { v: viewAt(4) }));
    expect(html).not.toContain('data-manage-big="not-working"');
    expect(html).toMatch(/data-manage-small="not-working".*?>done</);
  });
});

describe("where an open trade comes from", () => {
  const lot = (over: Partial<Lot> = {}): Lot => ({ symbol: "QQQ", kind: "call", strike: 753, expiry: S, side: "long", qty: 2, entry: 1.2, opened_at: new Date(clock(3)).toISOString(), ...over });

  it("reads the journal's open option lot on a focus name, with the card's entry as the price", () => {
    const [t] = openTrades(ITEMS, [lot()], [], S);
    expect(t).toMatchObject({ symbol: "QQQ", side: "call", entry: { source: "journal", price: CALL.entry } });
    const html = renderToStaticMarkup(createElement(ManageCard, { v: viewAt(3, [], [lot()]) }));
    expect(html).toContain("In a trade · QQQ call");
    expect(html).toContain("From your Webull fills, up to 2 min behind; price levels from the card");
    expect(html).not.toContain("Clear");
  });

  it("leaves out shares, short lots, other names and other days", () => {
    expect(openTrades(ITEMS, [lot({ kind: "stock" }), lot({ side: "short" }), lot({ symbol: "NVDA" }), lot({ opened_at: "2026-10-09T15:00:00Z" })], [], S)).toEqual([]);
  });

  it("prefers the owner's note, which has the fill price", () => {
    const ts = openTrades(ITEMS, [lot()], [note()], S);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.entry.source).toBe("manual");
    const html = renderToStaticMarkup(createElement(ManageCard, { v: viewAt(3), onClear: () => {} }));
    expect(html).toContain("Your own note in this browser");
    expect(html).toContain("Clear");
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/\border\b/i);
  });

  it("manages a live alternative against its own entry, stop and 2:1 target", () => {
    const p = altPlan({ kind: "failed_break", side: "put", level: 779.4, stop: 780, entry: 779.1, at: 0 });
    expect(p).toMatchObject({ side: "put", entry: 779.1, stop: 780, target1: 777.3 });
  });
});

describe("the I'm in form", () => {
  it("takes a positive number within 5% of the live price", () => {
    expect(checkFill("753.43", 753.4)).toEqual({ ok: true, price: 753.43 });
    expect(checkFill(" 753.4 ", 753.4)).toEqual({ ok: true, price: 753.4 });
    expect(checkFill("", 753.4)).toMatchObject({ ok: false });
    expect(checkFill("abc", 753.4)).toMatchObject({ ok: false });
    expect(checkFill("-1", 753.4)).toEqual({ ok: false, error: "The price must be above 0" });
    expect(checkFill("800", 753.4)).toEqual({ ok: false, error: "That is more than 5% from the live price 753.40: check it" });
    expect(checkFill("715.8", 753.4)).toMatchObject({ ok: true });
  });

  it("starts with the live price, the side and the time, and never looks like an order", () => {
    const f = formFromRow("QQQ", entryState, QQQ, clock(3))!;
    const html = renderToStaticMarkup(createElement(ImInForm, { f, live: 753.43, now: clock(3), session: S, halfDay: false, onSave: () => {}, onCancel: () => {} }));
    expect(html).toContain('value="753.43"');
    expect(html).toContain("QQQ call");
    expect(html).toContain("Filled at (New York, to the minute)");
    expect(html).toContain('value="10:28"');
    expect(html).toContain("Save note");
    expect(html).toContain("Nothing is sent anywhere");
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/\b(buy|sell|order|submit)\b/i);
  });
});

describe("the notes in this browser", () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = () => {
    const m = new Map<string, string>();
    return {
      m,
      ls: {
        get length() {
          return m.size;
        },
        key: (i: number) => [...m.keys()][i] ?? null,
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
      },
    };
  };

  it("keeps a day's notes under that day's key and drops the other days'", () => {
    const { m, ls } = store();
    m.set(noteKey("2026-10-09"), "[]");
    vi.stubGlobal("window", { localStorage: ls, dispatchEvent: () => true });
    writeNotes(S, [note()]);
    expect([...m.keys()]).toEqual([noteKey(S)]);
    expect(parseNotes(readNotes(S))).toEqual([note()]);
    writeNotes(S, []);
    expect(m.size).toBe(0);
  });

  it("works for the page when storage throws, and with no storage at all", () => {
    const throwing = {
      get length(): number {
        throw new Error("denied");
      },
      getItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("window", { localStorage: throwing, dispatchEvent: () => true });
    writeNotes(S, [note()]);
    expect(parseNotes(readNotes(S))).toEqual([note()]);
    writeNotes(S, []);
    vi.stubGlobal("window", { dispatchEvent: () => true });
    expect(readNotes(S)).toBe("");
  });

  it("drops a malformed note, never throwing", () => {
    expect(parseNotes("not json")).toEqual([]);
    expect(parseNotes(JSON.stringify([{ symbol: "QQQ" }, { ...note(), price: -1 }, { ...note(), plan: { ...CALL, side: "put" } }]))).toEqual([]);
    expect(parseNotes(JSON.stringify([note(), note()]))).toHaveLength(1);
    // several notes are kept: one per name, side and fill time
    const later = { ...note(), at: new Date(clock(4)).toISOString() };
    const put = { ...note(), side: "put" as const, plan: { ...CALL, side: "put" as const } };
    expect(parseNotes(JSON.stringify([note(), later, put]))).toEqual([note(), later, put]);
  });

  it("formats the countdown and the time to flat", () => {
    expect(mmss(299)).toBe("4:59");
    expect(mmss(5)).toBe("0:05");
    expect(hoursMin(286)).toBe("4 h 46 min");
    expect(hoursMin(12)).toBe("12 min");
    expect(hoursMin(0)).toBe("now");
  });
});

// ---- the review's findings ------------------------------------------------------------------------------------------
const ny = (h: number, m: number) => new Date(nyInstant(S, h * 60 + m)!).toISOString();
const lotAt = (iso: string | null, over: Partial<Lot> = {}): Lot => ({ symbol: "QQQ", kind: "call", strike: 753, expiry: S, side: "long", qty: 1, entry: 1.2, opened_at: iso, ...over });
const closedAt = (opened: string, closed: string, over: Partial<Trade> = {}): Trade => ({
  id: `t-${closed}`,
  symbol: "QQQ",
  kind: "call",
  strike: 753,
  expiry: S,
  side: "long",
  qty: 1,
  opened_at: opened,
  closed_at: closed,
  entry: 1.2,
  exit: 0.9,
  multiplier: 100,
  pnl: -30,
  close: "order",
  ...over,
});

describe("a card pauses on its own row and its own quote", () => {
  it("says CHECK when its own row is paused, though the other rows are live", () => {
    const v = viewAt(3, [note()], [], { rowState: "paused" });
    expect(v).toMatchObject({ action: "check", tone: "warn", line: PAUSED_LINE });
  });

  it("says CHECK, never HOLD, with its quote missing or its last trade older than TRADE_STALE_MS", () => {
    expect(viewAt(3).action).toBe("hold"); // the fresh read
    expect(viewAt(3, [note()], [], { quote: null })).toMatchObject({ action: "check", line: PAUSED_LINE });
    const q = scriptQuote("QQQ", S, 3)!;
    const old = { ...q, at: new Date(clock(3) - TRADE_STALE_MS - 1).toISOString() };
    expect(viewAt(3, [note()], [], { quote: old })).toMatchObject({ action: "check", line: PAUSED_LINE });
    expect(viewAt(3, [note()], [], { rowState: null })).toMatchObject({ action: "check" });
  });

  it("keeps an exit that manage already reads", () => {
    expect(viewAt(5, [note()], [], { rowState: "paused" }).action).toBe("exit");
  });

  it("reads the pause from the row's state, the quote's day and its age", () => {
    const q = scriptQuote("QQQ", S, 3)!;
    expect(cardPaused("enter_zone", q, clock(3), S)).toBe(false);
    expect(cardPaused("paused", q, clock(3), S)).toBe(true);
    expect(cardPaused(undefined, q, clock(3), S)).toBe(true);
    expect(cardPaused("watch", null, clock(3), S)).toBe(true);
    expect(cardPaused("watch", { ...q, day: "2026-10-09" }, clock(3), S)).toBe(true);
    expect(cardPaused("watch", q, Date.parse(q.at) + TRADE_STALE_MS + 1, S)).toBe(true);
  });
});

describe("a note's lifecycle: matched to its own trade by the broker's fill time", () => {
  it("(1) noted 10:28, its trade closed 10:31, a new lot at 10:35: the note retires and the lot gets its own journal card", () => {
    const n = note(); // 10:28
    const closed = [closedAt(ny(10, 28), ny(10, 31))];
    const lots = [lotAt(ny(10, 35))];
    expect(retiredNotes([n], lots, closed, S)).toEqual([n]);
    const ts = openTrades(ITEMS, lots, [n], S, closed);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ note: null, entry: { source: "journal", at: ny(10, 35), price: CALL.entry } });
  });

  it("(2) another trade's close never retires a note the journal has not shown yet", () => {
    const n = { ...note(), at: ny(10, 40) };
    const closed = [closedAt(ny(10, 30), new Date(nyInstant(S, 10 * 60 + 40)! + 20_000).toISOString())];
    expect(retiredNotes([n], [], closed, S)).toEqual([]);
    expect(openTrades(ITEMS, [], [n], S, closed)).toMatchObject([{ note: n, entry: { source: "manual" } }]);
  });

  it("(3) a note at 10:28 manages the lot opened at 10:29, with no second card", () => {
    const ts = openTrades(ITEMS, [lotAt(ny(10, 29))], [note()], S);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ entry: { source: "manual", price: note().price } });
  });

  it("matches within NOTE_MATCH_MS only, and a lot further off is a separate trade with its own card", () => {
    expect(NOTE_MATCH_MS).toBe(120_000);
    const ts = openTrades(ITEMS, [lotAt(ny(10, 31))], [note()], S); // 2 min 34 s after the note
    expect(ts.map((t) => t.entry.source)).toEqual(["manual", "journal"]);
    expect(ts[1]!.entry.at).toBe(ny(10, 31));
    expect(retiredNotes([note()], [], [closedAt(ny(10, 31), ny(10, 40))], S)).toEqual([]);
  });

  it("keeps a note while part of its own trade is still open, or when the closed trade is another side or name", () => {
    expect(retiredNotes([note()], [lotAt(ny(10, 28))], [closedAt(ny(10, 28), ny(10, 40))], S)).toEqual([]); // sold half
    expect(retiredNotes([note()], [], [closedAt(ny(10, 28), ny(10, 40), { kind: "put" })], S)).toEqual([]);
    expect(retiredNotes([note()], [], [closedAt(ny(10, 28), ny(10, 40), { symbol: "SPY" })], S)).toEqual([]);
  });

  it("keeps several notes, each its own card, and retires each only by its own trade", () => {
    const later = { ...note(), price: 754, at: ny(10, 45) };
    expect(openTrades(ITEMS, [], [note(), later], S).map((t) => t.entry.at)).toEqual([note().at, ny(10, 45)]);
    expect(retiredNotes([note(), later], [], [closedAt(ny(10, 28), ny(10, 40))], S)).toEqual([note()]);
  });
});

describe("a re-entry inside the window", () => {
  it("note 10:28 (stored 10:29:00), stopped 10:29:30, re-bought 10:30:30: the new lot is its own card and the note retires", () => {
    const n = { ...note(), at: new Date(nyInstant(S, 629)!).toISOString() };
    const closed = [closedAt(new Date(nyInstant(S, 628)! + 20_000).toISOString(), new Date(nyInstant(S, 629)! + 30_000).toISOString())];
    const lots = [lotAt(new Date(nyInstant(S, 630)! + 30_000).toISOString())];
    expect(retiredNotes([n], lots, closed, S)).toEqual([n]);
    expect(openTrades(ITEMS, lots, [n], S, closed)).toMatchObject([{ note: null, entry: { source: "journal", at: lots[0]!.opened_at } }]);
  });

  it("an add before the first fill closed stays the note's trade", () => {
    const n = { ...note(), at: new Date(nyInstant(S, 629)!).toISOString() };
    const closed = [closedAt(new Date(nyInstant(S, 628)! + 20_000).toISOString(), new Date(nyInstant(S, 629)! + 30_000).toISOString())];
    const lots = [lotAt(new Date(nyInstant(S, 628)! + 50_000).toISOString())];
    expect(retiredNotes([n], lots, closed, S)).toEqual([]);
    expect(openTrades(ITEMS, lots, [n], S, closed)).toMatchObject([{ note: n }]);
  });
});

describe("a note the journal does not show", () => {
  const after = (min: number) => new Date(nyInstant(S, 628)! + min * 60_000).toISOString();

  it("a mistyped 10:24 for a 10:28 fill: CHECK once the journal has caught up, with the lot's time offered", () => {
    const n = { ...note(), at: ny(10, 24) };
    const lots = [lotAt(ny(10, 28))];
    const [own, other] = openTrades(ITEMS, lots, [n], S, [], after(4));
    expect(own).toMatchObject({ note: n, unmatched: true, hintAt: ny(10, 28) });
    expect(other).toMatchObject({ note: null, entry: { at: ny(10, 28) } }); // the lot keeps its own card meanwhile
    const v = viewAt(3, [n], lots, { asOf: after(4) });
    expect(v).toMatchObject({ action: "check", tone: "warn", line: UNMATCHED_LINE });
    expect(v.hint).toEqual({ line: "Your fills show a QQQ call at 10:28: use that time?", at: ny(10, 28) });
    const html = renderToStaticMarkup(createElement(ManageCard, { v, onUseTime: () => {} }));
    expect(html).toContain("Use that time");
    // taking the lot's time: the note matches it, one card
    expect(openTrades(ITEMS, lots, [{ ...n, at: ny(10, 28) }], S, [], after(4))).toMatchObject([{ unmatched: false, entry: { source: "manual" } }]);
  });

  it("an un-noted trade on another contract inside the window never joins the note", () => {
    // A: a 750 call at 10:27:30, not noted; B: a 753 call filled 10:28:40, noted as 10:28 (stored 10:29:00)
    const plus = (iso: string, sec: number) => new Date(Date.parse(iso) + sec * 1000).toISOString();
    const a = lotAt(plus(ny(10, 27), 30), { strike: 750 });
    const b = lotAt(plus(ny(10, 28), 40), { strike: 753 });
    const n = { ...note(), at: ny(10, 29) };
    const trades = openTrades(ITEMS, [a, b], [n], S, [], after(4));
    expect(trades.filter((t) => t.note)).toHaveLength(1);
    // A keeps a journal card of its own, from its own fill, never the note's
    expect(trades.filter((t) => !t.note)).toMatchObject([{ entry: { at: a.opened_at } }]);
  });

  it("a note's hint never offers a lot another note already manages", () => {
    const b = lotAt(ny(10, 28));
    const mine = { ...note(), at: ny(10, 28) };
    const other = { ...note(), at: ny(10, 22) }; // mistyped, unmatched, within NOTE_HINT_MS of b
    const t = openTrades(ITEMS, [b], [mine, other], S, [], after(4));
    expect(t.find((x) => x.note?.at === ny(10, 22))).toMatchObject({ unmatched: true, hintAt: null });
  });

  it("a note for a fill that never happened: CHECK, never HOLD, and no hint", () => {
    const v = viewAt(3, [note()], [], { asOf: after(4) });
    expect(v).toMatchObject({ action: "check", line: UNMATCHED_LINE, hint: null });
    for (const step of [4, 5]) expect(viewAt(step, [note()], [], { asOf: after(20) }).action).toBe("check");
  });

  it("waits for the journal to catch up before calling a note unmatched", () => {
    expect(viewAt(3, [note()], [], { asOf: after(2) }).action).toBe("hold");
    expect(viewAt(3, [note()], [], { asOf: null }).action).toBe("hold");
    expect(viewAt(3, [note()], [], { asOf: "2026-10-16T21:05:00Z" }).action).toBe("hold"); // read on another day
    expect(openTrades(ITEMS, [lotAt(ny(10, 45))], [{ ...note(), at: ny(10, 24) }], S, [], after(30))[0]!.hintAt).toBeNull(); // beyond 10 min
  });
});

describe("a lot with no opening time", () => {
  const asOf = new Date(clock(3)).toISOString();

  it("never overrides a note", () => {
    expect(openTrades(ITEMS, [lotAt(null)], [note()], S, [], asOf)).toMatchObject([{ entry: { source: "manual" } }]);
  });

  it("with no note gives the fill time unknown CHECK, only when the journal says it is open today", () => {
    const [t] = openTrades(ITEMS, [lotAt(null)], [], S, [], asOf);
    expect(t).toMatchObject({ entry: { source: "journal", at: "" } });
    expect(viewAt(3, [], [lotAt(null)], { asOf })).toMatchObject({ action: "check", line: "Fill time unknown: manage this one on your chart" });
    expect(openTrades(ITEMS, [lotAt(null)], [], S, [], "2026-10-09T20:00:00Z")).toEqual([]);
    expect(openTrades(ITEMS, [lotAt(null)], [], S)).toEqual([]);
  });
});

describe("the form keeps what it opened on", () => {
  it("captures the side, trigger and levels at the click; a later row change never changes what Save writes", () => {
    const f = formFromRow("QQQ", entryState, QQQ, clock(3))!;
    expect(f).toMatchObject({ symbol: "QQQ", side: "call", kind: "plan", plan: CALL, state: "enter_zone", time: "10:28", origin: "row" });
    const now = stateOf("plan_off", "call", FAILED_PUT); // the row now offers a put
    expect(formMovedOn(f, now, QQQ)).toBe(true);
    expect(movedOnLine(f)).toBe("The board has moved on: this note keeps the call you opened");
    expect(noteFromForm(f, 753.43, ny(10, 28))).toEqual({ symbol: "QQQ", side: "call", price: 753.43, at: ny(10, 28), kind: "plan", plan: CALL });
    expect(formMovedOn(f, entryState, QQQ)).toBe(false);
    expect(formMovedOn(f, stateOf("missed", "call"), QQQ)).toBe(true);
  });

  it("captures a live alternative as its own side and trigger", () => {
    const f = formFromRow("QQQ", stateOf("plan_off", "call", FAILED_PUT), QQQ, clock(3))!;
    expect(f).toMatchObject({ side: "put", kind: "failed_break", plan: altPlan(FAILED_PUT) });
    expect(formFromRow("QQQ", stateOf("watch", "call"), QQQ, clock(3))).toBeNull();
  });

  it("shows the board has moved on in the form", () => {
    const f = formFromRow("QQQ", entryState, QQQ, clock(3))!;
    const html = renderToStaticMarkup(
      createElement(ImInForm, { f, live: 753.4, now: clock(4), session: S, halfDay: false, movedOn: movedOnLine(f), onSave: () => {}, onCancel: () => {} }),
    );
    expect(html).toContain("The board has moved on: this note keeps the call you opened");
    expect(html).toContain('data-im-in-side="call"');
  });
});

describe("the feed off", () => {
  it("keeps the cards once they were live, and shows none before", () => {
    expect(cardFeed("live", false, false)).toBe("live");
    expect(cardFeed("live", true, false)).toBeNull();
    expect(cardFeed("live", true, true)).toBe("live");
    expect(cardFeed("off", false, true)).toBe("off");
    expect(cardFeed("loading", false, true)).toBe("off");
    expect(cardFeed("off", false, false)).toBeNull();
    expect(cardFeed("next", false, true)).toBeNull();
    expect(cardFeed("old", false, true)).toBeNull();
  });

  it("says CHECK with the live prices off, from nothing old, even where it would read an exit", () => {
    for (const step of [3, 4, 5]) expect(viewAt(step, [note()], [], { feed: "off" })).toMatchObject({ action: "check", tone: "warn", line: OFF_LINE });
  });

  it("announces a HOLD that turns EXIT across the outage", () => {
    const hold = viewAt(3);
    const off = viewAt(4, [note()], [], { feed: "off" });
    const exit = viewAt(5);
    let r = manageNotices({}, [hold], 0);
    expect(r.fresh).toEqual([]);
    r = manageNotices(r.last, [off], 1);
    expect(r.fresh).toEqual([]);
    expect(r.last[hold.id]).toBe("hold");
    r = manageNotices(r.last, [exit], 2);
    expect(r.fresh.map((n) => n.title)).toEqual(["QQQ call: EXIT"]);
  });
});

describe("a journal lot with no note", () => {
  it("uses the focus plan's side only, never the board's live alternative, and names the kind in its id", () => {
    const [t] = openTrades(ITEMS, [lotAt(ny(10, 28))], [], S);
    expect(t).toMatchObject({ kind: "plan", plan: CALL, entry: { price: CALL.entry } });
    expect(t!.id).toBe(`QQQ|call|plan|${ny(10, 28)}|753/${S}|journal`);
  });

  it("says its levels are the card's, labels the card entry and offers Set my fill", () => {
    const lots = [lotAt(ny(10, 28))];
    const v = viewAt(4, [], lots);
    expect(v.fillLine).toBe(FILLS_LINE);
    expect(v.cardEntry).toBe(true);
    expect(v.line).toBe(`Target 1 hit: sell half, stop to ${CALL.entry!.toFixed(2)} ${CARD_ENTRY}`);
    const html = renderToStaticMarkup(createElement(ManageCard, { v, onSetFill: () => {} }));
    expect(html).toContain("From your fills: set your fill for exact levels");
    expect(html).toContain("text-warn");
    expect(html).toContain("Set my fill");
    expect(html).toContain(CARD_ENTRY);
    const counting = renderToStaticMarkup(createElement(ManageCard, { v: viewAt(3, [], lots) }));
    expect(counting.slice(counting.indexOf("Not working in"))).toContain(CARD_ENTRY);
    // the note's card has none of it
    expect(viewAt(4)).toMatchObject({ fillLine: null, cardEntry: false });
  });

  it("opens Set my fill on the same form, prefilled with its side, levels and the journal's fill time", () => {
    const [t] = openTrades(ITEMS, [lotAt(ny(10, 28))], [], S);
    expect(formFromTrade(t!, clock(4))).toMatchObject({ symbol: "QQQ", side: "call", kind: "plan", plan: CALL, time: "10:28", origin: "card", state: null });
  });

  it("reads one position added to (the same contract within NOTE_MATCH_MS) from its first fill", () => {
    const ts = openTrades(ITEMS, [lotAt(ny(10, 29)), lotAt(ny(10, 28)), lotAt(ny(10, 30))], [], S);
    expect(ts.map((t) => t.entry.at)).toEqual([ny(10, 28)]);
  });

  it("keeps separate journal trades apart: A at 10:00 and B at 10:40 both open are two cards, each from its own fill", () => {
    const ts = openTrades(ITEMS, [lotAt(ny(10, 40)), lotAt(ny(10, 0))], [], S);
    expect(ts.map((t) => [t.entry.source, t.entry.at])).toEqual([
      ["journal", ny(10, 0)],
      ["journal", ny(10, 40)],
    ]);
    // another contract inside the window is another trade too
    expect(openTrades(ITEMS, [lotAt(ny(10, 28)), lotAt(ny(10, 29), { strike: 754 })], [], S)).toHaveLength(2);
  });
});

describe("the note's fill time", () => {
  const end = (h: number, m: number) => new Date(nyInstant(S, h * 60 + m)! + 60_000).toISOString();

  it("takes HH:MM New York within today's session and not in the future, as the end of that minute", () => {
    expect(checkFillTime("10:28", clock(3), S, false)).toEqual({ ok: true, at: end(10, 28) });
    expect(checkFillTime(" 9:45 ", clock(3), S, false)).toEqual({ ok: true, at: end(9, 45) });
    expect(checkFillTime("10:29", clock(3), S, false)).toEqual({ ok: false, error: "That time is still to come: type the time of your fill" });
    expect(checkFillTime("09:29", clock(3), S, false)).toEqual({ ok: false, error: "The fill must be in today's session, 09:30 to 16:00 New York" });
    expect(checkFillTime("13:00", clock(3), S, true)).toMatchObject({ ok: false });
    expect(checkFillTime("1028", clock(3), S, false)).toEqual({ ok: false, error: "Type the time of your fill, like 10:28" });
    expect(checkFillTime("25:00", clock(3), S, false)).toMatchObject({ ok: false });
    expect(checkFillTime("10:28", clock(3) + 86_400_000, S, false)).toEqual({ ok: false, error: "A note is for today's session only" });
  });

  it("never counts a price from before the end of the typed minute, and rule 6 is due at most 60 s late, never early", () => {
    const r = checkFillTime("10:28", clock(3) + 120_000, S, false);
    if (!r.ok) throw new Error(r.error);
    const at = Date.parse(r.at);
    for (const fill of [nyInstant(S, 628)!, nyInstant(S, 628)! + 30_000, nyInstant(S, 628)! + 59_999]) {
      expect(at - fill).toBeGreaterThan(0);
      expect(at - fill).toBeLessThanOrEqual(60_000);
    }
    const now = new Date(at + 60_000);
    const early = [{ at: nyInstant(S, 628)! + 40_000, p: CALL.target1! + 1 }]; // inside the typed minute
    const m = manage({ side: "call", price: 753, at: r.at, source: "manual" }, CALL, bars2m([], null, now, false, S), null, now, false, early);
    expect(m.tone).not.toBe("good");
    expect(m.stop).toBe(CALL.stop);
  });

  it("says in the label and on the card that it is to the minute", () => {
    const f = formFromRow("QQQ", entryState, QQQ, clock(3))!;
    expect(renderToStaticMarkup(createElement(ImInForm, { f, live: 753.4, now: clock(3), session: S, halfDay: false, onSave: () => {}, onCancel: () => {} }))).toContain(
      "Filled at (New York, to the minute)",
    );
    expect(renderToStaticMarkup(createElement(ManageCard, { v: viewAt(3) }))).toContain("fill time to the minute");
    expect(viewAt(3, [], [lotAt(ny(10, 28))]).fillNote).toBeNull();
  });
});

describe("the manage notices", () => {
  const as = (v: ManageView, over: Partial<ManageView>): ManageView => ({ ...v, ...over });

  it("are keyed by trade, so two cards on one name and side never replace each other's notice", () => {
    const noteCard = viewAt(3);
    const lotCard = as(noteCard, { id: `QQQ|call|plan|${ny(10, 50)}|753/${S}|journal`, source: "journal" });
    expect(lotCard.key).toBe(noteCard.key); // the same name and side
    let r = manageNotices({}, [noteCard, lotCard], 0);
    r = manageNotices(r.last, [as(noteCard, { action: "sell_half" }), lotCard], 1);
    const one = mergeNotices([], r.fresh);
    r = manageNotices(r.last, [as(noteCard, { action: "sell_half" }), as(lotCard, { action: "exit" })], 2);
    const both = mergeNotices(one, r.fresh);
    expect(both.map((n) => n.key)).toEqual([lotCard.id, noteCard.id]);
    expect(shownNotices(both, [as(noteCard, { action: "sell_half" }), as(lotCard, { action: "exit" })])).toHaveLength(2);
  });

  it("do not count a CHECK as a change: a brief pause neither announces nor re-announces EXIT", () => {
    const exit = viewAt(5);
    const paused = viewAt(5, [note()], [], { feed: "off" });
    let r = manageNotices({}, [viewAt(3)], 0);
    r = manageNotices(r.last, [exit], 1);
    expect(r.fresh).toHaveLength(1);
    r = manageNotices(r.last, [paused], 2);
    expect(r.fresh).toEqual([]);
    r = manageNotices(r.last, [exit], 3);
    expect(r.fresh).toEqual([]);
  });

  it("show only while their card still says their word", () => {
    const exit = viewAt(5);
    const r = manageNotices({ [exit.id]: "hold" }, [exit], 0);
    expect(shownNotices(r.fresh, [exit])).toHaveLength(1);
    expect(shownNotices(r.fresh, [viewAt(5, [note()], [], { feed: "off" })])).toEqual([]);
    expect(shownNotices(r.fresh, [])).toEqual([]);
  });
});

