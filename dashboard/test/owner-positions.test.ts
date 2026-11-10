import { describe, expect, it } from "vitest";
import fixtureDoc from "./fixtures/journal.v1.json";
import type { JournalDoc, Trade } from "@/lib/journal";
import { MIN_SAMPLE } from "@/lib/journal";
import {
  exitStats,
  groupPieces,
  MEAN_MIN_POSITIONS,
  MEAN_MIN_SESSIONS,
  meanR25,
  OWNER_FEES,
  ownerPositions,
  positionOf,
  positionTrade,
  R25_SHARE,
  R50_DOLLARS,
  tradeUnits,
  WIN_SHARE,
  type OwnerPosition,
} from "@/lib/owner-positions";
import { PREMIUM_STOP, RISK_PER_TRADE } from "@/lib/trade-rules";

let n = 0;
const piece = (opened: string, closed: string, entry: number, exit: number, extra: Partial<Trade> = {}): Trade => {
  const qty = extra.qty ?? 1;
  return { id: `p${String(++n).padStart(3, "0")}`, symbol: "SPY", kind: "call", strike: 600, expiry: "2026-10-16", side: "long", qty, opened_at: opened, closed_at: closed, entry, exit, multiplier: 100, pnl: Math.round((exit - entry) * 100 * qty * 100) / 100, close: "order", ...extra };
};
const D = "2026-10-14";

describe("the fixed numbers", () => {
  it("are the owner's fees, R25 and R50 are rule 5's stop and rule 4's risk, and the winners' line is half the premium", () => {
    expect(OWNER_FEES).toEqual({ openPerContract: 0.55, closePerContract: 0.56, expiredClose: 0 });
    expect(R25_SHARE).toBe(PREMIUM_STOP);
    expect(R50_DOLLARS).toBe(RISK_PER_TRADE);
    expect(WIN_SHARE).toBe(0.5);
  });
});

describe("grouping pieces into positions", () => {
  it("makes a sell-half one position and a re-entry after the full exit another", () => {
    const ts = [piece(`${D}T14:00:00Z`, `${D}T14:05:00Z`, 1, 1.2), piece(`${D}T14:00:00Z`, `${D}T14:20:00Z`, 1, 1.4), piece(`${D}T14:20:00Z`, `${D}T14:25:00Z`, 1, 0.9)];
    expect(groupPieces(ts).map((g) => g.map((p) => p.id))).toEqual([[ts[0]!.id, ts[1]!.id], [ts[2]!.id]]);
  });

  it("does not depend on the order the journal lists the pieces in", () => {
    const ts = [piece(`${D}T14:00:00Z`, `${D}T14:05:00Z`, 1, 1.2), piece(`${D}T14:03:00Z`, `${D}T14:20:00Z`, 1, 1.4), piece(`${D}T14:30:00Z`, `${D}T14:35:00Z`, 1, 0.9)];
    expect(groupPieces([...ts].reverse())).toEqual(groupPieces(ts));
  });

  it("leaves shares, short pieces and malformed entries out", () => {
    const ts = [piece(`${D}T14:00:00Z`, `${D}T14:05:00Z`, 210, 212, { kind: "stock", strike: null, expiry: null, multiplier: 1 }), piece(`${D}T14:00:00Z`, `${D}T14:05:00Z`, 1, 0.8, { side: "short" })];
    const book = ownerPositions({ trades: [null, 7, { id: "x" }, ...ts] });
    expect(book.positions).toEqual([]);
    expect(book.excluded).toEqual({ stock: 1, short: 1, other: 0 });
  });
});

describe("a position's numbers", () => {
  it("adds the pieces up: cost, the result before and after fees, and R", () => {
    const p = positionOf([piece(`${D}T14:00:00Z`, `${D}T14:05:00Z`, 0.8, 1, { qty: 2 }), piece(`${D}T14:00:00Z`, `${D}T14:09:00Z`, 0.8, 0.5, { qty: 1 })]);
    expect(p.cost).toBeCloseTo(240);
    expect(p.gross).toBeCloseTo(10);
    expect(p.fees).toBeCloseTo(3 * 0.55 + 3 * 0.56);
    expect(p.net).toBeCloseTo(10 - 3.33);
    expect(p.r25).toBeCloseTo((10 - 3.33) / 60);
    expect(p.r50).toBeCloseTo((10 - 3.33) / 50);
    expect(p.r25Gross).toBeCloseTo(10 / 60);
    expect(p.holdMinutes).toBeCloseTo(9);
    expect(p.counts).toBe(true);
  });

  it("writes a position as one record: whole cost, average prices, last close", () => {
    const p = positionOf([piece(`${D}T14:00:00Z`, `${D}T14:06:00Z`, 1.5, 1, { qty: 2 }), piece(`${D}T14:00:00Z`, `${D}T14:08:00Z`, 1.5, 0.9, { qty: 2 })]);
    const t = positionTrade(p, "net");
    expect(t.entry * t.multiplier * t.qty).toBeCloseTo(600);
    expect(1 - t.exit / t.entry).toBeCloseTo(1 - 380 / 600);
    expect(t.closed_at).toBe(`${D}T14:08:00Z`);
    expect(t.pnl).toBeCloseTo(p.net);
    expect(positionTrade(p).pnl).toBeCloseTo(-220);
  });

  it("keeps the units for shares and short pieces as the pieces themselves", () => {
    const share = piece(`${D}T14:00:00Z`, `${D}T15:00:00Z`, 210, 212, { kind: "stock", strike: null, expiry: null, multiplier: 1, qty: 10 });
    const units = tradeUnits([share, piece(`${D}T14:01:00Z`, `${D}T14:05:00Z`, 1, 1.1)], { basis: "net" });
    expect(units.map((u) => u.position === null)).toEqual([true, false]);
    expect(units[0]!.unit).toBe(share);
  });
});

