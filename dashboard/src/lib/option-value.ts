// The option's own market, as the owner sees it at entry and while holding: what a contract held from the journal
// is worth at the bid, what a typed ticket price looks like beside the live bid and ask, and what a round trip at
// the spread costs. Pure: no clock, no fetch, no DOM; the caller passes the times in.
//
// Display and checks only. Nothing here changes a rule, the board, a level or a ticket's size: the typed price stays
// the ticket's only sizing input (ticket.ts sizeTicket). When in doubt a number is withheld, never guessed at: a value
// needs a real-time (OPRA) answer checked within the last 10 s, a two-sided quote that is not crossed, a spread no
// wider than 30% of its mid, the regular option session, and one contract named exactly by the journal and listed in
// the chain. The indicative feed is 15 minutes behind: it never gives a live value.
import type { ChainResponse } from "./chain";
import { readQuote } from "./contract";
import { fillStop } from "./manage-stop";
import { nyNow, sessionOf } from "./market-calendar";
import { OWNER_FEES } from "./owner-positions";
import { PREMIUM_STOP } from "./premium-stop";
import { roundTripCents, usd } from "./ticket";

// ---- the contract's symbol ------------------------------------------------------------------------------------------
/** As many contracts as one /api/contract request may name. */
export const MAX_CONTRACT_SYMBOLS = 20;

/** OCC: a root of 1 to 6 letters, yymmdd, C or P, the strike in thousandths in 8 digits. Adjusted roots (`SPY1`) are not one. */
const OCC = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/** A real calendar date, YYYY-MM-DD: 31 June and month 13 are not. */
function realDate(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

/** A standard contract's parts from its OCC symbol (`SPY261019P00760000`), or null for anything else. */
export function parseOccSymbol(raw: string): { root: string; expiry: string; kind: "call" | "put"; strike: number } | null {
  const m = OCC.exec(raw);
  if (!m) return null;
  const expiry = `20${m[2]}-${m[3]}-${m[4]}`;
  if (!realDate(expiry)) return null;
  const strike = Number(m[6]) / 1000;
  return strike > 0 ? { root: m[1]!, expiry, kind: m[5] === "C" ? "call" : "put", strike } : null;
}

/**
 * The OCC symbol of a standard contract on `symbol` (the root is the name without its dots, as Alpaca lists it), or
 * null when the parts cannot make one: a root that is not 1 to 6 letters, a date that is not real, a strike that is
 * not a positive whole number of tenths of a cent under $100,000.
 */
export function occSymbol(symbol: string, expiry: string, kind: "call" | "put", strike: number): string | null {
  const root = symbol.replace(/\./g, "");
  if (!/^[A-Z]{1,6}$/.test(root) || !realDate(expiry) || !(strike > 0) || strike >= 100_000) return null;
  const milli = Math.round(strike * 1000);
  if (Math.abs(milli - strike * 1000) > 1e-6) return null;
  return `${root}${expiry.slice(2).replace(/-/g, "")}${kind === "call" ? "C" : "P"}${String(milli).padStart(8, "0")}`;
}

// ---- the route's answer -----------------------------------------------------------------------------------------------
/** One contract's latest quote and trade on the option feed. Prices per share in US dollars; times ISO 8601. */
export interface ContractQuote {
  /** Null when the feed gave none. A bid of 0 is kept: it is a real quote nobody will pay for. */
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  quote_at: string | null;
  last: number | null;
  last_at: string | null;
}

export interface ContractResponse {
  /** When the quotes were fetched from Alpaca (the oldest fetch among the contracts answered). */
  as_of: string;
  /** When this answer was built, on the server's clock: `as_of` plus however long it sat in the cache. */
  served_at?: string;
  /** The feed the quotes came from: indicative (15 minutes behind) or opra (real time). */
  feed: "indicative" | "opra";
  delay_min: number;
  /** Set when opra was configured but Alpaca refused it (HTTP 403): the answer is indicative's instead. */
  fallback?: "opra-refused";
  contracts: Record<string, ContractQuote>;
  /** Contracts asked for that came back without a quote or a trade. */
  missing: string[];
  fixture?: true;
}

/** What the browser holds from /api/contract (contract-request.ts requestContracts). */
export type ContractFeed =
  | { status: "idle" }
  | { status: "loading" }
  /** The site has no keys for the option feed, or its option feed setting is refused (503). */
  | { status: "off" }
  | { status: "error" }
  /**
   * `sentPerf` and `sentWall`: when the request that brought this answer was SENT, on the browser's monotonic clock
   * and on its wall clock (ms). Its age counts from the send, so time in flight is never fresh time.
   */
  | { status: "ok"; answer: ContractResponse; sentPerf: number; sentWall: number };

// ---- the guards ---------------------------------------------------------------------------------------------------
/** How often the page asks for a held or ticketed contract's quote. */
export const CONTRACT_POLL_MS = 2_000;
/** An answer checked longer ago than this (since its request was sent, plus its time in the server's cache) gives no value. */
export const VALUE_MAX_AGE_MS = 10_000;
/** A spread wider than this share of its mid gives no value: the bid is then no guide to what a contract is worth. */
export const MAX_SPREAD_SHARE = 0.3;
/** A quote stamped this far after the answer's own server time is not believed. */
export const QUOTE_AHEAD_MS = 5_000;

/**
 * How long ago the answer was checked against Alpaca, in ms: its time in the server's cache (`served_at` less
 * `as_of`, both on the server's clock) plus the time since its request was sent (the browser's monotonic clock), so
 * a slow answer is as old as the wait for it. Never the quote's own time: a quiet contract keeps an old quote time
 * and is still a fresh check (quoteToday bounds that time on its own). Null without a send time.
 */
export function checkedAgeMs(answer: Pick<ContractResponse, "as_of" | "served_at">, sentPerf: number | null | undefined, perfNow: number | null | undefined): number | null {
  const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!fin(sentPerf) || !fin(perfNow)) return null;
  const asOf = Date.parse(answer.as_of);
  const served = answer.served_at ? Date.parse(answer.served_at) : NaN;
  const cached = Number.isFinite(asOf) && Number.isFinite(served) ? Math.max(0, served - asOf) : 0;
  return cached + Math.max(0, perfNow - sentPerf);
}

