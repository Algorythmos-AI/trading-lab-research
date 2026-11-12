import "server-only";
import { readText } from "./blob";
import { parseEvalSwitch, serverLogPath } from "./desk-eval";
import { presentsBypass } from "./desk-flags-run";
import { ALL_OFF, DESK_GUARDS_PATH, type GuardSwitches, parseGuardSwitches } from "./desk-guards";
import { defaultEvalStatusDeps, type EvalStatusDeps, lastLoggedSlot } from "./desk-page-run";
import { logEvent } from "./log";
import { nyClock } from "./options";
import { fixtureMode } from "./snapshot";

// The store's side of the bad-data guards' switches (desk-guards.ts) for the Options page, and the Operations page's
// read of the data plan's rate limit.
//
//  * GET /api/desk/guards: the switches as the store holds them, `{ on, status }` only, for the open page to read
//    again while its live board is on, so a switch the owner turns on or off reaches the page without a reload or a
//    deploy. Behind Vercel Authentication like every page, hardened like /api/desk/eval-status (GET and HEAD only,
//    cross-site refused, Vercel's protection bypass refused in every documented form, no-store). It writes nothing.
//  * loadGuardSwitches: the same read for the page's server render.
//  * loadDataPlanLimit: the snapshot's X-RateLimit-Limit on the server check's newest record (its probe), for the
//    Operations page's feeds panel. Display only: nothing is sent.
// In fixture mode and anywhere but production none of them touches the store: every guard is off, no limit is read.

const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
const fail = (status: number, error: string, extra?: Record<string, string>) => json(status, { error }, extra);
const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");
const isDry = () => fixtureMode() || process.env.VERCEL_ENV !== "production";

export interface GuardReadDeps {
  /** Fixture mode or anywhere but production: nothing is read, every guard is off. */
  dry: boolean;
  /** desk/guards.json as stored, or null when there is none. */
  read(): Promise<string | null>;
}

export function defaultGuardReadDeps(): GuardReadDeps {
  if (isDry()) return { dry: true, read: async () => null };
  return { dry: false, read: async () => (await readText(DESK_GUARDS_PATH))?.text ?? null };
}

/** The switches, never thrown: a dry run and a missing document are all off; a failed read is all off as "error". */
export async function readGuardSwitches(deps: GuardReadDeps = defaultGuardReadDeps()): Promise<GuardSwitches> {
  if (deps.dry) return ALL_OFF("missing");
  try {
    return parseGuardSwitches(await deps.read());
  } catch (e) {
    logEvent("desk-guards.read", { outcome: "error", error: errName(e) });
    return ALL_OFF("error");
  }
}

/** The switches as the Options page's server render reads them. */
export const loadGuardSwitches = (): Promise<GuardSwitches> => readGuardSwitches();

/** GET and HEAD /api/desk/guards: `{ on, status }` only. */
export async function handleGuards(req: Request, deps: GuardReadDeps = defaultGuardReadDeps()): Promise<Response> {
  if (presentsBypass(req)) return fail(403, "forbidden");
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method-not-allowed", { allow: "GET, HEAD" });
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return fail(403, "forbidden");
  const s = await readGuardSwitches(deps);
  const res = json(200, { on: s.on, status: s.status });
  return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

/**
 * The data plan's rate limit as the newest server record today read it (`probe.rate_limit`), or null: outside a
 * session day, the check switched off, no record among the latest slots, no probe on it, or any read failing. One
 * switch read, at most a few head() calls (desk-page-run's lastLoggedSlot) and one record read.
 */
export async function loadDataPlanLimit(now: number, deps: EvalStatusDeps & { readRecord?(path: string): Promise<string | null> } = defaultEvalStatusDeps()): Promise<number | null> {
  if (deps.dry) return null;
  try {
    if (parseEvalSwitch(await deps.readSwitch()) !== "log") return null;
    const last = await lastLoggedSlot(deps, now);
    const day = nyClock(new Date(now).toISOString())?.day;
    if (last === null || !day) return null;
    const read = deps.readRecord ?? (async (p: string) => (await readText(p))?.text ?? null);
    const text = await read(serverLogPath(day, last));
    const rec: unknown = text === null ? null : JSON.parse(text);
    const probe = rec !== null && typeof rec === "object" ? (rec as { probe?: unknown }).probe : null;
    const limit = probe !== null && typeof probe === "object" ? (probe as { rate_limit?: unknown }).rate_limit : null;
    return typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? limit : null;
  } catch (e) {
    logEvent("desk-guards.rate-limit", { outcome: "error", error: errName(e) });
    return null;
  }
}
