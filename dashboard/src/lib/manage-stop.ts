// After the fill: the option stop to rest in Webull for a trade the owner noted with "I'm in", worked out with the
// trade ticket's own arithmetic (ticket.ts) from the option price and contracts he typed, and how this browser's notes
// stand against the journal's fills for the day's trade count. Pure: no I/O and no clock.
//
// Arithmetic on the owner's own rules, never advice: nothing here places or changes an order. What he types stays in
// this browser.
import type { Lot, Trade } from "./journal";
import { nyClock } from "./options";
import { failWords, nickelStop, readPrice, type Size, sizeTicket, usd } from "./ticket";
import { MAX_PREMIUM, MAX_TRADES_PER_DAY, PREMIUM_STOP, RISK_PER_TRADE } from "./trade-rules";
import { MAX_CONTRACTS, NOTE_MATCH_MS, type ManualNote, noteId, type OptionFill } from "./trade-manage";

// ---- the option fill as typed ---------------------------------------------------------------------------------------
export { MAX_CONTRACTS, type OptionFill, parseFill } from "./trade-manage";

export type ContractsRead = { kind: "empty" } | { kind: "bad"; text: string } | { kind: "ok"; n: number };

/** The contracts as typed: a whole number from 1 to MAX_CONTRACTS, spaces ignored. */
export function readContracts(raw: string | null | undefined): ContractsRead {
  const t = (raw ?? "").replace(/\s+/g, "");
  if (t === "") return { kind: "empty" };
  if (!/^\d+$/.test(t)) return { kind: "bad", text: "Type the contracts as a whole number, like 2." };
  const n = Number(t);
  if (n < 1) return { kind: "bad", text: "At least 1 contract." };
  if (n > MAX_CONTRACTS) return { kind: "bad", text: `That is more than ${MAX_CONTRACTS} contracts: check it.` };
  return { kind: "ok", n };
}

export type FillCheck = { ok: true; fill: OptionFill | null } | { ok: false; field: "opt" | "n"; error: string };

/**
 * The optional option fill on the "I'm in" form: both boxes empty is no fill; one without the other asks for the
 * other. The price is read by the trade ticket's own reader (readPrice), so "1,25" and "$1.25" both read.
 */
export function checkOptionFill(priceRaw: string, contractsRaw: string): FillCheck {
  const p = readPrice(priceRaw);
  const n = readContracts(contractsRaw);
  if (p.kind === "empty" && n.kind === "empty") return { ok: true, fill: null };
  if (p.kind === "bad") return { ok: false, field: "opt", error: p.text };
  if (p.kind === "empty") return { ok: false, field: "opt", error: "Type the option price a share you paid, like 1.25, or clear the contracts." };
  if (n.kind === "bad") return { ok: false, field: "n", error: n.text };
  if (n.kind === "empty") return { ok: false, field: "n", error: "Type how many contracts you bought." };
  return { ok: true, fill: { priceCents: p.cents, contracts: n.n } };
}

/**
 * The ticket's typed price as the form's prefill: the price only. The contracts stay empty, so he types what he
 * actually bought rather than what the ticket sized.
 */
export function prefillFrom(typed: string | null | undefined): { price: string; contracts: string } | null {
  const p = readPrice(typed);
  if (p.kind !== "ok") return null;
  return { price: (p.cents / 100).toFixed(2), contracts: "" };
}

// ---- the stop to place ----------------------------------------------------------------------------------------------
export interface FillStop {
  fill: OptionFill;
  /** The ticket's sizing at the typed price (its stop, tick and one contract's figures). */
  size: Size;
  /** The stop to place, cents a share: sizeTicket's own. */
  stopCents: number;
  tick: 1 | 5;
  /** The stop if the contract steps $0.05, for his contracts (ticket's nickelStop); null when they agree. */
  nickel: { stopCents: number; riskCents: number } | null;
  /** Premium paid for his contracts, cents. */
  premiumCents: number;
  /** Lost if filled at the stop, for his contracts, round-trip fees in, cents. */
  lossCents: number;
  /** His fill measured against rule 4, one plain line per limit it is over, with the numbers. */
  breaks: string[];
  /**
   * So cheap ($0.01 to $0.03) that −25% rounds up to the price itself: there is no stop under it. Only `noStopLine`
   * is shown then: no stop, no loss, no tick and no room.
   */
  noStop: string | null;
}