/** Whether `nowMs` is inside the regular session of its New York day (09:30 to the close, 13:00 on a half day), by the market calendar. */
export function inOptionSession(nowMs: number | null | undefined): boolean {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return false;
  const { day, minute } = nyNow(new Date(nowMs));
  const s = sessionOf(day);
  return s.open !== null && s.close !== null && minute >= s.open && minute < s.close;
}

/** The answer's own time on the server's clock: `served_at`, else `as_of`; NaN when neither reads. */
export function servedMs(answer: Pick<ContractResponse, "as_of" | "served_at">): number {
  const s = answer.served_at ? Date.parse(answer.served_at) : NaN;
  return Number.isFinite(s) ? s : Date.parse(answer.as_of);
}

/**
 * A quote time a value may rest on, against the answer's server time `served`: it reads, it is on the same New York
 * session day, at or after that day's regular open, and no more than QUOTE_AHEAD_MS after `served`. A quiet contract
 * quoted at 09:31 still stands at 11:00; yesterday's closing quote never does, however fresh the check.
 */
export function quoteToday(quoteAt: string | null | undefined, served: number): "ok" | "none" | "ahead" {
  const t = typeof quoteAt === "string" ? Date.parse(quoteAt) : NaN;
  if (!Number.isFinite(t) || !Number.isFinite(served)) return "none";
  if (t > served + QUOTE_AHEAD_MS) return "ahead";
  const q = nyNow(new Date(t));
  const s = nyNow(new Date(served));
  const open = sessionOf(s.day).open;
  return q.day === s.day && open !== null && q.minute >= open ? "ok" : "none";
}

