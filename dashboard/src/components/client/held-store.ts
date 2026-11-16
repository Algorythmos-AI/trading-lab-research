"use client";

// The held contracts' live values, shared from each manage card (which polls its contract's quote) with the board
// (the card's word, the notices, the hero) and the status rail (the day pill). And the −25% premium stop per contract:
// its count of quotes under the stop, and once fired, when, latched for the session in this browser, so a reload, a
// pause or the card changing hands (a journal card that a "Set my fill" note takes over) never takes the EXIT back.
// A later trade in the same contract, filled after the stop fired, starts clean. The count and the latch belong to the
// trade's stop (its contract and its −25% level), so two cards on one contract at two prices never share a run or an
// EXIT; a fire at one stop stands for every card whose own stop is at or above it (the bid was at or under both).
// Read only: nothing here places an order or leaves this browser.
import { useSyncExternalStore } from "react";
import { NO_STOP, type PremiumStop, premiumStep } from "@/lib/held-marks";
import type { HeldValue } from "@/lib/option-value";
import { NOTE_MATCH_MS } from "@/lib/trade-manage";

/** One upstream quote that stays the same is counted again after this long: a quote under the stop that does not move is still under it. */
export const SAME_QUOTE_RECOUNT_MS = 10_000;

const LATCH_PREFIX = "held-stop:";
const latchKey = (day: string) => `${LATCH_PREFIX}${day}`;

/** A card's last fresh value (null while its quote is withheld), and whether its lot is a note's own. */
interface Value {
  value: HeldValue | null;
  fromNote: boolean;
  /** The card's latest quote is too thin to read the stop (held-marks.ts readThinQuote): the card says CHECK. */
  thin?: boolean;
}

/** One trade's stop (contract and stop level, for the day): the last upstream quote counted, the count, and when it fired. */
interface Count {
  key: string | null;
  /** When the key was last counted, ms (this browser's clock). */
  keyAt: number;
  stop: PremiumStop;
  firedAt: number | null;
}

/** The stop's own key: its day, contract and level ("none" for an entry too cheap for a stop). */
const countKey = (day: string, occ: string, stopCents: number | null) => `${day}|${occ}|${stopCents ?? "none"}`;
/** A latch entry: the contract and the stop level it fired at. A bare contract (written before levels were kept) stands for every level. */
const latchEntry = (occ: string, stopCents: number) => `${occ}@${stopCents}`;
function parseLatch(k: string): { occ: string; stopCents: number | null } {
  const i = k.lastIndexOf("@");
  if (i < 0) return { occ: k, stopCents: null };
  const n = Number(k.slice(i + 1));
  return Number.isInteger(n) ? { occ: k.slice(0, i), stopCents: n } : { occ: k, stopCents: null };
}

const values = new Map<string, Value>();
const counts = new Map<string, Count>();
/** Used only when the browser's storage is off or throws: the latch then lasts as long as the page. */
const fallback = new Map<string, Record<string, number>>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const l of listeners) l();
}

/** The day's fired stops: contract (OCC) to when it fired, ms. */
function readLatched(day: string): Record<string, number> {
  const out: Record<string, number> = { ...(fallback.get(day) ?? {}) };
  try {
    const raw = window.localStorage.getItem(latchKey(day));
    const v: unknown = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v))
      for (const [k, t] of Object.entries(v as Record<string, unknown>)) if (typeof t === "number" && Number.isFinite(t)) out[k] = t;
  } catch {
    // storage off: the page's own memory only
  }
  return out;
}

/** Keep a fired stop for the day, and drop every other day's: a latch never outlives its session. */
function writeLatched(day: string, entry: string, at: number) {
  const all = { ...readLatched(day), [entry]: at };
  try {
    const ls = window.localStorage;
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k && k.startsWith(LATCH_PREFIX) && k !== latchKey(day)) ls.removeItem(k);
    }
    ls.setItem(latchKey(day), JSON.stringify(all));
  } catch {
    fallback.set(day, all);
  }
  for (const k of [...fallback.keys()]) if (k !== day) fallback.delete(k);
}

