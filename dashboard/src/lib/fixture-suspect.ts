// The `quotes-suspect` fixture variant (fixture-variants.ts): fixture quotes bent so each trips the board's bad-data
// guards (quote-guards.ts) in turn, for the unit and component tests and, in fixture mode, the page. The guards' switches
// are all off in fixture mode (desk-guards-run.ts never reads the store there), so on the page the board reads exactly
// as with the plain fixture: the variant shows the guards' switches-off behaviour; a test passes switches to see them on.
// Pure: no I/O.
import { GUARD_REASONS, type GuardReason, type SnapshotQuoteFields } from "./quote-guards";

type Q = { price: number; open: number | null; high: number | null; low: number | null; prev_close: number | null } & SnapshotQuoteFields;

const c2 = (v: number) => Math.round(v * 100) / 100;

/**
 * `q` as a snapshot the guards can read (both bars readable, a normal one-cent quote on each side), then bent so that
 * `reason` applies. A high below the low also puts the open outside the range (no open is inside a range whose high is
 * below its low), so that one trips both bar guards; each other one trips its guard alone.
 */
export function suspectQuote<T extends Q>(q: T, reason: GuardReason): T {
  const low = q.low ?? q.price;
  const high = q.high ?? q.price;
  const base: T = { ...q, open: q.open ?? q.price, high, low, prev_close: q.prev_close ?? q.price, bar_ok: true, prev_bar_ok: true, bid: c2(q.price - 0.01), ask: c2(q.price + 0.01), bid_size: 100, ask_size: 100 };
  switch (reason) {
    case "bar-high-below-low":
      return { ...base, high: c2(low - 0.5) };
    case "bar-open-outside-range":
      return { ...base, open: c2(high + 0.5) };
    case "price-far-from-prior-close":
      return { ...base, prev_close: c2(q.price / 1.3) };
    case "quote-crossed":
      return { ...base, bid: c2(q.price + 0.02), ask: c2(q.price - 0.02) };
  }
}

/** The reason the i-th name (in the order asked) is bent for: each guard in turn. */
export const suspectReasonFor = (i: number): GuardReason => GUARD_REASONS[((i % GUARD_REASONS.length) + GUARD_REASONS.length) % GUARD_REASONS.length]!;
