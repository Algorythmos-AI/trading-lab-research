import "server-only";
import { alpacaDataUrl } from "./alpaca-data-url";
import { FEED_PLAN_REFUSED, planRefused } from "./alpaca-feed";
import { readText, readTextIfChanged } from "./blob";
import { OPTIONS_PATHS } from "./desk";
import { presentsBypass } from "./desk-flags-run";
import { parseEdition } from "./desk-run";
import { baselinePath, flowNames } from "./flow-baseline-run";
import { type Baseline, baselineSessions, flowBarOf, type FlowBar, FULL_SESSION_SLOTS, type NameStats, parseBaseline, sessionSlots, SLOT_MS } from "./flow";
import { flagsFromCookieHeader, focusOptions, FROZEN_NOW, type VariantFlag } from "./fixture-variants";
import { alpacaHost } from "./feed-agreement-fetch";
import { logEvent } from "./log";
import { nyNow } from "./market-calendar";
import { nyClock, type Options } from "./options";
import type { OptionsEdition } from "./options.types";
import { alpacaKeys } from "./quote";
import { fixtureMode } from "./snapshot";
import { UpstreamError, upstreamBody, upstreamStatus } from "./upstream";

// GET /api/flow?s=SPY,QQQ: the data behind the flow measures (flow.ts) for the names the page may see: the top of the
// book, the last trade, the day's volume and today's regular-session 2-minute bars with volume, plus the day's volume
// baseline (flow-baseline-run.ts). SIP only, named literally: never ALPACA_FEED, never IEX (DEC-0050).
//
//  * Allowed names only (EXP-0032's blind): the stored edition's focus names when it is today's, plus SPY and QQQ.
//    Any other symbol refuses the whole request with 400 before anything is fetched or computed. Without `s`, every
//    allowed name is answered. The refusal never echoes the symbol.
//  * One snapshots call and one 2-minute bars call (from 09:30 New York, every page, none outside the session), both built
//    by alpacaDataUrl. Its own cache, CACHE_MS per instance, keyed by the sorted names and the New York day, with one
//    upstream read in flight per key; quote.ts's and bars.ts's caches are never read or written from here.
//  * The baseline is read from the private store once per instance for the session; a missing one is asked for again
//    after BASELINE_RETRY_MS, so one written late is still picked up. The edition is read at most every
//    EDITION_CACHE_MS; an unreadable one allows the market names only.
//  * Signed in only, as /api/feeds/live: the deployment-protection bypass and cross-site requests are refused. GET and
//    HEAD only; HEAD gives the same refusals without reading upstream.
//  * 503 without keys or when Alpaca refuses SIP on the plan; 429 for upstream's rate limit, 502 for any other failure.
//    A bars read still paging after MAX_BAR_PAGES answers bars null for every name, never a partial day.
//  * ALPACA_DATA_URL must pass feed-agreement-fetch's alpacaHost (https on an alpaca.markets host), as for the crons;
//    otherwise 503 not-configured and nothing is asked. A 401 from upstream (bad keys) is 502, as /api/quote, /api/bars
//    and /api/chain answer it (upstream.ts's upstreamStatus).
//  * The answer's `as_of` is the server's clock: clients build the flow measures' SlotClock from it with flow.ts's
//    slotClockFromAsOf, never from the device's clock, so the bars and the slots counted always agree.
// The answer names focus symbols: owner-only data. Log lines carry counts and statuses, never a symbol.

export const CACHE_MS = 3_000;
export const MAX_CACHED = 16;
/** Bar pages read for one answer at most: a session for six names is one page, but Alpaca may page early. */
export const MAX_BAR_PAGES = 20;
/** A missing baseline is looked for again after this long on an instance. */
export const BASELINE_RETRY_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 6_000;
/** The stored edition (for the allowed names) is read again after this long on an instance. */
export const EDITION_CACHE_MS = 30_000;
const DEFAULT_DATA_URL = "https://data.alpaca.markets";
const NO_STORE = { "cache-control": "no-store" } as const;

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response => Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