/**
 * When a stop on this contract fired today that stands for a trade filled at `entryAt` (ms) with its stop at
 * `stopCents`, or null. It stands when it fired at or under this trade's own level, and not before its fill (one fired
 * before the fill was another trade's), allowing NOTE_MATCH_MS: the desk's own window for a note and a journal fill to
 * be one trade, since the note's minute and the journal's second can put the fill after a quick fire. `stopCents` undefined: any level; null: the trade has no stop, so none fired.
 */
function firedFor(day: string, occ: string, entryAt: number, stopCents: number | null | undefined): number | null {
  if (stopCents === null) return null;
  // A fire at a level stands for a stop at or above it (the bid was at or under both), and for one a little under it:
  // the same trade's stop worked from the note's typed fill and from the journal's average can differ by a cent or
  // two, and the card changing hands must never take the EXIT back. Two trades whose stops are that close share a fire,
  // which errs to EXIT.
  const slack = stopCents === undefined ? 0 : Math.max(5, Math.round(stopCents * 0.05));
  const stands = (level: number | null, at: number) =>
    (level === null || stopCents === undefined || level <= stopCents + slack) && !(Number.isFinite(entryAt) && entryAt > at + NOTE_MATCH_MS);
  let best: number | null = null;
  const take = (at: number) => {
    if (best === null || at < best) best = at;
  };
  const prefix = `${day}|${occ}|`;
  for (const [k, c] of counts) {
    if (!k.startsWith(prefix) || c.firedAt === null) continue;
    const level = Number(k.slice(prefix.length));
    if (stands(Number.isInteger(level) ? level : null, c.firedAt)) take(c.firedAt);
  }
  for (const [k, at] of Object.entries(readLatched(day))) {
    const e = parseLatch(k);
    if (e.occ === occ && stands(e.stopCents, at)) take(at);
  }
  return best;
}

const sameValue = (a: HeldValue, b: HeldValue) =>
  a.valueCents === b.valueCents && a.perContractCents === b.perContractCents && a.qty === b.qty && a.stopCents === b.stopCents && a.toStopCents === b.toStopCents;

export interface HeldRecord {
  day: string;
  /** The card (ManageView.id): its value counts in the day pill while the card is shown. */
  id: string;
  /** The contract (OCC symbol): the stop is the position's, whatever card shows it. */
  occ: string;
  /** The trade's fill time, ms (NaN when unknown). */
  entryAt: number;
  value: HeldValue;
  /** The upstream quote this value came from: one quote, however many polls return it from the cache, counts once. */
  key: string;
  fromNote: boolean;
}

/** One upstream quote read against a trade's stop: its contract, fill, stop level, and the bid's distance to it. */
export interface StopQuote {
  day: string;
  occ: string;
  entryAt: number;
  stopCents: number | null;
  /** The bid less the stop, cents (at or under zero: at or under the stop); null with no stop. */
  toStopCents: number | null;
  key: string;
}

/** Counts one upstream quote against the trade's stop; true when anything changed. */
function stepStop(r: StopQuote): boolean {
  const ck = countKey(r.day, r.occ, r.stopCents);
  const fired = firedFor(r.day, r.occ, r.entryAt, r.stopCents);
  const prev = counts.get(ck);
  // Fired for this trade (here, or latched before a reload): fired. Fired only for an earlier trade in this contract:
  // this one starts clean. The same object is kept while nothing changes, so a render never counts as a change.
  let base: Count;
  if (fired !== null) base = prev && prev.stop.hit && prev.firedAt === fired ? prev : { key: prev?.key ?? null, keyAt: prev?.keyAt ?? 0, stop: { under: 0, hit: true }, firedAt: fired };
  else base = prev && !prev.stop.hit ? prev : { key: prev?.key ?? null, keyAt: prev?.keyAt ?? 0, stop: NO_STOP, firedAt: null };
  const now = Date.now();
  if (base.key !== r.key || now - base.keyAt >= SAME_QUOTE_RECOUNT_MS) {
    const stop = premiumStep(base.stop, r.toStopCents);
    // Never before the trade's own fill: a browser clock running slow must not make the stop look like an earlier trade's.
    const firedAt = stop.hit && !base.stop.hit ? Math.max(Date.now(), Number.isFinite(r.entryAt) ? r.entryAt : 0) : base.firedAt;
    if (firedAt !== null && base.firedAt === null && r.stopCents !== null) writeLatched(r.day, latchEntry(r.occ, r.stopCents), firedAt);
    counts.set(ck, { key: r.key, keyAt: now, stop, firedAt });
    return true;
  }
  if (base !== prev) {
    counts.set(ck, base);
    return true;
  }
  return false;
}

