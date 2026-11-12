import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fixtureDoc from "./fixtures/journal.v1.json";
import { DayReviewBody, rulesLegend, rulesText } from "@/components/day-review";
import { BOARD_LABEL_LINE, parseDay, pickDay, reviewView } from "@/lib/day-review";
import { poisonedJournal } from "@/lib/fixture-variants";
import { ALL, daily, MIN_SAMPLE, nyTime, sessionView, skippedLine, summarize, type JournalDoc, type Lot, type Trade } from "@/lib/journal";
import { yourDays } from "@/lib/market-calendar";
import { daysWithEntries, judgeDay } from "@/lib/overview";
import { exitStats, R50_DOLLARS, tradeUnits } from "@/lib/owner-positions";
import type { JournalResult } from "@/lib/snapshot";
import { dayCheck, RULES, tradeBreaks } from "@/lib/trade-rules";
import { tradesView } from "@/lib/trades-view";

// The pane boundary asks for the router; no app router is mounted under a static render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/review",
  useSearchParams: () => new URLSearchParams(),
}));

const fixture = fixtureDoc as unknown as JournalDoc;
// The fixture journal's last read, an evening after its last trades.
const LATE = new Date("2026-10-16T22:00:00Z");

let n = 0;
const piece = (opened: string, closed: string, entry: number, exit: number, extra: Partial<Trade> = {}): Trade => {
  const qty = extra.qty ?? 1;
  return { id: `r${String(++n).padStart(3, "0")}`, symbol: "SPY", kind: "call", strike: 600, expiry: "2026-11-20", side: "long", qty, opened_at: opened, closed_at: closed, entry, exit, multiplier: 100, pnl: Math.round((exit - entry) * 100 * qty * 100) / 100, close: "order", ...extra };
};
const journal = (trades: Trade[], open: Lot[] = [], extra: Partial<JournalDoc> = {}): JournalDoc =>
  ({ ...fixture, as_of: "2026-11-03T21:05:00Z", trades, open, gaps: [], money: null, fees_included: false, ...extra }) as JournalDoc;
