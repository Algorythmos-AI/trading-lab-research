"use client";

// The held contracts' live values, shared from each manage card (which polls its contract's quote) with the board
// (the card's word, the notices, the hero) and the status rail (the day pill). And the −25% premium stop per contract:
// its count of quotes under the stop, and once fired, when, latched for the session in this browser, so a reload, a
// pause or the card changing hands (a journal card that a "Set my fill" note takes over) never takes the EXIT back.
// A later trade in the same contract, filled after the stop fired, starts clean.
// Read only: nothing here places an order or leaves this browser.
import { useSyncExternalStore } from "react";
import { NO_STOP, type PremiumStop, premiumStep } from "@/lib/held-marks";
import type { HeldValue } from "@/lib/option-value";

const LATCH_PREFIX = "held-stop:";
const latchKey = (day: string) => `${LATCH_PREFIX}${day}`;

/** A card's last fresh value (null while its quote is withheld), and whether its lot is a note's own. */
interface Value {
  value: HeldValue | null;
  fromNote: boolean;
}

/** One contract's stop: the last upstream quote counted, the count, and when it fired. */
interface Count {
  key: string | null;
  stop: PremiumStop;
  firedAt: number | null;
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
function writeLatched(day: string, occ: string, at: number) {
  const all = { ...readLatched(day), [occ]: at };
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

/** When the contract's stop fired today for a trade filled at `entryAt` (ms), or null: one fired before the fill was another trade's. */
function firedFor(day: string, occ: string, entryAt: number): number | null {
  const at = counts.get(occ)?.firedAt ?? readLatched(day)[occ] ?? null;
  if (at === null) return null;
  return Number.isFinite(entryAt) && entryAt > at ? null : at;
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

/** One fresh value: the card's for the day pill, and the contract's stop counted once per upstream quote. */
export function recordValue(r: HeldRecord) {
  let dirty = false;
  const was = values.get(r.id);
  if (!was || was.value === null || !sameValue(was.value, r.value) || was.fromNote !== r.fromNote) {
    values.set(r.id, { value: r.value, fromNote: r.fromNote });
    dirty = true;
  }
  const fired = firedFor(r.day, r.occ, r.entryAt);
  const prev = counts.get(r.occ);
  // Fired for this trade (here, or latched before a reload): fired. Fired only for an earlier trade in this contract:
  // this one starts clean. The same object is kept while nothing changes, so a render never counts as a change.
  let base: Count;
  if (fired !== null) base = prev && prev.stop.hit && prev.firedAt === fired ? prev : { key: prev?.key ?? null, stop: { under: 0, hit: true }, firedAt: fired };
  else base = prev && !prev.stop.hit ? prev : { key: prev?.key ?? null, stop: NO_STOP, firedAt: null };
  if (base.key !== r.key) {
    const stop = premiumStep(base.stop, r.value.toStopCents);
    // Never before the trade's own fill: a browser clock running slow must not make the stop look like an earlier trade's.
    const firedAt = stop.hit && !base.stop.hit ? Math.max(Date.now(), Number.isFinite(r.entryAt) ? r.entryAt : 0) : base.firedAt;
    if (firedAt !== null && base.firedAt === null) writeLatched(r.day, r.occ, firedAt);
    counts.set(r.occ, { key: r.key, stop, firedAt });
    dirty = true;
  } else if (base !== prev) {
    counts.set(r.occ, base);
    dirty = true;
  }
  if (dirty) changed();
}

/** The card's quote is withheld (old, wide, one-sided): no value; the contract's count kept as it is. */
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

/** Whether the contract's −25% stop has fired today for a trade filled at `entryAt` (ms). */
export function stopFired(day: string | null, occ: string | null, entryAt: number): boolean {
  if (day === null || occ === null) return false;
  return firedFor(day, occ, entryAt) !== null;
}

/** The card's last fresh value, or null. */
export function valueOf(id: string): HeldValue | null {
  return values.get(id)?.value ?? null;
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
