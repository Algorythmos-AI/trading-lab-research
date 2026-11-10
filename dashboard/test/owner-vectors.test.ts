import { describe, expect, it } from "vitest";
import type { Lot } from "@/lib/journal";
import { OWNER_FEES, ownerPositions } from "@/lib/owner-positions";
import vectors from "./fixtures/owner.vectors.json";

// The vectors are worked out by the Python (scripts/gen_owner_vectors.py from wt.owner.positions), which also keeps
// them current. Agreeing with them here means the page and the verdict group and price the owner's trades the same way.
function near(got: number | null, want: number | null) {
  if (want === null) return expect(got).toBeNull();
  expect(got).not.toBeNull();
  expect(Math.abs(got! - want)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(want)));
}

describe("the owner vectors shared with the Python", () => {
  it("are the ones this suite was written for, with the same fees", () => {
    expect(vectors.schema).toBe("wt/owner-vectors");
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThan(12);
    expect(vectors.fees).toEqual({ open_per_contract: OWNER_FEES.openPerContract, close_per_contract: OWNER_FEES.closePerContract, expired_close: OWNER_FEES.expiredClose });
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      const book = ownerPositions({ trades: c.doc.trades, open: c.doc.open as Lot[] | null, gaps: c.doc.gaps as never, fees_included: c.doc.fees_included });
      const want = c.expect;
      expect(book.excluded).toEqual(want.excluded);
      expect({ zero_cost: book.leftOut.zeroCost, gap_piece: book.leftOut.gapPiece, open_lot: book.leftOut.openLot }).toEqual(want.left_out);
      expect(book.feesIncluded).toBe(want.fees_included);
      expect(book.positions.map((p) => p.pieces.map((x) => x.id))).toEqual(want.positions.map((p) => p.piece_ids));
      book.positions.forEach((p, i) => {
        const w = want.positions[i]!;
        expect([p.id, p.symbol, p.kind, p.strike, p.expiry, p.day, p.t0, p.lastClose]).toEqual([w.id, w.symbol, w.kind, w.strike, w.expiry, w.day, w.t0, w.last_close]);
        near(p.holdMinutes, w.hold_minutes);
        near(p.contractsOpened, w.contracts_opened);
        near(p.contractsClosed, w.contracts_closed);
        near(p.contractsExpired, w.contracts_expired);
        near(p.cost, w.cost);
        near(p.proceeds, w.proceeds);
        near(p.gross, w.gross);
        near(p.fees, w.fees);
        near(p.net, w.net);
        near(p.optionPct, w.option_pct);
        near(p.grossPct, w.gross_pct);
        near(p.r25, w.r25);
        near(p.r50, w.r50);
        near(p.r25Gross, w.r25_gross);
        near(p.r50Gross, w.r50_gross);
        expect(p.closedLaterDay).toBe(w.closed_later_day);
        expect(p.flags).toEqual({ gapPiece: w.flags.gap_piece, zeroCost: w.flags.zero_cost, openLot: w.flags.open_lot, feesIncluded: w.flags.fees_included });
        expect(p.counts).toBe(w.counts);
      });
    });
  }
});
