// contract-pick.ts: DEC-0051 section 2.5's contract check, on synthetic OPRA chains. The expiry rule counts sessions
// on the real exchange calendar; the checks reuse the ticket's sizing and option-value.ts's quote judging.
import { describe, expect, it } from "vitest";
import type { ChainContract, ChainExpiry, ChainResponse } from "@/lib/chain";
import { type ContractCheckId, nearestFailure, noContractWords, pickContract, pickExpiry, type PickInput, sessionsOut } from "@/lib/contract-pick";
import { SIGNAL_PARAMS } from "@/lib/signal-params";

// 2026-11-12, a Thursday: 10:30 New York is 15:30Z.
const DAY = "2026-11-12";
const AS_OF = "2026-11-12T15:30:00.000Z";
const QUOTED = "2026-11-12T15:29:59.000Z";

const contract = (kind: "call" | "put", strike: number, over: Partial<ChainContract> = {}): ChainContract => ({
  kind,
  strike,
  bid: 0.78,
  ask: 0.82,
  last: 0.8,
  at: QUOTED,
  iv: 0.3,
  delta: kind === "call" ? 0.5 : -0.5,
  volume: 500,
  bid_size: 10,
  ask_size: 10,
  ...over,
});

const expiry = (date: string, contracts: ChainContract[]): ChainExpiry => ({ date, contracts });

const chain = (expiries: ChainExpiry[], over: Partial<ChainResponse> = {}): ChainResponse => ({
  as_of: AS_OF,
  served_at: AS_OF,
  feed: "opra",
  delay_min: 0,
  symbol: "AAPL",
  expiries,
  ...over,
});

/** Strikes 98 to 102, calls and puts, every one inside the rules unless a case says otherwise. */
const strikes = (date = "2026-11-13", over: (k: number, kind: "call" | "put") => Partial<ChainContract> = () => ({})) =>
  expiry(date, [98, 99, 100, 101, 102].flatMap((k) => (["call", "put"] as const).map((kind) => contract(kind, k, over(k, kind)))));

const input = (c: ChainResponse | null, over: Partial<PickInput> = {}): PickInput => ({ symbol: "AAPL", kind: "call", spot: 100.2, chain: c, checkedAgeMs: 1_000, today: DAY, ...over });

const checkOf = (p: ReturnType<typeof pickContract>, id: ContractCheckId, i = 0) => p.candidates[i]!.checks.find((k) => k.id === id)!;

describe("sessionsOut and the expiry rule", () => {
  it("counts sessions after today up to the expiry; the same day and earlier days are not out at all", () => {
    expect(sessionsOut(DAY, "2026-11-13")).toBe(1);
    expect(sessionsOut(DAY, "2026-11-16")).toBe(2); // over the weekend
    expect(sessionsOut(DAY, "2026-11-19")).toBe(5);
    expect(sessionsOut(DAY, "2026-11-20")).toBe(6);
    expect(sessionsOut(DAY, DAY)).toBeNull();
    expect(sessionsOut(DAY, "2026-11-11")).toBeNull();
    expect(sessionsOut(DAY, "2026-11-14")).toBeNull(); // a Saturday is not a session
  });

  it("a holiday and half-day week: Thanksgiving is not a session, the half day after it is", () => {
    // Mon 23: Tue 24 (1), Wed 25 (2), Thu 26 holiday, Fri 27 half day (3), Mon 30 (4), Tue 1 Dec (5), Wed 2 Dec (6)
    expect(sessionsOut("2026-11-23", "2026-11-26")).toBeNull();
    expect(sessionsOut("2026-11-23", "2026-11-27")).toBe(3);
    expect(sessionsOut("2026-11-23", "2026-12-01")).toBe(5);
    expect(sessionsOut("2026-11-23", "2026-12-02")).toBe(6);
    const c = chain([strikes("2026-11-26"), strikes("2026-12-02")]);
    expect(pickExpiry(c, "call", "2026-11-23")).toBeNull();
    expect(pickExpiry(chain([strikes("2026-12-02"), strikes("2026-12-01")]), "call", "2026-11-23")).toBe("2026-12-01");
  });

  it("past the calendar's end nothing is counted", () => {
    expect(sessionsOut("2029-12-28", "2030-01-02")).toBeNull();
  });

  it("the nearest listed expiry in range; one listed for the other kind only does not count", () => {
    const c = chain([strikes("2026-11-16"), strikes("2026-11-13"), strikes("2026-11-20")]);
    expect(pickExpiry(c, "call", DAY)).toBe("2026-11-13");
    const putsOnly = chain([expiry("2026-11-13", [contract("put", 100)]), strikes("2026-11-16")]);
    expect(pickExpiry(putsOnly, "call", DAY)).toBe("2026-11-16");
    expect(pickExpiry(putsOnly, "put", DAY)).toBe("2026-11-13");
  });
});