const stopPct = Math.round(PREMIUM_STOP * 100);

/** The stop for a typed fill, from the ticket's arithmetic (sizeTicket, nickelStop), for the contracts he bought. */
export function fillStop(fill: OptionFill): FillStop {
  const size = sizeTicket(fill.priceCents);
  const n = fill.contracts;
  const premiumCents = n * size.perContract.premium;
  const lossCents = n * size.perContract.risk;
  const breaks: string[] = [];
  const noStop = size.fails.includes("stop") ? (failWords(size).find((w) => w.startsWith("Too cheap")) ?? "Too cheap to place a stop under it.") : null;
  if (premiumCents > MAX_PREMIUM * 100)
    breaks.push(`${n} × ${usd(fill.priceCents)} a share is ${usd(premiumCents)} of premium, over your ${usd(MAX_PREMIUM * 100)} cap (rule 4).`);
  if (lossCents > RISK_PER_TRADE * 100)
    breaks.push(`At the stop this loses ${usd(lossCents)} with fees, over your ${usd(RISK_PER_TRADE * 100)} a trade (rule 4).`);
  return { fill, size, stopCents: size.stopCents, tick: size.tick, nickel: nickelStop({ ...size, contracts: n }), premiumCents, lossCents, breaks, noStop };
}

/** "−25% from your $1.24 fill, rounded up". */
export const stopFromLine = (f: FillStop) => `−${stopPct}% from your ${usd(f.fill.priceCents)} fill, rounded up`;
export const tickLine = (f: FillStop) => `On a $${(f.tick / 100).toFixed(2)} tick: check the tick in Webull.`;
export const nickelLine = (f: FillStop) => (f.nickel ? `If it steps $0.05: stop ${usd(f.nickel.stopCents)}, −${usd(f.nickel.riskCents)} there with fees.` : null);
export const lossLine = (f: FillStop) => `Lost if filled at the stop, with fees: −${usd(f.lossCents)} on ${f.fill.contracts} contract${f.fill.contracts === 1 ? "" : "s"}`;
export const INVITE_LINE = "Add your option fill to see the stop to place in Webull.";
export const STOP_PLACED = "Stop placed in Webull";
export const STOP_REMINDER = "Not ticked yet. Your rule 5: place the stop in Webull once filled.";
export const STOP_OWN_TICK = "Marked placed by you; this page cannot see Webull.";

// ---- notes against the journal --------------------------------------------------------------------------------------
/** One entry in the journal: a buy fill of a long option, as both a closed piece and an open lot may show it. */
interface Entry {
  key: string;
  symbol: string;
  side: "call" | "put";
  at: number;
  day: string;
}

/**
 * Today's buy fills of long options in the journal, one per fill: the pieces of a fill sold in parts, and the lot left
 * open from it, share its contract and opening time and are one entry. A lot with no opening time is no entry (the
 * day check does not count it either).
 */
