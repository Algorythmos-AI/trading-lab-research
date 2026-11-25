import { beforeEach, describe, expect, it, vi } from "vitest";
import { REGISTRY_ACCEPTS } from "@/lib/editions";
import { sign } from "@/lib/hmac";
import type { RegistryIndex } from "@/lib/registry.types";
import { syncStatus, type GithubView, type IndexView } from "@/lib/registry-status";
import { counts, filterRecords, inbound, mainState, neighbours, parseFilters, timeline } from "@/lib/registry-view";
import { REGISTRY_PROSE, isRegistry, validateRegistry } from "@/lib/validate";
import integrationJson from "./fixtures/registry.integration.v1.json";
import mainJson from "./fixtures/registry.main.v1.json";

// The Reference Registry: an index of the research records per branch, built in CI (scripts/build_registry.py) and
// sent signed with the `registry` key. The fixtures are the builder's own output on a made-up repository.

const blob = vi.hoisted(() => {
  class PreconditionFailed extends Error {}
  const store = new Map<string, { text: string; etag: string; at: string }>();
  let seq = 0;
  return {
    store,
    PreconditionFailed,
    broken: new Set<string>(),
    reset() {
      store.clear();
      this.broken.clear();
      seq = 0;
    },
    put(pathname: string, text: string) {
      const etag = `"e${++seq}"`;
      store.set(pathname, { text, etag, at: `2026-10-08T00:00:${String(seq).padStart(2, "0")}.000Z` });
      return etag;
    },
  };
});

vi.mock("@/lib/blob", () => ({
  LATEST_PATH: "snapshots/latest.json",
  SHADOW_LATEST_PATH: "shadow/latest.json",
  HISTORY_PREFIX: "snapshots/history/",
  ALERT_STATE_PATH: "alerts/state.json",
  PreconditionFailed: blob.PreconditionFailed,
  listPaths: vi.fn(async () => []),
  exists: vi.fn(async (p: string) => blob.store.has(p)),
  storedAt: vi.fn(async (p: string) => blob.store.get(p)?.at ?? null),
  storedMeta: vi.fn(async (p: string) => (blob.store.has(p) ? { etag: blob.store.get(p)!.etag, uploadedAt: blob.store.get(p)!.at } : null)),
  readText: vi.fn(async (p: string) => {
    if (blob.broken.has(p)) throw new Error("store down");
    return blob.store.get(p) ?? null;
  }),
  readTextIfChanged: vi.fn(async (p: string) => blob.store.get(p) ?? null),
  readForUpdate: vi.fn(async (p: string) => {
    if (blob.broken.has(p)) throw new Error("store down");
    return blob.store.get(p) ?? null;
  }),
  writeText: vi.fn(async (p: string, body: string, opts: { ifMatch?: string | null; createOnly?: boolean } = {}) => {
    const cur = blob.store.get(p);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    if (opts.createOnly && cur) throw new blob.PreconditionFailed();
    return { etag: blob.put(p, body) };
  }),
}));

const { handleIngest } = await import("@/lib/ingest");
const { loadRegistry, parseChecked, registryFlagsFrom } = await import("@/lib/registry-store");
const { handleRegistryRefresh, handleRegistryStatus, forgetDispatches, fixtureGithub } = await import("@/lib/registry-run");

