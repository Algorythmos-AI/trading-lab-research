// GitHub, read and dispatched on the server for the Reference Registry. The token (GITHUB_REGISTRY_TOKEN, Vercel
// production only) never leaves this file: no answer carries it, no log line names it, the browser never sees it.
// Only three calls exist: the branch head, the registry job's recent runs, and a dispatch of that one job.
import "server-only";
import { logEvent } from "./log";
import type { RegistryBranch } from "./registry-store";
import type { GithubView, RunInfo } from "./registry-status";

export const REGISTRY_REPO = "Algorythmos-AI/trading-lab-research";
export const REGISTRY_WORKFLOW = "registry.yml";
const API = "https://api.github.com";
const TIMEOUT_MS = 5_000;
/** How long a read is shared on this instance. Short, so a page that polls while Syncing sees the run finish. */
export const GITHUB_TTL_MS = 15_000;

type Fetch = typeof fetch;

// On globalThis, so a dispatch from the refresh route clears what the pages' bundle keeps too.
const g = globalThis as { __registryGithubKept?: Map<RegistryBranch, { at: number; view: GithubView }> };
const kept: Map<RegistryBranch, { at: number; view: GithubView }> = (g.__registryGithubKept ??= new Map());

/** For tests, and after a dispatch: forget the kept reads. */
export function forgetGithub(): void {
  kept.clear();
}

function token(): string | null {
  const t = process.env.GITHUB_REGISTRY_TOKEN;
  return t && t.trim() ? t.trim() : null;
}

async function call(path: string, init: RequestInit, f: Fetch): Promise<Response> {
  const t = token();
  return f(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "trading-lab-dashboard",
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
}

/**
 * GitHub answers 403 both when the rate limit is spent and when the token lacks a permission; only the first says
 * `x-ratelimit-remaining: 0` (or sends `retry-after`, for the secondary limit).
 */
function failure(status: number, headers?: Headers): GithubView {
  if (status === 401) return { ok: false, reason: "unauthorized" };
  if (status === 429) return { ok: false, reason: "rate-limited" };
  if (status === 403) {
    const spent = headers?.get("x-ratelimit-remaining") === "0" || headers?.has("retry-after");
    return { ok: false, reason: spent ? "rate-limited" : "forbidden" };
  }
  if (status === 404) return { ok: false, reason: "not-found" };
  return { ok: false, reason: "unreachable" };
}

function runsFrom(body: unknown): RunInfo[] {
  const list = (body as { workflow_runs?: unknown })?.workflow_runs;
  if (!Array.isArray(list)) return [];
  const out: RunInfo[] = [];
  for (const r of list.slice(0, 20)) {
    if (r === null || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    if (typeof x.status !== "string" || typeof x.head_sha !== "string" || typeof x.created_at !== "string") continue;
    out.push({
      status: x.status,
      conclusion: typeof x.conclusion === "string" ? x.conclusion : null,
      head_sha: x.head_sha,
      created_at: x.created_at,
      event: typeof x.event === "string" ? x.event : "unknown",
    });
  }
  return out;
}

/** The branch head and the registry job's recent runs on it, shared for GITHUB_TTL_MS on this instance. */
export async function readGithub(branch: RegistryBranch, f: Fetch = fetch, nowMs: number = Date.now()): Promise<GithubView> {
  if (!token()) return { ok: false, reason: "no-token" };
  const hit = kept.get(branch);
  if (hit && nowMs - hit.at < GITHUB_TTL_MS) return hit.view;
  let view: GithubView;
  try {
    const [b, r] = await Promise.all([
      call(`/repos/${REGISTRY_REPO}/branches/${branch}`, {}, f),
      call(`/repos/${REGISTRY_REPO}/actions/workflows/${REGISTRY_WORKFLOW}/runs?branch=${branch}&per_page=10`, {}, f),
    ]);
    if (!b.ok) view = failure(b.status, b.headers);
    else if (!r.ok) view = failure(r.status, r.headers);
    else {
      const bb = (await b.json()) as { commit?: { sha?: unknown; commit?: { committer?: { date?: unknown } } } };
      const head = bb.commit?.sha;
      const at = bb.commit?.commit?.committer?.date;
      view = typeof head === "string" && /^[0-9a-f]{40}$/.test(head)
        ? { ok: true, head, headAt: typeof at === "string" ? at : null, runs: runsFrom(await r.json()) }
        : { ok: false, reason: "unreachable" };
    }
  } catch (e) {
    view = { ok: false, reason: "unreachable" };
    logEvent("registry.github", { outcome: "error", branch, error: e instanceof Error ? e.name : "unknown" });
  }
  if (!view.ok) logEvent("registry.github", { outcome: view.reason, branch });
  kept.set(branch, { at: nowMs, view });
  return view;
}

export type DispatchResult = { ok: true } | { ok: false; reason: "no-token" | "unauthorized" | "forbidden" | "rate-limited" | "not-found" | "unreachable" };

/** Start the registry job on one branch (workflow_dispatch). The job, the repository and the ref are fixed here. */
export async function dispatchRegistry(branch: RegistryBranch, f: Fetch = fetch): Promise<DispatchResult> {
  if (!token()) return { ok: false, reason: "no-token" };
  try {
    const r = await call(`/repos/${REGISTRY_REPO}/actions/workflows/${REGISTRY_WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: branch }),
    }, f);
    forgetGithub();
    if (r.status === 204 || r.ok) return { ok: true };
    const v = failure(r.status, r.headers);
    return { ok: false, reason: v.ok || v.reason === "no-token" ? "unreachable" : v.reason };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
