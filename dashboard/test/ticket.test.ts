import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TicketBody, TradeTicket } from "@/components/client/ticket";
import type { SidePlan } from "@/lib/focus-plan";
import { price } from "@/lib/bs";
import { heroTicketSide } from "@/components/client/now-hero";
import {
  expiryPick,
  failWords,
  floorToTick,
  IV_MAX,
  maxLimitTable,
  minutesLeft,
  nickelStop,
  OWNER_LIMITS,
  quoteAgeMin,
  readAmount,
  readPrice,
  resultLine,
  roundTripCents,
  slipPerCent,
  sizeTicket,
  stopCents,
  strikesByDistance,
  ticketEstimates,
  tickCents,
  usd,
  type Limits,
} from "@/lib/ticket";

const NO_FEES: Limits = { ...OWNER_LIMITS, fees: { openPerContract: 0, closePerContract: 0 } };
const CENT_FEE: Limits = { ...OWNER_LIMITS, fees: { openPerContract: 0.01, closePerContract: 0 } };

describe("reading the typed price", () => {
  it("reads plain, dollar-signed, comma-decimal and spaced prices as whole cents", () => {
    expect(readPrice("1.25")).toEqual({ kind: "ok", cents: 125, reread: false });
    expect(readPrice("$1.25")).toEqual({ kind: "ok", cents: 125, reread: false });
    expect(readPrice(" 1.25 ")).toEqual({ kind: "ok", cents: 125, reread: false });
    expect(readPrice(".5")).toEqual({ kind: "ok", cents: 50, reread: false });
    expect(readPrice("2")).toEqual({ kind: "ok", cents: 200, reread: false });
    expect(readPrice(" 1,25 ")).toEqual({ kind: "ok", cents: 125, reread: true });
    expect(readPrice("1,000.50")).toEqual({ kind: "ok", cents: 100050, reread: true });
  });

  it("says what it read whenever the text is not a plain price", () => {
    expect(readPrice("1 25")).toEqual({ kind: "ok", cents: 12500, reread: true });
    expect(readPrice("12,5.0")).toEqual({ kind: "ok", cents: 12500, reread: true });
    expect(readPrice("$ 1 .2 5")).toEqual({ kind: "ok", cents: 125, reread: true });
    expect(readPrice("1.250")).toEqual({ kind: "ok", cents: 125, reread: true });
  });

  it("refuses more than two decimals instead of rounding", () => {
    for (const t of ["0.005", "1.255", "1.005", "1.004"]) expect(readPrice(t), t).toMatchObject({ kind: "bad", why: "too_many_decimals" });
  });

  it("handles empty, zero, negative, junk and absurd input without a NaN", () => {
    expect(readPrice("")).toEqual({ kind: "empty" });
    expect(readPrice("   ")).toEqual({ kind: "empty" });
    expect(readPrice("$")).toEqual({ kind: "empty" });
    expect(readPrice(null)).toEqual({ kind: "empty" });
    expect(readPrice("0")).toMatchObject({ kind: "bad", why: "zero" });
    expect(readPrice("0.00")).toMatchObject({ kind: "bad", why: "zero" });
    expect(readPrice("-1.25")).toMatchObject({ kind: "bad", why: "negative" });
    expect(readPrice("−1.25")).toMatchObject({ kind: "bad", why: "negative" });
    expect(readPrice("-$1.25")).toMatchObject({ kind: "bad", why: "negative" });
    for (const junk of ["abc", "1.2.3", "1e3", "NaN", "Infinity", ".", "1-2"]) expect(readPrice(junk), junk).toMatchObject({ kind: "bad", why: "not_a_number" });
    expect(readPrice("99999999999999999999999")).toMatchObject({ kind: "bad", why: "too_high" });
    // 250 a share is a price, just one far over the cap: it sizes to nothing and says why.
    const big = readPrice("250");
    expect(big).toEqual({ kind: "ok", cents: 25000, reread: false });
    const s = sizeTicket(25000);
    expect(s.contracts).toBe(0);
    expect(s.fails).toEqual(["premium", "risk"]);
    expect(failWords(s).join(" ")).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("reads a strike as dollars", () => {
    expect(readAmount("712.5")).toBe(712.5);
    expect(readAmount("")).toBeNull();
    expect(readAmount("-5")).toBeNull();
  });
});

describe("the tick and the stop", () => {
  it("assumes $0.01 under $3.00 and $0.05 from $3.00", () => {
    expect(tickCents(299)).toBe(1);
    expect(tickCents(300)).toBe(5);
  });

  it("puts the stop at 75% of the price rounded UP to the cent under $3.00", () => {
    expect(stopCents(125)).toBe(94); // 93.75 → 94
    expect(stopCents(100)).toBe(75); // exact
    expect(stopCents(101)).toBe(76); // 75.75 → 76
    expect(stopCents(399)).toBe(300); // 299.25 → 300, on both ticks
    expect(stopCents(1)).toBe(1); // 0.75 → 1
  });

  it("rounds the stop UP to the nickel from $3.00", () => {
    expect(stopCents(400)).toBe(300); // exact
    expect(stopCents(401)).toBe(305); // 300.75 → 305
    expect(stopCents(500)).toBe(375);
    expect(stopCents(501)).toBe(380); // 375.75 → 380
    expect(stopCents(1000)).toBe(750);
    expect(stopCents(1001)).toBe(755); // 750.75 → 755
  });

  it("rounds a limit price DOWN to the tick", () => {
    expect(floorToTick(66)).toBe(66);
    expect(floorToTick(304)).toBe(300);
    expect(floorToTick(309)).toBe(305);
    expect(floorToTick(299)).toBe(299);
  });
});

describe("the most he may pay, before a price is typed", () => {
  it("matches the hand-worked table for 1 to 5 contracts", () => {
    // Cap: floor($200 / (N × 100)). Both rules: the highest cent price whose stop loss plus $1.11 fees, times N, is ≤ $50.
    // N = 1: $1.95 (stop 1.47, 48¢ × 100 + 111 = 4911); $1.96 has stop 1.47, 49¢ → 5011, over.
    expect(maxLimitTable(5)).toEqual([
      { contracts: 1, capCents: 200, bothCents: 195 },
      { contracts: 2, capCents: 100, bothCents: 95 },
      { contracts: 3, capCents: 66, bothCents: 63 },
      { contracts: 4, capCents: 50, bothCents: 47 },
      { contracts: 5, capCents: 40, bothCents: 35 },
    ]);
  });

  it("without fees, the cap and the stop rule agree at one contract", () => {
    expect(maxLimitTable(1, NO_FEES)[0]).toEqual({ contracts: 1, capCents: 200, bothCents: 200 });
  });
});

describe("sizing from the typed price", () => {
  it("sizes $1.25: one contract, stop $0.94, $32.11 at the stop with fees", () => {
    const s = sizeTicket(125);
    expect(s).toMatchObject({ contracts: 1, stopCents: 94, tick: 1, premiumCents: 12500, feesCents: 111, riskCents: 3211, byPremium: 1, byRisk: 1, fails: [] });
    expect(s.perContract).toEqual({ premium: 12500, lossAtStop: 3100, fees: 111, risk: 3211 });
  });

  it("includes the round-trip fees: $0.55 in and $0.56 out", () => {
    expect(roundTripCents()).toBe(111);
    // $0.35: stop 0.27, 8¢ a share → $8 + $1.11 = $9.11 a contract; 5 fit ($45.55); without fees 6 would.
    expect(sizeTicket(35)).toMatchObject({ contracts: 5, riskCents: 4555, feesCents: 555 });
    expect(sizeTicket(35, NO_FEES).contracts).toBe(5); // the cap: 5 × $35 = $175, a 6th is $210
    // $0.20: stop 0.15, 5¢ a share. Without fees $5 a contract, 10 fit; with them $6.11, 8 fit ($48.88), a 9th is $54.99.
    expect(sizeTicket(20, NO_FEES).contracts).toBe(10);
    expect(sizeTicket(20)).toMatchObject({ contracts: 8, riskCents: 4888, feesCents: 888, premiumCents: 16000 });
  });

  it("allows exactly $200 of premium and refuses one cent over", () => {
    expect(sizeTicket(200, NO_FEES)).toMatchObject({ contracts: 1, premiumCents: 20000 });
    expect(sizeTicket(201, NO_FEES)).toMatchObject({ contracts: 0, fails: ["premium"] });
    expect(sizeTicket(100, NO_FEES)).toMatchObject({ contracts: 2, premiumCents: 20000 });
  });

  it("allows exactly $50 at the stop and refuses one cent over", () => {
    // $2.00 with no fees: stop $1.50, 50¢ × 100 = $50.00 exactly.
    expect(sizeTicket(200, NO_FEES)).toMatchObject({ contracts: 1, riskCents: 5000 });
    // The same with a one-cent fee: $50.01, over by a cent.
    expect(sizeTicket(200, CENT_FEE)).toMatchObject({ contracts: 0, fails: ["risk"] });
    // With the owner's fees $2.00 is $51.11 at the stop: the cap is met, the stop rule is not.
    expect(sizeTicket(200)).toMatchObject({ contracts: 0, fails: ["risk"] });
  });

  it("says plainly which rule a price breaks when nothing fits", () => {
    expect(failWords(sizeTicket(200))).toEqual(["One contract would lose $51.11 at the stop with fees ($50.00 + $1.11 fees), over the $50.00 risk cap."]);
    expect(failWords(sizeTicket(201, NO_FEES))).toEqual(["One contract costs $201.00, over the $200.00 premium cap."]);
    expect(failWords(sizeTicket(125))).toEqual([]);
  });

  it("sizes nothing where the stop rounds up to the price itself", () => {
    for (const p of [1, 2, 3]) {
      const s = sizeTicket(p);
      expect(s.stopCents, `${p}`).toBe(p);
      expect(s.contracts).toBe(0);
      expect(s.fails).toContain("stop");
      expect(failWords(s).join(" ")).toContain("Too cheap to place a stop under it");
    }
    expect(sizeTicket(4)).toMatchObject({ stopCents: 3, contracts: 23 }); // $1 + $1.11 a contract
  });

  it("says what each cent of a worse stop fill costs: N × $1", () => {
    expect(slipPerCent(sizeTicket(125))).toBe(100);
    expect(slipPerCent(sizeTicket(20))).toBe(800);
    expect(slipPerCent(sizeTicket(200))).toBe(0);
  });

  it("gives the nickel stop, rounded UP, only for a stop under $3.00 off the nickel", () => {
    expect(nickelStop(sizeTicket(125))).toEqual({ stopCents: 95, riskCents: 3111 }); // 93.75 → 95; 30¢ × 100 + 111
    expect(nickelStop(sizeTicket(101))).toEqual({ stopCents: 80, riskCents: 2211 }); // 75.75 → 80
    expect(nickelStop(sizeTicket(100))).toBeNull(); // 0.75 is on the nickel
    expect(nickelStop(sizeTicket(200))).toBeNull(); // nothing sized
    expect(nickelStop(sizeTicket(6))).toBeNull(); // 4.5 → 5 is on the nickel
    expect(nickelStop(sizeTicket(5))).toBeNull(); // 3.75 → 5, the price itself: no stop under it
    for (let p = 4; p < 400; p++) {
      const s = sizeTicket(p);
      const n = nickelStop(s);
      if (n) {
        expect(n.stopCents % 5).toBe(0);
        expect(n.stopCents).toBeGreaterThan(s.stopCents);
        expect(n.stopCents).toBeLessThan(p);
      }
    }
  });

  it("puts the result in one short line for screen readers", () => {
    expect(resultLine(sizeTicket(125))).toBe("1 contract, stop $0.94.");
    expect(resultLine(sizeTicket(20))).toBe("8 contracts, stop $0.15.");
    expect(resultLine(sizeTicket(200))).toBe("At $2.00: does not fit your rules.");
  });

  it("refuses a price that is not whole positive cents", () => {
    expect(() => sizeTicket(0)).toThrow(RangeError);
    expect(() => sizeTicket(1.5)).toThrow(RangeError);
    expect(() => sizeTicket(Number.NaN)).toThrow(RangeError);
  });

  it("formats cents without float noise", () => {
    expect(usd(3211)).toBe("$32.11");
    expect(usd(-4555)).toBe("−$45.55");
    expect(usd(100050)).toBe("$1,000.50");
    expect(usd(5)).toBe("$0.05");
  });
});

describe("the sizing invariants, over a few thousand random prices", () => {
  // A small seeded generator, so a failure can be replayed.
  let seed = 20261111;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  it("never passes $200 of premium or $50 at the stop with fees, keeps the stop on the tick at or over 75%, and is maximal", () => {
    const cap = OWNER_LIMITS.maxPremium * 100;
    const max = OWNER_LIMITS.maxRisk * 100;
    for (let i = 0; i < 4000; i++) {
      // Mostly under $3, where sizes are not zero, and some up to $12.
      const p = 1 + Math.floor(rand() < 0.8 ? rand() * 300 : rand() * 1200);
      const s = sizeTicket(p);
      expect(Number.isInteger(s.contracts) && s.contracts >= 0).toBe(true);
      expect(s.contracts * p * 100).toBeLessThanOrEqual(cap);
      expect(s.contracts * ((p - s.stopCents) * 100 + 111)).toBeLessThanOrEqual(max);
      expect(s.riskCents).toBeLessThanOrEqual(max);
      expect(s.premiumCents).toBeLessThanOrEqual(cap);
      // stop ≥ 0.75 P, in integers: 100 × stop ≥ 75 × P; and the next tick down would be under it (rounded UP).
      expect(s.stopCents * 100).toBeGreaterThanOrEqual(75 * p);
      expect((s.stopCents - tickCents(s.stopCents - 1)) * 100).toBeLessThan(75 * p);
      expect(s.stopCents % tickCents(s.stopCents)).toBe(0);
      // Maximal: one more contract breaks a rule.
      const n = s.contracts + 1;
      if (s.stopCents < p) expect(n * p * 100 > cap || n * ((p - s.stopCents) * 100 + 111) > max).toBe(true);
      else expect(s.fails).toContain("stop");
      // A sized trade always has room under the price for its stop.
      if (s.contracts > 0) expect(s.stopCents).toBeLessThan(p);
      // Zero only with a reason, and a reason only at zero.
      expect(s.contracts === 0).toBe(s.fails.length > 0);
    }
  });
});

describe("estimates from the typed price", () => {
  const base = {
    kind: "call" as const,
    spot: 710,
    strike: 712,
    minutes: 300,
    contracts: 1,
    levels: [
      { key: "stop" as const, label: "At the chart stop", price: 708 },
      { key: "t1" as const, label: "At T1", price: 715 },
    ],
  };
  // A price the model gives at 25% a year, so the solve has a clean answer to find.
  const fair = Math.round(price(710, 712, 300, 0.25, "call") * 100);

  it("works out the option's value at the chart stop and T1 from the solved volatility", () => {
    const e = ticketEstimates({ ...base, paidCents: fair });
    expect(e).not.toBeNull();
    expect(e!.iv).toBeGreaterThan(0.2);
    expect(e!.iv).toBeLessThan(0.3);
    const [stop, t1] = e!.rows;
    expect(stop!.key).toBe("stop");
    expect(stop!.valueCents).toBeLessThan(fair);
    expect(t1!.valueCents).toBeGreaterThan(fair);
    expect(t1!.pnlCents).toBe((t1!.valueCents - fair) * 100 - 111);
  });

  it("withholds every estimate on bad or missing inputs, with no fallback number", () => {
    expect(ticketEstimates({ ...base, paidCents: fair, spot: null })).toBeNull();
    expect(ticketEstimates({ ...base, paidCents: fair, spot: Number.NaN })).toBeNull();
    expect(ticketEstimates({ ...base, paidCents: fair, strike: null })).toBeNull();
    expect(ticketEstimates({ ...base, paidCents: fair, strike: 0 })).toBeNull();
    expect(ticketEstimates({ ...base, paidCents: fair, minutes: 0 })).toBeNull();
    expect(ticketEstimates({ ...base, paidCents: fair, minutes: -5 })).toBeNull();
    expect(ticketEstimates({ ...base, paidCents: 0 })).toBeNull();
    // Under what the option is in the money by: no volatility gives it.
    expect(ticketEstimates({ ...base, strike: 600, paidCents: 5000 })).toBeNull();
    // A price that only an absurd volatility explains is a failed solve, not a reading.
    const wild = Math.round(price(710, 712, 300, IV_MAX * 1.5, "call") * 100);
    expect(ticketEstimates({ ...base, paidCents: wild })).toBeNull();
    // Under $0.05 a share, or within a tick of what it is in the money by: no estimate.
    expect(ticketEstimates({ ...base, paidCents: 4, strike: 760 })).toBeNull();
    expect(ticketEstimates({ ...base, strike: 705, paidCents: 505 })).toBeNull(); // $5.00 in the money, a $0.05 tick
    expect(ticketEstimates({ ...base, strike: 709, paidCents: 101 })).toBeNull(); // $1.00 in the money, a $0.01 tick
    expect(ticketEstimates({ ...base, strike: 709, paidCents: 140 })).not.toBeNull();
    // No usable levels: nothing to estimate at.
    expect(ticketEstimates({ ...base, paidCents: fair, levels: [{ key: "stop", label: "x", price: null }] })).toBeNull();
  });
});

describe("the expiry", () => {
  // 2026-11-27 is a half day: the bell is 13:00 New York (18:00 UTC). 12:00 New York is 17:00 UTC.
  const NOON = Date.parse("2026-11-27T17:00:00Z");

  it("uses the calendar's close for a same-day expiry, half days included", () => {
    expect(minutesLeft("2026-11-27", NOON, "2026-11-27")).toBe(60);
  });

  it("withholds a same-day expiry when the page's session is not today's", () => {
    expect(minutesLeft("2026-11-27", NOON, "2026-11-25")).toBeNull();
    expect(minutesLeft("2026-12-04", NOON, "2026-11-25")).toBeGreaterThan(0);
  });

  it("knows no expiry on a day the market is shut, nor without a clock", () => {
    expect(minutesLeft("2026-11-26", NOON, "2026-11-27")).toBeNull(); // Thanksgiving
    expect(minutesLeft("2026-11-28", NOON, "2026-11-27")).toBeNull(); // a Saturday
    expect(minutesLeft("2026-12-04", null, "2026-11-27")).toBeNull();
    expect(minutesLeft("soon", NOON, "2026-11-27")).toBeNull();
    expect(minutesLeft("2026-11-20", NOON, "2026-11-27")!).toBeLessThan(0);
  });

  it("has no default, and drops a pick that passed or left the chain, saying so", () => {
    expect(expiryPick("", ["2026-12-04"], null)).toEqual({ expiry: null, note: null });
    expect(expiryPick("2026-12-04", ["2026-12-04"], 100)).toEqual({ expiry: "2026-12-04", note: null });
    expect(expiryPick("2026-12-04", null, 100)).toEqual({ expiry: "2026-12-04", note: null });
    expect(expiryPick("2026-11-27", ["2026-12-04"], 60)).toMatchObject({ expiry: null, note: expect.stringContaining("no longer in the chain") });
    expect(expiryPick("2026-11-20", null, -10)).toMatchObject({ expiry: null, note: expect.stringContaining("has passed") });
  });
});

describe("the chain ask's age", () => {
  it("is that contract's own quote time, rounded up, never the newest in the chain", () => {
    // Quoted 14:13:30, answered 14:30:00, received 10 s ago: 16.67 min → 17.
    expect(quoteAgeMin("2026-10-12T14:13:30Z", "2026-10-12T14:30:00Z", 1_000, 11_000)).toBe(17);
    expect(quoteAgeMin("2026-10-12T14:15:00Z", "2026-10-12T14:30:00Z", 0, 0)).toBe(15);
    expect(quoteAgeMin("2026-10-12T14:14:59Z", "2026-10-12T14:30:00Z", 0, 0)).toBe(16);
  });

  it("is unknown without the contract's own time", () => {
    expect(quoteAgeMin(null, "2026-10-12T14:30:00Z", 0, 0)).toBeNull();
    expect(quoteAgeMin("junk", "2026-10-12T14:30:00Z", 0, 0)).toBeNull();
    expect(quoteAgeMin("2026-10-12T14:15:00Z", "2026-10-12T14:30:00Z", null, 0)).toBeNull();
  });
});

describe("the hero's ticket button", () => {
  const card = { stop: 711.59, target1: 716.05 };
  const row = (plan: { stop: number | null; target1: number | null } | null) => ({ state: { plan } }) as unknown as Parameters<typeof heroTicketSide>[1];
  const main = { badge: { alt: null } } as unknown as Parameters<typeof heroTicketSide>[2];
  const alt = { badge: { alt: "failed_break" } } as unknown as Parameters<typeof heroTicketSide>[2];

  it("shows only for a side the card has a plan for, with the same stop and T1", () => {
    expect(heroTicketSide("call", row(card), main, card)).toBe("call");
    expect(heroTicketSide("call", row(null), main, card)).toBe("call");
    expect(heroTicketSide(null, row(card), main, card)).toBeNull();
    expect(heroTicketSide("call", row(card), main, null)).toBeNull();
  });

  it("hides for an alternative trigger, or a plan whose levels differ from the card's", () => {
    expect(heroTicketSide("call", row(card), alt, card)).toBeNull();
    expect(heroTicketSide("call", row({ stop: 711.0, target1: 716.05 }), main, card)).toBeNull();
    expect(heroTicketSide("call", row({ stop: 711.59, target1: null }), main, card)).toBeNull();
  });
});

describe("strikes", () => {
  it("are ordered by distance from the live stock price, with no list without one", () => {
    expect(strikesByDistance([700, 705, 710, 715, 720], 711, 4)).toEqual([710, 715, 705, 720]);
    expect(strikesByDistance([705, 715], 710)).toEqual([705, 715]);
    expect(strikesByDistance([700, 710], null)).toEqual([]);
  });
});

describe("the ticket's markup", () => {
  const plan: SidePlan = { side: "call", level: 712.5, levelName: "PDH", entry: 713.41, stop: 711.59, target1: 716.05, target2: null };
  const live = { symbol: "QQQ", session: "2026-10-19", halfDay: false, premarket: null, close: 709.82, closeDate: "2026-10-16", ceiling: 712.5, floor: 704.1, atr: 9.1, move: 6 };

  it("with no typed price shows the limit table and no size, no stop and no estimate", () => {
    const h = renderToStaticMarkup(createElement(TicketBody, { symbol: "QQQ", plan, live, typed: { price: "", strike: "", expiry: "" }, onType: () => {} }));
    expect(h).toContain("data-ticket-table");
    expect(h).toContain('inputMode="decimal"');
    expect(h).not.toContain("data-ticket-size");
    expect(h).not.toContain("data-ticket-stop");
    expect(h).not.toContain("data-ticket-estimate");
    expect(h).not.toContain("data-ticket-none");
    expect(h).not.toMatch(/Stop to place|Lost at that stop|≈/);
    expect(h).not.toMatch(/NaN|undefined/);
  });

  it("with a bad price shows why, and still no size", () => {
    for (const price of ["-1", "0", "abc"]) {
      const h = renderToStaticMarkup(createElement(TicketBody, { symbol: "QQQ", plan, live, typed: { price, strike: "", expiry: "" }, onType: () => {} }));
      expect(h).not.toContain("data-ticket-size");
      expect(h).toContain('aria-invalid="true"');
      expect(h).not.toMatch(/NaN|undefined/);
    }
  });

  it("with a typed price sizes it, and without a live stock price gives no estimate", () => {
    const h = renderToStaticMarkup(createElement(TicketBody, { symbol: "QQQ", plan, live, typed: { price: "1.25", strike: "712", expiry: "" }, onType: () => {} }));
    expect(h).toContain('data-ticket-size="1"');
    expect(h).toContain("$0.94");
    expect(h).toContain("−$32.11");
    expect(h).toContain("Lost if filled at the stop, with fees");
    expect(h).toContain("Each cent worse on the fill costs $1.00 more.");
    expect(h).toContain("If it steps $0.05: stop $0.95");
    // Only the short result line is a live region, not the whole block.
    expect(h.match(/role="status"/g)).toHaveLength(1);
    expect(h).toMatch(/role="status"[^>]*>1 contract, stop \$0\.94\.</);
    expect(h).not.toContain("aria-live");
    // No expiry is picked for him.
    expect(h).toContain("No estimate without a live stock price");
    expect(h).not.toContain("data-ticket-estimate=");
    expect(h).toContain("data-ticket-no-estimate");
  });

  it("says what it read for a price that is not plain", () => {
    const h = renderToStaticMarkup(createElement(TicketBody, { symbol: "QQQ", plan, live, typed: { price: "1 25", strike: "", expiry: "" }, onType: () => {} }));
    expect(h).toContain("Read as $125.00.");
  });

  it("closed, the fold is one summary line with nothing sized in it", () => {
    const h = renderToStaticMarkup(createElement(TradeTicket, { symbol: "QQQ", plan, live }));
    expect(h).toMatch(/^<details/);
    expect(h).not.toMatch(/<details[^>]*open/);
    expect(h).toContain("Size this call");
    expect(h).not.toContain("data-ticket-body");
  });
});
