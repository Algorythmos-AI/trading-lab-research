import { describe, expect, it } from "vitest";
import type { ChainContract, ChainResponse } from "@/lib/chain";
import { bellMinute, STALE_SAME_DAY_MIN } from "@/lib/contract";
import { triggerDistances } from "@/lib/level-ladder";
import { MAX_PREMIUM } from "@/lib/trade-rules";
import {
  atmContract,
  chainAgeMin,
  chainFresh,
  chainPx,
  chainStamp,
  dayRoom,
  entryStopDistance,
  fromEntryLabel,
  heldOrAtm,
  insideBox,
  lossFromEntry,
  moveWords,
  optionAtStop,
  premiumCheck,
  roomShown,
  showInsideBox,
  stopDistance,
  UNLIKELY_MOVES,
  whichStopFirst,
} from "@/lib/what-if";

// Monday 12 October 2026, 10:30 in New York (EDT). 2026-11-27 is a half day (13:00 close).
const NOW = Date.parse("2026-10-12T14:30:00Z");
const QUOTED = "2026-10-12T14:15:00Z";
const c = (kind: "call" | "put", strike: number, bid: number | null, ask: number | null, delta: number | null = null, at: string | null = QUOTED): ChainContract => ({
  kind,
  strike,
  bid,
  ask,
  last: null,
  at,
  iv: null,
  delta,
  volume: null,
  bid_size: null,
  ask_size: null,
});
const chain = (expiries: ChainResponse["expiries"], as_of = "2026-10-12T14:30:00Z"): ChainResponse => ({ as_of, feed: "indicative", delay_min: 15, symbol: "SPY", expiries });
const strip = [
  c("call", 775, 6.1, 6.3, 0.8),
  c("call", 780, 1.4, 1.5, 0.5),
  c("call", 785, 0.5, 0.6, 0.2),
  c("put", 775, 0.4, 0.5, -0.2),
  c("put", 780, 1.9, 2.1, -0.5),
  c("put", 785, 5.8, 6.0, -0.8),
];

describe("distance in 1-day moves", () => {
  it("gives the distance as a multiple of the expected move, to one decimal", () => {
    expect(moveWords(1, 5)).toEqual({ multiple: 0.2, text: "0.2× move", unlikely: false });
    expect(moveWords(0, 5)).toEqual({ multiple: 0, text: "0.0× move", unlikely: false });
    expect(moveWords(7.24, 5)?.text).toBe("1.4× move");
  });

  it("says unlikely today at 3 moves or more, judged on the number shown", () => {
    expect(UNLIKELY_MOVES).toBe(3);
    expect(moveWords(15, 5)).toMatchObject({ text: "3.0× move", unlikely: true });
    expect(moveWords(14.76, 5)).toMatchObject({ text: "3.0× move", unlikely: true }); // 2.952 shows as 3.0
    expect(moveWords(14.7, 5)).toMatchObject({ text: "2.9× move", unlikely: false }); // 2.94
    expect(moveWords(40, 5)).toMatchObject({ text: "8.0× move", unlikely: true });
  });

  it("says nothing without a move or with a distance that is not one", () => {
    expect(moveWords(1, null)).toBeNull();
    expect(moveWords(1, 0)).toBeNull();
    expect(moveWords(1, -2)).toBeNull();
    expect(moveWords(null, 5)).toBeNull();
    expect(moveWords(Number.NaN, 5)).toBeNull();
    expect(moveWords(-1, 5)).toBeNull();
  });

  it("is the one source of the ladder's distance words, and marks the unlikely ones", () => {
    const d = triggerDistances(770, 790, 765, 6, 5);
    // 20.00 to the ceiling is 4 moves: unlikely; 5.00 to the floor is 1 move
    expect(d.map((x) => [x.to, x.text, x.unlikely])).toEqual([
      ["floor", "5.00 away · 1.0× move", false],
      ["ceiling", "20.00 away · 4.0× move", true],
    ]);
    // past a trigger, or with no move (ATRs), never unlikely
    expect(triggerDistances(800, 790, 765, 6, 5).find((x) => x.to === "ceiling")?.unlikely).toBe(false);
    expect(triggerDistances(770, 790, 765, 6, null).every((x) => !x.unlikely)).toBe(true);
  });
});