const REGISTRY_SECRET = "test-registry-secret";
const HOST_SECRET = "test-host-secret";
const RADAR_SECRET = "test-radar-secret";
const NOW = new Date("2026-10-08T00:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const INTEGRATION = integrationJson as unknown as RegistryIndex;
const MAIN = mainJson as unknown as RegistryIndex;
const doc = (base: RegistryIndex = INTEGRATION, mutate?: (d: RegistryIndex) => void): RegistryIndex => {
  const d = structuredClone(base);
  mutate?.(d);
  return d;
};

function post(body: unknown, keyId = "registry", secret = REGISTRY_SECRET): Request {
  const text = JSON.stringify(body);
  return new Request("https://lab.example/api/ingest", {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json", "x-wt-timestamp": String(NOW_S), "x-wt-signature": sign(secret, NOW_S, Buffer.from(text, "utf8")), "x-wt-key-id": keyId },
  });
}
const send = async (body: unknown, keyId?: string, secret?: string) => {
  const res = await handleIngest(post(body, keyId, secret), NOW);
  return { status: res.status, body: (await res.json()) as { status?: string; error?: string; errors?: string[] } };
};

beforeEach(() => {
  blob.reset();
  forgetDispatches();
  vi.unstubAllEnvs();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_FIXTURE", "");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", HOST_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
  vi.stubEnv("REGISTRY_INGEST_SECRET", REGISTRY_SECRET);
});

describe("the registry's contract", () => {
  it("takes both fixtures", () => {
    expect(isRegistry(INTEGRATION)).toBe(true);
    for (const d of [INTEGRATION, MAIN]) {
      const r = validateRegistry(d);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });

  it("is prose off, and refuses record text at any depth while it is", () => {
    expect(REGISTRY_PROSE).toBe(false);
    for (const key of ["title", "summary", "statement", "path", "name"]) {
      const d = doc(INTEGRATION, (x) => ((x.records[0] as unknown as Record<string, unknown>)[key] = "words of a record"));
      const r = validateRegistry(d);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors.join(" ")).toContain(`/records/0/${key}`);
        expect(r.errors.join(" ")).not.toContain("words of a record");
      }
    }
    expect(validateRegistry(doc(INTEGRATION, (x) => ((x as unknown as Record<string, unknown>).prose = true))).ok).toBe(false);
  });

  it("refuses what the schema cannot say: a run id that is not branch@sha, an id twice, a tombstone that is live", () => {
    expect(validateRegistry(doc(INTEGRATION, (x) => (x.run_id = `main@${x.sha}`))).ok).toBe(false);
    expect(validateRegistry(doc(INTEGRATION, (x) => x.records.push(structuredClone(x.records[0]!)))).ok).toBe(false);
    expect(validateRegistry(doc(INTEGRATION, (x) => (x.tombstones[0]!.id = x.records[0]!.id))).ok).toBe(false);
    expect(validateRegistry(doc(INTEGRATION, (x) => ((x.records[0] as unknown as Record<string, unknown>).status = "maybe"))).ok).toBe(false);
    expect(validateRegistry(doc(INTEGRATION, (x) => ((x as unknown as Record<string, unknown>).branch = "feature"))).ok).toBe(false);
  });
});

describe("ingest", () => {
  it("stores each branch in its own slot and reports it on /api/health", async () => {
    expect((await send(INTEGRATION)).body.status).toBe("stored");
    expect((await send(MAIN)).body.status).toBe("stored");
    expect(JSON.parse(blob.store.get("registry/integration/latest.json")!.text).sha).toBe(INTEGRATION.sha);
    expect(JSON.parse(blob.store.get("registry/main/latest.json")!.text).sha).toBe(MAIN.sha);
    const health = await (await import("@/app/api/health/route")).GET();
    const reg = ((await health.json()) as { editions: { registry: { accepts: number; branches: Record<string, { sha: string }> } } }).editions.registry;
    expect(reg.accepts).toBe(REGISTRY_ACCEPTS);
    expect(reg.branches.integration!.sha).toBe(INTEGRATION.sha);
    expect(reg.branches.main!.sha).toBe(MAIN.sha);
    expect(JSON.stringify(reg)).not.toContain("DEC-");
  });

  it("answers a resend as a duplicate and marks it checked; an earlier commit is older", async () => {
    await send(INTEGRATION);
    const first = blob.store.get("registry/integration/latest.json")!.etag;
    const again = await send(INTEGRATION);
    expect(again).toEqual({ status: 200, body: { status: "duplicate", run_id: INTEGRATION.run_id } });
    expect(blob.store.get("registry/integration/latest.json")!.etag).toBe(first);
    expect(parseChecked(blob.store.get("registry/integration/checked.json")!.text, INTEGRATION.run_id)).toBe(NOW.toISOString());
    const older = doc(INTEGRATION, (x) => {
      x.sha = "a".repeat(40);
      x.run_id = `integration@${x.sha}`;
      x.as_of = "2026-10-06T12:00:00Z";
    });
    expect((await send(older)).status).toBe(409);
    expect(JSON.parse(blob.store.get("registry/integration/latest.json")!.text).sha).toBe(INTEGRATION.sha);
  });

  it("takes the registry only from its own key, and the key publishes nothing else", async () => {
    expect((await send(INTEGRATION, "default", HOST_SECRET)).status).toBe(403);
    expect((await send(INTEGRATION, "radar", RADAR_SECRET)).status).toBe(403);
    expect(blob.store.size).toBe(0);
    const snapshot = { schema: "trading-lab/snapshot", run_id: "x", as_of: "2026-10-07T00:00:00Z" };
    const r = await send(snapshot);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("may not publish");
    expect((await send(INTEGRATION, "registry", "wrong-secret")).status).toBe(401);
  });

  it("refuses an invalid index or one ahead of the clock, naming paths, never values", async () => {
    const bad = await send(doc(INTEGRATION, (x) => ((x.records[0] as unknown as Record<string, unknown>).title = "SECRET WORDS")));
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).not.toContain("SECRET WORDS");
    const ahead = await send(doc(INTEGRATION, (x) => (x.as_of = "2026-10-09T00:00:00Z")));
    expect(ahead.status).toBe(422);
    expect(blob.store.size).toBe(0);
  });

  it("reads back what it stored, and an unreadable store or a poisoned document is an error, never shown", async () => {
    await send(INTEGRATION);
    const ok = await loadRegistry("integration");
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.checkedAt).toBe(NOW.toISOString());
    expect((await loadRegistry("main")).status).toBe("missing");
    blob.put("registry/main/latest.json", JSON.stringify({ ...MAIN, records: "nope" }));
    expect((await loadRegistry("main")).status).toBe("error");
  });

  it("does not let a checked record of another run speak for this one", () => {
    expect(parseChecked(JSON.stringify({ run_id: "integration@x", at: "2026-10-08T00:00:00Z" }), INTEGRATION.run_id)).toBeNull();
    expect(parseChecked("not json", INTEGRATION.run_id)).toBeNull();
  });
});

