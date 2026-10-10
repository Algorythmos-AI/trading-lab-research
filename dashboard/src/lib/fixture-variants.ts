// Fixture variants: the synthetic fixtures bent into the states a pane must survive (nothing published, storage
// down, a sparse edition, a corrupt one, the live feed off or failing). They exist only in fixture mode
// (DASHBOARD_FIXTURE=1, refused in production) and are chosen per request by the `fx` cookie, so the browser tests
// can put any page into any state. Pure: no I/O.
import type { OptionsLive } from "./options-live.types";
import type { OptionsEdition } from "./options.types";

export const VARIANT_COOKIE = "fx";

/**
 * - `empty`: no options edition has published yet.
 * - `error`: storage could not be read.
 * - `partial`: a valid but sparse edition (names without IV, ATR, zones, bars or a last bar; no paper record).
 * - `poison`: a stored edition that no longer matches its schema, as after corruption. One pane must fail alone.
 * - `quotes-off`: the live feed has no keys. `quotes-error`: Alpaca is failing.
 * - `quotes-tick`: the live price flips by one cent every three seconds, without changing any name's state.
 * - `chain-off`: the option feed has no keys. `chain-error`: Alpaca is failing.
 * - `chain-thin`: the nearest expiry's first calls come without a volatility, without a market, and crossed.
 * - `v2`: the edition in its second format, with the day's context, events and each name's volatility block.
 * - `positions-off`: no options live document has been published. `positions-none`: one has, with nothing open.
 * - `positions-old`: the document is three hours old.
 */
export const VARIANT_FLAGS = [
  "empty",
  "error",
  "partial",
  "poison",
  "quotes-off",
  "quotes-error",
  "quotes-tick",
  "chain-off",
  "chain-error",
  "chain-thin",
  "v2",
  "positions-off",
  "positions-none",
  "positions-old",
] as const;
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

const DAY = 86_400_000;
const plus = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * The same edition in its second format: the day's context, scheduled events around the session, and a volatility
 * block on each name. Synthetic, like the rest of the fixture. Some of it is left out or
 * left partly empty on purpose, since every part of the second format is optional and the page must say so with a
 * dash, not a zero.
 */