/** A quote that passed every guard, in whole cents a share. */
export interface LiveQuote {
  /** Rounded down to the cent: never a better bid than was quoted. */
  bidCents: number;
  /** Rounded up to the cent: never a better ask than was quoted. */
  askCents: number;
  /** May end in half a cent. */
  midCents: number;
  spreadCents: number;
  /** Whole seconds since the answer was checked. */
  checkedS: number;
  /** The answer is the fixture's (fixture mode): the page says "sample data", never OPRA. */
  sample: boolean;
}

export type QuoteJudgement = { ok: true; q: LiveQuote } | { ok: false; why: string };

export interface JudgeInput {
  feed: ContractFeed;
  /** The contract's OCC symbol. */
  occ: string;
  /** The monotonic clock now (ms); null before the page has read it. */
  perfNow: number | null;
  /**
   * The wall clock now (ms), only to bound the time since the request was sent when the monotonic clock did not run
   * (a computer asleep). Never for the session: that is judged on the answer's server time.
   */
  wallNow: number | null;
  /** When the tab was last shown again after being hidden (monotonic clock, ms); null when it never was. */
  shownPerf: number | null;
}

export const WAITING = "waiting for a live quote";
export const OFF = "option quotes are not set up on this site";
export const FAILED = "the option quote check failed";
export const SHOWN_AGAIN = "the tab was hidden: waiting for a fresh quote";
export const NOT_OPRA = "the option feed here is 15 minutes behind, not OPRA";
export const OPRA_REFUSED = "Alpaca refused OPRA, so the option feed here is 15 minutes behind";
export const OUTSIDE_SESSION = "outside the regular option session";
export const NO_QUOTE = "no quote for this contract";
export const NO_QUOTE_TODAY = "no quote yet today";
export const QUOTE_AHEAD = "the quote's time is ahead of the check";
export const NO_BID = "one-sided quote: no bid";
export const NO_ASK = "one-sided quote: no ask";
export const ZERO_BID = "nobody is bidding (a zero bid)";
export const CROSSED = "crossed quote: the bid is above the ask";
export const tooOld = (s: number) => `the last quote was checked ${s} s ago, over ${VALUE_MAX_AGE_MS / 1000} s`;
export const tooWide = (pct: number) => `the spread is ${pct}% of the mid, over ${Math.round(MAX_SPREAD_SHARE * 100)}%`;

/** The bid rounded down and the ask rounded up to whole cents (a hair of slack for binary fractions such as 1.15). */
const bidToCents = (v: number) => Math.floor(v * 100 + 1e-7);
const askToCents = (v: number) => Math.ceil(v * 100 - 1e-7);

/**
 * Whether one contract's quote may be shown as live, and why not. In this order: the route answered; its request was
 * sent after the tab was last shown again; the feed is opra; the answer was checked within VALUE_MAX_AGE_MS of its
 * request's send on the monotonic clock, and on the wall clock too; the answer's server time is in the regular
 * session; the contract is in the answer, quoted today (quoteToday), two-sided, uncrossed, with a bid above zero; the
 * spread is no more than MAX_SPREAD_SHARE of the mid. The device's own clock never decides the session.
 */