describe("the sync status", () => {
  const index: IndexView = { status: "ok", sha: "a".repeat(40), as_of: "2026-10-07T00:00:00Z", storedAt: "2026-10-07T00:01:00Z", checkedAt: "2026-10-07T05:00:00Z" };
  const gh = (over: Partial<Extract<GithubView, { ok: true }>> = {}): GithubView => ({ ok: true, head: "a".repeat(40), headAt: null, runs: [], ...over });
  const run = (status: string, conclusion: string | null, at = "2026-10-07T06:00:00Z") => ({ status, conclusion, head_sha: "b".repeat(40), created_at: at, event: "push" });

  it("Synced when the index is the head, whatever the runs say, with the later of stored and checked", () => {
    const s = syncStatus(index, gh({ runs: [run("completed", "failure")] }));
    expect(s.state).toBe("synced");
    expect(s.lastSync).toBe("2026-10-07T05:00:00Z");
  });
  it("Syncing when the head moved and a run is queued or running", () => {
    for (const st of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      expect(syncStatus(index, gh({ head: "b".repeat(40), runs: [run(st, null)] })).state).toBe("syncing");
    }
  });
  it("Sync failed when the newest finished run failed", () => {
    for (const c of ["failure", "cancelled", "timed_out", "startup_failure"]) {
      const s = syncStatus(index, gh({ head: "b".repeat(40), runs: [run("completed", c), run("completed", "success", "2026-10-07T01:00:00Z")] }));
      expect(s.state).toBe("sync_failed");
      expect(s.failedAt).toBe("2026-10-07T06:00:00Z");
    }
    // A later success after a failure is not a failure.
    expect(syncStatus(index, gh({ head: "b".repeat(40), runs: [run("completed", "failure", "2026-10-07T01:00:00Z"), run("completed", "success")] })).state).toBe("out_of_date");
  });
  it("Out of date when the head moved and nothing is under way, and when no index has arrived", () => {
    expect(syncStatus(index, gh({ head: "b".repeat(40) })).state).toBe("out_of_date");
    const s = syncStatus({ status: "missing" }, gh());
    expect([s.state, s.reason, s.lastSync]).toEqual(["out_of_date", "no-index", null]);
  });
  it("Can't check, never Synced, when GitHub cannot be asked or the store failed", () => {
    for (const reason of ["no-token", "unauthorized", "unreachable", "rate-limited", "not-found"] as const) {
      const s = syncStatus(index, { ok: false, reason });
      expect([s.state, s.reason, s.headSha]).toEqual(["cant_check", reason, null]);
    }
    expect(syncStatus({ status: "error" }, gh()).state).toBe("cant_check");
  });
});

