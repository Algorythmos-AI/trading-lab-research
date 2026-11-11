import { describe, expect, it } from "vitest";
import { type JournalRow, listRows, nextSort, rowWords, SORT_CHOICES, sortOf, sortValue } from "@/lib/journal-list";
import { readShortLine } from "@/lib/session-timeline";

// The Trades page's list of every trade: one row model and one state, drawn as a table from sm up and as cards on a
// phone. The search, the filter, the sort and the words each row shows are shared, so both say the same.
const row = (id: string, over: Partial<JournalRow> = {}): JournalRow => ({
  id,
  when: "16 Oct 26 · 14:07",
  at: 0,
  symbol: "SPY",
  what: "SPY 16 Oct 26 580 C",
  kind: "call",
  qty: 1,
  entry: 1.25,
  exit: 1.5,
  pnl: 0,
  gross: 0,
  fees: null,
  optionPct: null,
  r25: null,
  r50: null,
  pieces: [],
  held: "3 min",
  holdMin: 3,
  expired: false,
  ...over,
});

const rows = [
  row("a", { at: 1, pnl: 25, holdMin: 5, qty: 2 }),
  row("b", { at: 2, pnl: -40, holdMin: 1, qty: 1, what: "QQQ 16 Oct 26 500 P", symbol: "QQQ" }),
  row("c", { at: 3, pnl: 0, holdMin: 9, qty: 3, when: "17 Oct 26 · 10:01" }),
];
const ids = (r: JournalRow[]) => r.map((x) => x.id);

describe("the trade list", () => {
  it("sorts by any column either way, and leaves its input alone", () => {
    expect(ids(listRows(rows, "", "all", { key: "at", dir: -1 }))).toEqual(["c", "b", "a"]);
    expect(ids(listRows(rows, "", "all", { key: "pnl", dir: -1 }))).toEqual(["a", "c", "b"]);
    expect(ids(listRows(rows, "", "all", { key: "holdMin", dir: 1 }))).toEqual(["b", "a", "c"]);
    expect(ids(rows)).toEqual(["a", "b", "c"]);
  });

  it("keeps winners or losers only (a flat trade is neither), and finds by contract or date", () => {
    expect(ids(listRows(rows, "", "win", { key: "at", dir: 1 }))).toEqual(["a"]);
    expect(ids(listRows(rows, "", "loss", { key: "at", dir: 1 }))).toEqual(["b"]);
    expect(ids(listRows(rows, " qqq ", "all", { key: "at", dir: 1 }))).toEqual(["b"]);
    expect(ids(listRows(rows, "17 oct", "all", { key: "at", dir: 1 }))).toEqual(["c"]);
  });

  it("flips a column pressed again, and starts another high to low", () => {
    expect(nextSort({ key: "at", dir: -1 }, "at")).toEqual({ key: "at", dir: 1 });
    expect(nextSort({ key: "at", dir: 1 }, "pnl")).toEqual({ key: "pnl", dir: -1 });
  });

  it("offers every column sort in the phone's menu, and reads each choice back", () => {
    for (const key of ["at", "pnl", "holdMin", "qty"] as const)
      for (const dir of [1, -1] as const) expect(sortOf(sortValue({ key, dir }))).toEqual({ key, dir });
    expect(SORT_CHOICES).toHaveLength(8);
    expect(sortOf("nonsense")).toBeNull();
  });

  it("says each figure with a real minus sign, the same in the table and on a card", () => {
    const w = rowWords(row("x", { pnl: -12.5, gross: -10, fees: 2.5, optionPct: -0.1, r25: -0.4, r50: -0.25, qty: 1200 }));
    expect(w).toEqual({
      result: "−$12.50",
      beforeFees: "−$10.00 before fees",
      tone: "bad",
      qty: "1,200",
      inOut: "1.25 → 1.50",
      fees: "$2.50",
      onPremium: "−10%",
      r25: "−0.40",
      r50: "−0.25",
    });
    const s = rowWords(row("y", { pnl: 41, gross: 41 }));
    expect(s).toMatchObject({ result: "+$41.00", beforeFees: null, tone: "good", fees: "—", onPremium: "—", r25: "—" });
    expect(rowWords(row("z")).tone).toBe("flat");
  });
});

describe("the rail's short fills-read line", () => {
  it("puts the time first, and the New York day only when the read was not today", () => {
    expect(readShortLine("2026-10-16T14:21:00Z", true)).toBe("Fills read 10:21 NY");
    expect(readShortLine("2026-10-16T21:05:00Z", false)).toBe("Fills read 17:05 NY, Fri 16 Oct");
  });
});