// One contract of 100 shares sold in one piece, unless `pieces` says otherwise.
const pos = (net: number, cost: number, proceeds: number, extra: Partial<OwnerPosition> = {}): OwnerPosition =>
  ({ net, cost, proceeds, r25: net / (0.25 * cost), counts: true, day: `${D}`, contractsOpened: 1, pieces: [piece(`${D}T14:00:00Z`, `${D}T14:05:00Z`, cost / 100, proceeds / 100)], ...extra }) as OwnerPosition;

describe("exit statistics, over every position together", () => {
  it("counts losers past the −25% stop and the dollars beyond it, by what the option was sold for", () => {
    const ps = [pos(-61, 200, 140), pos(-21, 100, 80), pos(-26.11, 100, 75), pos(40, 100, 141), pos(70, 100, 171)];
    const x = exitStats(ps, MIN_SAMPLE);
    expect(x.losers).toBe(3);
    expect(x.pastStop).toBe(1); // 140 of 200 is −30%; 75 of 100 is exactly the stop, not past it
    expect(x.beyondStop).toBeCloseTo(10); // 150 − 140
    expect(x.winners).toBe(2);
    expect(x.smallWins).toBe(1); // +41% is under +50%; +71% is not
    expect(x.avgLoserR25).toBeNull(); // 3 losers: too few to average
  });

  it("counts the positions where a part was held past −25%, apart from the whole result", () => {
    const halves = [piece(`${D}T14:00:00Z`, `${D}T14:02:00Z`, 1, 1.2), piece(`${D}T14:00:00Z`, `${D}T14:05:00Z`, 1, 0.6)];
    const scaled = pos(-20 - 2.22, 200, 180, { contractsOpened: 2, pieces: halves });
    const x = exitStats([scaled, pos(-21, 100, 80), pos(-31, 100, 70)], MIN_SAMPLE);
    expect(x.pastStop).toBe(1); // only the −30% single piece, taken whole
    expect(x.partPastStop).toBe(2); // that one, and the scale-out whose second half was sold at −40%
    expect(x.n).toBe(3);
  });

  it("averages losers and winners in R25 from eight each, and leaves the flagged positions out", () => {
    const ps = [...Array.from({ length: 8 }, () => pos(-25, 100, 76)), ...Array.from({ length: 8 }, () => pos(50, 100, 151)), pos(-90, 100, 10, { counts: false })];
    const x = exitStats(ps, MIN_SAMPLE);
    expect(x.avgLoserR25).toBeCloseTo(-1);
    expect(x.avgWinnerR25).toBeCloseTo(2);
    expect(x.leftOut).toBe(1);
    expect(x.pastStop).toBe(0);
  });

  it("shows the overall mean R25 only from 20 positions over 10 sessions", () => {
    const days = (k: number) => Array.from({ length: 20 }, (_, i) => pos(10, 100, 111, { day: `2026-10-${String(1 + (i % k)).padStart(2, "0")}` }));
    expect(meanR25(days(9))).toEqual({ n: 20, sessions: 9, mean: null });
    expect(meanR25(days(10)).mean).toBeCloseTo(0.4);
    expect(meanR25(days(10).slice(0, MEAN_MIN_POSITIONS - 1)).mean).toBeNull();
    expect(MEAN_MIN_SESSIONS).toBe(10);
  });
});

describe("the fixture", () => {
  it("holds a scale-out, a re-entry, an oversized entry sold in halves and a half left to expire", () => {
    const book = ownerPositions(fixtureDoc as unknown as JournalDoc);
    const of = (id: string) => book.positions.find((p) => p.pieces.some((x) => x.id === id))!;
    expect(of("fx-pos-1").pieces.map((x) => x.id)).toEqual(["fx-pos-1", "fx-pos-2"]);
    expect(of("fx-pos-3").pieces).toHaveLength(1);
    expect(of("fx-pos-4").cost).toBeCloseTo(360);
    expect(of("fx-pos-6").contractsExpired).toBe(1);
    expect(of("fx-pos-6").fees).toBeCloseTo(2 * 0.55 + 0.56);
    // 259 pieces: one share piece, and three positions of two pieces each.
    expect([fixtureDoc.trades.length, book.positions.length]).toEqual([259, 255]);
  });
});
