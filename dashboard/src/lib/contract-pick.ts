// The contract check of DEC-0051 section 2.5: from one OPRA chain answer, the contract a side's signal may name, or
// none. The expiry is the nearest listed one 1 to 5 sessions out by the market calendar (the same day never); the
// strikes are tried nearest the stock's price first (ticket.ts strikesByDistance, at most 6); the first whose contract
// passes every check is named. Every check of every strike tried is returned with its value, so the card and the log
// can say why none passed.
//
// The checks reuse the owner's own rules, never a copy of them: the premium through the ticket's sizing (sizeTicket
// with OWNER_LIMITS: the premium cap, the risk cap at the 25% stop with the owner's fees, a stop under the price), the
// quote by option-value.ts's pure pieces (the bid rounded down and the ask up to the cent), judged here on the server's
// own times: OPRA, the answer's time in the regular session by the calendar passed in, the quote stamped that session
// and no older than the record's limit before the answer, two-sided, not crossed, a bid above zero, and the answer's
// checked age within its limit; and a contract listed once in the chain (chainMatches). Delta is the feed's own
// (chain.ts takes it from the snapshot's greeks only), of the kind's sign; none is ever worked out here. The numbers
// are this module's SIGNAL_PARAMS only: no caller can pass others.
//
// Pure: no I/O and no clock; the caller passes the chain, its checked age and the day. Never throws on a thin or odd
// chain. Nothing here places, stages or sizes an order; it names a contract the owner may look at.
import type { ChainContract, ChainResponse } from "./chain";
import { type FlowCalendar, MARKET_CALENDAR } from "./flow";
import { addDays, nyNow } from "./market-calendar";
import { askToCents, bidToCents, chainMatches, occSymbol, QUOTE_AHEAD_MS, servedMs } from "./option-value";
import { failWords, OWNER_LIMITS, sizeTicket, strikesByDistance, usd } from "./ticket";
import { PREMIUM_STOP } from "./trade-rules";
import { SIGNAL_PARAMS } from "./signal-params";

export type ContractCheckId = "listed" | "quote" | "premium" | "bid_ask" | "volume" | "delta";
export const CONTRACT_CHECKS: readonly ContractCheckId[] = ["listed", "quote", "premium", "bid_ask", "volume", "delta"];

export interface ContractCheck {
  id: ContractCheckId;
  pass: boolean;
  /** The value the check read: cents, seconds, contracts or a delta; null when there was nothing to read. */
  value: number | null;
  why: string;
}

export interface Candidate {
  /** The contract's OCC symbol; null when one cannot be made from the name, the expiry and the strike. */
  occ: string | null;
  expiry: string;
  strike: number;
  kind: "call" | "put";
  /** Every check, in CONTRACT_CHECKS order. */
  checks: ContractCheck[];
  pass: boolean;
  /** The quote the checks read, whole cents (the bid rounded down, the ask up), when it passed the quote check. */
  bidCents: number | null;
  askCents: number | null;
  delta: number | null;
  volume: number | null;
  /** The chain answer's checked age, ms. */
  checkedAgeMs: number | null;
}

export type NoContractWhy = "no-chain" | "other-name" | "not-opra" | "no-expiry" | "no-strikes" | "none-passed";

export interface ContractPick {
  /** The first candidate that passed every check, or null: "no contract". */
  picked: Candidate | null;
  /** The expiry the rule chose; null when none is listed in range. */
  expiry: string | null;
  /** Every strike tried, in the order tried. */
  candidates: Candidate[];
  /** Why none was named; null when one was. */
  why: NoContractWhy | null;
}