export function judgeQuote(x: JudgeInput): QuoteJudgement {
  const f = x.feed;
  if (f.status === "off") return { ok: false, why: OFF };
  if (f.status === "error") return { ok: false, why: FAILED };
  if (f.status !== "ok" || x.perfNow === null || x.wallNow === null) return { ok: false, why: WAITING };
  // An answer to a request sent before the tab was last shown is from before the gap: never fresh.
  if (x.shownPerf !== null && f.sentPerf < x.shownPerf) return { ok: false, why: SHOWN_AGAIN };
  if (f.answer.feed !== "opra") return { ok: false, why: f.answer.fallback === "opra-refused" ? OPRA_REFUSED : NOT_OPRA };
  const age = checkedAgeMs(f.answer, f.sentPerf, x.perfNow);
  if (age === null) return { ok: false, why: WAITING };
  if (age > VALUE_MAX_AGE_MS) return { ok: false, why: tooOld(Math.floor(age / 1000)) };
  // The monotonic clock may not run while the computer sleeps; the wall clock does.
  const wallAge = x.wallNow - f.sentWall;
  if (wallAge > VALUE_MAX_AGE_MS) return { ok: false, why: tooOld(Math.floor(wallAge / 1000)) };
  const served = servedMs(f.answer);
  if (!inOptionSession(served)) return { ok: false, why: OUTSIDE_SESSION };
  const c = Object.hasOwn(f.answer.contracts, x.occ) ? f.answer.contracts[x.occ] : undefined;
  if (!c) return { ok: false, why: NO_QUOTE };
  const today = quoteToday(c.quote_at, served);
  if (today !== "ok") return { ok: false, why: today === "ahead" ? QUOTE_AHEAD : NO_QUOTE_TODAY };
  // The quote read as the contract pane reads it (contract.ts readQuote), with the one-sided cases told apart.
  const read = readQuote({ kind: "call", strike: 1, bid: c.bid, ask: c.ask, last: null, at: null, iv: null, delta: null, volume: null, bid_size: null, ask_size: null });
  // No ask, or an ask of zero, is no offer: one-sided.
  if (read.state === "no-market") return { ok: false, why: NO_ASK };
  if (read.state === "crossed") return { ok: false, why: CROSSED };
  if (c.bid === null) return { ok: false, why: NO_BID };
  if (read.state === "no-bid") return { ok: false, why: ZERO_BID };
  const bidCents = bidToCents(c.bid);
  const askCents = askToCents(c.ask!);
  // A bid under a cent is a zero bid in whole cents, rounded down.
  if (bidCents <= 0) return { ok: false, why: ZERO_BID };
  if (bidCents > askCents) return { ok: false, why: CROSSED };
  const spreadCents = askCents - bidCents;
  // Whole cents keep the 30% boundary exact: spread / mid > 0.3 is 20 × spread > 3 × (bid + ask).
  if (20 * spreadCents > 3 * (bidCents + askCents)) return { ok: false, why: tooWide(Math.round((spreadCents / ((bidCents + askCents) / 2)) * 100)) };
  return { ok: true, q: { bidCents, askCents, midCents: (bidCents + askCents) / 2, spreadCents, checkedS: Math.floor(age / 1000), sample: f.answer.fixture === true } };
}

/** "$1.20 × $1.25 · spread $0.05 · OPRA · checked 3 s ago"; "sample data" in place of OPRA on the fixture. */
export function quoteLine(q: LiveQuote): string {
  return `${usd(q.bidCents)} × ${usd(q.askCents)} · spread ${usd(q.spreadCents)} · ${q.sample ? "sample data" : "OPRA"} · checked ${q.checkedS} s ago`;
}

// ---- the held contract -----------------------------------------------------------------------------------------------
/** What the journal says of one open lot, as much as is read here. */
export interface HeldLot {
  symbol: string;
  kind: string;
  side: string;
  strike?: number | null;
  expiry?: string | null;
  qty: number;
  /** What a share cost, dollars. */
  entry: number;
}

/** One contract the journal names exactly: its symbol, its parts, the contracts held and what they cost. */
export interface Held {
  occ: string;
  expiry: string;
  strike: number;
  kind: "call" | "put";
  /** Contracts held, over all the trade's lots. */
  qty: number;
  /** Everything the contracts cost, cents (entry × 100 × qty, summed). */
  costCents: number;
  /** The average price a share paid, whole cents (for the −25% stop). */
  paidCents: number;
}

export type HeldRead = { ok: true; held: Held } | { ok: false; why: "no-contract" | "two-contracts" | "bad-lot" | "not-in-chain" | "not-exact-root" };

/**
 * Known limit: the journal names a contract by its name, kind, strike and expiry only. An adjusted contract (after a
 * split or a merger, listed under another root such as AAPL1, delivering something other than 100 shares) and the
 * standard one share all four fields, and so do SPX and SPXW (monthly and weekly roots of one index). Neither can be
 * told apart from the journal's fields. The value is therefore given only when the name is itself the root (letters
 * only), and the contract built from it is listed exactly once in the chain, which leaves adjusted roots out
 * (chain.ts parseOcc). A position in an adjusted contract or under a second root would read as the standard contract
 * if both trade: check the contract in Webull.
 *
 * The one contract a trade's journal lots name, before the chain is asked: every lot long, of the card's kind, with a
 * positive whole quantity and a positive price, and all on the same strike and expiry. "no-contract" when there is
 * no lot (a hand note the journal does not show) or a lot names no strike or expiry; "two-contracts" when the lots
 * name more than one; "bad-lot" when a lot cannot be priced. Never the at-the-money contract in its place.
 */