const render = (result: JournalResult, q: Record<string, string> = {}, now = LATE) => renderToStaticMarkup(createElement(DayReviewBody, { result, q, now }));
const ok = (doc: JournalDoc): JournalResult => ({ status: "ok", doc, source: "fixture" });
/** The page's words, without its markup. */
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("picking the day", () => {
  it("reads only a real day written YYYY-MM-DD", () => {
    expect(parseDay("2026-10-09")).toBe("2026-10-09");
    for (const bad of ["2026-13-01", "2026-02-30", "2026-10-9", "2026-10-09 ", "20261009", "yesterday", "", "2026-10-09T00:00:00Z"]) expect(parseDay(bad)).toBeNull();
    expect(parseDay(["2026-10-09"])).toBeNull();
    expect(parseDay(undefined)).toBeNull();
  });

  it("defaults to the latest day, keeps a valid one, ignores an invalid one and links only to days with positions", () => {
    const days = ["2026-10-06", "2026-10-08", "2026-10-09"];
    expect(pickDay(days, undefined)).toEqual({ day: "2026-10-09", prev: "2026-10-08", next: null });
    expect(pickDay(days, "nonsense")).toEqual({ day: "2026-10-09", prev: "2026-10-08", next: null });
    expect(pickDay(days, "2026-10-06")).toEqual({ day: "2026-10-06", prev: null, next: "2026-10-08" });
    expect(pickDay(days, "2026-10-08")).toEqual({ day: "2026-10-08", prev: "2026-10-06", next: "2026-10-09" });
    // A day with nothing on it is shown as asked, its neighbours the nearest days that have positions.
    expect(pickDay(days, "2026-10-07")).toEqual({ day: "2026-10-07", prev: "2026-10-06", next: "2026-10-08" });
    expect(pickDay(days, "2026-01-01")).toEqual({ day: "2026-01-01", prev: null, next: "2026-10-06" });
    expect(pickDay([], undefined)).toEqual({ day: null, prev: null, next: null });
  });

  it("over the fixture: the latest day up to today, and no link at either end", () => {
    const v = reviewView(fixture, undefined, LATE);
    expect(v.day).toBe("2026-10-15");
    expect(v.next).toBeNull();
    expect(v.prev).toBe("2026-10-13");
    const first = reviewView(fixture, v.days[0], LATE);
    expect(first.prev).toBeNull();
    // Under the pictures' stood-still clock (Mon 12 Oct, 11:01 New York) the later days are not offered.
    const frozen = reviewView(fixture, undefined, new Date("2026-10-12T15:01:00Z"));
    expect(frozen.day).toBe("2026-10-09");
    expect(frozen.next).toBeNull();
    for (const d of [...v.days, ...frozen.days]) expect(v.days).toContain(d);
    const html = render(ok(fixture), { day: v.days[0]! });
    expect(html).not.toContain("Previous day with positions");
    expect(html).toContain(`href="/review?day=${v.days[1]}"`);
  });

  it("takes the New York day, across midnight UTC and the end of daylight saving", () => {
    // 21:30 New York on Mon 2 Nov (EST, the day after the clocks went back) is 02:30 UTC on 3 Nov.
    const late = piece("2026-11-03T02:30:00Z", "2026-11-03T02:40:00Z", 1, 1.2);
    // 09:35 New York on Fri 30 Oct (EDT) and on Mon 2 Nov (EST): an hour apart in UTC.
    const edt = piece("2026-10-30T13:35:00Z", "2026-10-30T13:40:00Z", 1, 1.1);
    const est = piece("2026-11-02T14:35:00Z", "2026-11-02T14:40:00Z", 1, 0.9);
    const doc = journal([late, edt, est]);
    // 22:00 New York on 2 Nov is 03:00 UTC on 3 Nov: still 2 Nov in New York, so 3 Nov is not a day yet.
    const v = reviewView(doc, undefined, new Date("2026-11-03T03:00:00Z"));
    expect(v.days).toEqual(["2026-10-30", "2026-11-02"]);
    expect(v.day).toBe("2026-11-02");
    expect(v.review!.rows.map((r) => r.id)).toEqual([est.id, late.id]);
    expect(v.review!.isToday).toBe(true);
    expect(v.review!.sessionOpen).toBe(false);
    expect(v.review!.rows.map((r) => nyTime(r.openedAt).minute)).toEqual([9 * 60 + 35, 21 * 60 + 30]);
    expect(reviewView(doc, "2026-10-30", new Date("2026-11-03T03:00:00Z")).review!.rows.map((r) => nyTime(r.openedAt).minute)).toEqual([9 * 60 + 35]);
    // In the session that day: the day so far.
    const open = reviewView(doc, undefined, new Date("2026-11-02T15:00:00Z"));
    expect(open.day).toBe("2026-11-02");
    expect(open.review!.sessionOpen).toBe(true);
    expect(render(ok(doc), {}, new Date("2026-11-02T15:00:00Z"))).toContain("Session still open: this is the day so far.");
    expect(render(ok(doc), {}, new Date("2026-11-03T03:00:00Z"))).not.toContain("Session still open");
  });
});

