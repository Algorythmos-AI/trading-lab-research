// Fixture variants: the synthetic fixtures bent into the states a pane must survive (nothing published, storage
// down, a sparse edition, a corrupt one, the live feed off or failing). They exist only in fixture mode
// (DASHBOARD_FIXTURE=1, refused in production) and are chosen per request by the `fx` cookie, so the browser tests
// can put any page into any state. Pure: no I/O.
import type { CalendarDoc } from "./calendar.types";
import { settledSlotEnd } from "./desk-eval";
import { adjacentSession, type DocFeed, FEEDS, slotsAround, type StampedInputs } from "./feed-watch";
import type { Lot } from "./journal.types";
import { addDays, nyNow } from "./market-calendar";
import { nyInstant } from "./options";
import type { OptionsClone } from "./options-clone.types";
import type { PaperOptions } from "./paper-options.types";
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
 * - `quotes-flaky`: a short outage of the live feed. The first request answers, the next FLAKY_FAILS fail (502), and
 *   every one after answers again; the count is kept per browser in the `fxflaky` cookie the route sets.
 * - `quotes-suspect`: each fixture name's quote trips the board's bad-data guards in turn (fixture-suspect.ts). The
 *   guards' switches are off in fixture mode, so the board reads as with the plain fixture.
 * - `quotes-script`: the quotes and the session's bars walk a fixed morning (fixture-script.ts), one step every
 *   few seconds of the server's clock or the step in the `fxstep` cookie, so the "Trade now" board shows every state.
 *   With `focus`, AAPL joins the focus names.
 * - `chain-off`: the option feed has no keys. `chain-error`: Alpaca is failing.
 * - `chain-thin`: the nearest expiry's first calls come without a volatility, without a market, and crossed.
 * - `chain-opra`: the chain answers as Alpaca's real-time OPRA feed (no delay, quotes a few seconds old).
 * - `v2`: the edition in its second format, with the day's context, events and each name's volatility block.
 * - `positions-off`: no options live document has been published. `positions-none`: one has, with nothing open.
 * - `positions-old`: the document is three hours old.
 * - `paper-off`: the paper options history has not been published. With `partial` it carries the clone's trades
 *   only (no arms); with `poison` one clone row names a contract that cannot be read.
 * - `clone-off`: the options clone has published nothing. `clone-latched`: its document on a bad day.
 * - `journal-poison`: a stored trade journal with a null trade, as after corruption. The panes drawn from the trades
 *   must fail alone; the rest of each page keeps working.
 * - `calendar-off`: no economic calendar has been published. `calendar-stale`: the last one is three weeks old and
 *   FRED could not be read for it. `calendar-poison`: the stored one no longer matches its schema.
 * - `focus`: the options edition with a Today's focus block on SPY and QQQ, so the chart lines can be scanned.
 * - `feeds-ok`, `feeds-late`, `feeds-failed`, `feeds-unknown`: the feed watch's inputs (feed-watch.ts) bent for the
 *   Options page's health strip and the Operations page's feeds, and nothing else: the board, the cards and the desk
 *   are drawn from the same documents as without them. `feeds-ok`: every server-known feed on time (meant for a
 *   session clock, e.g. with `frozen`). `feeds-late`: the edition is for an earlier session, the journal has missed two
 *   runs, the server check has been silent for half an hour. `feeds-failed`: the edition was refused and nothing newer
 *   is stored. `feeds-unknown`: the store could not be read for the edition and the journal.
 * - `flow-off`, `flow-error`, `flow-thin`, `flow-stale`, `flow-crossed`: /api/flow only (flow-route.ts), and nothing
 *   else. `flow-off`: no keys (503). `flow-error`: Alpaca is failing (502). `flow-thin`: the baseline has 9 sessions.
 *   `flow-stale`: the baseline is for another session. `flow-crossed`: the first name's quote is crossed.
 * - `flow-down`, `flow-mixed`, `flow-range`: /api/flow only, the market bar's other states at FROZEN_NOW. Without them
 *   SPY and QQQ both rise above VWAP (MARKET UP). `flow-down`: both fall below it. `flow-mixed`: SPY up, QQQ down.
 *   `flow-range`: both drift sideways around VWAP.
 * - `journal-option-lot`: the journal holds one open long QQQ call bought at the scripted morning's second step (2
 *   contracts at $1.20), on the strike nearest the fixture chain's QQQ price and an expiry three weeks after the
 *   server's day, so the chain lists it exactly once (fixtureOptionLot); the journal reads a few minutes after the
 *   fill. With `chain-opra` and `quotes-script` the manage card shows its live value. Off by default.
 * - `journal-option-stop`: as `journal-option-lot`, but one contract bought at $17.00, so the fixture's sample bid
 *   ($12.11) is under its −25% stop ($12.75) and the card's premium stop fires (held-marks.ts). Off by default.
 * - `radar-building`, `radar-late`, `radar-hand`, `radar-refused`: the Radar page's pipeline for the session in view
 *   (radar-pipeline-fixture.ts): a build that has started and not ended; an edition stored 3 h 7 min behind by the
 *   catch-up; the same started by a person; an edition the ingest refused. Without one, a clean run so far.
 * - `radar-holiday`: the Radar page's pipeline is drawn for 10:00 New York on Thanksgiving 2026, a day the market is
 *   shut. Off by default.
 */