export function lotsContract(symbol: string, kind: "call" | "put", lots: readonly HeldLot[]): HeldRead {
  if (lots.length === 0) return { ok: false, why: "no-contract" };
  // The OCC root must be the name itself, letter for letter: BRK.B lists as BRKB, which the journal's fields cannot confirm.
  if (!/^[A-Z]{1,6}$/.test(symbol)) return { ok: false, why: "not-exact-root" };
  for (const l of lots) if (typeof l.strike !== "number" || !(l.strike > 0) || typeof l.expiry !== "string" || !l.expiry) return { ok: false, why: "no-contract" };
  const strikes = new Set(lots.map((l) => l.strike));
  const expiries = new Set(lots.map((l) => l.expiry));
  if (strikes.size !== 1 || expiries.size !== 1 || lots.some((l) => l.kind !== kind)) return { ok: false, why: "two-contracts" };
  if (lots.some((l) => l.symbol !== symbol || l.side !== "long" || !Number.isInteger(l.qty) || l.qty <= 0 || !Number.isFinite(l.entry) || l.entry <= 0)) return { ok: false, why: "bad-lot" };
  const strike = lots[0]!.strike!;
  const expiry = lots[0]!.expiry!;
  const occ = occSymbol(symbol, expiry, kind, strike);
  if (!occ) return { ok: false, why: "no-contract" };
  const qty = lots.reduce((n, l) => n + l.qty, 0);
  const costCents = Math.round(lots.reduce((s, l) => s + l.entry * 100 * 100 * l.qty, 0));
  return { ok: true, held: { occ, expiry, strike, kind, qty, costCents, paidCents: Math.round(costCents / 100 / qty) } };
}

/** How many contracts in a chain answer are that kind, strike and expiry: exactly one names a contract. */
export function chainMatches(chain: Pick<ChainResponse, "expiries"> | null | undefined, expiry: string, kind: "call" | "put", strike: number): number {
  let n = 0;
  for (const x of chain?.expiries ?? []) if (x.date === expiry) for (const c of x.contracts) if (c.kind === kind && c.strike === strike) n++;
  return n;
}

/**
 * The held contract once the chain has answered for this name: lotsContract, and the contract listed exactly once in
 * the chain. Zero or two listings: "not-in-chain", no value.
 */
export function heldContract(symbol: string, kind: "call" | "put", lots: readonly HeldLot[], chain: Pick<ChainResponse, "symbol" | "expiries"> | null | undefined): HeldRead {
  const r = lotsContract(symbol, kind, lots);
  if (!r.ok) return r;
  if (!chain || chain.symbol !== symbol || chainMatches(chain, r.held.expiry, kind, r.held.strike) !== 1) return { ok: false, why: "not-in-chain" };
  return r;
}

/** What the held contracts are worth at the bid, and what that makes the trade, fees in. */
export interface HeldValue {
  /** One contract at the bid, and at the mid, cents. */
  valueCents: number;
  midValueCents: number;
  /** One contract's P&L at the bid, round-trip fees in (the owner's own fees), cents. */
  perContractCents: number;
  /** The whole position's P&L at the bid, fees in; null unless the journal is current (its count may be out of date). */
  totalCents: number | null;
  qty: number;
  /** The journal's average price a share paid, whole cents: the entry the stop below is measured from. */
  paidCents: number;
  /** The −25% stop from the average price paid (manage-stop.ts fillStop), cents a share; null when it is too cheap for one. */
  stopCents: number | null;
  /** Bid less that stop, cents a share: at or below zero, the bid is at or under the stop. */
  toStopCents: number | null;
}