export interface FlowRow {
  price: number | null;
  trade_at: string | null;
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  quote_at: string | null;
  /** The snapshot's daily bar volume, when that bar is today's (New York). */
  day_volume: number | null;
  /** Today's bars from 09:30 New York, the forming one included; null when the read was cut short. */
  bars: FlowBar[] | null;
}

export interface FlowAnswer {
  /** The server's time of the answer: build the SlotClock from it (flow.ts slotClockFromAsOf), never the device's. */
  as_of: string;
  feed: "sip";
  /** The day's baseline for the answered names only; null when there is none for today. */
  baseline: { for_session: string; sessions: string[]; names: Record<string, NameStats> } | null;
  names: Record<string, FlowRow>;
  /** Asked-for names the snapshot did not carry. */
  missing: string[];
  fixture?: true;
}

export interface FlowDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now: () => Date;
  baseUrl: string;
  fixture: boolean;
  /** The stored options edition, or null when missing or unreadable. */
  loadEdition(): Promise<Options | null>;
  /** The stored baseline text for a session, or null when there is none. */
  readBaseline(session: string): Promise<string | null>;
}

/** Alpaca's market-data host, or ALPACA_DATA_URL when set (a function, so the deps object is not itself a URL). */
function dataBase(): string {
  return process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL;
}

export const defaultFlowDeps = (): FlowDeps => ({
  env: process.env,
  fetch,
  now: () => new Date(),
  baseUrl: dataBase(),
  fixture: fixtureMode(),
  loadEdition: async () => {
    const r = await readTextIfChanged(OPTIONS_PATHS.latest);
    if (!r) return null;
    const e = parseEdition(r.text);
    return e.status === "ok" ? e.edition : null;
  },
  readBaseline: async (session) => (await readText(baselinePath(session)))?.text ?? null,
});

/**
 * The names a request asks for: every allowed name without `s`; with it, its names (trimmed, upper case, each once,
 * sorted) when every one is allowed, else null.
 */
export function requestedNames(raw: string | null, allowed: readonly string[]): string[] | null {
  if (raw === null || raw.trim() === "") return [...allowed].sort();
  const asked = [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()))];
  if (asked.length === 0 || asked.some((s) => !allowed.includes(s))) return null;
  return asked.sort();
}

type Raw = Record<string, unknown> | null;
const rec = (v: unknown): Raw => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);

/** One name's snapshot as a row's quote fields; the daily volume only when the daily bar is `day`'s. */
export function snapshotRow(raw: unknown, day: string): Omit<FlowRow, "bars"> {
  const s = rec(raw);
  const t = rec(s?.latestTrade);
  const q = rec(s?.latestQuote);
  const d = rec(s?.dailyBar);
  const dAt = iso(d?.t);
  return {
    price: num(t?.p),
    trade_at: iso(t?.t),
    bid: num(q?.bp),
    ask: num(q?.ap),
    bid_size: num(q?.bs),
    ask_size: num(q?.as),
    quote_at: iso(q?.t),
    day_volume: dAt !== null && nyClock(dAt)?.day === day ? num(d?.v) : null,
  };
}

const headers = (keys: { id: string; secret: string }) => ({ "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" });

/**
 * Today's bars per name from one paged read on sip, or null when still paging after MAX_BAR_PAGES. Only inside the
 * regular session: before the open and from the close (and off session days) no bars call is made and every name
 * answers no bars, so an answer outside the session costs the snapshots call alone.
 */