describe("the summary is the Trades page's own figures", () => {
  const view = tradesView(fixture, ALL, LATE);
  const gross = daily(fixture.trades);
  const breaks = tradeBreaks(fixture.trades);
  const days = yourDays(fixture.trades);
  // The Overview strip and the Calendar's test of the two day rules.
  const rule = new Map(daysWithEntries(fixture.trades).map((d) => [d.day, { ...d, ...judgeDay(d) }]));
  const all = reviewView(fixture, undefined, LATE).days;

  it("covers every fixture day", () => expect(all.length).toBeGreaterThan(20));

  for (const day of reviewView(fixture, undefined, LATE).days)
    it(`on ${day}`, () => {
      const r = reviewView(fixture, day, LATE).review!;
      const positions = view.positions.filter((p) => p.day === day);
      // Loss size: the Loss size panel's exitStats over the same positions.
      const x = exitStats(positions, MIN_SAMPLE);
      expect(r.loss).toMatchObject({ counted: x.n, losers: x.losers, pastStop: x.pastStop });
      expect(r.loss.beyondStop).toBeCloseTo(x.beyondStop, 9);
      // Every loser over $50 carries rule 4 on its row.
      for (const row of r.rows.filter((w) => w.overRisk)) expect(row.rules).toContain(4);
      expect(r.rows.filter((row) => row.pastStop).length).toBe(x.pastStop);
      expect(r.rows.reduce((s, row) => s + row.beyondPlan, 0)).toBeCloseTo(x.beyondStop, 9);
      // Result: the Trades page's day after fees (its calendar and best and worst days) and before fees.
      const netDay = view.days.find((d) => d.day === day);
      expect(r.result?.net ?? null).toBe(netDay?.pnl ?? null);
      if (r.result) {
        expect(r.result.gross).toBe(gross.find((d) => d.day === day)!.pnl);
        expect(r.result.r50).toBeCloseTo(netDay!.pnl / R50_DOLLARS, 12);
      }
      // Rules: the same breaks the Trades page and the Calendar read, per position and for the day.
      for (const row of r.rows) {
        const ids = breaks.get(row.id) ?? [];
        expect(row.rules).toEqual(RULES.filter((x) => ids.includes(x.id)).map((x) => x.n));
      }
      expect(r.rules.kept).toBe(positions.filter((p) => !breaks.has(p.id)).length);
      expect(r.rules.of).toBe(positions.length);
      expect([...new Set(r.rows.flatMap((row) => row.rules))].sort((a, b) => a - b)).toEqual(days.get(day)?.rules ?? []);
      const d = rule.get(day)!;
      expect(r.rules.entries).toBe(d.entries);
      expect(r.rules.dayLossKept && r.rules.entriesKept).toBe(d.kept);
      // Trades: as the Today panel counts the session's trades, when nothing is still held.
      if (!r.trades.open) {
        const units = tradeUnits(fixture.trades, { basis: "net", feesIncluded: fixture.fees_included }).filter((u) => u.position?.day === day);
        const s = summarize(units.map((u) => u.unit));
        expect([r.trades.taken, r.trades.winners, r.trades.losers]).toEqual([s.trades, s.wins, s.losses]);
        // With every position closed the same day, the day's R50 is the positions' R50 added up.
        if (!r.result!.carried) expect(r.result!.r50).toBeCloseTo(units.reduce((s, u) => s + u.position!.r50, 0), 9);
      }
    });

  it("counts today's trades as the rules strip does", () => {
    const now = new Date("2026-10-15T15:00:00Z");
    const r = reviewView(fixture, undefined, now).review!;
    expect(r.day).toBe("2026-10-15");
    const c = dayCheck(sessionView(fixture, now), { asOf: fixture.as_of, now });
    expect(r.rules.entries).toBe(c.used);
    expect(r.rules.dayNet).toBe(c.net);
  });
});