describe("inside the box", () => {
  it("is true only strictly between the floor and the ceiling", () => {
    expect(insideBox(334.6, 330.7, 338.6)).toBe(true);
    expect(insideBox(330.7, 330.7, 338.6)).toBe(false);
    expect(insideBox(338.6, 330.7, 338.6)).toBe(false);
    expect(insideBox(340, 330.7, 338.6)).toBe(false);
    expect(insideBox(329, 330.7, 338.6)).toBe(false);
  });

  it("is never true for a box that is not one, or a price that is missing", () => {
    expect(insideBox(334, 338.6, 330.7)).toBe(false);
    expect(insideBox(334, null, 338.6)).toBe(false);
    expect(insideBox(334, 330.7, undefined)).toBe(false);
    expect(insideBox(null, 330.7, 338.6)).toBe(false);
    expect(insideBox(Number.NaN, 330.7, 338.6)).toBe(false);
  });

  const base = { dot: { kind: "live", price: 334.6 }, paused: false, state: "no_trade" as const, why: "range_middle" as const, alt: false, floor: 330.7, ceiling: 338.6 };
  it("shows the chip on a live dot beside a watch or a no trade for the middle of yesterday's range", () => {
    expect(showInsideBox(base)).toBe(true);
    expect(showInsideBox({ ...base, state: "watch", why: undefined })).toBe(true);
  });

  it("never shows it beside a no trade for a closed window, or one that does not say why", () => {
    for (const why of ["closed", "opening", "lunch", "late", "day_limit", "no_plan"] as const) expect(showInsideBox({ ...base, why })).toBe(false);
    expect(showInsideBox({ ...base, why: undefined })).toBe(false);
    expect(showInsideBox({ ...base, why: null })).toBe(false);
  });

  it("never shows it off a live dot, while paused, beside an entry, a get-ready or an alternative", () => {
    for (const kind of ["pre", "close", "last"]) expect(showInsideBox({ ...base, dot: { kind, price: 334.6 } })).toBe(false);
    expect(showInsideBox({ ...base, dot: null })).toBe(false);
    expect(showInsideBox({ ...base, paused: true })).toBe(false);
    for (const state of ["enter_zone", "get_ready", "plan_off", "missed", "paused"] as const) expect(showInsideBox({ ...base, state })).toBe(false);
    expect(showInsideBox({ ...base, state: null })).toBe(false);
    expect(showInsideBox({ ...base, alt: true })).toBe(false);
    expect(showInsideBox({ ...base, dot: { kind: "live", price: 339 } })).toBe(false);
  });
});

describe("the option chain's age", () => {
  const ch = chain([{ date: "2026-10-12", contracts: strip }]);
  it("adds the feed's lag at the answer to the time since it arrived, on each clock alone", () => {
    // quotes 15 min behind the answer, received 2 min ago on the browser's monotonic clock
    expect(chainAgeMin(ch, 1_000_000, 1_000_000 + 120_000)).toBeCloseTo(17, 10);
    expect(chainFresh(ch, 1_000_000, 1_000_000 + 120_000)).toBe(true);
  });

  it("measures the time since the answer on the monotonic clock, so a wall clock set back cannot make it new", () => {
    // Received at 5 s of page time, read 21 min later: stale, whatever the wall clock was set to in between (the
    // wall clock is not an input at all).
    expect(chainAgeMin(ch, 5_000, 5_000 + 21 * 60_000)).toBeCloseTo(36, 10);
    expect(chainFresh(ch, 5_000, 5_000 + 21 * 60_000)).toBe(false);
  });

  it("is stale past STALE_SAME_DAY_MIN, never fresh without a quote time or a receipt", () => {
    expect(STALE_SAME_DAY_MIN).toBe(35);
    expect(chainFresh(ch, 0, (STALE_SAME_DAY_MIN - 15) * 60_000)).toBe(true);
    expect(chainFresh(ch, 0, (STALE_SAME_DAY_MIN - 15) * 60_000 + 1)).toBe(false);
    const untimed = chain([{ date: "2026-10-12", contracts: strip.map((x) => ({ ...x, at: null })) }]);
    expect(chainAgeMin(untimed, 0, 0)).toBeNull();
    expect(chainFresh(untimed, 0, 0)).toBe(false);
    expect(chainFresh(ch, null, 0)).toBe(false);
    expect(chainFresh(ch, 0, null)).toBe(false);
    expect(chainFresh(null, 0, 0)).toBe(false);
    expect(chainFresh({ ...ch, as_of: "junk" }, 0, 0)).toBe(false);
  });

  it("counts a quote stamped after the answer as no lag, and the newest quote anywhere as the feed's", () => {
    const mixed = chain([{ date: "2026-10-12", contracts: [c("call", 780, 1, 1.1, 0.5, "2026-10-12T13:00:00Z"), c("put", 780, 1, 1.1, -0.5, "2026-10-12T14:20:00Z")] }]);
    expect(chainAgeMin(mixed, 0, 0)).toBeCloseTo(10, 10);
    expect(chainAgeMin(chain([{ date: "2026-10-12", contracts: [c("call", 780, 1, 1.1, 0.5, "2026-10-12T14:40:00Z")] }]), 0, 0)).toBe(0);
  });

  it("labels every line with the chain's New York time and its delay", () => {
    expect(chainStamp(ch)).toBe("Option chain 10:30 NY · 15 min behind");
  });

  it("asks around the live price in half-percent steps of the close, else the close", () => {
    expect(chainPx(780, 781.3)).toBe(780);
    expect(chainPx(780, 783)).toBe(783.9);
    expect(chainPx(780, null)).toBe(780);
    expect(chainPx(null, 781)).toBeNull();
    expect(chainPx(0, 781)).toBeNull();
  });
});

