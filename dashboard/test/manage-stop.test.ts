import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StopBlock, type CardStop } from "@/components/client/trade-manage";
import type { Lot, Trade } from "@/lib/journal";
import { checkOptionFill, fillStop, matchNotes, nickelLine, otherOpenPositions, prefillFrom, readContracts, STOP_REMINDER, tradeCount } from "@/lib/manage-stop";
import { dayFacts, journalLive, railDay, railWithNotes } from "@/lib/session-timeline";
import { readPrice } from "@/lib/ticket";
import { type ManageView, type ManualNote, NOTE_MATCH_MS, noteId, parseNotes } from "@/lib/trade-manage";
import { ROOM_BROKEN, ROOM_LATE, ROOM_NO_JOURNAL, ROOM_OTHER_OPEN, ROOM_STALE, roomAfterStop, roomNotShown, roomShown } from "@/lib/what-if";

// 2026-10-12 is a Monday on EDT (UTC−4).
const S = "2026-10-12";
const ny = (hhmm: string, day = S) => new Date(`${day}T${hhmm}:00-04:00`).toISOString();
const PLAN = { side: "call" as const, level: 750, levelName: "", entry: 751, stop: 749, target1: 755, target2: null };
const note = (at: string, symbol = "QQQ", side: "call" | "put" = "call"): ManualNote => ({ symbol, side, price: 751, at, kind: "plan", plan: { ...PLAN, side } });
const trade = (opened: string, symbol = "QQQ", kind: "call" | "put" = "call", extra: Partial<Trade> = {}): Trade =>
  ({ id: `${symbol}-${opened}`, symbol, kind, strike: 750, expiry: S, side: "long", qty: 1, opened_at: opened, closed_at: opened, entry: 1.2, exit: 1, multiplier: 100, pnl: -20, ...extra }) as Trade;
const lot = (opened: string | null, symbol = "QQQ", kind: "call" | "put" = "call"): Lot => ({ symbol, kind, strike: 750, expiry: S, side: "long", qty: 1, entry: 1.2, opened_at: opened });

