// The Reference Registry's server side: what the records pages and the two routes ask for. GitHub is read and
// dispatched only here (through ./registry-github), never from the browser (the site's CSP is connect-src 'self').
import "server-only";
import { isJson, presentsBypass, readCapped, sameOrigin } from "./desk-flags-run";
import { logEvent } from "./log";
import { dispatchRegistry, readGithub, type DispatchResult } from "./registry-github";
import { isRegistryBranch, loadRegistry, registryFlags, type RegistryBranch, type RegistryFlag, type RegistryLoad } from "./registry-store";
import { syncSentence, syncStatus, type GithubView, type IndexView, type SyncStatus } from "./registry-status";

export interface RegistryDeps {
  load(branch: RegistryBranch): Promise<RegistryLoad>;
  github(branch: RegistryBranch): Promise<GithubView>;
  dispatch(branch: RegistryBranch): Promise<DispatchResult>;
  flags(): Promise<Set<RegistryFlag>>;
  now(): number;
  /** Fixture mode or anywhere but production: GitHub is never asked and a dispatch is only pretended. */
  dry: boolean;
}

function dryMode(): boolean {
  return !(process.env.VERCEL_ENV === "production" && process.env.DASHBOARD_FIXTURE !== "1");
}

export const liveDeps: RegistryDeps = {
  load: (b) => loadRegistry(b),
  github: (b) => readGithub(b),
  dispatch: (b) => dispatchRegistry(b),
  flags: () => registryFlags(),
  now: () => Date.now(),
  get dry() {
    return dryMode();
  },
};

export function indexView(load: RegistryLoad): IndexView {
  return load.status === "ok"
    ? { status: "ok", sha: load.doc.sha, as_of: load.doc.as_of, storedAt: load.storedAt, checkedAt: load.checkedAt }
    : load;
}

// Fixture mode's pretend GitHub, bent by the `fx` flags, and its pretend dispatch (a run "under way" for 20 s).
// On globalThis, so the route that starts it and the page that draws it (separate bundles in Next) see one map.
const g = globalThis as { __registryPretendRuns?: Map<RegistryBranch, number> };
const pretendRuns: Map<RegistryBranch, number> = (g.__registryPretendRuns ??= new Map());

export function fixtureGithub(load: RegistryLoad, flags: ReadonlySet<RegistryFlag>, branch: RegistryBranch, nowMs: number): GithubView {
  if (flags.has("registry-unknown")) return { ok: false, reason: "unreachable" };
  const sha = load.status === "ok" ? load.doc.sha : "0".repeat(40);
  const moved = "f".repeat(40);
  const at = new Date(nowMs - 4 * 60_000).toISOString();
  const started = pretendRuns.get(branch);
  const pretending = started !== undefined && nowMs - started < 20_000;
  if (flags.has("registry-syncing") || pretending) {
    return { ok: true, head: moved, headAt: at, runs: [{ status: "in_progress", conclusion: null, head_sha: moved, created_at: at, event: "push" }] };
  }
  if (flags.has("registry-failed")) {
    return { ok: true, head: moved, headAt: at, runs: [{ status: "completed", conclusion: "failure", head_sha: moved, created_at: at, event: "push" }] };
  }
  if (flags.has("registry-stale")) return { ok: true, head: moved, headAt: at, runs: [] };
  return { ok: true, head: sha, headAt: at, runs: [] };
}

export interface RegistryState {
  branch: RegistryBranch;
  load: RegistryLoad;
  status: SyncStatus;
  sentence: string;
}

