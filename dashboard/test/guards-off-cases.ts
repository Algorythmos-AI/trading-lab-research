// The inputs the all-switches-off proof runs (guards-off.test.ts): every fixture edition the board can be drawn from
// (the plain focus card, the partial and the v2 variants), at every step of the scripted morning and at fixed clock
// times across a session (the opening range, the morning, lunch, the afternoon, after the flat time, after the
// close), with each quote set the fixture can serve (the plain fixture prices, the ticking ones, the script's) and
// the same quotes bent by the `quotes-suspect` variant (fixture-suspect.ts), every guard in turn. Plain data, built
// the same way every run, so its hash is pinned beside the outputs' (guards-off.golden.json).
import { SCRIPT_ANSWER_LAG_MS, SCRIPT_STEPS, SCRIPT_SYMBOLS, scriptBars, scriptQuote, stepInstant } from "@/lib/fixture-script";
import { suspectQuote, suspectReasonFor } from "@/lib/fixture-suspect";
import { FIXTURE_OFFSET_ATR, focusOptions, partialOptions, tickPrice, v2Options } from "@/lib/fixture-variants";
import { GUARD_REASONS } from "@/lib/quote-guards";
import type { EvalInput } from "@/lib/desk-eval";
import type { LiveQuote, Options } from "@/lib/options";
import type { OptionsEdition } from "@/lib/options.types";
import type { BoardInput } from "@/lib/trade-now";
import { SERVER_SETTLE_MS, type Bar2 } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

export interface BoardCase {
  id: string;
  input: BoardInput;
  live: boolean;
}
export interface EvalCase {
  id: string;
  input: EvalInput;
  evaluatedAt: number;
}

const BASE = optionsJson as unknown as OptionsEdition;
const EDITIONS: [string, Options][] = [
  ["focus", focusOptions(BASE, true) as unknown as Options],
  ["partial", focusOptions(partialOptions(BASE), true) as unknown as Options],
  ["v2", focusOptions(v2Options(BASE), true) as unknown as Options],
];
const S = BASE.session;
const ny = (hhmm: string) => Date.parse(`${S}T${hhmm}:00-04:00`);
/** Fixed clock times across the session, New York (EDT on the fixture's session). */
const CLOCK = ["09:31", "09:36", "10:30", "11:45", "13:05", "15:20", "15:55", "16:05"];

/** The fixture route's own prices (quote-route.ts fixtureQuotes): a fixed share of an ATR above each close. */
function fixturePrices(e: Options, at: number, tick: boolean): Record<string, LiveQuote> {
  const out: Record<string, LiveQuote> = {};
  const second = tick ? Math.floor(at / 1000) % 60 : 0;
  for (const t of e.tickers) {
    const close = t.last?.close;
    if (typeof close !== "number") continue;
    const base = Math.round((close + FIXTURE_OFFSET_ATR * (t.atr14 ?? 0)) * 100) / 100;
    const price = tick ? tickPrice(base, second) : base;
    out[t.symbol] = {
      price,
      at: new Date(at - 2_000).toISOString(),
      open: close,
      high: Math.max(price, close),
      low: Math.min(price, close),
      day: S,
      prev_close: close,
      vwap: Math.round(((close + price) / 2) * 100) / 100,
    };
  }
  return out;
}

/** The quote sets for one instant: as served, and bent by `quotes-suspect` (each guard alone, then in turn). */
function quoteSets(base: Record<string, LiveQuote>): [string, Record<string, LiveQuote>][] {
  const names = Object.keys(base);
  const bend = (pick: (i: number) => (typeof GUARD_REASONS)[number]) => Object.fromEntries(names.map((s, i) => [s, suspectQuote(base[s]!, pick(i))]));
  return [
    ["plain", base],
    // valid snapshot fields and nothing suspect: what normalise gives a healthy snapshot
    ["fields", Object.fromEntries(names.map((s) => [s, { ...base[s]!, bar_ok: true, prev_bar_ok: true, bid: base[s]!.price - 0.01, ask: base[s]!.price + 0.01, bid_size: 1, ask_size: 1 }]))],
    ...GUARD_REASONS.map((g): [string, Record<string, LiveQuote>] => [`suspect-${g}`, bend(() => g)]),
    ["suspect-turn", bend(suspectReasonFor)],
  ];
}