/** One fresh value: the card's for the day pill, and the trade's stop counted once per upstream quote. */
export function recordValue(r: HeldRecord) {
  let dirty = false;
  const was = values.get(r.id);
  if (!was || was.value === null || !sameValue(was.value, r.value) || was.fromNote !== r.fromNote || was.thin) {
    values.set(r.id, { value: r.value, fromNote: r.fromNote });
    dirty = true;
  }
  if (stepStop({ day: r.day, occ: r.occ, entryAt: r.entryAt, stopCents: r.value.stopCents, toStopCents: r.value.toStopCents, key: r.key })) dirty = true;
  if (dirty) changed();
}

/**
 * A fresh quote too one-sided or too wide to value the position (no value for the day pill) that still says which side
 * of the stop the option is on (held-marks.ts readThinQuote: "under" or "above"): it counts as a valued quote would.
 */
export function recordStopOnly(id: string, fromNote: boolean, r: StopQuote) {
  let dirty = false;
  const was = values.get(id);
  if (!was || was.value !== null || was.thin) {
    values.set(id, { value: null, fromNote, thin: false });
    dirty = true;
  }
  if (stepStop(r)) dirty = true;
  if (dirty) changed();
}

/** A fresh quote too thin to say which side of the stop the option is on: no value, the card says CHECK, the count is kept. */
export function recordThin(id: string, fromNote: boolean) {
  const was = values.get(id);
  if (was && was.value === null && was.thin) return;
  values.set(id, { value: null, fromNote, thin: true });
  changed();
}

/**
 * The card's quote is withheld for its age, session or day (or the chain is not read): no value; the count kept as it
 * is, and a thin CHECK kept too (less to go on never makes the card more reassuring). Only a quote that reads the stop
 * clears it, or the card going.
 */
export function recordWithheld(id: string) {
  const was = values.get(id);
  if (!was || was.value === null) return;
  values.set(id, { ...was, value: null });
  changed();
}

/** The card is gone (the trade closed, or another card shows it): its value no longer counts; a fired stop stays. */
export function forgetValue(id: string) {
  if (!values.delete(id)) return;
  changed();
}

/**
 * Whether a −25% stop on the contract has fired today that stands for a trade filled at `entryAt` (ms) with its stop
 * at `stopCents` (undefined: at any level).
 */
export function stopFired(day: string | null, occ: string | null, entryAt: number, stopCents?: number | null): boolean {
  if (day === null || occ === null) return false;
  return firedFor(day, occ, entryAt, stopCents) !== null;
}

/** The card's last fresh value, or null. */
export function valueOf(id: string): HeldValue | null {
  return values.get(id)?.value ?? null;
}

/** Whether the card's latest quote is too thin to read its stop. */
export function thinOf(id: string): boolean {
  return values.get(id)?.thin === true;
}

/** Whether the card's value comes from the note's own lot (not yet the journal's). */
export function fromNoteOf(id: string): boolean {
  return values.get(id)?.fromNote === true;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Re-renders on every change of the shared values; the number itself means nothing. */
export function useHeldVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

/** For tests: start empty, as a reload does (the browser's storage is kept). */
export function resetHeldStore() {
  values.clear();
  counts.clear();
  fallback.clear();
  version = 0;
}