export async function registryState(branch: RegistryBranch, deps: RegistryDeps = liveDeps): Promise<RegistryState> {
  const load = await deps.load(branch);
  const gh = deps.dry ? fixtureGithub(load, await deps.flags(), branch, deps.now()) : await deps.github(branch);
  const status = syncStatus(indexView(load), gh);
  return { branch, load, status, sentence: syncSentence(status) };
}

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The status only: no record, no token, no URL. */
function statusBody(s: RegistryState): Record<string, unknown> {
  return {
    branch: s.branch,
    state: s.status.state,
    label: s.status.label,
    reason: s.status.reason,
    sentence: s.sentence,
    index_sha: s.status.indexSha,
    head_sha: s.status.headSha,
    head_at: s.status.headAt,
    last_sync: s.status.lastSync,
    failed_at: s.status.failedAt,
    index_run_id: s.load.status === "ok" ? s.load.doc.run_id : null,
  };
}

function branchOf(req: Request): RegistryBranch | null {
  try {
    const b = new URL(req.url).searchParams.get("b") ?? "integration";
    return isRegistryBranch(b) ? b : null;
  } catch {
    return null;
  }
}

/** GET /api/registry/status?b=integration|main */
export async function handleRegistryStatus(req: Request, deps: RegistryDeps = liveDeps): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method" });
  if (presentsBypass(req)) return json(403, { error: "forbidden" });
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return json(403, { error: "forbidden" });
  const branch = branchOf(req);
  if (!branch) return json(400, { error: "branch" });
  if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  return json(200, statusBody(await registryState(branch, deps)));
}

/** Per instance: when each branch was last dispatched, so a double tap starts one run. */
const lastDispatch = new Map<RegistryBranch, number>();
export const REFRESH_COOLDOWN_MS = 60_000;

/** For tests. */
export function forgetDispatches(): void {
  lastDispatch.clear();
  pretendRuns.clear();
}

/**
 * POST /api/registry/refresh with exactly `{"branch": "integration" | "main"}`. Hardened like /api/desk/flags: same
 * origin, JSON, at most 256 bytes, Vercel's bypass refused, no CORS. It starts the registry job only (the job, the
 * repository and the ref are fixed in ./registry-github), never while a run is under way or within a minute of the last.
 */
export async function handleRegistryRefresh(req: Request, deps: RegistryDeps = liveDeps): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method" });
  if (presentsBypass(req)) return json(403, { error: "forbidden" });
  if (!sameOrigin(req)) return json(403, { error: "forbidden" });
  if (!isJson(req.headers.get("content-type"))) return json(415, { error: "content-type" });
  const body = await readCapped(req, 256);
  if (body === "too-large") return json(413, { error: "too-large" });
  if (body === "bad") return json(400, { error: "body" });
  let branch: unknown;
  try {
    const v = JSON.parse(body.text) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v) || Object.keys(v).join(",") !== "branch") return json(400, { error: "body" });
    branch = (v as { branch: unknown }).branch;
  } catch {
    return json(400, { error: "body" });
  }
  if (!isRegistryBranch(branch)) return json(400, { error: "branch" });

  const nowMs = deps.now();
  const prev = lastDispatch.get(branch);
  if (prev !== undefined && nowMs - prev < REFRESH_COOLDOWN_MS) {
    return json(429, { error: "cooldown", retry_after_s: Math.ceil((REFRESH_COOLDOWN_MS - (nowMs - prev)) / 1000) });
  }
  const state = await registryState(branch, deps);
  if (state.status.state === "syncing") return json(409, { error: "already-syncing", ...statusBody(state) });
  if (state.status.reason === "no-token" || state.status.reason === "unauthorized") return json(503, { error: state.status.reason });

  lastDispatch.set(branch, nowMs);
  if (deps.dry) {
    pretendRuns.set(branch, nowMs);
    logEvent("registry.refresh", { outcome: "pretend", branch });
    return json(202, { status: "dispatched", pretend: true, branch });
  }
  const r = await deps.dispatch(branch);
  logEvent("registry.refresh", { outcome: r.ok ? "dispatched" : r.reason, branch });
  if (!r.ok) {
    lastDispatch.delete(branch);
    return json(r.reason === "rate-limited" ? 429 : 502, { error: r.reason });
  }
  return json(202, { status: "dispatched", branch });
}