export interface PickInput {
  symbol: string;
  kind: "call" | "put";
  /** The stock's price the strikes are ordered around; null gives no strikes. */
  spot: number | null;
  chain: ChainResponse | null;
  /** How long ago the chain answer was checked against the feed (option-value.ts checkedAgeMs), ms; null fails. */
  checkedAgeMs: number | null;
  /** The New York session day the signal is for. */
  today: string;
  calendar?: FlowCalendar;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * How many sessions `expiry` is after `today`, by the calendar: sessions strictly after today up to and including the
 * expiry. Null when the expiry is today or earlier, is not itself a session (a holiday or a weekend), or the calendar
 * does not cover a day between them.
 */
export function sessionsOut(today: string, expiry: string, calendar: FlowCalendar = MARKET_CALENDAR): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || expiry <= today) return null;
  let n = 0;
  // Two months of days hold far more than the rule's five sessions; the bound only stops a broken date looping.
  for (let day = addDays(today, 1), i = 0; day <= expiry && i < 62; day = addDays(day, 1), i++) {
    const s = calendar.sessionOf(day);
    if (s.kind === "out_of_range") return null;
    const open = s.kind === "open" || s.kind === "half";
    if (open) n++;
    if (day === expiry) return open ? n : null;
  }
  return null;
}

/**
 * The expiry the rule names: the nearest listed one (for the side's kind) from min_sessions to max_sessions sessions
 * out. Null when none is listed in that range: "no contract".
 */
export function pickExpiry(chain: Pick<ChainResponse, "expiries"> | null, kind: "call" | "put", today: string, calendar: FlowCalendar = MARKET_CALENDAR): string | null {
  const params = SIGNAL_PARAMS;
  const listed = new Set<string>();
  for (const x of chain?.expiries ?? []) if (typeof x?.date === "string" && Array.isArray(x.contracts) && x.contracts.some((c) => c?.kind === kind)) listed.add(x.date);
  for (const d of [...listed].sort()) {
    const n = sessionsOut(today, d, calendar);
    if (n !== null && n >= params.expiry_rule.min_sessions && n <= params.expiry_rule.max_sessions) return d;
  }
  return null;
}

export type QuoteRead = { ok: true; bidCents: number; askCents: number } | { ok: false; why: string };

/**
 * One contract's quote, judged on the server's own times (never a browser's): the answer is OPRA and its time
 * (`served_at`, else `as_of`) is inside the regular session by `calendar`; the quote's stamp is on that session, at or
 * after its open, not ahead of the answer by more than QUOTE_AHEAD_MS, and at most contract_quote_stamp_max_age_s
 * before it; the answer's checked age is at most contract_quote_max_age_s; the quote is two-sided with a bid above zero and not crossed
 * (a locked quote is two-sided). Bid rounded down and ask up to whole cents (option-value.ts).
 */
export function readContractQuote(
  chain: Pick<ChainResponse, "as_of" | "served_at" | "feed" | "fallback">,
  c: Pick<ChainContract, "bid" | "ask" | "at">,
  checkedAgeMs: number | null,
  calendar: FlowCalendar = MARKET_CALENDAR,
): QuoteRead {
  const checkedMaxS = SIGNAL_PARAMS.contract_quote_max_age_s;
  const stampMaxS = SIGNAL_PARAMS.contract_quote_stamp_max_age_s;
  if (chain.feed !== "opra" || chain.fallback !== undefined) return { ok: false, why: "the option quotes are not OPRA" };
  const served = servedMs(chain);
  if (!Number.isFinite(served)) return { ok: false, why: "the answer has no time" };
  const day = nyNow(new Date(served));
  const s = calendar.sessionOf(day.day);
  if (s.open === null || s.close === null || day.minute < s.open || day.minute >= s.close) return { ok: false, why: "outside the regular option session" };
  if (!isNum(checkedAgeMs) || checkedAgeMs < 0) return { ok: false, why: "the quote's checked age is not known" };
  if (checkedAgeMs > checkedMaxS * 1000) return { ok: false, why: `the quote was checked ${Math.floor(checkedAgeMs / 1000)} s ago, over ${checkedMaxS} s` };
  const t = typeof c.at === "string" ? Date.parse(c.at) : NaN;
  if (!Number.isFinite(t)) return { ok: false, why: "the quote has no time" };
  if (t > served + QUOTE_AHEAD_MS) return { ok: false, why: "the quote's time is ahead of the answer" };
  const q = nyNow(new Date(t));
  if (q.day !== day.day || q.minute < s.open) return { ok: false, why: "no quote yet today" };
  if (served - t > stampMaxS * 1000) return { ok: false, why: `the quote is ${Math.floor((served - t) / 1000)} s old, over ${stampMaxS} s` };
  if (c.ask === null || !isNum(c.ask) || c.ask <= 0) return { ok: false, why: "one-sided quote: no ask" };
  if (c.bid === null || !isNum(c.bid)) return { ok: false, why: "one-sided quote: no bid" };
  const bidCents = bidToCents(c.bid);
  const askCents = askToCents(c.ask);
  if (bidCents <= 0) return { ok: false, why: "nobody is bidding (a zero bid)" };
  if (bidCents > askCents) return { ok: false, why: "crossed quote: the bid is above the ask" };
  return { ok: true, bidCents, askCents };
}

