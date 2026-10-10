// Fixture variants: the synthetic fixtures bent into the states a pane must survive (nothing published, storage
// down, a sparse edition, a corrupt one, the live feed off or failing). They exist only in fixture mode
// (DASHBOARD_FIXTURE=1, refused in production) and are chosen per request by the `fx` cookie, so the browser tests
// can put any page into any state. Pure: no I/O.
import type { OptionsEdition } from "./options.types";

export const VARIANT_COOKIE = "fx";

/**
 * - `empty`: no options edition has published yet.
 * - `error`: storage could not be read.
 * - `partial`: a valid but sparse edition (names without IV, ATR, zones, bars or a last bar; no paper record).
 * - `poison`: a stored edition that no longer matches its schema, as after corruption. One pane must fail alone.
 * - `quotes-off`: the live feed has no keys. `quotes-error`: Alpaca is failing.
 * - `quotes-tick`: the live price flips by one cent every three seconds, without changing any name's state.
 */
export const VARIANT_FLAGS = ["empty", "error", "partial", "poison", "quotes-off", "quotes-error", "quotes-tick"] as const;
export type VariantFlag = (typeof VARIANT_FLAGS)[number];

const KNOWN = new Set<string>(VARIANT_FLAGS);

/** The flags in a cookie value such as `partial.quotes-tick`. Unknown words are ignored. */
export function parseFlags(raw: string | null | undefined): Set<VariantFlag> {
  const out = new Set<VariantFlag>();
  for (const word of (raw ?? "").split(".")) if (KNOWN.has(word)) out.add(word as VariantFlag);
  return out;
}

/** The flags from a request's `Cookie` header. */
export function flagsFromCookieHeader(header: string | null | undefined): Set<VariantFlag> {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === VARIANT_COOKIE) return parseFlags(part.slice(eq + 1).trim());
  }
  return new Set();
}

/**
 * A sparse edition that still passes the schema: every optional thing is missing on some name. The page must show
 * a dash where a number is absent, never a zero or NaN, and every other name must be unaffected.
 */
export function partialOptions(e: OptionsEdition): OptionsEdition {
  const out = structuredClone(e);
  const t = out.tickers;
  if (t[0]) t[0].expected_move = null;
  if (t[1]) t[1].atr14 = null;
  if (t[2]) {
    t[2].zones = [];
    t[2].levels = [];
  }
  if (t[3]) {
    t[3].bars = [];
    t[3].close_strength = null;
  }
  if (t[4]) t[4].last = null;
  if (t[5]) {
    t[5].expected_move = null;
    t[5].atr14 = null;
    t[5].zones = [];
    t[5].levels = [];
    t[5].bars = [];
    t[5].close_strength = null;
  }
  if (out.rules?.[0]) {
    out.rules[0].backtest = null;
    out.rules[0].live = null;
  }
  out.paper = [];
  out.expected_move_check = null;
  return out;
}

/** An edition whose paper record holds a null row, which the schema forbids and the scorecard cannot draw. */
export function poisonedOptions(e: OptionsEdition): OptionsEdition {
  const out = structuredClone(e);
  out.paper = [null] as unknown as OptionsEdition["paper"];
  return out;
}

/** How far above its close, in ATRs, every fixture quote sits. */
export const FIXTURE_OFFSET_ATR = 0.3;

/** How long the `quotes-tick` price holds before it flips, in seconds. */
export const TICK_HOLD_S = 3;

/**
 * The `quotes-tick` price for a given second: the plain fixture price, one cent higher in every other three-second
 * block. One cent on purpose: several fixture names sit a few cents from a state boundary, and a test holds that
 * no name changes state, so in the browser a row never has a reason to move. Three seconds on purpose: the page
 * polls every two, so a flip every second or every two could land on the same side at every poll and never show.
 */
export function tickPrice(base: number, second: number): number {
  const up = Math.floor(Math.abs(second) / TICK_HOLD_S) % 2 === 1;
  return Math.round((base + (up ? 0.01 : 0)) * 100) / 100;
}