export const VARIANT_FLAGS = [
  "empty",
  "error",
  "partial",
  "poison",
  "journal-poison",
  "quotes-off",
  "quotes-error",
  "quotes-tick",
  "quotes-script",
  "quotes-flaky",
  "quotes-suspect",
  "chain-off",
  "chain-error",
  "chain-thin",
  "chain-opra",
  "v2",
  "positions-off",
  "positions-none",
  "positions-old",
  "rules-none",
  "rules-off",
  "rules-final",
  "hourly-off",
  "clone-off",
  "clone-latched",
  "paper-off",
  "calendar-off",
  "calendar-stale",
  "calendar-poison",
  "frozen",
  "focus",
  "feeds-ok",
  "feeds-late",
  "feeds-failed",
  "feeds-unknown",
  "flow-off",
  "flow-error",
  "flow-thin",
  "flow-stale",
  "flow-crossed",
  "flow-down",
  "flow-mixed",
  "flow-range",
  "journal-option-lot",
  "journal-option-stop",
  "radar-building",
  "radar-late",
  "radar-hand",
  "radar-refused",
  "radar-holiday",
] as const;
export type VariantFlag = (typeof VARIANT_FLAGS)[number];

/**
 * `frozen`: the server's clock for the Options pages stands at this instant (11:01 New York on the fixture's
 * session), so a screenshot is the same picture on every run. The browser's clock is set to match by the test.
 */
export const FROZEN_NOW = "2026-10-12T15:01:00Z";

const KNOWN = new Set<string>(VARIANT_FLAGS);

/** `quotes-flaky`: the cookie holding how many quote requests this browser has made, and how many fail in a row. */
export const FLAKY_COOKIE = "fxflaky";
export const FLAKY_FAILS = 3;

/** The count in a request's `Cookie` header: 0 when missing or not a whole number. */
export function flakyCountFromCookieHeader(header: string | null | undefined): number {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === FLAKY_COOKIE) {
      const n = Number(part.slice(eq + 1).trim());
      return Number.isInteger(n) && n >= 0 ? n : 0;
    }
  }
  return 0;
}

/** Whether the request with this count (0 for the first) fails: the 2nd to the (FLAKY_FAILS + 1)th do. */
export function flakyFails(count: number): boolean {
  return count >= 1 && count <= FLAKY_FAILS;
}

/** The flags in a cookie value such as `partial.quotes-tick`. Unknown words are ignored. */
export function parseFlags(raw: string | null | undefined): Set<VariantFlag> {
  const out = new Set<VariantFlag>();
  for (const word of (raw ?? "").split("."))
    if (KNOWN.has(word)) out.add(word as VariantFlag);
  return out;
}

/** The flags from a request's `Cookie` header. */
export function flagsFromCookieHeader(
  header: string | null | undefined,
): Set<VariantFlag> {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === VARIANT_COOKIE)
      return parseFlags(part.slice(eq + 1).trim());
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
const plus = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);