function entries(trades: readonly Trade[], lots: readonly Lot[], session: string): Entry[] {
  const out = new Map<string, Entry>();
  for (const x of [...trades, ...lots] as { symbol: string; kind: string; side: string; strike?: number | null; expiry?: string | null; opened_at?: string | null }[]) {
    if (x.side !== "long" || (x.kind !== "call" && x.kind !== "put") || !x.opened_at) continue;
    const at = Date.parse(x.opened_at);
    const day = Number.isFinite(at) ? nyClock(x.opened_at)?.day : undefined;
    if (!day || day !== session) continue;
    const key = `${x.symbol}|${x.kind}|${x.strike ?? ""}|${x.expiry ?? ""}|${at}`;
    if (!out.has(key)) out.set(key, { key, symbol: x.symbol, side: x.kind, at, day });
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}

/** "QQQ|call|750|2026-10-16": the contract part of an entry key (its opening time dropped). */
export const contractOf = (entryKey: string) => entryKey.split("|").slice(0, 4).join("|");
const lotContract = (l: Lot) => `${l.symbol}|${l.kind}|${l.strike ?? ""}|${l.expiry ?? ""}`;

/** The journal's open positions, one per contract held (any name, any day, a lot held overnight too). */
export function openPositions(lots: readonly Lot[]): string[] {
  return [...new Set(lots.filter((l) => l.qty !== 0).map(lotContract))];
}

/**
 * Open positions other than this note's own: every contract the journal holds, less the one of the fill matched to the
 * note (if any). Its loss is not priced here, so a room worked out beside it would be too generous.
 */
export function otherOpenPositions(lots: readonly Lot[], matchedEntry: string | null | undefined): number {
  const mine = matchedEntry ? contractOf(matchedEntry) : null;
  return openPositions(lots).filter((c) => c !== mine).length;
}

export interface NoteMatch {
  /** Each matched note's id and the journal entry it took. */
  matched: Map<string, string>;
  /** Today's notes the journal shows no fill for yet. */
  provisional: ManualNote[];
}

/**
 * Which of this browser's notes the journal already shows. A note matches a journal buy fill of a long option on the
 * same name and side (call or put), on the same New York day (the session's), opened at or after the note's time less
 * NOTE_MATCH_MS (the note's time is the end of its typed minute). Each fill matches one note at most and each note one
 * fill: the notes in time order, each taking the earliest fill left that it may (no note can then take a fill another
 * needed). A note from another day never counts and never matches.
 *
 * The allowance is kept because he taps "I'm in" after the fill, so a fill just before the note is the normal case.
 * Known narrow case: an un-noted fill on the same name and side inside that window (or any later one) can be taken for
 * the noted fill, and the noted one, once it reaches the journal, is then counted there and not as a note.
 */
export function matchNotes(notes: readonly ManualNote[], trades: readonly Trade[], lots: readonly Lot[], session: string): NoteMatch {
  const es = entries(trades, lots, session);
  const taken = new Set<string>();
  const matched = new Map<string, string>();
  const provisional: ManualNote[] = [];
  const today = notes.filter((n) => Number.isFinite(Date.parse(n.at)) && nyClock(n.at)?.day === session).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const n of today) {
    const from = Date.parse(n.at) - NOTE_MATCH_MS;
    const e = es.find((x) => !taken.has(x.key) && x.symbol === n.symbol && x.side === n.side && x.at >= from);
    if (e) {
      taken.add(e.key);
      matched.set(noteId(n), e.key);
    } else provisional.push(n);
  }
  return { matched, provisional };
}

export interface TradeCount {
  /** Journal entries and this browser's notes not yet in it. */
  total: number;
  provisional: number;
  /** The count with the notes reaches the day's cap. */
  usedUp: boolean;
  /** "1 not yet in the journal", or null with none. */
  note: string | null;
  /** The plain line once the cap is reached by the count with the notes; null otherwise. */
  usedUpLine: string | null;
}

/**
 * The day's trade count with this browser's notes that the journal does not show yet: never fewer than the journal's
 * own count, so a note can only make the count more cautious.
 */
export function tradeCount(used: number, provisional: number): TradeCount {
  const u = Math.max(0, Math.floor(used));
  const p = Math.max(0, Math.floor(provisional));
  const total = u + p;
  const usedUp = total >= MAX_TRADES_PER_DAY;
  return {
    total,
    provisional: p,
    usedUp,
    note: p > 0 ? `${p} not yet in the journal` : null,
    usedUpLine: usedUp && p > 0 ? `${total} of ${MAX_TRADES_PER_DAY} by your own count: your ${MAX_TRADES_PER_DAY}-trade rule is used up for today.` : null,
  };
}
