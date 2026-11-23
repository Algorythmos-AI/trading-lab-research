"use client";

import { useSyncExternalStore } from "react";

/**
 * One timer per interval for the whole page, however many parts read the clock. Every reader of the same interval is
 * told in the same task, so React draws them in one pass. Before this each reader had its own `setInterval`, each at
 * its own phase: seven 1 s clocks and two 250 ms ones redrew the Options page about fifteen times a second.
 *
 * The timer is lined up on the wall clock's boundary (a 1 s clock fires just after each whole second), so a reader
 * whose value is a wall-clock bucket sees it change on the tick, not up to one interval later. It starts with the
 * first reader and stops with the last. The timers are looked up on `globalThis` at each start, so a test's fake timers
 * apply.
 */
interface Ticker {
  listeners: Set<() => void>;
  lead: ReturnType<typeof setTimeout> | null;
  every: ReturnType<typeof setInterval> | null;
}
const tickers = new Map<number, Ticker>();
const subscribers = new Map<number, (onChange: () => void) => () => void>();

function fire(t: Ticker) {
  // A copy: a reader may stop listening while being told.
  for (const fn of [...t.listeners]) fn();
}

function start(ms: number, t: Ticker) {
  const wait = ms - (Date.now() % ms);
  t.lead = globalThis.setTimeout(() => {
    t.lead = null;
    fire(t);
    t.every = globalThis.setInterval(() => fire(t), ms);
  }, wait);
}

function stop(t: Ticker) {
  if (t.lead !== null) globalThis.clearTimeout(t.lead);
  if (t.every !== null) globalThis.clearInterval(t.every);
  t.lead = null;
  t.every = null;
}

/**
 * The shared tick for `ms`, as a `useSyncExternalStore` subscribe function: the same function for the same interval,
 * so a reader never unsubscribes and subscribes again on a render.
 */
export function subscribeEvery(ms: number): (onChange: () => void) => () => void {
  const known = subscribers.get(ms);
  if (known) return known;
  const subscribe = (onChange: () => void) => {
    let t = tickers.get(ms);
    if (!t) {
      t = { listeners: new Set(), lead: null, every: null };
      tickers.set(ms, t);
    }
    t.listeners.add(onChange);
    if (t.lead === null && t.every === null) start(ms, t);
    return () => {
      const cur = tickers.get(ms);
      if (!cur) return;
      cur.listeners.delete(onChange);
      if (cur.listeners.size === 0) {
        stop(cur);
        tickers.delete(ms);
      }
    };
  };
  subscribers.set(ms, subscribe);
  return subscribe;
}

/** For the tests: how many timers run now (one per interval with readers). */
export function runningTickers(): number {
  let n = 0;
  for (const t of tickers.values()) if (t.lead !== null || t.every !== null) n++;
  return n;
}

const off = () => () => undefined;
const nothing = () => null;

/**
 * The current time, re-read every `intervalMs`. Null during server render and hydration, so
 * time-dependent text is only ever produced in the browser (no hydration mismatch). `active` false: no clock at all
 * (null), so a part that only needs the time now and then does not redraw every tick while it does not.
 */
export function useNow(intervalMs = 1000, active = true): number | null {
  const bucket = useSyncExternalStore(
    active ? subscribeEvery(intervalMs) : off,
    active ? () => Math.floor(Date.now() / intervalMs) : nothing,
    nothing,
  );
  return bucket === null ? null : bucket * intervalMs;
}

/**
 * The browser's monotonic clock (`performance.now()`, ms), re-read every `intervalMs`: for measuring how long ago
 * something reached the page. Unlike the wall clock it never steps back when the computer's time is changed, so an
 * old answer cannot be made to look new. Null during server render and hydration.
 */
export function usePerfNow(intervalMs = 1000): number | null {
  const bucket = useSyncExternalStore(
    subscribeEvery(intervalMs),
    // Rounded up, not down: an age measured against this clock may read up to one interval old, never young.
    () => Math.ceil(performance.now() / intervalMs),
    nothing,
  );
  return bucket === null ? null : bucket * intervalMs;
}