describe("the at-the-money contract", () => {
  const ch = chain([
    { date: "2026-10-09", contracts: strip },
    { date: "2026-10-12", contracts: strip },
    { date: "2026-10-14", contracts: strip },
  ]);
  it("takes the nearest expiry still trading, the strike nearest the price, the side asked for", () => {
    expect(atmContract(ch, "call", 781.3, NOW)).toMatchObject({ expiry: "2026-10-12", contract: { kind: "call", strike: 780 } });
    expect(atmContract(ch, "put", 783.1, NOW)).toMatchObject({ expiry: "2026-10-12", contract: { kind: "put", strike: 785 } });
    // of two equally near, the lower strike
    expect(atmContract(ch, "call", 782.5, NOW)?.contract.strike).toBe(780);
  });

  it("skips a same-day expiry once its bell has rung, the early bell on a half day", () => {
    const half = chain([
      { date: "2026-11-27", contracts: strip },
      { date: "2026-11-30", contracts: strip },
    ]);
    // 13:30 New York on the half day: its own expiry closed at 13:00
    const after = Date.parse("2026-11-27T18:30:00Z");
    const bell = (x: string) => bellMinute(x, "2026-11-27", true);
    expect(atmContract(half, "call", 780, after, bell)?.expiry).toBe("2026-11-30");
    // without the half day's bell it would still be trading until 16:00
    expect(atmContract(half, "call", 780, after)?.expiry).toBe("2026-11-27");
  });

  it("has none once the price is more than a strike step past the chain's last strike", () => {
    // the strip runs 775 to 785 in steps of 5: 790 is one step past 785, 790.01 is more
    expect(atmContract(ch, "call", 790, NOW)?.contract.strike).toBe(785);
    expect(atmContract(ch, "call", 790.01, NOW)).toBeNull();
    expect(atmContract(ch, "put", 769.99, NOW)).toBeNull();
    expect(atmContract(ch, "put", 770, NOW)?.contract.strike).toBe(775);
    // a lone strike has no step to judge by
    expect(atmContract(chain([{ date: "2026-10-12", contracts: [c("call", 780, 1.4, 1.5, 0.5)] }]), "call", 780, NOW)).toBeNull();
  });

  it("has none without a price or a contract on that side", () => {
    expect(atmContract(ch, "call", 0, NOW)).toBeNull();
    expect(atmContract(chain([{ date: "2026-10-12", contracts: strip.filter((x) => x.kind === "put") }]), "call", 780, NOW)).toBeNull();
    expect(atmContract(chain([]), "call", 780, NOW)).toBeNull();
  });

  it("uses the held contract when the chain carries it, else the at-the-money one", () => {
    expect(heldOrAtm(ch, "call", { expiry: "2026-10-14", strike: 785 }, 780, NOW)).toMatchObject({ held: true, expiry: "2026-10-14", contract: { strike: 785 } });
    expect(heldOrAtm(ch, "call", { expiry: "2026-10-14", strike: 990 }, 780, NOW)).toMatchObject({ held: false, expiry: "2026-10-12", contract: { strike: 780 } });
    // an expired held contract is not priced from
    expect(heldOrAtm(ch, "call", { expiry: "2026-10-09", strike: 780 }, 780, NOW)).toMatchObject({ held: false, expiry: "2026-10-12" });
    expect(heldOrAtm(ch, "put", null, 780, NOW)).toMatchObject({ held: false, contract: { kind: "put", strike: 780 } });
  });
});