describe("the routes", () => {
  const deps = (over: Partial<Parameters<typeof handleRegistryRefresh>[1]> = {}) => {
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    return {
      dispatch,
      d: {
        load: async () => ({ status: "ok" as const, doc: INTEGRATION, storedAt: null, checkedAt: null, source: "blob" as const }),
        github: async (): Promise<GithubView> => ({ ok: true, head: "b".repeat(40), headAt: null, runs: [] }),
        dispatch,
        flags: async () => new Set<never>(),
        now: () => NOW.getTime(),
        dry: false,
        ...over,
      },
    };
  };
  const refresh = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://lab.example/api/registry/refresh", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", origin: "https://lab.example", host: "lab.example", "sec-fetch-site": "same-origin", ...headers },
    });

  it("dispatches the job once for a good request, then holds a cooldown", async () => {
    const { d, dispatch } = deps();
    expect((await handleRegistryRefresh(refresh({ branch: "integration" }), d)).status).toBe(202);
    expect(dispatch).toHaveBeenCalledWith("integration");
    expect((await handleRegistryRefresh(refresh({ branch: "integration" }), d)).status).toBe(429);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("starts nothing while a run is under way", async () => {
    const { d, dispatch } = deps({ github: async () => ({ ok: true, head: "b".repeat(40), headAt: null, runs: [{ status: "in_progress", conclusion: null, head_sha: "b".repeat(40), created_at: NOW.toISOString(), event: "push" }] }) });
    const r = await handleRegistryRefresh(refresh({ branch: "main" }), d);
    expect(r.status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses cross-site, the bypass, other bodies and other branches, and dispatches nothing", async () => {
    const { d, dispatch } = deps();
    const cases: [Request, number][] = [
      [refresh({ branch: "integration" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }), 403],
      [refresh({ branch: "integration" }, { "x-vercel-protection-bypass": "x" }), 403],
      [refresh({ branch: "feature" }), 400],
      [refresh({ branch: "integration", ref: "x" }), 400],
      [refresh("x".repeat(300)), 413],
      [refresh({ branch: "integration" }, { "content-type": "text/plain" }), 415],
      [new Request("https://lab.example/api/registry/refresh", { method: "GET" }), 405],
    ];
    for (const [req, code] of cases) expect((await handleRegistryRefresh(req, d)).status).toBe(code);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not try with no token or a refused one", async () => {
    const { d, dispatch } = deps({ github: async () => ({ ok: false, reason: "no-token" }) });
    expect((await handleRegistryRefresh(refresh({ branch: "integration" }), d)).status).toBe(503);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("pretends in dry mode and never calls GitHub", async () => {
    const github = vi.fn();
    const { d, dispatch } = deps({ dry: true, github });
    const r = await handleRegistryRefresh(refresh({ branch: "integration" }), d);
    expect(r.status).toBe(202);
    expect(((await r.json()) as { pretend?: boolean }).pretend).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
    const st = await handleRegistryStatus(new Request("https://lab.example/api/registry/status?b=integration", { headers: { "sec-fetch-site": "same-origin" } }), d);
    expect(((await st.json()) as { state: string }).state).toBe("syncing");
  });

  it("status answers codes and SHAs only, and refuses the bypass and unknown branches", async () => {
    const { d } = deps();
    const r = await handleRegistryStatus(new Request("https://lab.example/api/registry/status?b=main", { headers: { "sec-fetch-site": "same-origin" } }), d);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.state).toBe("out_of_date");
    expect(Object.keys(body).sort()).toEqual(["branch", "failed_at", "head_at", "head_sha", "index_run_id", "index_sha", "label", "last_sync", "reason", "sentence", "state"]);
    expect(JSON.stringify(body)).not.toMatch(/DEC-|HYP-|token/i);
    expect((await handleRegistryStatus(new Request("https://lab.example/api/registry/status?b=x"), d)).status).toBe(400);
    expect((await handleRegistryStatus(new Request("https://lab.example/api/registry/status?x-vercel-protection-bypass=1"), d)).status).toBe(403);
  });

  it("fixture GitHub bends to the flags", () => {
    const load = { status: "ok" as const, doc: INTEGRATION, storedAt: null, checkedAt: null, source: "fixture" as const };
    const st = (flags: string) => syncStatus({ status: "ok", sha: INTEGRATION.sha, as_of: INTEGRATION.as_of, storedAt: null, checkedAt: null }, fixtureGithub(load, registryFlagsFrom(flags), "main", NOW.getTime())).state;
    expect(st("")).toBe("synced");
    expect(st("registry-syncing")).toBe("syncing");
    expect(st("registry-failed")).toBe("sync_failed");
    expect(st("registry-stale")).toBe("out_of_date");
    expect(st("registry-unknown")).toBe("cant_check");
    expect([...registryFlagsFrom("empty.error.nonsense")].sort()).toEqual(["registry-off", "registry-poison"]);
  });
});

describe("what the pages draw", () => {
  it("counts by kind and phase, and nothing new in a week long past", () => {
    const c = counts(INTEGRATION, Date.parse("2026-12-01T00:00:00Z"));
    expect(c.byKind).toEqual({ dec: 4, hyp: 4, exp: 3, ll: 1 });
    expect(c.byKindPhase.dec).toEqual({ active: 2, pending: 0, done: 1, other: 1 });
    expect([c.newIn7d, c.changedIn7d, c.conflicts]).toEqual([0, 0, 1]);
    expect(counts(INTEGRATION, Date.parse("2026-10-08T00:00:00Z")).newIn7d).toBe(12);
  });

  it("finds incoming links, the neighbourhood, and the timeline", () => {
    const ins = inbound(INTEGRATION).get("DEC-9001")!;
    expect(ins).toContainEqual({ type: "amends", from: "DEC-9003" });
    expect(ins).toContainEqual({ type: "decision", from: "HYP-9001" });
    const n = neighbours(INTEGRATION, "DEC-9001").map((x) => x.id);
    expect(n).toEqual(expect.arrayContaining(["DEC-9003", "EXP-9001", "HYP-9001", "LL-9001"]));
    expect(n).not.toContain("DEC-9001");
    expect(timeline(INTEGRATION)).toEqual([{ month: "2026-10", byKind: { dec: 4, hyp: 4, exp: 3, ll: 1 }, total: 12 }]);
  });

  it("says how each integration record stands against main", () => {
    const rec = (id: string) => INTEGRATION.records.find((r) => r.id === id)!;
    expect(mainState(rec("DEC-9003"), MAIN)).toBe("on_main");
    expect(mainState(rec("DEC-9001"), MAIN)).toBe("changed");
    expect(mainState(rec("HYP-9005"), MAIN)).toBe("not_on_main");
    expect(mainState(rec("HYP-9005"), null)).toBe("unknown");
  });

  it("filters by the address, ignoring what it does not know", () => {
    expect(filterRecords(INTEGRATION, parseFilters({ k: "hyp" })).map((r) => r.id)).toEqual(["HYP-9001", "HYP-9003", "HYP-9004", "HYP-9005"]);
    expect(filterRecords(INTEGRATION, parseFilters({ p: "done" })).map((r) => r.id)).toEqual(["DEC-9004"]);
    expect(filterRecords(INTEGRATION, parseFilters({ i: "1" })).map((r) => r.id)).toEqual(["DEC-9005", "HYP-9003", "HYP-9004", "HYP-9005"]);
    expect(filterRecords(INTEGRATION, parseFilters({ q: "exp-9001" })).map((r) => r.id)).toEqual(["DEC-9001", "HYP-9001", "EXP-9001"]);
    expect(filterRecords(INTEGRATION, parseFilters({ f: "Z" })).map((r) => r.id)).toEqual(["DEC-9001", "DEC-9004", "HYP-9001", "HYP-9004", "HYP-9005"]); // HYP-9003 cannot be read, so its family is not known
    expect(parseFilters({ k: "<script>", s: "nope", f: "x".repeat(40) })).toMatchObject({ kind: null, status: null, family: null });
  });
});