export function v2Options(e: OptionsEdition): OptionsEdition {
  const out = structuredClone(e);
  out.schema_version = 2;
  out.market = { vix: { close: 16.24, change: 0.82, pct_52w: 0.34 }, session: { half_day: false }, calendar: "complete" };
  const [a, b, c] = out.tickers.map((t) => t.symbol);
  out.events = [
    { date: plus(e.session, 2), time_et: "14:00", kind: "macro", type: "fomc_decision", severity: "high" },
    { date: e.session, time_et: "14:00", kind: "macro", type: "fomc_minutes", severity: "medium" },
    // Written the way another calendar might: one digit for the hour, seconds, capitals.
    { date: e.session, time_et: "8:30:00", kind: "macro", type: "CPI", severity: "high" },
    // A code this build has no name for, with no time: never drawn as written, and after the timed ones.
    { date: e.session, time_et: null, kind: "macro", type: "fed_holds_rates_powell_turns_hawkish", severity: null },
    // The same release listed twice must not trip the page.
    { date: e.session, time_et: null, kind: "macro", type: "fed_holds_rates_powell_turns_hawkish", severity: null },
    ...(b ? [{ date: plus(e.session, 3), time_et: null, kind: "earnings" as const, type: "earnings", symbol: b, when: "amc" as const }] : []),
    ...(a ? [{ date: plus(e.session, 1), time_et: null, kind: "earnings" as const, type: "earnings", symbol: a, when: "bmo" as const }] : []),
    // Outside the week, and for a name the edition does not carry: neither belongs on the page.
    ...(c ? [{ date: plus(e.session, 30), time_et: null, kind: "earnings" as const, type: "earnings", symbol: c, when: "amc" as const }] : []),
    { date: e.session, time_et: null, kind: "earnings", type: "earnings", symbol: "ZZZZ", when: "amc" },
    { date: plus(e.session, -3), time_et: "08:30", kind: "macro", type: "nfp", severity: "high" },
  ];
  out.tickers.forEach((t, i) => {
    const iv = t.expected_move?.annual_iv ?? null;
    // One name with no block at all, one with a block of blanks, the rest filled in.
    if (i === 3) return;
    if (i === 4) {
      t.vol = { iv30: null, iv_change_1d: null, iv_pct_13w: null, iv_pct_26w: null, hv30: null, opt_volume: null, opt_volume_avg20: null };
      return;
    }
    t.vol = {
      iv30: iv,
      iv_change_1d: iv === null ? null : Math.round((i % 2 === 0 ? 0.012 : -0.008) * 1000) / 1000,
      iv_pct_13w: Math.min(1, (t.expected_move?.iv_pct_52w ?? 0.3) + 0.14),
      iv_pct_26w: Math.min(1, (t.expected_move?.iv_pct_52w ?? 0.3) + 0.05),
      hv30: iv === null ? null : Math.round((iv / (i % 3 === 0 ? 1.32 : 0.9)) * 10000) / 10000,
      opt_volume: 120_000 + i * 15_000,
      opt_volume_avg20: i === 5 ? 0 : 100_000,
    };
  });
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

/** An OCC option symbol: root, yymmdd, C or P, strike in thousandths. */
export function occSymbol(root: string, expiry: string, kind: "call" | "put", strike: number): string {
  return `${root}${expiry.slice(2).replace(/-/g, "")}${kind === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

/**
 * A synthetic options live document: three open paper option positions (two on the desk's names, one on a name
 * the desk does not carry) and a little open interest. Dated from `now`, so its contracts have not expired and
 * its age is what a healthy feed's would be, whenever the tests run.
 */
export function fixtureOptionsLive(e: OptionsEdition, now: Date, flags: ReadonlySet<VariantFlag> = new Set()): OptionsLive {
  // The first Friday at least a week out.
  let day = now.getTime() + 7 * DAY;
  while (new Date(day).getUTCDay() !== 5) day += DAY;
  const expiry = new Date(day).toISOString().slice(0, 10);
  const asOf = new Date(now.getTime() - (flags.has("positions-old") ? 180 : 2) * 60_000);
  const strikeNear = (symbol: string, step: number) => {
    const close = e.tickers.find((t) => t.symbol === symbol)?.last?.close ?? 100;
    return Math.round(close / step) * step;
  };
  const spy = strikeNear("SPY", 5);
  const nvda = strikeNear("NVDA", 5);
  const positions: OptionsLive["positions"] = flags.has("positions-none")
    ? []
    : [
        { contract: occSymbol("SPY", expiry, "call", spy), qty: 2, avg_price: 2.85, price: 3.1, market_value: 620, unrealized_pl: 50 },
        { contract: occSymbol("NVDA", expiry, "put", nvda), qty: 1, avg_price: 3.4, price: 2.9, market_value: 290, unrealized_pl: -50 },
        // A name the desk does not carry, with only what the broker always sends.
        { contract: occSymbol("IWM", expiry, "call", 250), qty: 1, avg_price: null, price: null, market_value: 180, unrealized_pl: 12.5 },
      ];
  return {
    schema: "stocksdelta/options-live",
    schema_version: 1,
    run_id: `options-live-fixture-${asOf.toISOString()}`,
    as_of: asOf.toISOString(),
    paper: true,
    // The stale document is one from an open market: that is when its age is a fault and not just the hour.
    market: { is_open: flags.has("positions-old"), next_open: null, next_close: new Date(now.getTime() + 2 * 3_600_000).toISOString() },
    positions,
    open_interest: [
      {
        symbol: "SPY",
        as_of: new Date(now.getTime() - DAY).toISOString().slice(0, 10),
        rows: [
          { expiry, strike: spy, kind: "call", oi: 18250 },
          { expiry, strike: spy, kind: "put", oi: 9120 },
          { expiry, strike: spy + 5, kind: "call", oi: 22410 },
        ],
      },
    ],
    problems: [],
  };
}
