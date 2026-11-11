import "server-only";
import { exists, PreconditionFailed, readText, readTextIfChanged, writeText } from "./blob";
import { OPTIONS_PATHS } from "./desk";
import {
  BAR_MS,
  DESK_EVAL_PATH,
  ENGINE_VERSION,
  type EvalSwitch,
  expectedSlots,
  focusSymbols,
  nyHhmm,
  type PageRecord,
  pageHiddenLogPath,
  pageLogPath,
  parseEvalSwitch,
  RECORD_V,
  ROW_STATES,
  type RowSide,
  serverLogPath,
  settledSlotEnd,
  SIDES,
  type StateRow,
  SYMBOL_RE,
} from "./desk-eval";
import { BYPASS_HEADER, isJson, readCapped, sameOrigin } from "./desk-flags-run";
import { type EditionRead, parseEdition } from "./desk-run";
import { logEvent } from "./log";
import { nyClock } from "./options";
import { fixtureMode } from "./snapshot";
import type { NameStateName } from "./trade-state";
import { CLOSE_GRACE_MS, SERVER_SETTLE_MS } from "./trade-state";

// Two small routes beside the server's shadow evaluation (DEC-0044, section 2), both behind Vercel Authentication
// like every page, and hardened exactly like /api/desk/flags:
//
//  * POST /api/desk/page-state: while the switch says "log", the open Options page sends its own states for a settled
//    slot, so the shadow numbers can say how often the server's match the page's. Same origin only, JSON only, a
//    small body, the bypass header refused, no CORS, no-store, and a strict schema: the slot, the engine label and
//    one row per focus name and side (a symbol of today's edition, a side, a state word), or `hidden: true` instead
//    of rows. Nothing else is accepted, and nothing the owner typed (no notes, fills or prices) is ever in it. Written
//    create-only to desk/log/YYYY-MM-DD/HHMM.page.json: the first page to send a slot wins; never outside production.
//  * GET /api/desk/eval-status: the switch and the last slot the server logged, for the page's "Server check paused"
//    line. Nothing else.

export const MAX_PAGE_BODY = 2_048;
/** A page's clock may run this far ahead of the server's. */
export const CLOCK_SKEW_MS = 5_000;
/** A slot older than this (after its settle instant) is not taken: the page sends a slot once, as it settles. */
export const MAX_SLOT_AGE_MS = 2 * BAR_MS;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const NO_STORE = { "cache-control": "no-store" };
function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}
const fail = (status: number, error: string, extra?: Record<string, string>) => json(status, { error }, extra);
const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

export type PagePost =
  | { slotEnd: number; engine: string; hidden: true; asOf: null; barsDelayed: null; rows: []; rowsAtSettle: [] }
  | { slotEnd: number; engine: string; hidden: false; asOf: number; barsDelayed: boolean; rows: StateRow[]; rowsAtSettle: StateRow[] };

/** One row list: each a focus name, a side and a state word, each name and side at most once. Null otherwise. */
function parseRows(v: unknown, focus: ReadonlySet<string>): StateRow[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > focus.size * SIDES.length) return null;
  const seen = new Set<string>();
  const rows: StateRow[] = [];
  for (const r of v) {
    if (!plain(r) || !onlyKeys(r, ["symbol", "side", "state"])) return null;
    const { symbol, side, state } = r;
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol) || !focus.has(symbol)) return null;
    if (typeof side !== "string" || !(SIDES as readonly string[]).includes(side)) return null;
    if (typeof state !== "string" || !(ROW_STATES as readonly string[]).includes(state)) return null;
    const key = `${symbol}|${side}`;
    if (seen.has(key)) return null;
    seen.add(key);
    rows.push({ symbol, side: side as RowSide, state: state as NameStateName });
  }
  return rows;
}

const VISIBLE_KEYS = ["slot_end", "engine", "as_of", "bars_delayed", "rows", "rows_at_settle"] as const;
const HIDDEN_KEYS = ["slot_end", "engine", "hidden"] as const;

/**
 * Exactly `{ slot_end, engine, as_of, bars_delayed, rows, rows_at_settle }` or `{ slot_end, engine, hidden: true }`,
 * or null. `as_of` must fall in the slot's grace window, from its close (end + CLOSE_GRACE_MS) to its settle; both
 * row lists hold focus names, sides and state words only.
 */