describe("the premium check", () => {
  it("prices one contract at the ask against the $200 cap", () => {
    expect(MAX_PREMIUM).toBe(200);
    expect(premiumCheck(c("call", 780, 1.4, 1.45))).toEqual({ ask: 1.45, perContract: 145, over: false, line: "ATM call 780 ask $1.45 ($145 a contract), within the $2.00 cap ($200)" });
    expect(premiumCheck(c("put", 780, 2.3, 2.45))).toEqual({
      ask: 2.45,
      perContract: 245,
      over: true,
      line: "ATM put 780 ask $2.45 ($245 a contract), over the $2.00 cap ($200): pick a strike further out of the money",
    });
  });

  it("is not over at the cap itself, and rounds the dollars", () => {
    expect(premiumCheck(c("call", 780, 1.9, 2))).toMatchObject({ perContract: 200, over: false });
    expect(premiumCheck(c("call", 780, 1.9, 2.01))).toMatchObject({ perContract: 201, over: true });
    expect(premiumCheck(c("call", 780, 0.1, 0.155))?.line).toBe("ATM call 780 ask $0.15 ($16 a contract), within the $2.00 cap ($200)");
  });

  it("takes an ask with no bid, as the Brief does, but nothing without an ask or from a crossed quote", () => {
    expect(premiumCheck(c("call", 780, 0, 1.2))).toMatchObject({ ask: 1.2 });
    expect(premiumCheck(c("call", 780, null, 1.2))).toMatchObject({ ask: 1.2 });
    expect(premiumCheck(c("call", 780, 1, null))).toBeNull();
    expect(premiumCheck(c("call", 780, 0, 0))).toBeNull();
    expect(premiumCheck(c("call", 780, 2, 1.5))).toBeNull();
    expect(premiumCheck(null)).toBeNull();
  });
});

describe("which stop comes first", () => {
  it("says the option stop comes first when 25% of the premium is lost before the chart stop", () => {
    // delta 0.5, $1.50 premium: −25% is $37.50, a 0.75 move on the stock; the chart stop is 1.20 away (−$60)
    const r = whichStopFirst(1.2, 0.5, 1.5)!;
    expect(r).toMatchObject({ first: "option", atChart: 60, optionStop: 37.5 });
    expect(r.text).toBe("The −25% option stop comes first, about $0.45 on the stock before the chart stop.");
  });

  it("says the chart stop comes first, with the estimate on the option there", () => {
    const r = whichStopFirst(0.5, 0.5, 1.5)!;
    expect(r).toMatchObject({ first: "chart", atChart: 25 });
    expect(r.text).toBe("The chart stop comes first, about $0.25 on the stock before the −25% option stop (≈ −$25 on the option there).");
  });

  it("reads a put's negative delta the same way", () => {
    expect(whichStopFirst(1.2, -0.5, 1.5)).toEqual(whichStopFirst(1.2, 0.5, 1.5));
  });

  it("says together when the two land within a cent", () => {
    expect(whichStopFirst(0.75, 0.5, 1.5)?.first).toBe("together");
  });

  it("says nothing without a distance, a delta or a premium", () => {
    expect(whichStopFirst(0, 0.5, 1.5)).toBeNull();
    expect(whichStopFirst(null, 0.5, 1.5)).toBeNull();
    expect(whichStopFirst(1, null, 1.5)).toBeNull();
    expect(whichStopFirst(1, 0, 1.5)).toBeNull();
    expect(whichStopFirst(1, 0.5, null)).toBeNull();
    expect(whichStopFirst(1, 0.5, 0)).toBeNull();
  });
});