async function readBars(symbols: string[], day: string, now: Date, keys: { id: string; secret: string }, d: FlowDeps): Promise<Record<string, FlowBar[]> | null> {
  const out: Record<string, FlowBar[]> = Object.fromEntries(symbols.map((s) => [s, []]));
  const s = sessionSlots(day);
  if (!s || now.getTime() < s.open || now.getTime() >= s.close) return out;
  let token: string | null = null;
  for (let page = 0; page < MAX_BAR_PAGES; page++) {
    const q: Record<string, string> = { symbols: symbols.join(","), timeframe: "2Min", start: new Date(s.open).toISOString(), feed: "sip", limit: "10000", adjustment: "raw" };
    if (token) q.page_token = token;
    const res = await d.fetch(alpacaDataUrl(d.baseUrl, "/v2/stocks/bars", q), { headers: headers(keys), cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new UpstreamError(res.status);
    const body = rec(await res.json());
    for (const [sym, list] of Object.entries(rec(body?.bars) ?? {})) {
      if (!out[sym] || !Array.isArray(list)) continue;
      for (const raw of list) {
        const b = flowBarOf(raw);
        if (b && b.start >= s.open && b.start < s.close) out[sym]!.push(b);
      }
    }
    token = typeof body?.next_page_token === "string" && body.next_page_token ? body.next_page_token : null;
    if (!token) break;
  }
  if (token) {
    logEvent("flow.fetch", { outcome: "page-limit", pages: MAX_BAR_PAGES, names: symbols.length });
    return null;
  }
  for (const sym of symbols) out[sym] = [...new Map(out[sym]!.map((b) => [b.start, b])).values()].sort((a, b) => a.start - b.start);
  return out;
}

type Body = Omit<FlowAnswer, "baseline">;
const cache = new Map<string, { at: number; body: Body }>();
const inFlight = new Map<string, Promise<Body>>();
const baselines = new Map<string, { at: number; doc: Baseline | null }>();
let editionKept: { at: number; doc: Options | null } | null = null;

/** Test hook: forget this route's caches and anything in flight. */
export function resetFlowCache(): void {
  cache.clear();
  inFlight.clear();
  baselines.clear();
  editionKept = null;
}

/** The upstream part of an answer for one key: the cache when young enough, else one read shared by every waiter. */
async function upstreamFor(key: string, symbols: string[], day: string, now: Date, keys: { id: string; secret: string }, d: FlowDeps): Promise<Body> {
  const t = now.getTime();
  const hit = cache.get(key);
  if (hit && t >= hit.at && t - hit.at < CACHE_MS) return hit.body;
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async () => {
    const snapUrl = alpacaDataUrl(d.baseUrl, "/v2/stocks/snapshots", { symbols: symbols.join(","), feed: "sip" });
    const [snapRes, bars] = await Promise.all([d.fetch(snapUrl, { headers: headers(keys), cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }), readBars(symbols, day, now, keys, d)]);
    if (!snapRes.ok) throw new UpstreamError(snapRes.status);
    const sb = rec(await snapRes.json());
    const map = rec(sb?.snapshots) ?? sb ?? {};
    const names: Record<string, FlowRow> = {};
    const missing: string[] = [];
    for (const sym of symbols) {
      if (!rec(map[sym])) missing.push(sym);
      names[sym] = { ...snapshotRow(map[sym], day), bars: bars ? (bars[sym] ?? []) : null };
    }
    const body: Body = { as_of: now.toISOString(), feed: "sip", names, missing };
    cache.delete(key);
    cache.set(key, { at: t, body });
    for (const k of cache.keys()) {
      if (cache.size <= MAX_CACHED) break;
      cache.delete(k);
    }
    return body;
  })();
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    if (inFlight.get(key) === p) inFlight.delete(key);
  }
}