export function parsePagePost(text: string, focus: ReadonlySet<string>): PagePost | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!plain(v)) return null;
  const hidden = Object.hasOwn(v, "hidden");
  if (!onlyKeys(v, hidden ? HIDDEN_KEYS : VISIBLE_KEYS)) return null;
  if (typeof v.slot_end !== "string" || !ISO_RE.test(v.slot_end) || typeof v.engine !== "string" || v.engine.length > 40) return null;
  const slotEnd = Date.parse(v.slot_end);
  if (!Number.isFinite(slotEnd) || slotEnd % BAR_MS !== 0) return null;
  const engine = v.engine;
  if (hidden) return v.hidden === true ? { slotEnd, engine, hidden: true, asOf: null, barsDelayed: null, rows: [], rowsAtSettle: [] } : null;
  if (typeof v.as_of !== "string" || !ISO_RE.test(v.as_of) || typeof v.bars_delayed !== "boolean") return null;
  const asOf = Date.parse(v.as_of);
  if (!Number.isFinite(asOf) || asOf < slotEnd + CLOSE_GRACE_MS || asOf >= slotEnd + SERVER_SETTLE_MS) return null;
  const rows = parseRows(v.rows, focus);
  const rowsAtSettle = parseRows(v.rows_at_settle, focus);
  if (!rows || !rowsAtSettle) return null;
  return { slotEnd, engine, hidden: false, asOf, barsDelayed: v.bars_delayed, rows, rowsAtSettle };
}

/** Whether a page may send `slotEnd` at `now`: one of today's loggable slots, settled, and at most MAX_SLOT_AGE_MS past it. */
export function slotTakesPost(slotEnd: number, now: number): { day: string } | null {
  const day = nyClock(new Date(slotEnd).toISOString())?.day;
  if (!day || nyClock(new Date(now).toISOString())?.day !== day) return null;
  if (!expectedSlots(day).includes(slotEnd)) return null;
  const settle = slotEnd + SERVER_SETTLE_MS;
  if (now + CLOCK_SKEW_MS < settle || now - settle > MAX_SLOT_AGE_MS) return null;
  return { day };
}

export interface PageStateDeps {
  now(): number;
  /** Fixture mode or anywhere but production: nothing is ever written. */
  dry: boolean;
  readSwitch(): Promise<string | null>;
  loadEdition(): Promise<EditionRead>;
  /** Create-only: PreconditionFailed when the slot's page record is already there. */
  write(path: string, body: string): Promise<void>;
}

const refuse = () => Promise.reject(new Error("dry run: the store is not touched"));
const isDry = () => fixtureMode() || process.env.VERCEL_ENV !== "production";

export function defaultPageStateDeps(): PageStateDeps {
  if (isDry()) return { now: () => Date.now(), dry: true, readSwitch: async () => null, loadEdition: refuse, write: refuse };
  return {
    now: () => Date.now(),
    dry: false,
    readSwitch: async () => (await readText(DESK_EVAL_PATH))?.text ?? null,
    loadEdition: async () => {
      const r = await readTextIfChanged(OPTIONS_PATHS.latest);
      return r ? parseEdition(r.text) : { status: "missing" };
    },
    write: async (path, body) => {
      await writeText(path, body, { createOnly: true });
    },
  };
}

/**
 * The switch as the Options page's server render reads it, for the browser: "off" in fixture mode, anywhere but
 * production, and whenever it cannot be read. While it is off the page sends no request about the check at all.
 */
export async function loadEvalSwitch(): Promise<EvalSwitch> {
  if (isDry()) return "off";
  try {
    return parseEvalSwitch((await readText(DESK_EVAL_PATH))?.text ?? null);
  } catch {
    return "off";
  }
}