/** The edition with a Today's focus block: SPY and QQQ, with levels taken from their own fixture levels. Synthetic. */
export function focusOptions(e: OptionsEdition, script = false): OptionsEdition {
  const out = structuredClone(e);
  out.focus = {
    picked_at: `${e.session}T21:54:00Z`,
    method: "fixture",
    items: [
      {
        symbol: "SPY",
        rank: 1,
        bias: "breakout",
        resistance: { price: 779.4, name: "PDH" },
        support: { price: 775.16, name: "PDL" },
        close: 778.55,
        atr: 6.26,
        target_up: { price: 781.62, name: "PWH/52WH" },
        target_down: { price: 769.63, name: "PWL" },
      },
      {
        symbol: "QQQ",
        rank: 2,
        bias: "support",
        resistance: { price: 752.86, name: "PDH" },
        support: { price: 748.39, name: "PDL" },
        close: 751.24,
        atr: 8.53,
        target_up: { price: 762.86, name: "PWH/52WH" },
        target_down: { price: 743.23, name: "PWL" },
      },
      // The scripted morning's third name: it stays in the middle of yesterday's range.
      ...(script
        ? [
            {
              symbol: "AAPL",
              rank: 3,
              bias: "breakout" as const,
              resistance: { price: 338.6, name: "PDH" },
              support: { price: 330.7, name: "PDL" },
              close: 336.62,
              atr: 6.46,
              target_up: { price: 341.57, name: "PWH" },
              target_down: { price: 330.62, name: "PWL" },
            },
          ]
        : []),
    ],
  };
  return out;
}

/**
 * The same edition in its second format: the day's context, scheduled events around the session, and a volatility
 * block on each name. Synthetic, like the rest of the fixture. Some of it is left out or
 * left partly empty on purpose, since every part of the second format is optional and the page must say so with a
 * dash, not a zero.
 */
