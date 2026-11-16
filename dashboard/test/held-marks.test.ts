// The owner's −25% premium stop on the manage card and the open options' loss in the day pill (held-marks.ts,
// held-store.ts, note-contract.ts). Synthetic figures throughout: a call bought at $1.60, so its −25% stop is $1.20.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetValue, fromNoteOf, recordStopOnly, recordThin, recordValue, recordWithheld, resetHeldStore, SAME_QUOTE_RECOUNT_MS, stopFired, thinOf, valueOf } from "@/components/client/held-store";
import { cardAsksChain } from "@/components/client/trade-manage";
import {
  NO_STOP,
  openMarks,
  PREMIUM_CONFIRM,
  premiumExitLine,
  premiumStep,
  roomLabel,
  roomText,
  stockStopExit,
  quoteKey,
  readThinQuote,
  stopCentsOf,
  THIN_LINE,
  WIDE_PREFIX,
  withClosedStopLine,
  withOpenLoss,
  withPremiumStop,
  withThinQuote,
} from "@/lib/held-marks";
import { fillStop } from "@/lib/manage-stop";
import { checkContract, noteHeldLots, parseContract, parseContracts } from "@/lib/note-contract";
import { CROSSED, lotsContract, NO_ASK, NO_BID, NO_QUOTE_TODAY, tooOld, tooWide, ZERO_BID, type HeldValue } from "@/lib/option-value";
import { railDay } from "@/lib/session-timeline";
import { manageNotices, type ManageView, OFF_LINE, PAUSED_LINE, UNMATCHED_LINE } from "@/lib/trade-manage";
import { type Bar2, manage } from "@/lib/trade-state";

const DAY = "2026-10-12";
const OCC = "QQQ261102C00600000";
const CARD = "QQQ|call|plan|2026-10-12T14:20:10.000Z|600/2026-11-02|journal";
const NOTE_CARD = "QQQ|call|2026-10-12T14:20:00.000Z|plan|manual";
const FILL = Date.parse("2026-10-12T14:20:10Z");
const PAID = 160;

/** The held call at a bid, in cents a share: paid $1.60, one contract. */
const at = (bidCents: number): HeldValue => {
  const stopCents = fillStop({ priceCents: PAID, contracts: 1 }).stopCents;
  return { valueCents: bidCents * 100, midValueCents: bidCents * 100, perContractCents: (bidCents - PAID) * 100 - 200, totalCents: null, qty: 1, paidCents: PAID, stopCents, toStopCents: bidCents - stopCents };
};

const view = (action: ManageView["action"], line: string, tone: ManageView["tone"] = "info"): ManageView => ({ id: CARD, key: "QQQ|call", symbol: "QQQ", side: "call", action, tone, line }) as unknown as ManageView;

const rec = (bidCents: number, key: string, x: Partial<{ id: string; occ: string; entryAt: number; fromNote: boolean }> = {}) =>
  recordValue({ day: DAY, id: x.id ?? CARD, occ: x.occ ?? OCC, entryAt: x.entryAt ?? FILL, value: at(bidCents), key, fromNote: x.fromNote ?? false });