describe("the manage card's estimate", () => {
  it("measures the distance to the stop on the trade's side", () => {
    expect(stopDistance("call", 753.43, 752.01)).toBe(1.42);
    expect(stopDistance("put", 775, 776.2)).toBe(1.2);
    expect(stopDistance("call", 751.5, 752.01)).toBe(-0.51);
    expect(stopDistance("call", null, 752.01)).toBeNull();
    expect(stopDistance("call", 753, null)).toBeNull();
  });

  it("measures entry to stop on the losing side only, for a call and a put", () => {
    expect(entryStopDistance("call", 752.95, 752.01)).toBe(0.94);
    expect(entryStopDistance("put", 779.1, 780)).toBe(0.9);
    // a stop on the wrong side of the entry is not given a size, nor a stop at the entry
    expect(entryStopDistance("call", 752.01, 752.95)).toBeNull();
    expect(entryStopDistance("put", 780, 779.1)).toBeNull();
    expect(entryStopDistance("call", 752.01, 752.01)).toBeNull();
    expect(entryStopDistance("call", null, 752.01)).toBeNull();
    expect(entryStopDistance("put", 780, undefined)).toBeNull();
  });

  it("estimates the loss at the stop from the entry, with a delta of either sign", () => {
    expect(lossFromEntry("call", 752.95, 752.01, 0.5)).toBeCloseTo(47, 10);
    expect(lossFromEntry("put", 779.1, 780, -0.4)).toBeCloseTo(36, 10);
    expect(lossFromEntry("call", 752.01, 752.95, 0.5)).toBeNull();
    expect(lossFromEntry("call", 752.95, 752.01, null)).toBeNull();
  });

  it("says the same loss for a trade already under water: the live price is not an input", () => {
    // a call in at 752.95 with the stock now at 752.40, still above the stop at 752.01: the stop costs the trade the
    // whole entry-to-stop move, not the 0.39 left from the price
    const live = 752.4;
    expect(stopDistance("call", live, 752.01)).toBe(0.39);
    expect(lossFromEntry("call", 752.95, 752.01, 0.5)).toBeCloseTo(47, 10);
    expect(lossFromEntry("call", 752.95, 752.01, 0.5)).not.toBeCloseTo(optionAtStop(stopDistance("call", live, 752.01), 0.5)!, 1);
  });

  it("agrees with the hero's which-stop line, which measures the same distance", () => {
    const d = entryStopDistance("call", 752.95, 752.01);
    expect(whichStopFirst(d, 0.5, 1.5)!.atChart).toBeCloseTo(lossFromEntry("call", 752.95, 752.01, 0.5)!, 10);
  });

  it("names whose entry the estimate is from", () => {
    expect(fromEntryLabel(false)).toBe("At the stop, from your entry");
    expect(fromEntryLabel(true)).toBe("At the stop, from the card entry");
  });

  it("estimates the option's $ at the stop from delta, for either sign", () => {
    expect(optionAtStop(1.42, 0.24)).toBeCloseTo(34.08, 10);
    expect(optionAtStop(1.42, -0.24)).toBeCloseTo(34.08, 10);
    expect(optionAtStop(0, 0.5)).toBeNull();
    expect(optionAtStop(-1, 0.5)).toBeNull();
    expect(optionAtStop(1, null)).toBeNull();
  });
});

describe("the day's room after a stop", () => {
  const base = { status: "clear" as const, current: true, used: 0, net: 0, openLine: "" };
  it("takes one more trade and a full stop off the day", () => {
    expect(dayRoom(base)).toBe("A stop now leaves $50 of $100 and 4 trades.");
    expect(dayRoom({ ...base, used: 3, net: -20 })).toBe("A stop now leaves $30 of $100 and 1 trade.");
    // a winning day leaves no more than the limit
    expect(dayRoom({ ...base, used: 1, net: 80 })).toBe("A stop now leaves $50 of $100 and 3 trades.");
    // whole dollars
    expect(dayRoom({ ...base, used: 1, net: -12.4 })).toBe("A stop now leaves $38 of $100 and 3 trades.");
  });

  it("says when a stop would end the day", () => {
    expect(dayRoom({ ...base, status: "careful", used: 2, net: -60 })).toBe("A stop now ends the day: $0 of $100 left.");
    expect(dayRoom({ ...base, status: "careful", used: 4, net: 0 })).toBe("A stop now leaves $50 of $100 and no trades: this is the day's last.");
  });

  it("says nothing when the journal is not current, the day is over, or a position is open", () => {
    expect(dayRoom({ ...base, current: false })).toBeNull();
    expect(dayRoom({ ...base, status: "unknown" })).toBeNull();
    expect(dayRoom({ ...base, status: "stop", net: -110 })).toBeNull();
    expect(dayRoom({ ...base, openLine: "1 position open: its open loss isn't priced here, and rule 7 counts it; check Webull." })).toBeNull();
    expect(dayRoom({ ...base, used: Number.NaN })).toBeNull();
  });

  it("is not shown while any trade card is open: a noted trade is not in the journal's numbers", () => {
    const room = dayRoom(base);
    expect(roomShown(room, 0)).toBe(room);
    expect(roomShown(room, 1)).toBeNull();
    expect(roomShown(room, 2)).toBeNull();
    expect(roomShown(null, 0)).toBeNull();
  });
});