describe("positions", () => {
  it("a sell-half is one position", () => {
    const a = piece("2026-11-02T14:35:00Z", "2026-11-02T14:38:00Z", 1, 1.3);
    const b = { ...piece("2026-11-02T14:35:00Z", "2026-11-02T14:44:00Z", 1, 1.5), id: "r999" };
    const r = reviewView(journal([a, b]), "2026-11-02", new Date("2026-11-03T03:00:00Z")).review!;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ id: a.id, contracts: 2, cost: 200, closedAt: b.closed_at, open: false });
    expect(r.trades).toEqual({ taken: 1, winners: 1, losers: 0, open: 0 });
    expect(r.rules.entries).toBe(1);
  });

  it("a contract still held only for its entry fill is open, with no result and no all-clear", () => {
    const sold = piece("2026-11-02T14:35:00Z", "2026-11-02T14:38:00Z", 1, 1.3);
    const rest: Lot = { symbol: "SPY", kind: "call", strike: 600, expiry: "2026-11-20", side: "long", qty: 1, entry: 1, opened_at: "2026-11-02T14:35:00Z" };
    const fresh: Lot = { symbol: "QQQ", kind: "put", strike: 500, expiry: "2026-11-20", side: "long", qty: 2, entry: 0.8, opened_at: "2026-11-02T15:10:00Z" };
    const doc = journal([sold], [rest, fresh]);
    const r = reviewView(doc, "2026-11-02", new Date("2026-11-02T16:00:00Z")).review!;
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row).toMatchObject({ open: true, net: null, gross: null, r25: null, r50: null, closedAt: null, pastStop: false, beyondPlan: 0, rules: [] });
    expect(r.rows[1]).toMatchObject({ contract: "QQQ 500 put · 20 Nov 26", contracts: 2, cost: 160 });
    expect(r.trades).toEqual({ taken: 2, winners: 0, losers: 0, open: 2 });
    const text = words(render(ok(doc), { day: "2026-11-02" }, new Date("2026-11-02T16:00:00Z")));
    expect(text).toContain("Still open");
    // "Rules kept" is the tile's label only: an open row reads "Open", never the all-clear.
    expect(text.match(/Rules kept/g)).toHaveLength(1);
    // Two rows, each "Open" on its card's rules and twice in the table (its close and its rules).
    expect(text.match(/ Open /g)?.length).toBe(6);
  });

  it("a position sold in full and bought again is closed; the rebuy still held is its own open row (B1)", () => {
    // SPY 600 call: bought 10:00 at $1.00, sold 10:04 at $0.70 ($30 before fees, $31.11 after); bought again 10:30 at
    // $0.80 and still held at 16:30 New York.
    const first = piece("2026-11-02T15:00:00Z", "2026-11-02T15:04:00Z", 1, 0.7);
    const rebuy: Lot = { symbol: "SPY", kind: "call", strike: 600, expiry: "2026-11-20", side: "long", qty: 1, entry: 0.8, opened_at: "2026-11-02T15:30:00Z" };
    const doc = journal([first], [rebuy], { as_of: "2026-11-02T21:20:00Z" });
    const now = new Date("2026-11-02T21:30:00Z");
    const r = reviewView(doc, undefined, now).review!;
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ id: first.id, open: false, closedAt: first.closed_at, rules: [5], pastStop: true, overRisk: false });
    expect(r.rows[0]!.net).toBeCloseTo(-31.11, 9);
    expect(r.rows[0]!.beyondPlan).toBeCloseTo(5, 9);
    expect(r.rows[1]).toMatchObject({ open: true, net: null, rules: [], contracts: 1, cost: 80 });
    expect(r.trades).toEqual({ taken: 2, winners: 0, losers: 1, open: 1 });
    expect(r.loss).toMatchObject({ losers: 1, pastStop: 1, overRisk: 0, leftOut: 0 });
    const text = words(render(ok(doc), {}, now));
    expect(text).toContain("0 won · 1 lost · 1 open");
    expect(text).toContain("−$5.00 beyond −25% · 1 past the stop · 0 over $50");
    expect(text).toContain("Trades 2 of 5: kept · Day closed inside the loss limit");
    expect(text).not.toContain("No losers");
  });

  it("a loser past −25% shows the dollars beyond the plan, to the cent, and a winner never does", () => {
    const loser = piece("2026-11-02T14:35:00Z", "2026-11-02T14:50:00Z", 2, 1);
    const kept = piece("2026-11-02T15:00:00Z", "2026-11-02T15:03:00Z", 2, 1.6);
    const winner = piece("2026-11-02T15:30:00Z", "2026-11-02T15:33:00Z", 1, 3);
    const doc = journal([loser, kept, winner]);
    const at = new Date("2026-11-03T03:00:00Z");
    const r = reviewView(doc, "2026-11-02", at).review!;
    const [l, k, w] = r.rows;
    // Sold for $100 against a cost of $200: $50 past the $150 the −25% stop leaves.
    expect(l).toMatchObject({ pastStop: true, beyondPlan: 50, overRisk: true });
    expect(k).toMatchObject({ pastStop: false, beyondPlan: 0, overRisk: false });
    expect(w).toMatchObject({ pastStop: false, beyondPlan: 0, overRisk: false });
    expect(r.loss).toEqual({ counted: 3, losers: 2, pastStop: 1, beyondStop: 50, overRisk: 1, leftOut: 0 });
    expect(l!.rules).toEqual([4, 5, 6]);
    const text = words(render(ok(doc), { day: "2026-11-02" }, at));
    // Once on the card and once in the table, for the one loser.
    expect(text.match(/−\$50\.00 beyond the plan/g)).toHaveLength(2);
    expect(text).toContain("Loss size −$50.00 beyond −25% · 1 past the stop · 1 over $50");
    const clean = words(render(ok(journal([kept, winner])), { day: "2026-11-02" }, at));
    expect(clean).toContain("Loss size $0.00 Every loss at plan size.");
    expect(clean).not.toMatch(/beyond the plan/);
  });

  it("counts a loss over $50 as rule 4 does, before fees (M1)", () => {
    const at = new Date("2026-11-03T03:00:00Z");
    // Cost $200, sold at $1.505: $49.50 lost before fees, $50.61 after. Inside rule 4, and inside the stop (−24.75%).
    const inside = piece("2026-11-02T14:35:00Z", "2026-11-02T14:38:00Z", 2, 1.505);
    const a = reviewView(journal([inside]), "2026-11-02", at).review!;
    expect(a.rows[0]).toMatchObject({ rules: [], overRisk: false, pastStop: false });
    expect(a.rows[0]!.net).toBeCloseTo(-50.61, 9);
    expect(a.loss).toMatchObject({ losers: 1, pastStop: 0, overRisk: 0 });
    const ta = words(render(ok(journal([inside])), { day: "2026-11-02" }, at));
    expect(ta).toContain("Every loss at plan size.");
    expect(ta).toContain("Rules kept 1 of 1 position");
    // Sold at $1.4999: $50.01 before fees, over rule 4, and a cent past the stop.
    const over = piece("2026-11-02T14:35:00Z", "2026-11-02T14:38:00Z", 2, 1.4999);
    const b = reviewView(journal([over]), "2026-11-02", at).review!;
    expect(b.rows[0]).toMatchObject({ rules: [4, 5], overRisk: true, pastStop: true });
    expect(b.loss).toMatchObject({ losers: 1, pastStop: 1, overRisk: 1 });
    expect(words(render(ok(journal([over])), { day: "2026-11-02" }, at))).toContain("Loss size −$0.01 beyond −25% · 1 past the stop · 1 over $50");
    // Sold at $1.49999: a tenth of a cent past the stop is not shown as beyond the plan and does not colour the tile.
    const hair = piece("2026-11-02T14:35:00Z", "2026-11-02T14:38:00Z", 2, 1.49999);
    const c = reviewView(journal([hair]), "2026-11-02", at).review!;
    expect(c.rows[0]).toMatchObject({ pastStop: false, beyondPlan: 0, overRisk: false });
    const tc = render(ok(journal([hair])), { day: "2026-11-02" }, at);
    expect(words(tc)).toContain("Loss size $0.00 Every loss at plan size.");
    expect(words(tc)).not.toContain("−$0");
    expect(tc).not.toMatch(/before:bg-bad-fill[^"]*"[^>]*>(?:(?!<\/div>).)*Loss size/s);
  });

  it("says the losers the figures leave out, and never gives the all-clear with one (M3)", () => {
    const at = new Date("2026-11-03T03:00:00Z");
    const gaps = [{ date: "2026-11-02", kind: "close-without-open", symbol: "SPY", pnl: 10 }] as JournalDoc["gaps"];
    // Cost $60, sold at $0.20: $40 lost, with a gap in the broker's history that day.
    const small = piece("2026-11-02T14:35:00Z", "2026-11-02T14:38:00Z", 0.6, 0.2);
    const a = reviewView(journal([small], [], { gaps }), "2026-11-02", at).review!;
    expect(a.loss).toEqual({ counted: 0, losers: 0, pastStop: 0, beyondStop: 0, overRisk: 0, leftOut: 1 });
    const ta = render(ok(journal([small], [], { gaps })), { day: "2026-11-02" }, at);
    expect(words(ta)).toContain("Loss size $0.00 beyond −25% · 0 past the stop · 0 over $50 · 1 left out");
    expect(words(ta)).not.toMatch(/Every loss at plan size|No losers/);
    expect(ta).toMatch(/before:bg-warn-fill[^"]*"[^>]*>(?:(?!<\/div>).)*Loss size/s);
    // A gap loser of $94 on its own.
    const big = piece("2026-11-02T14:35:00Z", "2026-11-02T14:38:00Z", 1.5, 0.56);
    const tb = words(render(ok(journal([big], [], { gaps })), { day: "2026-11-02" }, at));
    expect(tb).toContain("beyond −25% · 0 past the stop · 0 over $50 · 1 left out");
    expect(tb).toContain("The −25% test is on the price you sold at, before fees, so a result a little under −1 R25 can still be inside the stop.");
  });

  it("on 9 Oct a $1,470 position lost more than $50 without passing −25%", () => {
    const r = reviewView(fixture, "2026-10-09", LATE).review!;
    expect(r.loss).toMatchObject({ losers: 3, pastStop: 0, beyondStop: 0, overRisk: 1, leftOut: 0 });
    expect(r.rows.find((row) => row.overRisk)).toMatchObject({ contract: "SPY 559 put · 12 Oct 26", cost: 1470 });
    const html = render(ok(fixture), { day: "2026-10-09" });
    expect(words(html)).toContain("Loss size $0.00 beyond −25% · 0 past the stop · 1 over $50");
    expect(html).toMatch(/before:bg-bad-fill[^"]*"[^>]*>(?:(?!<\/div>).)*Loss size/s);
  });

  it("says no losers today, or this day on another day", () => {
    const winner = piece("2026-11-02T15:30:00Z", "2026-11-02T15:33:00Z", 1, 3);
    expect(words(render(ok(journal([winner])), { day: "2026-11-02" }, new Date("2026-11-03T03:00:00Z")))).toContain("No losers today.");
    expect(words(render(ok(journal([winner])), { day: "2026-11-02" }, new Date("2026-11-04T15:00:00Z")))).toContain("No losers this day.");
  });

  it("a lot bought Monday and still held Tuesday is Monday's open row, never 'Rules kept' (M2), and the cap says so", () => {
    const held: Lot = { symbol: "SPY", kind: "put", strike: 590, expiry: "2026-11-20", side: "long", qty: 1, entry: 1.2, opened_at: "2026-11-02T19:30:00Z" };
    const doc = journal([], [held]);
    const now = new Date("2026-11-03T16:00:00Z");
    const r = reviewView(doc, "2026-11-02", now).review!;
    expect(r.rows).toEqual([expect.objectContaining({ open: true, rules: [], net: null })]);
    const text = words(render(ok(doc), { day: "2026-11-02" }, now));
    expect(text).toContain("SPY 590 put · 20 Nov 26 Still open 14:30 → open");
    expect(text).toContain("Trades 0 of 5 closed · 1 still open · Day closed inside the loss limit");
    expect(text.match(/Rules kept/g)).toHaveLength(1);
  });

  it("words the day loss limit by the day's close: −$120 at 14:50, then +$100 at 15:30", () => {
    const down = piece("2026-11-02T19:40:00Z", "2026-11-02T19:50:00Z", 3, 1.8);
    const back = piece("2026-11-02T20:20:00Z", "2026-11-02T20:30:00Z", 1, 2);
    const r = reviewView(journal([down, back]), "2026-11-02", new Date("2026-11-04T15:00:00Z")).review!;
    expect(r.rules).toMatchObject({ entries: 2, dayNet: -20, dayLossKept: true, entriesKept: true });
    // The trade after the day was down $100 breaks rule 7 on its own row.
    expect(r.rows[1]!.rules).toEqual([7]);
    expect(words(render(ok(journal([down, back])), { day: "2026-11-02" }, new Date("2026-11-04T15:00:00Z")))).toContain("Trades 2 of 5: kept · Day closed inside the loss limit");
    const worse = piece("2026-11-02T20:20:00Z", "2026-11-02T20:30:00Z", 1, 0.9);
    expect(words(render(ok(journal([down, worse])), { day: "2026-11-02" }, new Date("2026-11-04T15:00:00Z")))).toContain("Day closed past the loss limit");
  });

  it("today with a journal that is not current: as last read, never kept", () => {
    const win = piece("2026-11-02T15:00:00Z", "2026-11-02T15:03:00Z", 1, 1.3);
    const doc = journal([win], [], { as_of: "2026-11-02T18:00:00Z" });
    const text = words(render(ok(doc), {}, new Date("2026-11-02T20:00:00Z")));
    expect(text).toContain("Trades 1 of 5 · Day result +⁠$30, as last read 13:00");
    expect(text).not.toMatch(/: kept|inside the loss limit/);
  });

  it("the session is open only between the open and the close, a half day's close included", () => {
    const early = piece("2026-11-02T12:00:00Z", "2026-11-02T12:10:00Z", 1, 1.2);
    const open = (iso: string) => reviewView(journal([early]), "2026-11-02", new Date(iso)).review!.sessionOpen;
    expect([open("2026-11-02T13:00:00Z"), open("2026-11-02T14:29:00Z"), open("2026-11-02T14:30:00Z"), open("2026-11-02T20:59:00Z"), open("2026-11-02T21:00:00Z")]).toEqual([false, false, true, true, false]);
    // Fri 27 Nov 2026 closes at 13:00 New York.
    const friday = piece("2026-11-27T15:00:00Z", "2026-11-27T15:05:00Z", 1, 1.2);
    const half = (iso: string) => reviewView(journal([friday]), "2026-11-27", new Date(iso)).review!.sessionOpen;
    expect([half("2026-11-27T17:59:00Z"), half("2026-11-27T18:00:00Z")]).toEqual([true, false]);
  });

  it("names the year of a day in another year, the table, and the stock sold that day", () => {
    const old = piece("2024-10-09T15:00:00Z", "2024-10-09T15:03:00Z", 1, 1.3);
    const stock = piece("2024-10-08T15:00:00Z", "2024-10-09T16:00:00Z", 100, 101, { kind: "stock", strike: null, expiry: null, multiplier: 1, symbol: "AAPL" });
    const html = render(ok(journal([old, stock])), { day: "2024-10-09" }, new Date("2026-11-04T15:00:00Z"));
    expect(words(html)).toContain("Day review Wed 9 Oct 2024");
    expect(html).toContain('aria-label="Positions on Wed 9 Oct 2024"');
    expect(html).toContain('scope="col"');
    expect(words(html)).toContain("1 stock or short trade this day is in the result but not listed here.");
    const same = render(ok(journal([piece("2026-11-02T15:00:00Z", "2026-11-02T15:03:00Z", 1, 1.3)])), {}, new Date("2026-11-04T15:00:00Z"));
    expect(words(same)).toContain("Day review Mon 2 Nov ");
    expect(words(same)).not.toContain("stock or short");
  });

  it("explains the day's broken rules once each, in number order, with their own titles", () => {
    expect(rulesLegend([{ rules: [] }])).toEqual([]);
    expect(rulesLegend([{ rules: [6, 7] }, { rules: [4, 6, 7] }, { rules: [] }])).toEqual([4, 6, 7].map((n) => `Rule ${n}: ${RULES.find((r) => r.n === n)!.title}`));
    const r = reviewView(fixture, "2026-10-09", LATE).review!;
    const broken = [...new Set(r.rows.flatMap((row) => row.rules))].sort((a, b) => a - b);
    const html = render(ok(fixture), { day: "2026-10-09" });
    const list = html.match(/<ul aria-label="Rules broken this day"[\s\S]*?<\/ul>/)?.[0] ?? "";
    expect([...list.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]!.replace(/&#x27;/g, "'"))).toEqual(broken.map((n) => `Rule ${n}: ${RULES.find((x) => x.n === n)!.title}`));
    // None on a day that kept them all.
    const kept = piece("2026-11-02T15:30:00Z", "2026-11-02T15:33:00Z", 1, 1.3);
    expect(render(ok(journal([kept])), { day: "2026-11-02" }, new Date("2026-11-03T03:00:00Z"))).not.toContain("Rules broken this day");
  });

  it("the result's hint does not repeat its label", () => {
    const text = words(render(ok(fixture), { day: "2026-10-09" }));
    expect(text).toContain("Result, after fees −⁠$108 R50 −2.16 · before fees −⁠$99");
    expect(text).not.toContain("After est. fees · R50");
  });

  it("names the rules in the rules strip's words", () => {
    expect(rulesText([])).toBe("Rules kept");
    expect(rulesText([5])).toBe("Rule 5");
    expect(rulesText([5, 7])).toBe("Rules 5, 7");
    expect(rulesText([], true)).toBe("Open");
    expect(rulesText([6], true)).toBe("Rule 6");
  });
});

describe("empty and broken journals", () => {
  it("counts the rows that could not be read, in the Trades page's words", () => {
    const v = reviewView(poisonedJournal(fixture), undefined, LATE);
    expect(v.skipped).toBe(1);
    expect(v.day).toBe("2026-10-15");
    expect(render(ok(poisonedJournal(fixture)))).toContain(skippedLine(1)!);
  });

  it("says so for a day with no positions, a journal with none at all, and a journal that is missing or unreadable", () => {
    expect(words(render(ok(fixture), { day: "2026-10-10" }))).toContain("No option positions on this day");
    const none = reviewView(journal([]), undefined, LATE);
    expect(none.day).toBeNull();
    expect(words(render(ok(journal([]))))).toContain("No option positions yet");
    expect(words(render({ status: "error" }))).toContain("Storage could not be read");
    expect(words(render({ status: "missing" }))).toContain("No trades have been sent yet");
    for (const html of [render({ status: "error" }), render(ok(fixture))]) expect(html).toMatch(/<h1[^>]*>Day review<\/h1>/);
  });
});

describe("what the page may not show (DEC-0045 point 8, DEC-0049 point 5)", () => {
  const FILES = ["../src/lib/day-review.ts", "../src/components/day-review.tsx", "../src/app/review/page.tsx"];
  const BANNED = ["would have", "ran to", "win rate", "accuracy", "profit factor", "should have", "high after", "after the exit", "from the level", "stop traded", "% won"];
  for (const f of FILES)
    it(`${f.replace("../", "")} uses none of the banned words`, () => {
      const text = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8").toLowerCase();
      expect(BANNED.filter((w) => text.includes(w))).toEqual([]);
    });

  it("the rendered page uses none of them either, and says nothing about the board's labels but the one fixed line, on every fixture day", () => {
    for (const day of reviewView(fixture, undefined, LATE).days) {
      const v = reviewView(fixture, day, LATE);
      expect(JSON.stringify(v)).not.toMatch(/label/i);
      const text = words(render(ok(fixture), { day }));
      expect(BANNED.filter((w) => text.toLowerCase().includes(w))).toEqual([]);
      expect(text.match(/label/gi)?.length).toBe(1);
      expect(text).toContain(BOARD_LABEL_LINE);
    }
  }, 30_000);
});