const check = (id: ContractCheckId, pass: boolean, value: number | null, why: string): ContractCheck => ({ id, pass, value, why });

/** One strike's contract, every check worked out. */
function judge(x: PickInput, chain: ChainResponse, expiry: string, strike: number, calendar: FlowCalendar): Candidate {
  const params = SIGNAL_PARAMS;
  const contracts = chain.expiries.filter((e) => e.date === expiry).flatMap((e) => (Array.isArray(e.contracts) ? e.contracts : []));
  const c = contracts.find((k) => k?.kind === x.kind && k.strike === strike) ?? null;
  const occ = occSymbol(x.symbol, expiry, x.kind, strike);
  const listings = chainMatches(chain, expiry, x.kind, strike);
  const checks: ContractCheck[] = [];
  checks.push(check("listed", listings === 1 && occ !== null, listings, listings === 1 && occ !== null ? "listed once in the chain" : listings > 1 ? "listed more than once in the chain" : "not a standard contract on this name"));

  let bidCents: number | null = null;
  let askCents: number | null = null;
  if (c) {
    const q = readContractQuote(chain, c, x.checkedAgeMs, calendar);
    if (!q.ok) checks.push(check("quote", false, isNum(x.checkedAgeMs) ? x.checkedAgeMs : null, q.why));
    else {
      checks.push(check("quote", true, x.checkedAgeMs, `two-sided quote, checked ${Math.floor(x.checkedAgeMs! / 1000)} s ago`));
      bidCents = q.bidCents;
      askCents = q.askCents;
    }
  } else checks.push(check("quote", false, null, "no quote for this contract"));

  if (askCents === null || bidCents === null) {
    checks.push(check("premium", false, null, "no usable quote to price it at"));
    checks.push(check("bid_ask", false, null, "no usable quote"));
  } else {
    const size = sizeTicket(askCents, OWNER_LIMITS);
    checks.push(check("premium", size.contracts >= 1, askCents, size.contracts >= 1 ? `at the ask ${usd(askCents)}, ${size.contracts} contract${size.contracts === 1 ? "" : "s"} fit your rules` : failWords(size).join(" ")));
    // ask − bid ≤ share × PREMIUM_STOP × mid, with the mid (bid + ask) ÷ 2, in whole numbers so the edge is exact.
    const share = Math.round(params.contract_spread_share_of_stop * 100);
    const stop = Math.round(PREMIUM_STOP * 100);
    const gap = askCents - bidCents;
    const ok = 2 * gap * 10_000 <= share * stop * (bidCents + askCents);
    const limit = (share * stop * (bidCents + askCents)) / 20_000;
    checks.push(check("bid_ask", ok, gap, `bid–ask ${usd(gap)}, ${ok ? "within" : "over"} the ${usd(Math.floor(limit))} limit (${share}% of the way from the mid to the premium stop)`));
  }

  const volume = c && isNum(c.volume) && c.volume >= 0 ? c.volume : null;
  checks.push(check("volume", volume !== null && volume >= params.contract_min_volume, volume, volume === null ? "no volume today from the feed" : `${volume} contracts traded today, ${volume >= params.contract_min_volume ? "at least" : "under"} ${params.contract_min_volume}`));
  // The feed's delta only: chain.ts reads it from the snapshot's greeks and nowhere else. A model's delta never counts.
  // A call's delta is above zero and a put's below: any other sign is data that cannot be right.
  const delta = c && isNum(c.delta) && Math.abs(c.delta) <= 1 ? c.delta : null;
  const signed = delta !== null && (x.kind === "call" ? delta > 0 : delta < 0);
  checks.push(check("delta", signed, delta, delta === null ? "no delta from the feed" : signed ? `delta ${delta.toFixed(2)} from the feed` : `delta ${delta.toFixed(2)} has the wrong sign for a ${x.kind}`));

  return {
    occ,
    expiry,
    strike,
    kind: x.kind,
    checks,
    pass: checks.every((k) => k.pass),
    bidCents,
    askCents,
    delta,
    volume,
    checkedAgeMs: isNum(x.checkedAgeMs) ? x.checkedAgeMs : null,
  };
}