/** POST /api/desk/page-state. Every other method is 405. */
export async function handlePageState(req: Request, deps: PageStateDeps = defaultPageStateDeps()): Promise<Response> {
  if (req.headers.has(BYPASS_HEADER)) return fail(403, "forbidden");
  if (req.method !== "POST") return fail(405, "method-not-allowed", { allow: "POST" });
  if (!sameOrigin(req)) return fail(403, "forbidden");
  if (!isJson(req.headers.get("content-type"))) return fail(415, "json-only");
  const body = await readCapped(req, MAX_PAGE_BODY);
  if (body === "too-large") return fail(413, "too-large");
  if (body === "bad") return fail(400, "bad-request");

  let sw: EvalSwitch = "off";
  try {
    sw = parseEvalSwitch(await deps.readSwitch());
  } catch {
    sw = "off";
  }
  if (sw !== "log") return fail(409, "off");
  let ed: EditionRead;
  try {
    ed = await deps.loadEdition();
  } catch {
    return fail(503, "read-failed");
  }
  if (ed.status !== "ok") return fail(503, "read-failed");
  const post = parsePagePost(body.text, new Set(focusSymbols(ed.edition)));
  if (!post) return fail(400, "bad-request");
  const now = deps.now();
  const slot = slotTakesPost(post.slotEnd, now);
  if (!slot || ed.edition.session !== slot.day) return fail(409, "slot");
  // A tab left open across a deploy runs an older engine: its states are not comparable, so they are not kept.
  if (post.engine !== ENGINE_VERSION) return fail(409, "engine");

  const record: PageRecord = {
    v: RECORD_V,
    engine: ENGINE_VERSION,
    source: "page",
    slot_end: new Date(post.slotEnd).toISOString(),
    received_at: new Date(now).toISOString(),
    hidden: post.hidden,
    as_of: post.asOf === null ? null : new Date(post.asOf).toISOString(),
    bars_delayed: post.barsDelayed,
    rows: post.rows,
    rows_at_settle: post.rowsAtSettle,
  };
  if (deps.dry) return json(200, { ok: true, saved: false, dry: true });
  try {
    await deps.write((post.hidden ? pageHiddenLogPath : pageLogPath)(slot.day, post.slotEnd), JSON.stringify(record));
  } catch (e) {
    if (e instanceof PreconditionFailed) return json(200, { ok: true, saved: false });
    logEvent("desk-page-state", { outcome: "write-failed", error: errName(e) });
    return fail(503, "write-failed");
  }
  logEvent("desk-page-state", { outcome: "saved", slot: nyHhmm(post.slotEnd), hidden: post.hidden });
  return json(200, { ok: true, saved: true });
}

// ---- the page's status read -----------------------------------------------------------------------------------------
export interface EvalStatusDeps {
  now(): number;
  dry: boolean;
  readSwitch(): Promise<string | null>;
  exists(path: string): Promise<boolean>;
}

export function defaultEvalStatusDeps(): EvalStatusDeps {
  if (isDry()) return { now: () => Date.now(), dry: true, readSwitch: async () => null, exists: refuse };
  return {
    now: () => Date.now(),
    dry: false,
    readSwitch: async () => (await readText(DESK_EVAL_PATH))?.text ?? null,
    exists: (path) => exists(path),
  };
}

/** How many of the latest slots the status looks for by head(): ten minutes' worth, and never a listing. */
export const STATUS_PROBES = 5;

/**
 * The last slot the server logged today among the latest STATUS_PROBES settled slots, newest first, by head() only
 * (one call when all is well). Null when none of them is there: the check is paused, and since when is not looked
 * for further, so a tab polling every minute never lists the store.
 */
export async function lastLoggedSlot(deps: EvalStatusDeps, now: number): Promise<number | null> {
  const day = nyClock(new Date(now).toISOString())?.day;
  if (!day) return null;
  const latest = settledSlotEnd(now);
  const due = expectedSlots(day).filter((s) => s <= latest).reverse();
  for (const s of due.slice(0, STATUS_PROBES)) if (await deps.exists(serverLogPath(day, s))) return s;
  return null;
}

/** GET and HEAD /api/desk/eval-status: `{ eval, last_slot_end }` only. */
export async function handleEvalStatus(req: Request, deps: EvalStatusDeps = defaultEvalStatusDeps()): Promise<Response> {
  if (req.headers.has(BYPASS_HEADER)) return fail(403, "forbidden");
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method-not-allowed", { allow: "GET, HEAD" });
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return fail(403, "forbidden");
  const answer = async (): Promise<Response> => {
    let sw: EvalSwitch = "off";
    try {
      sw = parseEvalSwitch(await deps.readSwitch());
    } catch {
      return fail(503, "read-failed");
    }
    if (sw !== "log") return json(200, { eval: "off", last_slot_end: null });
    try {
      const last = await lastLoggedSlot(deps, deps.now());
      return json(200, { eval: "log", last_slot_end: last === null ? null : new Date(last).toISOString() });
    } catch (e) {
      logEvent("desk-eval-status", { outcome: "error", error: errName(e) });
      return fail(503, "read-failed");
    }
  };
  const res = await answer();
  return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}