describe("roomAfterStop", () => {
  const day = (net: number, current = true) => ({ current, net });
  it("leaves $0 exactly at the limit and is over by a cent one cent past it", () => {
    // $60 lost, a stop costing $40.00 lands on the limit
    expect(roomAfterStop(day(-60), 4000)).toMatchObject({ kind: "left", cents: 0, line: "If this stop fills: $0.00 of your $100 day limit left." });
    expect(roomAfterStop(day(-60), 4001)).toMatchObject({ kind: "over", cents: 1, line: "This stop would take you past your $100 day limit by $0.01." });
    expect(roomAfterStop(day(-60.01), 4000)).toMatchObject({ kind: "over", cents: 1 });
  });
  it("counts a profit as no loss, as dayRoom does", () => {
    expect(roomAfterStop(day(25), 3110)).toMatchObject({ kind: "left", cents: 6890, line: "If this stop fills: $68.90 of your $100 day limit left." });
  });
  it("is withheld from a journal that is not current, a missing one, or beside another open trade", () => {
    expect(roomAfterStop(day(-10, false), 3000)).toEqual({ kind: "withheld", line: ROOM_STALE });
    expect(roomAfterStop(null, 3000)).toEqual({ kind: "withheld", line: ROOM_NO_JOURNAL });
    expect(roomAfterStop(day(0), 3000, 1)).toEqual({ kind: "withheld", line: ROOM_OTHER_OPEN });
  });
  it("is withheld when the fill breaks rule 4, whatever the room", () => {
    // 2 × $1.25 = $250 of premium
    const st = fillStop({ priceCents: 125, contracts: 2 });
    expect(st.breaks.length).toBeGreaterThan(0);
    expect(roomAfterStop(day(0), st.lossCents, 0, st.breaks.length)).toEqual({ kind: "withheld", line: ROOM_BROKEN });
    expect(roomAfterStop(day(0), st.lossCents, 0, 0).kind).toBe("left");
  });
  it("is withheld beside another open position in the journal, not beside the note's own", () => {
    const at = ny("10:29");
    const n = note(at);
    const mine = lot(at);
    const overnight: Lot = { ...lot(ny("15:10", "2026-10-09")), strike: 760 };
    const other: Lot = lot(ny("10:05"), "XYZ");
    const m = matchNotes([n], [], [mine], S).matched.get(noteId(n));
    expect(otherOpenPositions([mine], m)).toBe(0);
    expect(otherOpenPositions([mine, overnight], m)).toBe(1);
    expect(otherOpenPositions([mine, other], m)).toBe(1);
    // the note not yet matched: the journal's lot is another position
    expect(otherOpenPositions([mine], undefined)).toBe(1);
    expect(roomAfterStop(day(0), 3000, otherOpenPositions([mine, overnight], m))).toEqual({ kind: "withheld", line: ROOM_OTHER_OPEN });
    expect(dayFacts({ status: "clear", isToday: true, current: true, used: 1, net: 0 }, at, new Date(ny("10:30")), [mine, overnight, { ...mine, qty: 2 }]).openLots).toBe(2);
  });
  it("is re-checked on the browser clock: a read that ages out drops the room", () => {
    const f = dayFacts({ status: "clear", isToday: true, current: true, used: 1, net: 0 }, ny("10:21"), new Date(ny("10:22")));
    expect(journalLive(f, null)).toBe(true);
    expect(journalLive(f, Date.parse(ny("10:25")))).toBe(true);
    // in the session a read older than the intraday limit is no longer current
    expect(journalLive(f, Date.parse(ny("13:30")))).toBe(false);
    expect(journalLive({ ...f, current: false }, Date.parse(ny("10:25")))).toBe(false);
    expect(journalLive(null, null)).toBe(false);
    expect(roomShown("A stop now leaves $50 of $100 and 4 trades.", 0, 0, false)).toBe(ROOM_LATE);
  });
  it("is withheld when dayFacts finds the journal stale or not current", () => {
    const now = new Date(ny("10:30"));
    const c = { status: "clear" as const, isToday: true, current: true, used: 1, net: -10 };
    expect(dayFacts(c, ny("10:21"), now)).toMatchObject({ current: true, readLine: "Fills read 10:21 New York" });
    // journalStale: read more than 84 hours ago
    const old = new Date(Date.parse(ny("10:21")) - 90 * 3_600_000).toISOString();
    expect(dayFacts(c, old, now).current).toBe(false);
    expect(dayFacts({ ...c, current: false }, ny("10:21"), now).current).toBe(false);
    expect(dayFacts(c, null, now)).toMatchObject({ current: false, readLine: null });
    expect(roomAfterStop(dayFacts(c, old, now), 1000).kind).toBe("withheld");
  });
});