/** DEC-0051 section 2.5 for one side: the contract to name, or none with every strike's reasons. Never throws. */
export function pickContract(x: PickInput): ContractPick {
  const calendar = x.calendar ?? MARKET_CALENDAR;
  const none = (why: NoContractWhy, expiry: string | null = null, candidates: Candidate[] = []): ContractPick => ({ picked: null, expiry, candidates, why });
  try {
    const chain = x.chain;
    if (!chain || !Array.isArray(chain.expiries)) return none("no-chain");
    if (chain.symbol !== x.symbol) return none("other-name");
    if (chain.feed !== "opra" || chain.fallback !== undefined) return none("not-opra");
    const expiry = pickExpiry(chain, x.kind, x.today, calendar);
    if (expiry === null) return none("no-expiry");
    const strikes = chain.expiries
      .filter((e) => e.date === expiry)
      .flatMap((e) => (Array.isArray(e.contracts) ? e.contracts : []))
      .filter((c) => c?.kind === x.kind)
      .map((c) => c.strike);
    const order = strikesByDistance(strikes, x.spot);
    if (order.length === 0) return none("no-strikes", expiry);
    const candidates: Candidate[] = [];
    for (const k of order) {
      const c = judge(x, chain, expiry, k, calendar);
      candidates.push(c);
      if (c.pass) return { picked: c, expiry, candidates, why: null };
    }
    return none("none-passed", expiry, candidates);
  } catch {
    // A chain odd enough to throw names no contract.
    return none("no-chain");
  }
}

/** The first failed check of the nearest strike tried, for the card and the log; null when there is none. */
export function nearestFailure(p: ContractPick): { strike: number; check: ContractCheck } | null {
  const first = p.candidates[0];
  const failed = first?.checks.find((k) => !k.pass);
  return first && failed ? { strike: first.strike, check: failed } : null;
}

/** Why no contract was named, in plain words. */
export function noContractWords(why: NoContractWhy): string {
  const params = SIGNAL_PARAMS;
  switch (why) {
    case "no-chain":
      return "no option chain";
    case "other-name":
      return "the option chain is for another name";
    case "not-opra":
      return "the option quotes are not OPRA";
    case "no-expiry":
      return `no expiry listed ${params.expiry_rule.min_sessions} to ${params.expiry_rule.max_sessions} sessions out`;
    case "no-strikes":
      return "no strikes listed near the price";
    case "none-passed":
      return "no contract inside your rules";
  }
}