/** The held contracts at the bid, with the mid second; the total only while the journal is current. */
export function heldValue(h: Held, q: LiveQuote, journalCurrent: boolean): HeldValue {
  const fees = roundTripCents(OWNER_FEES);
  const total = q.bidCents * 100 * h.qty - h.costCents - fees * h.qty;
  const stop = fillStop({ priceCents: h.paidCents, contracts: h.qty });
  const stopCents = stop.noStop ? null : stop.stopCents;
  return {
    valueCents: q.bidCents * 100,
    midValueCents: Math.round(q.midCents * 100),
    perContractCents: Math.round(total / h.qty),
    totalCents: journalCurrent ? total : null,
    qty: h.qty,
    paidCents: h.paidCents,
    stopCents,
    toStopCents: stopCents === null ? null : q.bidCents - stopCents,
  };
}

const signedUsd = (c: number) => (c > 0 ? `+${usd(c)}` : usd(c));
const stopPct = Math.round(PREMIUM_STOP * 100);

/** The value's lines: what a contract is worth (bid, then mid), its P&L, the total when shown, and the room to the stop. */
export function heldLines(v: HeldValue): { value: string; pnl: string; total: string | null; stop: string | null } {
  return {
    value: `${usd(v.valueCents)} a contract at the bid (${usd(v.midValueCents)} at the mid)`,
    pnl: `${signedUsd(v.perContractCents)} a contract at the bid, fees in`,
    total: v.totalCents === null ? null : `${signedUsd(v.totalCents)} on ${v.qty} contract${v.qty === 1 ? "" : "s"}`,
    stop:
      v.stopCents === null || v.toStopCents === null
        ? null
        : v.toStopCents > 0
          ? `Bid ${usd(v.toStopCents)} above the −${stopPct}% stop ${usd(v.stopCents)}, from your journal average ${usd(v.paidCents)}`
          : `Bid at or under the −${stopPct}% stop ${usd(v.stopCents)}, from your journal average ${usd(v.paidCents)}`,
  };
}

/** Why a value is not shown, as the card says it. */
export const notAvailable = (why: string) => `Live option value not available: ${why}.`;

// ---- the ticket's price check ---------------------------------------------------------------------------------------
export interface TicketCheck {
  /** "Live OPRA quote $1.20 × $1.25 · spread $0.05 · checked 2 s ago". */
  line: string;
  /** A plain warning when the typed price is outside the quote; null inside it. */
  warn: string | null;
  /** Spread × 100 × contracts, plus round-trip fees on them, cents. */
  costCents: number;
  /** That cost as a share of the ticket's planned risk (loss at the stop with fees), or null without one. */
  costShare: number | null;
  costLine: string;
}

/**
 * Beside the typed price: the live quote, a warning when the price is above the ask or below the bid, and what a
 * round trip at this spread costs on the sized contracts. Never an input to the size: the typed price alone sizes.
 */
export function ticketCheck(typedCents: number, contracts: number, riskCents: number, q: LiveQuote): TicketCheck {
  const fees = roundTripCents(OWNER_FEES) * contracts;
  const spread = q.spreadCents * 100 * contracts;
  const costCents = spread + fees;
  const costShare = riskCents > 0 ? costCents / riskCents : null;
  const warn =
    typedCents > q.askCents
      ? `Your price is above the ask (${usd(q.askCents)}).`
      : typedCents < q.bidCents
        ? `Your price is below the bid (${usd(q.bidCents)}).`
        : null;
  return {
    line: `Live ${q.sample ? "quote (sample data)" : "OPRA quote"} ${usd(q.bidCents)} × ${usd(q.askCents)} · spread ${usd(q.spreadCents)} · checked ${q.checkedS} s ago`,
    warn,
    costCents,
    costShare,
    costLine: `A round trip at this spread: ${usd(spread)} spread + ${usd(fees)} fees = ${usd(costCents)} on ${contracts} contract${contracts === 1 ? "" : "s"}${
      costShare === null ? "" : `, ${Math.round(costShare * 100)}% of the ${usd(riskCents)} planned risk`
    }.`,
  };
}