describe("matching notes to the journal", () => {
  it("matches a fill on the name, side and day opened at or after the note less the allowance", () => {
    const n = note(ny("10:29"));
    // the note's time is the end of its minute: a fill a minute before still matches
    expect(matchNotes([n], [trade(ny("10:28"))], [], S).provisional).toEqual([]);
    expect(matchNotes([n], [], [lot(ny("11:40"))], S).provisional).toEqual([]);
    const edge = new Date(Date.parse(n.at) - NOTE_MATCH_MS).toISOString();
    expect(matchNotes([n], [trade(edge)], [], S).provisional).toEqual([]);
  });
  it("does not match a fill before the allowance, another name, or a lot with no time", () => {
    const n = note(ny("10:29"));
    const early = new Date(Date.parse(n.at) - NOTE_MATCH_MS - 1000).toISOString();
    expect(matchNotes([n], [trade(early)], [], S).provisional).toEqual([n]);
    expect(matchNotes([n], [trade(ny("10:29"), "SPY")], [], S).provisional).toEqual([n]);
    expect(matchNotes([n], [], [lot(null)], S).provisional).toEqual([n]);
  });
  it("tells a put from a call", () => {
    const n = note(ny("10:29"), "QQQ", "put");
    expect(matchNotes([n], [trade(ny("10:29"), "QQQ", "call")], [], S).provisional).toEqual([n]);
    expect(matchNotes([n], [trade(ny("10:29"), "QQQ", "put")], [], S).provisional).toEqual([]);
  });
  it("never counts a note from a previous day, and never matches a fill of another day", () => {
    const yesterday = note(ny("10:29", "2026-10-09"));
    expect(matchNotes([yesterday], [], [], S)).toMatchObject({ provisional: [] });
    expect(matchNotes([yesterday], [trade(ny("10:29"))], [], S).matched.size).toBe(0);
    const n = note(ny("10:29"));
    expect(matchNotes([n], [trade(ny("10:29", "2026-10-13"))], [], S).provisional).toEqual([n]);
  });
  it("two notes and one fill: one matches, the other stays provisional", () => {
    const a = note(ny("10:29"));
    const b = note(ny("10:45"));
    const r = matchNotes([b, a], [trade(ny("10:46"))], [], S);
    expect(r.matched.size).toBe(1);
    expect(r.provisional).toHaveLength(1);
  });
  it("one note and two fills: one fill is the note's, never both", () => {
    const n = note(ny("10:29"));
    const r = matchNotes([n], [trade(ny("10:29")), trade(ny("11:10"))], [], S);
    expect(r.matched.size).toBe(1);
    expect(r.provisional).toEqual([]);
  });
  it("a fill sold in parts and its open rest are one fill, matched once", () => {
    const at = ny("10:29");
    const a = note(ny("10:29"));
    const b = note(ny("10:30"));
    const r = matchNotes([a, b], [trade(at), trade(at, "QQQ", "call", { id: "x2" })], [lot(at)], S);
    expect(r.matched.size).toBe(1);
    expect(r.provisional.map(noteId)).toEqual([noteId(b)]);
  });
  it("gives the earlier note the earlier fill, so a later note can still match", () => {
    const a = note(ny("10:00"));
    const b = note(ny("11:00"));
    const r = matchNotes([a, b], [trade(ny("10:01")), trade(ny("11:01"))], [], S);
    expect(r.provisional).toEqual([]);
  });
});

describe("the day's count with the notes", () => {
  const base = { status: "clear" as const, isToday: true, current: true, used: 2, net: 0, openLine: "" };
  it("adds the provisional notes, and at the cap says the trades are used up as his rule", () => {
    expect(tradeCount(2, 1)).toMatchObject({ total: 3, usedUp: false, note: "1 not yet in the journal", usedUpLine: null });
    expect(tradeCount(4, 1)).toMatchObject({ total: 5, usedUp: true, usedUpLine: "5 of 5 by your own count: your 5-trade rule is used up for today." });
    const r = railWithNotes(railDay({ ...base, used: 4 }), { ...base, used: 4 }, 1);
    expect(r).toMatchObject({ word: "Trades used up", tone: "bad", line: "Trades used up · 5/5 trades · $0 of $100 · 1 not yet in the journal" });
  });
  it("is only ever more cautious: none leaves the server's line, one short of the cap reads careful", () => {
    const d = railDay(base);
    expect(railWithNotes(d, base, 0)).toEqual({ ...d, notes: null, usedUp: null });
    expect(railWithNotes(railDay({ ...base, used: 3 }), { ...base, used: 3 }, 1)).toMatchObject({ word: "Careful", tone: "warn", line: "Careful · 4/5 trades · $0 of $100 · 1 not yet in the journal" });
    expect(railWithNotes(d, base, 1)).toMatchObject({ word: "Clear", line: "Clear · 3/5 trades · $0 of $100 · 1 not yet in the journal" });
    expect(tradeCount(3, -2).total).toBe(3);
  });
  it("never shows the room or the trades left beside notes not yet in the journal", () => {
    const d = railDay({ ...base, used: 4 });
    expect(d.room).toMatch(/A stop now/);
    expect(railWithNotes(d, { ...base, used: 4 }, 3)).toMatchObject({ word: "Trades used up", room: null });
    expect(roomShown(d.room, 0, 3)).toBe("Room not shown: 3 trades not yet in the journal.");
    expect(roomShown(d.room, 0, 1)).toBe(roomNotShown(1));
    expect(roomShown(d.room, 2, 1)).toBe(roomNotShown(1));
    expect(roomShown(d.room, 0, 0)).toBe(d.room);
  });
  it("keeps a day already stopped as stopped", () => {
    const stop = { ...base, status: "stop" as const, net: -104 };
    expect(railWithNotes(railDay(stop), stop, 2)).toMatchObject({ word: "Stop for today", tone: "bad" });
  });
});