describe("pickContract", () => {
  it("names the nearest strike when every check passes, with every check's value", () => {
    const p = pickContract(input(chain([strikes()])));
    expect(p.why).toBeNull();
    expect(p.expiry).toBe("2026-11-13");
    expect(p.picked).toMatchObject({ occ: "AAPL261113C00100000", strike: 100, kind: "call", bidCents: 78, askCents: 82, delta: 0.5, volume: 500, checkedAgeMs: 1_000 });
    expect(p.picked!.checks.map((k) => [k.id, k.pass])).toEqual([
      ["listed", true],
      ["quote", true],
      ["premium", true],
      ["bid_ask", true],
      ["volume", true],
      ["delta", true],
    ]);
  });

  it("no expiry in range, or only today's: no contract", () => {
    expect(pickContract(input(chain([strikes("2026-11-20")]))).why).toBe("no-expiry");
    const today = pickContract(input(chain([strikes(DAY)])));
    expect(today).toMatchObject({ picked: null, why: "no-expiry", expiry: null });
    expect(noContractWords("no-expiry")).toBe("no expiry listed 1 to 5 sessions out");
  });

  it("no chain, another name's chain, or not OPRA (a refused OPRA included): no contract", () => {
    expect(pickContract(input(null)).why).toBe("no-chain");
    expect(pickContract(input(chain([strikes()], { symbol: "MSFT" }))).why).toBe("other-name");
    expect(pickContract(input(chain([strikes()], { feed: "indicative", delay_min: 15 }))).why).toBe("not-opra");
    expect(pickContract(input(chain([strikes()], { feed: "indicative", delay_min: 15, fallback: "opra-refused" }))).why).toBe("not-opra");
  });

  it("no price to order the strikes around: no strikes", () => {
    expect(pickContract(input(chain([strikes()]), { spot: null })).why).toBe("no-strikes");
  });

  it("tries at most six strikes, nearest first, the lower of two equally near first", () => {
    const wide = expiry("2026-11-13", [95, 96, 97, 98, 99, 100, 101, 102, 103, 104].map((k) => contract("call", k, { delta: null })));
    const p = pickContract(input(chain([wide]), { spot: 100 }));
    expect(p.why).toBe("none-passed");
    expect(p.candidates.map((c) => c.strike)).toEqual([100, 99, 101, 98, 102, 97]);
    expect(noContractWords(p.why!)).toBe("no contract inside your rules");
    expect(nearestFailure(p)).toMatchObject({ strike: 100, check: { id: "delta", pass: false } });
  });

  it("one-sided, zero-bid and crossed quotes fail the quote check, and with it the premium and bid–ask checks", () => {
    for (const over of [{ bid: null }, { bid: 0 }, { ask: null }, { ask: 0 }, { bid: 0.9, ask: 0.8 }]) {
      const p = pickContract(input(chain([strikes(undefined, () => over)])));
      expect(p.picked).toBeNull();
      expect(checkOf(p, "quote").pass).toBe(false);
      expect(checkOf(p, "premium")).toMatchObject({ pass: false, value: null });
      expect(checkOf(p, "bid_ask")).toMatchObject({ pass: false, value: null });
    }
  });

  it("a wide quote is two-sided but fails the bid–ask check, in bid–ask words", () => {
    const p = pickContract(input(chain([strikes(undefined, () => ({ bid: 0.5, ask: 0.9 }))])));
    expect(checkOf(p, "quote").pass).toBe(true);
    expect(checkOf(p, "bid_ask").pass).toBe(false);
    expect(checkOf(p, "bid_ask").why).toContain("bid–ask");
    expect(checkOf(p, "bid_ask").why).not.toMatch(/spread/i);
  });

  it("the reviewer's case: a quote stamped 09:31 read on a fresh check at 15:59 names no contract", () => {
    const late = chain([strikes(undefined, () => ({ at: "2026-11-12T14:31:00.000Z" }))], { as_of: "2026-11-12T20:59:00.000Z", served_at: "2026-11-12T20:59:00.000Z" });
    const p = pickContract(input(late, { checkedAgeMs: 500 }));
    expect(p.picked).toBeNull();
    expect(checkOf(p, "quote").why).toBe("the quote is 23280 s old, over 60 s");
  });

  it("the quote's own stamp: 60 s before the answer passes, a second more fails", () => {
    const stamped = (at: string) => pickContract(input(chain([strikes(undefined, () => ({ at }))])));
    expect(stamped("2026-11-12T15:29:00.000Z").picked).not.toBeNull();
    expect(stamped("2026-11-12T15:28:59.000Z").picked).toBeNull();
    expect(stamped("2026-11-12T15:30:05.000Z").picked).not.toBeNull(); // up to 5 s ahead of the answer is clock noise
    expect(checkOf(stamped("2026-11-12T15:30:05.001Z"), "quote").why).toBe("the quote's time is ahead of the answer");
  });

  it("the session is judged by the calendar passed in, never the device's", () => {
    const shut = { sessionOf: () => ({ kind: "closed" as const, open: null, close: null }) } as unknown as NonNullable<PickInput["calendar"]>;
    const p = pickContract(input(chain([strikes()]), { calendar: shut }));
    expect(p.picked).toBeNull();
  });

  it("delta must have the kind's sign: a call above zero, a put below", () => {
    const wrong = pickContract(input(chain([strikes(undefined, (_, kind) => ({ delta: kind === "call" ? -0.5 : 0.5 }))])));
    expect(checkOf(wrong, "delta")).toMatchObject({ pass: false, value: -0.5 });
    const putWrong = pickContract(input(chain([strikes(undefined, (_, kind) => ({ delta: kind === "call" ? -0.5 : 0.5 }))]), { kind: "put" }));
    expect(checkOf(putWrong, "delta")).toMatchObject({ pass: false, value: 0.5 });
    expect(checkOf(pickContract(input(chain([strikes(undefined, () => ({ delta: 0 }))]))), "delta").pass).toBe(false);
  });

  it("a locked quote (ask equal to the bid) is two-sided and passes", () => {
    const p = pickContract(input(chain([strikes(undefined, () => ({ bid: 0.8, ask: 0.8 }))])));
    expect(p.picked).toMatchObject({ bidCents: 80, askCents: 80 });
  });

  it("the quote's checked age: 10 s passes, a millisecond more fails, unknown fails", () => {
    expect(pickContract(input(chain([strikes()]), { checkedAgeMs: 10_000 })).picked).not.toBeNull();
    const old = pickContract(input(chain([strikes()]), { checkedAgeMs: 10_001 }));
    expect(old.picked).toBeNull();
    expect(checkOf(old, "quote")).toMatchObject({ pass: false, value: 10_001 });
    expect(checkOf(pickContract(input(chain([strikes()]), { checkedAgeMs: null })), "quote").pass).toBe(false);
  });

  it("a quote from before today's open, or from outside the session, fails", () => {
    const yesterday = pickContract(input(chain([strikes(undefined, () => ({ at: "2026-11-11T20:59:00.000Z" }))])));
    expect(checkOf(yesterday, "quote").pass).toBe(false);
    const evening = pickContract(input(chain([strikes()], { as_of: "2026-11-12T21:30:00.000Z", served_at: "2026-11-12T21:30:00.000Z" })));
    expect(checkOf(evening, "quote").pass).toBe(false);
  });

  it("premium: inside the cap and the risk cap at the 25% stop with fees, or not", () => {
    // 1.80: $180 premium, stop 1.35, $45 + $1.11 fees at the stop: inside both
    expect(pickContract(input(chain([strikes(undefined, () => ({ bid: 1.79, ask: 1.8 }))]))).picked).not.toBeNull();
    // 2.00: $200 premium is the cap, but $50 + $1.11 at the stop is over the $50 risk cap
    const risk = pickContract(input(chain([strikes(undefined, () => ({ bid: 1.99, ask: 2 }))])));
    expect(checkOf(risk, "premium")).toMatchObject({ pass: false, value: 200 });
    expect(checkOf(risk, "premium").why).toContain("risk cap");
    // 2.05: over the $200 premium cap
    const cap = pickContract(input(chain([strikes(undefined, () => ({ bid: 2.04, ask: 2.05 }))])));
    expect(checkOf(cap, "premium").why).toContain("premium cap");
    // 0.02: the 25% stop rounds up to the price itself, no stop under it
    const cheap = pickContract(input(chain([strikes(undefined, () => ({ bid: 0.02, ask: 0.02 }))])));
    expect(checkOf(cheap, "premium").pass).toBe(false);
  });

  it("bid–ask at exactly 20% of the way from the mid to the stop passes; a cent wider fails", () => {
    // mid 0.80, stop distance 0.25 × 0.80 = 0.20, 20% of it 0.04: 0.78 × 0.82 is on the limit
    const edge = pickContract(input(chain([strikes(undefined, () => ({ bid: 0.78, ask: 0.82 }))])));
    expect(checkOf(edge, "bid_ask")).toMatchObject({ pass: true, value: 4 });
    const wide = pickContract(input(chain([strikes(undefined, () => ({ bid: 0.77, ask: 0.82 }))])));
    expect(checkOf(wide, "bid_ask")).toMatchObject({ pass: false, value: 5 });
    expect(checkOf(wide, "bid_ask").why).toContain("bid–ask");
    expect(checkOf(wide, "bid_ask").why).not.toMatch(/spread/i);
  });

  it("volume today: exactly the minimum passes, one under fails, none from the feed fails", () => {
    expect(pickContract(input(chain([strikes(undefined, () => ({ volume: 100 }))]))).picked).not.toBeNull();
    expect(checkOf(pickContract(input(chain([strikes(undefined, () => ({ volume: 99 }))]))), "volume")).toMatchObject({ pass: false, value: 99 });
    expect(checkOf(pickContract(input(chain([strikes(undefined, () => ({ volume: null }))]))), "volume")).toMatchObject({ pass: false, value: null });
  });

  it("delta must come from the feed: a null delta fails, even with a volatility a model could use", () => {
    const p = pickContract(input(chain([strikes(undefined, () => ({ delta: null, iv: 0.3 }))])));
    expect(p.picked).toBeNull();
    expect(checkOf(p, "delta")).toMatchObject({ pass: false, value: null });
  });

  it("the first strike that passes is named, after nearer ones that fail", () => {
    const c = chain([strikes(undefined, (k) => (k === 100 ? { volume: 5 } : {}))]);
    const p = pickContract(input(c));
    expect(p.candidates.map((x) => [x.strike, x.pass])).toEqual([
      [100, false],
      [101, true],
    ]);
    expect(p.picked!.strike).toBe(101);
  });

  it("a chain with duplicates: a contract listed twice is not named, and the strike list holds each strike once", () => {
    const dup = chain([strikes(), expiry("2026-11-13", [contract("call", 100)])]);
    const p = pickContract(input(dup));
    expect(checkOf(p, "listed")).toMatchObject({ pass: false, value: 2 });
    expect(p.picked!.strike).toBe(101);
    expect(new Set(p.candidates.map((x) => x.strike)).size).toBe(p.candidates.length);
  });

  it("never throws on a thin or odd chain", () => {
    const odd = [
      chain([]),
      chain([expiry("2026-11-13", [])]),
      chain([{ date: "2026-11-13", contracts: null } as unknown as ChainExpiry]),
      chain([expiry("not a date", [contract("call", 100)])]),
      chain([expiry("2026-11-13", [contract("call", Number.NaN), contract("call", -1)])]),
      { ...chain([]), expiries: null } as unknown as ChainResponse,
      chain([expiry("2026-11-13", [null as unknown as ChainContract, contract("call", 100)])]),
    ];
    for (const c of odd) expect(() => pickContract(input(c))).not.toThrow();
    // Odd enough to need guessing (a null among the contracts) names nothing, rather than the one good-looking row.
    for (const c of odd) expect(pickContract(input(c)).picked).toBeNull();
  });

  it("the put side reads puts only", () => {
    const p = pickContract(input(chain([strikes()]), { kind: "put" }));
    expect(p.picked).toMatchObject({ kind: "put", occ: "AAPL261113P00100000", delta: -0.5 });
  });

  it("no caller can pass other numbers: a loose `params` is ignored", () => {
    const loose = { params: { ...SIGNAL_PARAMS, contract_min_volume: 0 } } as unknown as Partial<PickInput>;
    expect(pickContract(input(chain([strikes(undefined, () => ({ volume: 5 }))]), loose)).picked).toBeNull();
  });
});