function store() {
  const m = new Map<string, string>();
  const ls = {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return { m, ls };
}

describe("the −25% stop's count", () => {
  it("is $1.20 on a $1.60 fill", () => {
    expect(at(120).stopCents).toBe(120);
  });

  it("fires on the second fresh quote at or under the stop, not the first ($1.30, $1.19, $1.18)", () => {
    expect(PREMIUM_CONFIRM).toBe(2);
    const a = premiumStep(NO_STOP, at(130).toStopCents);
    expect(a).toEqual({ under: 0, hit: false });
    const b = premiumStep(a, at(119).toStopCents);
    expect(b).toEqual({ under: 1, hit: false });
    const c = premiumStep(b, at(118).toStopCents);
    expect(c).toEqual({ under: 2, hit: true });
  });

  it("counts a bid exactly at the stop as under it", () => {
    expect(premiumStep(premiumStep(NO_STOP, 0), 0).hit).toBe(true);
  });

  it("starts again on a quote back above, and never fires on one print", () => {
    const one = premiumStep(NO_STOP, -5);
    const back = premiumStep(one, 3);
    expect(back).toEqual(NO_STOP);
    expect(premiumStep(back, -1).hit).toBe(false);
  });

  it("stays fired once fired, whatever the bid does after", () => {
    const fired = { under: 2, hit: true };
    expect(premiumStep(fired, 40)).toBe(fired);
  });

  it("does nothing without a stop to measure", () => {
    expect(premiumStep({ under: 1, hit: false }, null)).toEqual({ under: 1, hit: false });
  });
});

describe("the card's word", () => {
  const hold = view("hold", "Holding: stop 598.00 · target 1 604.00");

  it("turns HOLD, TRAIL and SELL HALF into EXIT once the stop has fired, with the stop's line", () => {
    for (const a of ["hold", "trail", "sell_half"] as const) {
      const v = withPremiumStop(view(a, "x"), true, at(80));
      expect(v).toMatchObject({ action: "exit", tone: "bad", line: "Bid $0.40 under your −25% stop $1.20: exit" });
    }
  });

  it("leaves the card alone before it fires", () => {
    expect(withPremiumStop(hold, false, at(110))).toBe(hold);
  });

  it("keeps an EXIT the card already says, with its own line", () => {
    const own = view("exit", "5 min, not working: exit", "bad");
    expect(withPremiumStop(own, true, at(80))).toBe(own);
  });

  it("stands through the stock's paused prices, never over the feed off, an unmatched note or a guard", () => {
    expect(withPremiumStop(view("check", PAUSED_LINE, "warn"), true, at(80)).action).toBe("exit");
    for (const line of [OFF_LINE, UNMATCHED_LINE, "Bad data: the bid jumped"]) {
      const v = view("check", line, "warn");
      expect(withPremiumStop(v, true, at(80))).toBe(v);
    }
  });

  it("says the stop's figures, at it and under it", () => {
    expect(premiumExitLine(at(120))).toBe("Bid at your −25% stop $1.20: exit");
    expect(premiumExitLine(at(70))).toBe("Bid $0.50 under your −25% stop $1.20: exit");
    expect(withPremiumStop(hold, true, null).line).toBe("Under your −25% stop: exit");
  });

  it("is announced: HOLD to EXIT raises a notice", () => {
    const first = manageNotices({}, [hold], 0);
    const next = manageNotices(first.last, [withPremiumStop(hold, true, at(80))], 1);
    expect(next.fresh).toHaveLength(1);
    expect(next.fresh[0]).toMatchObject({ action: "exit", title: "QQQ call: EXIT", line: "Bid $0.40 under your −25% stop $1.20: exit" });
  });
});

describe("the bar under the option's value", () => {
  it("says where the bid is, and the exit once fired", () => {
    expect(roomLabel(31, false)).toBe("Bid above the −25% stop");
    expect(roomLabel(0, false)).toBe("Bid at the −25% stop");
    expect(roomLabel(-43, false)).toBe("Bid under the −25% stop");
    expect(roomLabel(0, true)).toBe("Bid at the −25% stop: exit");
    expect(roomLabel(-43, true)).toBe("Bid under the −25% stop: exit");
    expect(roomLabel(5, true)).toBe("Bid back above the −25% stop: the exit stands");
  });

  it("gives the distance under the stop, not 'at the stop'", () => {
    expect(roomText(31)).toBe("$0.31");
    expect(roomText(0)).toBe("at the stop");
    expect(roomText(-43)).toBe("$0.43 under");
  });
});

describe("the stock stop's line", () => {
  // manage()'s own words for a put whose 2-minute close went over its stop.
  const ms = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00-04:00`);
  const bar = (hhmm: string, c: number): Bar2 => ({ start: ms(hhmm), end: ms(hhmm) + 120_000, o: c, h: c, l: c, c });
  const stopped = manage(
    { side: "put", price: 99.5, at: new Date(ms("10:20") + 10_000).toISOString(), source: "journal" },
    { side: "put", level: 100, levelName: "MA50", entry: 99.5, stop: 101.25, target1: 96, target2: null },
    { closed: [bar("10:26", 101.1), bar("10:28", 101.4)], partial: null, since: ms("09:30"), complete: true, missing: [], gaps: 0 },
    null,
    new Date(ms("10:31")),
    false,
  );

  it("is pinned: manage() still says 'Above the stop 101.25: exit'", () => {
    expect(stopped.line).toBe("Above the stop 101.25: exit");
  });

  it("is said as a close, so a live distance back under the stop does not read as a contradiction", () => {
    const v = withClosedStopLine(view("exit", stopped.line, "bad"));
    expect(v.line).toBe("A 2-min close went above the stop 101.25: exit");
    expect(withClosedStopLine(view("exit", "Below the stop 158.18: exit", "bad")).line).toBe("A 2-min close went below the stop 158.18: exit");
    expect(stockStopExit(v)).toBe(true);
    expect(stockStopExit(view("exit", stopped.line, "bad"))).toBe(true);
    expect(stockStopExit(view("exit", "5 min, not working: exit", "bad"))).toBe(false);
  });

  it("keeps the card entry's mark after target 1 on a journal card", () => {
    const v = withClosedStopLine(view("exit", "Below the stop 99.50 (card entry): exit", "bad"));
    expect(v.line).toBe("A 2-min close went below the stop 99.50 (card entry): exit");
    expect(stockStopExit(v)).toBe(true);
  });

  it("leaves every other line as it is", () => {
    const v = view("hold", "Holding: stop 101.25 · target 1 96.00");
    expect(withClosedStopLine(v)).toBe(v);
  });
});

describe("the day pill with open losses (rule 7)", () => {
  const clear = railDay({ status: "clear", isToday: true, current: true, used: 1, net: 0, openLine: "1 position open: its open loss isn't priced here, and rule 7 counts it; check Webull." });
  const one = (lossCents: number, fromNote = false) => ({ priced: 1, journalPriced: fromNote ? 0 : 1, lossCents });

  it("adds the open loss at the bid: '$92 of $100 · $92 open', Careful from $60", () => {
    const d = withOpenLoss(clear, 0, one(9211), 1);
    expect(d.word).toBe("Careful");
    expect(d.tone).toBe("warn");
    expect(d.line).toBe("Careful · 1/5 trades · $92 of $100 · $92 open");
    expect(d.open).toBe("1 position open: −$92 at the bid, counted toward the $100 day stop (rule 7).");
    expect(d.room).toBeNull();
  });

  it("reads the stop's word once closed and open reach $100", () => {
    const d = withOpenLoss(clear, -40, one(6000), 1);
    expect(d).toMatchObject({ word: "Stop for today", tone: "bad", line: "Stop for today · 1/5 trades · $100 of $100 · $60 open" });
  });

  it("keeps Clear under $60, and says the journal positions it cannot price", () => {
    const d = withOpenLoss(clear, 0, one(2000), 2);
    expect(d.word).toBe("Clear");
    expect(d.line).toBe("Clear · 1/5 trades · $20 of $100 · $20 open");
    expect(d.open).toBe("1 position open: −$20 at the bid, counted toward the $100 day stop (rule 7). 1 more not priced here: check Webull.");
  });

  it("never lets a note's own trade stand for a journal position it does not price", () => {
    const d = withOpenLoss(clear, 0, one(2000, true), 1);
    expect(d.open).toBe("1 position open: −$20 at the bid, counted toward the $100 day stop (rule 7). 1 more not priced here: check Webull.");
  });

  it("keeps a warning already shown (the journal not current) short of the stop, and rounds the closed figure", () => {
    const stale = railDay({ status: "unknown", isToday: true, current: false, used: 1, net: -10.4 });
    const d = withOpenLoss(stale, -10.4, one(6000), 1);
    expect(d.word).toBe("Journal not current");
    expect(d.line).toBe("Journal not current · 1/5 trades · $70 of $100 · $60 open");
  });

  it("adds nothing to the figure for a position in profit, and says it has no loss", () => {
    const d = withOpenLoss(clear, 0, one(0), 1);
    expect(d.line).toBe("Clear · 1/5 trades · $0 of $100");
    expect(d.open).toBe("1 position open: no loss at the bid, counted toward the $100 day stop (rule 7).");
  });

  it("is the pill as it was with nothing priced", () => {
    expect(withOpenLoss(clear, 0, { priced: 0, journalPriced: 0, lossCents: 0 }, 1)).toBe(clear);
  });

  it("counts losing positions only, a gain as nothing, and which are the journal's", () => {
    expect(openMarks([{ value: at(80), fromNote: false }, { value: at(200), fromNote: true }])).toEqual({ priced: 2, journalPriced: 1, lossCents: 8200 });
  });
});

describe("the shared values (held-store.ts)", () => {
  beforeEach(() => resetHeldStore());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fires on the second upstream quote under the stop, counting one cached quote once, and latches for the day", () => {
    const { m, ls } = store();
    m.set("held-stop:2026-10-09", JSON.stringify({ old: 1 }));
    vi.stubGlobal("window", { localStorage: ls });
    rec(130, "q1");
    rec(119, "q2");
    rec(119, "q2"); // the same quote from the route's cache, on the next poll
    expect(stopFired(DAY, OCC, FILL)).toBe(false);
    rec(118, "q3");
    expect(stopFired(DAY, OCC, FILL)).toBe(true);
    expect([...m.keys()]).toEqual(["held-stop:2026-10-12"]);
    // a reload: the page's memory is gone, the browser's latch is not
    resetHeldStore();
    expect(stopFired(DAY, OCC, FILL)).toBe(true);
    rec(150, "q4");
    expect(stopFired(DAY, OCC, FILL)).toBe(true);
  });

  it("is the position's: a note taking over the journal card keeps the fired stop", () => {
    vi.stubGlobal("window", { localStorage: store().ls });
    rec(119, "q1");
    rec(118, "q2");
    forgetValue(CARD);
    rec(150, "q3", { id: NOTE_CARD, entryAt: FILL - 10_000 });
    expect(stopFired(DAY, OCC, FILL - 10_000)).toBe(true);
    expect(fromNoteOf(NOTE_CARD)).toBe(false);
  });

  it("starts clean for a later trade in the same contract, filled after the stop fired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T14:40:00Z"));
    vi.stubGlobal("window", { localStorage: store().ls });
    rec(119, "q1");
    rec(118, "q2");
    expect(stopFired(DAY, OCC, FILL)).toBe(true);
    const again = Date.parse("2026-10-12T15:05:00Z");
    vi.setSystemTime(new Date("2026-10-12T15:06:00Z"));
    expect(stopFired(DAY, OCC, again)).toBe(false);
    rec(150, "q3", { entryAt: again });
    expect(stopFired(DAY, OCC, again)).toBe(false);
    rec(119, "q4", { entryAt: again });
    rec(118, "q5", { entryAt: again });
    expect(stopFired(DAY, OCC, again)).toBe(true);
  });

  it("keeps the count through a withheld quote, and forgets the value when the card goes", () => {
    vi.stubGlobal("window", { localStorage: store().ls });
    rec(119, "q1", { fromNote: true });
    expect(fromNoteOf(CARD)).toBe(true);
    recordWithheld(CARD);
    expect(valueOf(CARD)).toBeNull();
    rec(118, "q2");
    expect(stopFired(DAY, OCC, FILL)).toBe(true);
    forgetValue(CARD);
    expect(valueOf(CARD)).toBeNull();
  });

  it("never dates the stop before its trade's fill, whatever the browser's clock says", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FILL - 60_000)); // a browser a minute slow
    vi.stubGlobal("window", { localStorage: store().ls });
    rec(119, "q1");
    rec(118, "q2");
    expect(stopFired(DAY, OCC, FILL)).toBe(true);
  });

  it("knows nothing without a contract or a day", () => {
    expect(stopFired(null, OCC, FILL)).toBe(false);
    expect(stopFired(DAY, null, FILL)).toBe(false);
  });

  it("works with the browser's storage off", () => {
    vi.stubGlobal("window", {
      localStorage: {
        get length(): number {
          throw new Error("denied");
        },
        getItem: () => {
          throw new Error("denied");
        },
      },
    });
    rec(115, "q1");
    rec(114, "q2");
    expect(stopFired(DAY, OCC, FILL)).toBe(true);
  });
});

describe("review fixes: a collapsing quote, two trades on one contract, one quote counted once, the day", () => {
  beforeEach(() => resetHeldStore());
  afterEach(() => vi.unstubAllGlobals());

  /** A paid-$1.00 trade on the same contract: its stop is $0.75. */
  const atPaid = (paid: number, bidCents: number): HeldValue => {
    const stopCents = fillStop({ priceCents: paid, contracts: 1 }).stopCents;
    return { valueCents: bidCents * 100, midValueCents: bidCents * 100, perContractCents: (bidCents - paid) * 100 - 200, totalCents: null, qty: 1, paidCents: paid, stopCents, toStopCents: bidCents - stopCents };
  };
  const recPaid = (paid: number, bidCents: number, key: string, id: string) =>
    recordValue({ day: DAY, id, occ: OCC, entryAt: FILL, value: atPaid(paid, bidCents), key, fromNote: false });

  it("reads a withheld quote against the stop: under only when even the ask is, above only on a real bid over it, else thin", () => {
    // stop $1.20
    expect(readThinQuote(NO_BID, null, 0.35, 120)).toEqual({ kind: "under", toStopCents: -85 }); // collapsed: 0 × 0.35
    expect(readThinQuote(ZERO_BID, 0, 1.2, 120)).toEqual({ kind: "under", toStopCents: 0 });
    expect(readThinQuote(tooWide(55), 0.6, 1.1, 120)).toEqual({ kind: "under", toStopCents: -10 });
    expect(readThinQuote(tooWide(40), 1.3, 2.1, 120)).toEqual({ kind: "above", toStopCents: 10 });
    expect(readThinQuote(NO_ASK, 1.25, null, 120)).toEqual({ kind: "above", toStopCents: 5 });
    // the stop inside the quote, an empty quote (a halt), a crossed one: thin, never a fire
    expect(readThinQuote(tooWide(60), 0.8, 1.6, 120)).toEqual({ kind: "thin" });
    expect(readThinQuote(NO_ASK, null, null, 120)).toEqual({ kind: "thin" });
    expect(readThinQuote(NO_ASK, 0, 0, 120)).toEqual({ kind: "thin" });
    expect(readThinQuote(NO_BID, null, 1.5, 120)).toEqual({ kind: "thin" });
    expect(readThinQuote(CROSSED, 1.0, 0.9, 120)).toEqual({ kind: "thin" });
    // not read at all: old, not today's, or no stop
    expect(readThinQuote(tooOld(40), 0.2, 0.3, 120)).toBeNull();
    expect(readThinQuote(NO_QUOTE_TODAY, 0.2, 0.3, 120)).toBeNull();
    expect(readThinQuote(NO_BID, null, 0.3, null)).toBeNull();
  });

  it("pins the wide reason's wording it reads", () => {
    expect(WIDE_PREFIX).toBe("the spread is ");
    expect(tooWide(41).startsWith(WIDE_PREFIX)).toBe(true);
  });

  it("keys a quote on its own time and prices, never the fetch", () => {
    const q = { quote_at: "2026-10-12T14:30:01.5Z", bid: 1.1, ask: 1.2 };
    expect(quoteKey(q)).toBe(quoteKey({ ...q }));
    expect(quoteKey({ ...q, bid: 1.05 })).not.toBe(quoteKey(q));
    expect(quoteKey({ bid: 1, ask: 1.1 })).toBeNull();
    expect(quoteKey(undefined)).toBeNull();
  });

  it("says CHECK on a thin quote, never over an EXIT or a CHECK", () => {
    expect(withThinQuote(view("hold", "Hold"), true)).toMatchObject({ action: "check", tone: "warn", line: THIN_LINE });
    expect(withThinQuote(view("trail", "Trail"), true).action).toBe("check");
    expect(withThinQuote(view("exit", "Above the stop 101.25: exit", "bad"), true).action).toBe("exit");
    expect(withThinQuote(view("hold", "Hold"), false).action).toBe("hold");
  });

  it("keeps the count through thin quotes, and a thin quote never fires or resets it", () => {
    vi.stubGlobal("window", { localStorage: store().ls });
    rec(119, "q1");
    recordThin(CARD, false);
    expect(thinOf(CARD)).toBe(true);
    recordThin(CARD, false);
    expect(stopFired(DAY, OCC, FILL)).toBe(false);
    rec(118, "q2");
    expect(thinOf(CARD)).toBe(false);
    expect(stopFired(DAY, OCC, FILL)).toBe(true);
  });

  it("works the stop as the card's value does", () => {
    expect(stopCentsOf({ paidCents: PAID, qty: 1 })).toBe(at(0).stopCents);
  });

  it("fires on a collapsing option whose quotes are too one-sided to value", () => {
    vi.stubGlobal("window", { localStorage: store().ls });
    const stopCents = at(0).stopCents!;
    rec(130, "q1");
    recordStopOnly(CARD, false, { day: DAY, occ: OCC, entryAt: FILL, stopCents, toStopCents: 35 - stopCents, key: "q2" });
    expect(valueOf(CARD)).toBeNull();
    expect(stopFired(DAY, OCC, FILL, stopCents)).toBe(false);
    recordStopOnly(CARD, false, { day: DAY, occ: OCC, entryAt: FILL, stopCents, toStopCents: 30 - stopCents, key: "q3" });
    expect(stopFired(DAY, OCC, FILL, stopCents)).toBe(true);
  });

  it("keeps two trades' runs apart on one contract, and a fire stands only for a stop at or above its level", () => {
    const { m, ls } = store();
    vi.stubGlobal("window", { localStorage: ls });
    // A paid $1.60 (stop $1.20), B paid $1.00 (stop $0.75); the bid falls to $1.00: under A's stop, above B's.
    recPaid(160, 110, "q1", "A");
    recPaid(100, 110, "q1", "B");
    recPaid(160, 100, "q2", "A");
    recPaid(100, 100, "q2", "B"); // B's quotes above its own stop never reset A's run
    expect(stopFired(DAY, OCC, FILL, 120)).toBe(true);
    expect(stopFired(DAY, OCC, FILL, 75)).toBe(false);
    // a trade with a higher stop than A's: the bid was at or under it too
    expect(stopFired(DAY, OCC, FILL, 150)).toBe(true);
    // the latch keeps the level, through a reload
    expect(JSON.parse(m.get(`held-stop:${DAY}`)!)).toEqual({ [`${OCC}@120`]: expect.any(Number) });
    resetHeldStore();
    expect(stopFired(DAY, OCC, FILL, 120)).toBe(true);
    expect(stopFired(DAY, OCC, FILL, 75)).toBe(false);
    // no stop to fire
    expect(stopFired(DAY, OCC, FILL, null)).toBe(false);
  });

  it("counts a quote that does not move again after a while: a bid stuck under the stop still confirms it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T14:30:00Z"));
    vi.stubGlobal("window", { localStorage: store().ls });
    rec(118, "same");
    rec(118, "same"); // the route's cache a few polls later: once
    expect(stopFired(DAY, OCC, FILL)).toBe(false);
    vi.setSystemTime(new Date(Date.parse("2026-10-12T14:30:00Z") + SAME_QUOTE_RECOUNT_MS));
    rec(118, "same");
    expect(stopFired(DAY, OCC, FILL)).toBe(true);
    vi.useRealTimers();
  });

  it("keeps a thin CHECK through worse data, and clears it only on a quote that reads the stop or the card going", () => {
    vi.stubGlobal("window", { localStorage: store().ls });
    recordThin(CARD, false);
    recordWithheld(CARD);
    expect(thinOf(CARD)).toBe(true);
    recordStopOnly(CARD, false, { day: DAY, occ: OCC, entryAt: FILL, stopCents: 120, toStopCents: 10, key: "a1" });
    expect(thinOf(CARD)).toBe(false);
    recordThin(CARD, false);
    forgetValue(CARD);
    expect(thinOf(CARD)).toBe(false);
  });

  it("keeps a quick EXIT when the journal's fill second lands after it, within the note's matching window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FILL + 20_000));
    vi.stubGlobal("window", { localStorage: store().ls });
    rec(119, "q1");
    rec(118, "q2");
    expect(stopFired(DAY, OCC, FILL + 45_000)).toBe(true);
    vi.useRealTimers();
  });

  it("keeps a thin CHECK card reading its chain, so the CHECK can clear", () => {
    const ctx = { close: null, now: FILL, session: DAY, halfDay: false };
    const lots = [{ occ: OCC }] as never;
    const base = { ...view("hold", "Hold"), price: 600, entry: 598, m: { stop: 596 } } as unknown as ManageView;
    expect(cardAsksChain(withThinQuote(base, true), ctx, { lots, journalCurrent: true })).toBe(true);
    expect(cardAsksChain({ ...base, action: "check", line: PAUSED_LINE } as ManageView, ctx, { lots, journalCurrent: true })).toBe(false);
  });

  it("keeps the EXIT when the card changes hands and the same trade's stop differs by a cent", () => {
    vi.stubGlobal("window", { localStorage: store().ls });
    recPaid(160, 115, "q1", "note"); // the note's typed $1.60: stop $1.20
    recPaid(160, 114, "q2", "note");
    expect(stopFired(DAY, OCC, FILL, 120)).toBe(true);
    // the journal's average $1.58 works out a $1.19 stop: the fire at $1.20 still stands
    expect(stopFired(DAY, OCC, FILL, 119)).toBe(true);
    expect(stopFired(DAY, OCC, FILL, 115)).toBe(true);
    // a trade far under it does not share it
    expect(stopFired(DAY, OCC, FILL, 100)).toBe(false);
  });

  it("reads a latch written before levels were kept as standing for every level", () => {
    const { m, ls } = store();
    m.set(`held-stop:${DAY}`, JSON.stringify({ [OCC]: FILL + 1000 }));
    vi.stubGlobal("window", { localStorage: ls });
    expect(stopFired(DAY, OCC, FILL, 75)).toBe(true);
  });

  it("never carries a fired stop into the next day, in the page's own memory either", () => {
    vi.stubGlobal("window", { localStorage: store().ls });
    rec(119, "q1");
    rec(118, "q2");
    expect(stopFired(DAY, OCC, FILL)).toBe(true);
    expect(stopFired("2026-10-13", OCC, FILL)).toBe(false);
  });
});

describe("the contract a note names (note-contract.ts)", () => {
  const note = { symbol: "QQQ", side: "call" as const, fill: { priceCents: PAID, contracts: 1 } };

  it("checks the form's boxes: empty is no contract, the expiry today by default", () => {
    expect(checkContract("", "", DAY)).toEqual({ ok: true, contract: null });
    expect(checkContract("600", "", DAY)).toEqual({ ok: true, contract: { strike: 600, expiry: DAY } });
    expect(checkContract(" 602.5 ", "2026-10-16", DAY)).toEqual({ ok: true, contract: { strike: 602.5, expiry: "2026-10-16" } });
    expect(checkContract("abc", "", DAY).ok).toBe(false);
    expect(checkContract("0", "", DAY).ok).toBe(false);
    expect(checkContract("600", "12/10", DAY).ok).toBe(false);
    expect(checkContract("600", "2026-10-09", DAY).ok).toBe(false);
  });

  it("round-trips through storage and drops anything malformed", () => {
    const raw = JSON.stringify({ a: { strike: 600, expiry: DAY }, b: { strike: -1, expiry: DAY }, c: { strike: 1, expiry: DAY, x: 1 } });
    expect(parseContracts(raw)).toEqual({ a: { strike: 600, expiry: DAY } });
    expect(parseContracts("not json")).toEqual({});
    expect(parseContract(null)).toBeNull();
  });

  it("gives the one lot the card can quote, only with a contract and an option fill", () => {
    const lots = noteHeldLots(note, { strike: 600, expiry: DAY });
    expect(lots).toEqual([{ symbol: "QQQ", kind: "call", side: "long", strike: 600, expiry: DAY, qty: 1, entry: 1.6 }]);
    const r = lotsContract("QQQ", "call", lots);
    expect(r.ok && r.held).toMatchObject({ strike: 600, expiry: DAY, qty: 1, paidCents: PAID });
    expect(noteHeldLots(note, null)).toEqual([]);
    expect(noteHeldLots({ ...note, fill: undefined }, { strike: 600, expiry: DAY })).toEqual([]);
  });
});

describe("outside the hashed code", () => {
  it("no file in the signal's or the engine's import closure imports these modules", async () => {
    // @ts-expect-error: a plain .mjs script, no types
    const sig = (await import("../scripts/gen-signal.mjs")) as { signalFiles(): string[] };
    // @ts-expect-error: a plain .mjs script, no types
    const eng = (await import("../scripts/gen-engine.mjs")) as { engineFiles(): string[] };
    const files = [...sig.signalFiles(), ...eng.engineFiles()].map((f) => f.split("/src/lib/")[1]);
    for (const f of ["held-marks.ts", "note-contract.ts"]) expect(files).not.toContain(f);
  });
});