export function boardCases(): BoardCase[] {
  const out: BoardCase[] = [];
  for (const [ed, e] of EDITIONS) {
    const items = e.focus!.items;
    const common = { session: S, halfDay: false, items, tickers: e.tickers, dayLimitUsed: false, wonToday: false };
    // the scripted morning, with the server's bars
    SCRIPT_STEPS.forEach((_, step) => {
      const at = stepInstant(S, step) + SCRIPT_ANSWER_LAG_MS;
      const script: Record<string, LiveQuote> = {};
      for (const s of SCRIPT_SYMBOLS) {
        const q = scriptQuote(s, S, step);
        if (q) script[s] = q;
      }
      const serverBars: Record<string, Bar2[]> = Object.fromEntries(items.map((i) => [i.symbol, scriptBars(i.symbol, S, step)]));
      const serverFetchedAt = Object.fromEntries(items.map((i) => [i.symbol, stepInstant(S, step) + SERVER_SETTLE_MS]));
      for (const [qs, quotes] of quoteSets(script))
        out.push({ id: `${ed}/step${step}/${qs}`, live: true, input: { ...common, quotes, trails: {}, serverBars, serverFetchedAt, now: at + 1_000, receivedAt: at } });
    });
    // fixed clock times with the fixture's prices, plain and ticking; and a feed gone quiet
    for (const hhmm of CLOCK) {
      const at = ny(hhmm);
      for (const tick of [false, true])
        for (const [qs, quotes] of quoteSets(fixturePrices(e, at, tick))) {
          const id = `${ed}/${hhmm}/${tick ? "tick" : "fixture"}/${qs}`;
          out.push({ id, live: true, input: { ...common, quotes, trails: {}, serverBars: {}, serverFetchedAt: {}, now: at, receivedAt: at - 1_000 } });
          if (!tick) out.push({ id: `${id}/quiet`, live: true, input: { ...common, quotes, trails: {}, serverBars: {}, serverFetchedAt: {}, now: at, receivedAt: at - 60_000 } });
          if (!tick && hhmm === "10:30") out.push({ id: `${id}/not-live`, live: false, input: { ...common, quotes, trails: {}, serverBars: {}, serverFetchedAt: {}, now: at, receivedAt: at - 1_000 } });
        }
    }
  }
  return out;
}

export function evalCases(): EvalCase[] {
  const out: EvalCase[] = [];
  const e = EDITIONS[0]![1];
  const items = e.focus!.items;
  SCRIPT_STEPS.forEach((_, step) => {
    const at = stepInstant(S, step);
    // the slot that has settled a minute and a half after the step, as a run then would evaluate it
    const runAt = at + 90_000;
    const end = Math.floor((runAt - SERVER_SETTLE_MS) / 120_000) * 120_000;
    const script: Record<string, LiveQuote> = {};
    for (const s of SCRIPT_SYMBOLS) {
      const q = scriptQuote(s, S, step);
      if (q) script[s] = q;
    }
    const bars = Object.fromEntries(items.map((i) => [i.symbol, scriptBars(i.symbol, S, step)]));
    const fetchedAt = Object.fromEntries(items.map((i) => [i.symbol, runAt]));
    for (const [qs, snapshots] of quoteSets(script)) {
      for (const done of [false, true])
        out.push({ id: `eval/step${step}/${qs}/${done ? "done" : "open"}`, evaluatedAt: runAt + 500, input: { slot: { day: S, end }, edition: e, journal: null, done, bars, fetchedAt, snapshots } });
    }
  });
  return out;
}