/** The day's baseline: kept for the session once found; a missing one is asked for again after BASELINE_RETRY_MS. */
async function baselineFor(day: string, now: number, d: FlowDeps): Promise<Baseline | null> {
  const kept = baselines.get(day);
  if (kept && (kept.doc !== null || (now >= kept.at && now - kept.at < BASELINE_RETRY_MS))) return kept.doc;
  let doc: Baseline | null = null;
  try {
    const text = await d.readBaseline(day);
    doc = text === null ? null : parseBaselineFor(text, day);
    if (text !== null && doc === null) logEvent("flow.baseline-read", { outcome: "unreadable" });
  } catch (e) {
    // Not kept: the next request asks the store again.
    logEvent("flow.baseline-read", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return null;
  }
  baselines.clear(); // one session's at a time
  baselines.set(day, { at: now, doc });
  return doc;
}

/** A stored baseline for `day`, or null. The path names the day, so a document for another day is not this one. */
function parseBaselineFor(text: string, day: string): Baseline | null {
  const b = parseBaseline(text);
  return b && b.for_session === day ? b : null;
}

/** The stored edition, read at most once per EDITION_CACHE_MS on an instance. Unreadable: null, and not kept. */
async function editionFor(now: number, d: FlowDeps): Promise<Options | null> {
  if (editionKept && now >= editionKept.at && now - editionKept.at < EDITION_CACHE_MS) return editionKept.doc;
  try {
    const doc = await d.loadEdition();
    editionKept = { at: now, doc };
    return doc;
  } catch (e) {
    // Only the market names are allowed then, never a guess at the focus list.
    logEvent("flow.edition", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return null;
  }
}

/**
 * The baseline restricted to the answered names, without the per-slot ranges: those are for the server's shock gate
 * (DEC-0051), and the browser draws nothing from them.
 */
function baselineView(b: Baseline | null, symbols: readonly string[]): FlowAnswer["baseline"] {
  if (!b) return null;
  const names: Record<string, NameStats> = {};
  for (const s of symbols)
    if (Object.hasOwn(b.names, s)) {
      const { slot_median, cum_median, n } = b.names[s]!;
      names[s] = { slot_median, cum_median, n };
    }
  return { for_session: b.for_session, sessions: b.sessions, names };
}

// ---- the server's own read (DEC-0051) ---------------------------------------------------------------------------------

/** The flow answer as the desk's signal step reads it on the server: the baseline whole, ranges and build time included. */
export interface ServerFlow extends Omit<FlowAnswer, "baseline"> {
  baseline: Baseline | null;
}

/** Why the server's read gave no answer, with no symbol: no keys or data URL, SIP refused by the plan, or names not allowed. */
export class FlowUnavailable extends Error {
  constructor(readonly why: "not-configured" | "plan" | "not-allowed") {
    super(why);
    this.name = "FlowUnavailable";
  }
}

/**
 * The same answer GET /api/flow gives, read in the server's own process for the desk's signal step (signal-run.ts),
 * never through HTTP: the same allowed names (the edition's focus names when it is today's, plus SPY and QQQ; any other
 * refuses before anything is fetched), the same SIP reads, cache and baseline. The edition is the one the desk's run
 * read, passed in. The baseline is kept whole (the shock gate's ranges, its build time) for the answered names only.
 * Throws FlowUnavailable, or the upstream error, never a partial answer.
 */
export async function serverFlow(symbols: readonly string[], edition: Pick<Options, "session" | "focus"> | null, over: Partial<FlowDeps> = {}): Promise<ServerFlow> {
  const d = { ...defaultFlowDeps(), ...over };
  const now = d.now();
  const day = nyNow(now).day;
  const allowed = flowNames(edition, day);
  const names = [...new Set(symbols)].sort();
  if (names.length === 0 || names.some((s) => !allowed.includes(s))) throw new FlowUnavailable("not-allowed");
  const keys = alpacaKeys(d.env);
  if (!keys || alpacaHost(d.baseUrl) === null) throw new FlowUnavailable("not-configured");
  try {
    const [body, baseline] = await Promise.all([upstreamFor(`${day}|${names.join(",")}`, names, day, now, keys, d), baselineFor(day, now.getTime(), d)]);
    const kept = baseline ? Object.fromEntries(names.filter((s) => Object.hasOwn(baseline.names, s)).map((s) => [s, baseline.names[s]!])) : null;
    return { ...body, baseline: baseline && kept ? { ...baseline, built_for: baseline.built_for.filter((s) => names.includes(s)), names: kept } : null };
  } catch (e) {
    if (planRefused("sip", e)) throw new FlowUnavailable("plan");
    throw e;
  }
}

// ---- fixture mode -----------------------------------------------------------------------------------------------------

/** Fixture prices: about the fixture edition's closes, inlined so nothing under test/ is read for them. */
const FIXTURE_BASE: Readonly<Record<string, number>> = { SPY: 778.55, QQQ: 751.24, AAPL: 336.62 };

/** A made-up slot volume: high at the open and the close, low at midday. */
const fixtureSlotVolume = (k: number, i: number) => Math.round(40_000 + 60_000 * ((k - 97) / 97) ** 2 + 1_000 * i);

/** A fixture path's shape: 1 rises, -1 falls (both a wave on a drift), 0 drifts sideways in a narrow band. */
export type FixtureShape = 1 | -1 | 0;

/** The shape of `sym`'s path under the flags: rising unless `flow-down`, `flow-mixed` (QQQ only) or `flow-range` say not. */
export function fixtureShape(sym: string, flags: ReadonlySet<VariantFlag>): FixtureShape {
  if (flags.has("flow-range")) return 0;
  if (flags.has("flow-down") || (flags.has("flow-mixed") && sym === "QQQ")) return -1;
  return 1;
}

/** The fixture path's move from the base at slot k: at FROZEN_NOW a shape of 1 stands 20 bp or more above VWAP. */
const fixtureMove = (shape: FixtureShape, k: number, i: number) => (shape === 0 ? 0.0004 * Math.sin((k + i) * 1.7) : shape * (0.003 * Math.sin((k + i) / 5) + 0.00009 * k));

/** Fixture bars for one name: every bar of `day` that has started by `now`, the last one still forming. */
export function fixtureBars(sym: string, i: number, day: string, now: number, shape: FixtureShape = 1): FlowBar[] {
  const s = sessionSlots(day);
  if (!s) return [];
  const base = FIXTURE_BASE[sym] ?? 100 + 10 * i;
  const out: FlowBar[] = [];
  let c = base;
  for (let k = 0, at = s.open; at < Math.min(now, s.close); k++, at += SLOT_MS) {
    const o = c;
    c = Math.round(base * (1 + fixtureMove(shape, k, i)) * 100) / 100;
    const h = Math.round((Math.max(o, c) + 0.05 * (1 + (k % 3))) * 100) / 100;
    const l = Math.round((Math.min(o, c) - 0.05 * (1 + ((k + 1) % 3))) * 100) / 100;
    // Every tenth slot trades twice its usual volume, so a surge shows; the forming bar holds half a bar.
    const full = fixtureSlotVolume(k, i) * (k % 10 === 7 ? 2 : 1);
    const v = at + SLOT_MS > now ? Math.round(full / 2) : full;
    out.push({ start: at, end: at + SLOT_MS, o, h, l, c, v, vw: Math.round(((h + l + c) / 3) * 100) / 100, n: Math.round(v / 100) });
  }
  return out;
}

/**
 * The fixture baseline for `forSession` (version 2, with ranges): 20 sessions, or 9 with `flow-thin`; for the session
 * before with `flow-stale`.
 */
export function fixtureBaseline(names: readonly string[], forSession: string, flags: ReadonlySet<VariantFlag>): Baseline | null {
  const target = flags.has("flow-stale") ? (baselineSessions(forSession)?.at(-1) ?? null) : forSession;
  const sessions = target ? baselineSessions(target) : null;
  if (!target || !sessions) return null;
  const n = flags.has("flow-thin") ? 9 : sessions.length;
  const stats: Record<string, NameStats> = {};
  names.forEach((sym, i) => {
    const slot_median = Array.from({ length: FULL_SESSION_SLOTS }, (_, k) => fixtureSlotVolume(k, i));
    let run = 0;
    // A made-up range per slot, as the volume: wider at the open and the close (version 2, for the shock gate).
    const range_median = slot_median.map((v) => Math.round(v / 100) / 1_000);
    stats[sym] = { slot_median, cum_median: slot_median.map((x) => (run += x)), range_median, n };
  });
  return { v: 2, for_session: target, built_at: `${sessions.at(-1)}T21:00:00.000Z`, feed: "sip", sessions: sessions.slice(-n), built_for: [...names].sort(), names: stats };
}

/** The fixture answer: the fixture session at FROZEN_NOW, whatever the server's clock says. No network. */
async function fixtureAnswer(raw: string | null, flags: ReadonlySet<VariantFlag>): Promise<Response> {
  const mod = await import("../../test/fixtures/options.v1.json");
  const base = (mod.default ?? mod) as unknown as OptionsEdition;
  const edition = flags.has("focus") ? focusOptions(base, flags.has("quotes-script")) : base;
  const symbols = requestedNames(raw, flowNames(edition as unknown as Options, edition.session));
  if (!symbols) return json(400, { error: "not-allowed" });
  const now = Date.parse(FROZEN_NOW);
  const day = nyNow(new Date(now)).day;
  const names: Record<string, FlowRow> = {};
  symbols.forEach((sym, i) => {
    const bars = fixtureBars(sym, i, day, now, fixtureShape(sym, flags));
    const price = bars.at(-1)?.c ?? FIXTURE_BASE[sym] ?? 100 + 10 * i;
    const crossed = flags.has("flow-crossed") && i === 0;
    names[sym] = {
      price,
      trade_at: new Date(now - 2_000 - 500 * i).toISOString(),
      bid: Math.round((crossed ? price + 0.02 : price - 0.01) * 100) / 100,
      ask: Math.round((price + 0.01) * 100) / 100,
      bid_size: 3,
      ask_size: 4,
      quote_at: new Date(now - 1_500 - 500 * i).toISOString(),
      day_volume: bars.reduce((s, b) => s + b.v, 0),
      bars,
    };
  });
  const out: FlowAnswer = { as_of: new Date(now).toISOString(), feed: "sip", baseline: baselineView(fixtureBaseline(symbols, day, flags), symbols), names, missing: [], fixture: true };
  return json(200, out);
}

// ---- the route --------------------------------------------------------------------------------------------------------

/** GET and HEAD /api/flow?s=SPY,QQQ. */
export async function handleFlow(req: Request, over: Partial<FlowDeps> = {}): Promise<Response> {
  if (presentsBypass(req)) return json(403, { error: "forbidden" });
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method-not-allowed" }, { allow: "GET, HEAD" });
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return json(403, { error: "forbidden" });
  const d = { ...defaultFlowDeps(), ...over };
  const head = req.method === "HEAD";
  const answer = (status: number, body: unknown): Response => (head ? new Response(null, { status, headers: NO_STORE }) : json(status, body));
  const raw = new URL(req.url).searchParams.get("s");

  if (d.fixture) {
    const flags = flagsFromCookieHeader(req.headers.get("cookie"));
    if (flags.has("flow-off")) return answer(503, { error: "not-configured" });
    if (flags.has("flow-error")) return answer(502, { error: "upstream" });
    if (head) return answer(200, null);
    return fixtureAnswer(raw, flags);
  }

  const now = d.now();
  const day = nyNow(now).day;
  const symbols = requestedNames(raw, flowNames(await editionFor(now.getTime(), d), day));
  if (!symbols) {
    logEvent("flow.request", { outcome: "not-allowed" });
    return answer(400, { error: "not-allowed" });
  }
  const keys = alpacaKeys(d.env);
  if (!keys) return answer(503, { error: "not-configured" });
  if (alpacaHost(d.baseUrl) === null) {
    logEvent("flow.request", { outcome: "data-url" });
    return answer(503, { error: "not-configured" });
  }
  if (head) return answer(200, null);
  try {
    const [body, baseline] = await Promise.all([upstreamFor(`${day}|${symbols.join(",")}`, symbols, day, now, keys, d), baselineFor(day, now.getTime(), d)]);
    const out: FlowAnswer = { ...body, baseline: baselineView(baseline, symbols) };
    return json(200, out);
  } catch (e) {
    if (planRefused("sip", e)) return json(503, FEED_PLAN_REFUSED);
    logEvent("flow.fetch", { outcome: "error", error: e instanceof UpstreamError ? `status-${e.status}` : e instanceof Error ? e.name : "unknown" });
    const status = upstreamStatus(e);
    return json(status, upstreamBody(status));
  }
}