describe("the option fill and its stop", () => {
  it("gives the stop and loss worked out by hand, across random prices", () => {
    // Written out here, not taken from the ticket: 75% of the price, rounded UP to the cent under $3.00 and to the
    // nickel at or over it; the loss is (price − stop) × 100 + $1.11 fees, a contract.
    const byHand = (p: number) => {
      const exact = (p * 75) / 100;
      return exact >= 300 ? Math.ceil(exact / 5 - 1e-9) * 5 : Math.ceil(exact - 1e-9);
    };
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 400; i++) {
      const cents = 4 + Math.floor(rnd() * 2000);
      const n = 1 + Math.floor(rnd() * 5);
      const f = fillStop({ priceCents: cents, contracts: n });
      const stop = byHand(cents);
      expect(f.stopCents).toBe(stop);
      expect(f.tick).toBe(stop >= 300 ? 5 : 1);
      expect(f.lossCents).toBe(n * ((cents - stop) * 100 + 111));
      expect(f.premiumCents).toBe(n * cents * 100);
      expect(f.noStop).toBeNull();
    }
    // a few by eye: $1.24 → $0.93; $4.10 → $3.075 → $3.10; $3.99 → $2.9925 → $3.00 (to the cent, under $3.00)
    expect(fillStop({ priceCents: 124, contracts: 1 }).stopCents).toBe(93);
    expect(fillStop({ priceCents: 410, contracts: 1 }).stopCents).toBe(310);
    expect(fillStop({ priceCents: 399, contracts: 1 }).stopCents).toBe(300);
  });
  it("says each rule 4 limit the fill is over, with the numbers", () => {
    // 3 at $1.00: $300 premium, stop $0.75, $25 + $1.11 fees a contract = $78.33 at the stop
    const f = fillStop({ priceCents: 100, contracts: 3 });
    expect(f.breaks).toEqual([
      "3 × $1.00 a share is $300.00 of premium, over your $200.00 cap (rule 4).",
      "At the stop this loses $78.33 with fees, over your $50.00 a trade (rule 4).",
    ]);
    expect(fillStop({ priceCents: 100, contracts: 1 }).breaks).toEqual([]);
    expect(fillStop({ priceCents: 3, contracts: 1 }).noStop).toMatch(/^Too cheap to place a stop under it/);
  });
  it("reads the typed fill forgivingly, with the ticket's reader", () => {
    expect(checkOptionFill("", "")).toEqual({ ok: true, fill: null });
    expect(checkOptionFill("1,25", " 2 ")).toEqual({ ok: true, fill: { priceCents: 125, contracts: 2 } });
    expect(checkOptionFill("$1.25", "")).toMatchObject({ ok: false, field: "n" });
    expect(checkOptionFill("", "2")).toMatchObject({ ok: false, field: "opt" });
    expect(checkOptionFill("abc", "2")).toMatchObject({ ok: false, field: "opt", error: (readPrice("abc") as { text: string }).text });
    expect(readContracts("1.5").kind).toBe("bad");
    expect(readContracts("0").kind).toBe("bad");
    expect(readContracts("100").kind).toBe("bad");
    // the price only: he types the contracts he actually bought
    expect(prefillFrom("1,24")).toEqual({ price: "1.24", contracts: "" });
    expect(prefillFrom("")).toBeNull();
  });
  it("loads an old note without the new fields, and drops a bad fill without dropping the note", () => {
    const old = { symbol: "QQQ", side: "call", price: 751, at: ny("10:29"), kind: "plan", plan: PLAN };
    expect(parseNotes(JSON.stringify([old]))).toEqual([old]);
    const [bad] = parseNotes(JSON.stringify([{ ...old, fill: { priceCents: 1.5, contracts: 2 }, stopPlaced: "yes" }]));
    expect(bad).toEqual(old);
    const [good] = parseNotes(JSON.stringify([{ ...old, fill: { priceCents: 124, contracts: 2 }, stopPlaced: true }]));
    expect(good).toEqual({ ...old, fill: { priceCents: 124, contracts: 2 }, stopPlaced: true });
  });
  it("draws the stop big, the tick caveat, the plain reminder until ticked, and the room", () => {
    const v = { symbol: "QQQ", side: "call" } as ManageView;
    const st = fillStop({ priceCents: 124, contracts: 1 });
    const s: CardStop = { stop: st, placed: false, room: roomAfterStop({ current: true, net: 0 }, st.lossCents), readLine: "Fills read 10:21 New York" };
    const html = renderToStaticMarkup(createElement(StopBlock, { v, s }));
    expect(html).toContain("Stop to place in Webull:");
    expect(html).toContain("$0.93");
    expect(html).toContain("check the tick in Webull");
    expect(html).toContain(STOP_REMINDER);
    expect(html).toContain("If this stop fills: $67.89 of your $100 day limit left.");
    if (nickelLine(st)) expect(html).toContain("If it steps $0.05");
    const ticked = renderToStaticMarkup(createElement(StopBlock, { v, s: { ...s, placed: true } }));
    expect(ticked).not.toContain(STOP_REMINDER);
    expect(ticked).toContain("Marked placed by you; this page cannot see Webull.");
    const none = renderToStaticMarkup(createElement(StopBlock, { v, s: { ...s, stop: null, room: null } }));
    expect(none).toContain("Add your option fill");
  });
  it("offers Edit fill on a card with a fill, as a 44 px button", () => {
    const v = { symbol: "QQQ", side: "call" } as ManageView;
    const st = fillStop({ priceCents: 124, contracts: 1 });
    const html = renderToStaticMarkup(createElement(StopBlock, { v, s: { stop: st, placed: false, room: null, readLine: null, onAddFill: () => {} } }));
    expect(html).toMatch(/<button[^>]*data-manage-fill-edit[^>]*min-h-11[^>]*>Edit fill<\/button>/);
  });
  it("shows only the too-cheap line for a fill of $0.01 to $0.03", () => {
    const v = { symbol: "QQQ", side: "call" } as ManageView;
    for (const c of [1, 2, 3]) {
      const st = fillStop({ priceCents: c, contracts: 1 });
      const html = renderToStaticMarkup(createElement(StopBlock, { v, s: { stop: st, placed: false, room: roomAfterStop({ current: true, net: 0 }, st.lossCents), readLine: null } }));
      expect(html).toContain("Too cheap to place a stop under it");
      expect(html).not.toContain("Stop to place in Webull");
      expect(html).not.toContain("Lost if filled at the stop");
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain("day limit");
    }
    expect(fillStop({ priceCents: 4, contracts: 1 }).noStop).toBeNull();
  });
});