export function v2Options(e: OptionsEdition): OptionsEdition {
  const out = structuredClone(e);
  out.schema_version = 2;
  out.market = {
    vix: { close: 16.24, change: 0.82, pct_52w: 0.34 },
    session: { half_day: false },
    calendar: "complete",
  };
  const [a, b, c] = out.tickers.map((t) => t.symbol);
  out.events = [
    {
      date: plus(e.session, 2),
      time_et: "14:00",
      kind: "macro",
      type: "fomc_decision",
      severity: "high",
    },
    {
      date: e.session,
      time_et: "14:00",
      kind: "macro",
      type: "fomc_minutes",
      severity: "medium",
    },
    // Written the way another calendar might: one digit for the hour, seconds, capitals.
    {
      date: e.session,
      time_et: "8:30:00",
      kind: "macro",
      type: "CPI",
      severity: "high",
    },
    // A code this build has no name for, with no time: never drawn as written, and after the timed ones.
    {
      date: e.session,
      time_et: null,
      kind: "macro",
      type: "fed_holds_rates_powell_turns_hawkish",
      severity: null,
    },
    // The same release listed twice must not trip the page.
    {
      date: e.session,
      time_et: null,
      kind: "macro",
      type: "fed_holds_rates_powell_turns_hawkish",
      severity: null,
    },
    ...(b
      ? [
          {
            date: plus(e.session, 3),
            time_et: null,
            kind: "earnings" as const,
            type: "earnings",
            symbol: b,
            when: "amc" as const,
          },
        ]
      : []),
    ...(a
      ? [
          {
            date: plus(e.session, 1),
            time_et: null,
            kind: "earnings" as const,
            type: "earnings",
            symbol: a,
            when: "bmo" as const,
          },
        ]
      : []),
    // Outside the week, and for a name the edition does not carry: neither belongs on the page.
    ...(c
      ? [
          {
            date: plus(e.session, 30),
            time_et: null,
            kind: "earnings" as const,
            type: "earnings",
            symbol: c,
            when: "amc" as const,
          },
        ]
      : []),
    {
      date: e.session,
      time_et: null,
      kind: "earnings",
      type: "earnings",
      symbol: "ZZZZ",
      when: "amc",
    },
    {
      date: plus(e.session, -3),
      time_et: "08:30",
      kind: "macro",
      type: "nfp",
      severity: "high",
    },
  ];
  out.tickers.forEach((t, i) => {
    const iv = t.expected_move?.annual_iv ?? null;
    // One name with no block at all, one with a block of blanks, the rest filled in.
    if (i === 3) return;
    if (i === 4) {
      t.vol = {
        iv30: null,
        iv_change_1d: null,
        iv_pct_13w: null,
        iv_pct_26w: null,
        hv30: null,
        opt_volume: null,
        opt_volume_avg20: null,
      };
      return;
    }
    t.vol = {
      iv30: iv,
      iv_change_1d:
        iv === null
          ? null
          : Math.round((i % 2 === 0 ? 0.012 : -0.008) * 1000) / 1000,
      iv_pct_13w: Math.min(1, (t.expected_move?.iv_pct_52w ?? 0.3) + 0.14),
      iv_pct_26w: Math.min(1, (t.expected_move?.iv_pct_52w ?? 0.3) + 0.05),
      hv30:
        iv === null
          ? null
          : Math.round((iv / (i % 3 === 0 ? 1.32 : 0.9)) * 10000) / 10000,
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

/** A journal whose trades hold a null row, which the schema forbids and every trade view reads past. */
export function poisonedJournal<T extends { trades: readonly unknown[] }>(
  doc: T,
): T {
  return { ...doc, trades: [null, ...doc.trades] };
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
export function occSymbol(
  root: string,
  expiry: string,
  kind: "call" | "put",
  strike: number,
): string {
  return `${root}${expiry.slice(2).replace(/-/g, "")}${kind === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

/**
 * A synthetic options live document: three open paper option positions (two on the desk's names, one on a name
 * the desk does not carry) and a little open interest. Dated from `now`, so its contracts have not expired and
 * its age is what a healthy feed's would be, whenever the tests run.
 */
export function fixtureOptionsLive(
  e: OptionsEdition,
  now: Date,
  flags: ReadonlySet<VariantFlag> = new Set(),
): OptionsLive {
  // The first Friday at least a week out.
  let day = now.getTime() + 7 * DAY;
  while (new Date(day).getUTCDay() !== 5) day += DAY;
  const expiry = new Date(day).toISOString().slice(0, 10);
  const asOf = new Date(
    now.getTime() - (flags.has("positions-old") ? 180 : 2) * 60_000,
  );
  const strikeNear = (symbol: string, step: number) => {
    const close =
      e.tickers.find((t) => t.symbol === symbol)?.last?.close ?? 100;
    return Math.round(close / step) * step;
  };
  const spy = strikeNear("SPY", 5);
  const nvda = strikeNear("NVDA", 5);
  const positions: OptionsLive["positions"] = flags.has("positions-none")
    ? []
    : [
        {
          contract: occSymbol("SPY", expiry, "call", spy),
          qty: 2,
          avg_price: 2.85,
          price: 3.1,
          market_value: 620,
          unrealized_pl: 50,
        },
        {
          contract: occSymbol("NVDA", expiry, "put", nvda),
          qty: 1,
          avg_price: 3.4,
          price: 2.9,
          market_value: 290,
          unrealized_pl: -50,
        },
        // A name the desk does not carry, with only what the broker always sends.
        {
          contract: occSymbol("IWM", expiry, "call", 250),
          qty: 1,
          avg_price: null,
          price: null,
          market_value: 180,
          unrealized_pl: 12.5,
        },
      ];
  return {
    schema: "stocksdelta/options-live",
    schema_version: 1,
    run_id: `options-live-fixture-${asOf.toISOString()}`,
    as_of: asOf.toISOString(),
    paper: true,
    // The stale document is one from an open market: that is when its age is a fault and not just the hour.
    market: {
      is_open: flags.has("positions-old"),
      next_open: null,
      next_close: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
    },
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
    ...(flags.has("rules-off")
      ? {}
      : {
          schema_version: 2,
          rules: fixtureRules(
            e,
            asOf,
            flags.has("rules-none"),
            flags.has("rules-final"),
          ),
        }),
    ...(flags.has("hourly-off")
      ? {}
      : { schema_version: 3, hourly: fixtureHourly(e) }),
  };
}

/** Rule states for the fixture's own session: one rule open on the first name and one at its target on the third. */
function fixtureRules(
  e: OptionsEdition,
  asOf: Date,
  none: boolean,
  final = false,
): NonNullable<OptionsLive["rules"]> {
  const ids = (e.rules ?? []).map((r) => r.id);
  const hit: Record<
    string,
    Record<
      string,
      { state: "open" | "target"; bar: string; side: "call" | "put"; r: number }
    >
  > = none
    ? {}
    : {
        [e.tickers[0]?.symbol ?? ""]: {
          [ids[0] ?? ""]: {
            state: "open",
            bar: "11:00",
            side: "call",
            r: 0.42,
          },
        },
        [e.tickers[2]?.symbol ?? ""]: {
          [ids[3] ?? ""]: { state: "target", bar: "12:00", side: "put", r: 2 },
        },
      };
  return {
    // `rules-final`: the evening, when the host's last word is still the finished session the edition was built from.
    session: final ? (e.built_from ?? e.session) : e.session,
    as_of: new Date(asOf.getTime() - 16 * 60_000).toISOString(),
    delay_min: 16,
    provisional: true,
    complete: final,
    names: e.tickers.map((t) => ({
      symbol: t.symbol,
      bars: 3,
      states: ids.map((rule) => ({
        rule,
        ...(hit[t.symbol]?.[rule] ?? { state: "waiting" as const }),
      })),
    })),
  };
}

/**
 * Five sessions of hourly bars for every name but the last (a name the host left out), ending at the close the
 * edition was built from: plain arithmetic around each name's close, so the picture is the same on every run.
 */
function fixtureHourly(e: OptionsEdition): NonNullable<OptionsLive["hourly"]> {
  const days = [
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
    "2026-10-09",
  ];
  const hours = ["09:30", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"];
  return e.tickers.slice(0, -1).flatMap((t, k) => {
    const close = t.last?.close;
    if (typeof close !== "number" || !(close > 0)) return [];
    const step = close * 0.0015;
    const total = days.length * hours.length;
    const bars = days.flatMap((d, i) =>
      hours.map((h, j) => {
        const n = i * hours.length + j;
        // A slow drift into the close with a wobble that differs by name.
        const c =
          close -
          (total - 1 - n) * step * 0.4 +
          Math.sin(n * 0.9 + k) * step * 2;
        const o =
          close -
          (total - n) * step * 0.4 +
          Math.sin((n - 1) * 0.9 + k) * step * 2;
        const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
        return {
          t: `${d}T${h}`,
          o: r4(o),
          h: r4(Math.max(o, c) + step),
          l: r4(Math.min(o, c) - step),
          c: r4(c),
        };
      }),
    );
    return [{ symbol: t.symbol, bars }];
  });
}

/**
 * The options clone's fixture document, as is, or with `clone-latched` as a bad day: the day loss latch on, the
 * feed unfit, a position to flatten by hand, and the broker's stop refused.
 */
export function fixtureOptionsClone(
  d: OptionsClone,
  flags: ReadonlySet<VariantFlag> = new Set(),
): OptionsClone {
  if (!flags.has("clone-latched")) return d;
  return {
    ...d,
    run_id: `${d.run_id}-latched`,
    final: false,
    day_pnl: { ...d.day_pnl, usd: -104.5 },
    latch: "day",
    off: ["feed", "latch"],
    feed_unfit: true,
    flatten_required: true,
    broker_stop: "refused",
    quote_age_median_s: 7.4,
    slippage_median_pct: 4.1,
    trades: [
      ...d.trades,
      {
        trade_id: `${d.session}-O-3`,
        hyp: "HYP-0029",
        side: "put",
        contract: "QQQ261012P00598000",
        state: "open",
        fill: 1.62,
        exit_fill: null,
        exit_reason: null,
        rop: null,
      },
    ],
  };
}

/**
 * The paper options history fixture, as is; with `partial` the clone's trades only, as before the host reads the
 * manual account and the arms; with `poison` one clone row whose contract cannot be read (the page leaves it out and
 * says so).
 */
export function fixturePaperOptions(d: PaperOptions, flags: ReadonlySet<VariantFlag> = new Set()): PaperOptions {
  let out = d;
  if (flags.has("partial")) out = { ...out, manual: null, arms: null };
  if (flags.has("poison")) {
    const [first, ...rest] = out.clone.trades;
    if (first) out = { ...out, clone: { ...out.clone, trades: [{ ...first, contract: "ZZZ269999C00000000" }, ...rest] } };
  }
  return out;
}

/**
 * The economic calendar fixture (the job's own output on the recorded sources), dated two days before `now`, or
 * three weeks before it with FRED stale for `calendar-stale`.
 */
export function fixtureCalendar(
  doc: CalendarDoc,
  now: Date,
  flags: ReadonlySet<VariantFlag>,
): CalendarDoc {
  const stale = flags.has("calendar-stale");
  const asOf = new Date(now.getTime() - (stale ? 21 : 2) * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  return {
    ...doc,
    as_of: asOf,
    sources: doc.sources.map((s) => ({
      ...s,
      fetched_at: s.fetched_at ? asOf : null,
      ...(stale && s.id === "fred" ? { ok: false, stale_since: asOf } : {}),
    })),
  };
}

/**
 * The feed watch's stamps under the `feeds-*` flags (see VARIANT_FLAGS). Untouched without one. The times are read
 * from `nowMs`, so with `frozen` the strip is the same picture on every run.
 */
export function feedVariant(s: StampedInputs, flags: ReadonlySet<VariantFlag>, nowMs: number): StampedInputs {
  const any = flags.has("feeds-ok") || flags.has("feeds-late") || flags.has("feeds-failed") || flags.has("feeds-unknown");
  if (!any) return s;
  const today = nyNow(new Date(nowMs)).day;
  const preAt = nyInstant(today, 8 * 60 + 52) ?? nowMs;
  const ok = (session: string | null, at: number | null) => ({ status: "ok" as const, value: { session, at } });
  // The session the edition in force should be for: the run before now (the evening's build is for the next session).
  const edition = FEEDS.find((f): f is DocFeed => f.id === "options-edition")!;
  const due = slotsAround(edition, nowMs).filter((x) => x.due <= nowMs).at(-1);
  const want = due?.for_session ?? today;
  const stamps: StampedInputs["stamps"] = {
    ...s.stamps,
    "options-edition": ok(want, nowMs - 14 * 3_600_000),
    "pre-open": ok(today, preAt),
    journal: ok(today, nowMs - 5 * 60_000),
  };
  let refusals: StampedInputs["refusals"] = { ...s.refusals, options: { status: "missing" }, journal: { status: "missing" } };
  let shadow: StampedInputs["shadow"] = { status: "ok", value: { on: true, switched_at: null, last_slot_end: settledSlotEnd(nowMs) } };
  const out = { ...stamps };
  if (flags.has("feeds-late") || flags.has("feeds-failed")) out["options-edition"] = ok(adjacentSession(want, -1).day, nowMs - 38 * 3_600_000);
  if (flags.has("feeds-late")) {
    out.journal = ok(today, nowMs - 3 * 3_600_000);
    shadow = { status: "ok", value: { on: true, switched_at: null, last_slot_end: settledSlotEnd(nowMs) - 30 * 60_000 } };
  }
  if (flags.has("feeds-failed"))
    refusals = { ...refusals, options: { status: "ok", value: { current: true, at: new Date(nowMs - 20 * 60_000).toISOString(), outcome: "invalid" } } };
  if (flags.has("feeds-unknown")) {
    out["options-edition"] = { status: "error" };
    out["pre-open"] = { status: "error" };
    out.journal = { status: "error" };
  }
  return { stamps: out, refusals, shadow };
}

/**
 * `journal-option-lot`: one open long QQQ call, 2 contracts at $1.20 a share, opened at `openedAt`. Its strike is the
 * fixture chain's centre strike for QQQ (chain-route.ts fixtureChain: the close plus FIXTURE_OFFSET_ATR of an ATR, on
 * its strike step), so it is listed once; its expiry is three weeks after `now`'s New York day, which the chain and
 * the contract route add as the held contract wherever it sits. Null when the edition has no QQQ close.
 */
export function fixtureOptionLot(e: OptionsEdition, now: Date, openedAt: number, fill: { qty: number; entry: number } = { qty: 2, entry: 1.2 }): Lot | null {
  const t = e.tickers.find((x) => x.symbol === "QQQ");
  const close = t?.last?.close;
  if (typeof close !== "number") return null;
  const spot = Math.round((close + FIXTURE_OFFSET_ATR * (t?.atr14 ?? 0)) * 100) / 100;
  const step = spot < 50 ? 0.5 : spot < 300 ? 1 : 5;
  const strike = Math.round((Math.round(spot / step) * step) * 100) / 100;
  return { symbol: "QQQ", kind: "call", strike, expiry: addDays(nyNow(now).day, 21), side: "long", qty: fill.qty, entry: fill.entry, opened_at: new Date(openedAt).toISOString() };
}
