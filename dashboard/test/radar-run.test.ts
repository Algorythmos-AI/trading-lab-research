import { beforeEach, describe, expect, it, vi } from "vitest";
import { RADAR_RUN_PATHS, radarRunPath } from "@/lib/desk";
import { RADAR_RUN_ACCEPTS, radarRunHealth } from "@/lib/editions";
import { ENGINE_VERSION } from "@/lib/engine-version.gen";
import { FEEDS } from "@/lib/feed-watch";
import { sign } from "@/lib/hmac";
import { INGEST_REJECT_KINDS } from "@/lib/ingest-reject";
import type { RadarRunDoc } from "@/lib/radar-run.types";
import { SIGNAL_CODE_HASH } from "@/lib/signal-version.gen";
import { DENY_KEYS, isRadar, isRadarDesk, isRadarRun, RADAR_RUN_SCHEMA, RADAR_RUN_STAGES, validateRadarRun } from "@/lib/validate";
import runJson from "./fixtures/radar-run.v1.json";

// The Radar run beacon: the pre-market Radar routine sends one when a stage of its run starts and one when it ends,
// signed with the radar's key. Times, ids, closed codes, booleans and integers only: no free text and nothing of an
// edition. Display only. The site keeps the newest beacon per session and stage. The fixture is synthetic.

const blob = vi.hoisted(() => {
  class PreconditionFailed extends Error {}
  const store = new Map<string, { text: string; etag: string }>();
  let seq = 0;
  return {
    store,
    PreconditionFailed,
    /** Paths whose read throws, as a failing store would. */
    broken: new Set<string>(),
    reset() {
      store.clear();
      this.broken.clear();
      seq = 0;
    },
    put(pathname: string, text: string) {
      const etag = `"e${++seq}"`;
      store.set(pathname, { text, etag });
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
  readText: vi.fn(async (pathname: string) => {
    if (blob.broken.has(pathname)) throw new Error("store down");
    return blob.store.get(pathname) ?? null;
  }),
  readForUpdate: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  writeText: vi.fn(async (pathname: string, body: string, opts: { ifMatch?: string | null; createOnly?: boolean } = {}) => {
    const cur = blob.store.get(pathname);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    if (opts.createOnly && cur) throw new blob.PreconditionFailed();
    return { etag: blob.put(pathname, body) };
  }),
}));

const { handleIngest } = await import("@/lib/ingest");
const { loadRadarRun, loadRadarRunLatest, parseRadarRun } = await import("@/lib/snapshot");
const healthRoute = await import("@/app/api/health/route");

const RADAR_SECRET = "test-radar-secret";
const HOST_SECRET = "test-host-secret";
// Monday 2026-10-12, 07:10 New York (EDT): the fixture's build stage ended at 11:04 UTC.
const NOW = new Date("2026-10-12T11:10:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const SESSION = "2026-10-12";
const doc = (mutate?: (d: RadarRunDoc) => void): RadarRunDoc => {
  const d = structuredClone(runJson) as unknown as RadarRunDoc;
  mutate?.(d);
  return d;
};
/** The same stage as it starts: nothing ended yet. */
const started = (mutate?: (d: RadarRunDoc) => void): RadarRunDoc =>
  doc((d) => {
    d.run_id = "radar-2026-10-12-build-start";
    d.state = "started";
    d.as_of = "2026-10-12T10:52:04Z";
    d.ended_at = null;
    d.exit_code = null;
    delete d.reason;
    mutate?.(d);
  });
const loose = (v: unknown) => v as Record<string, unknown>;
const stored = (path: string) => JSON.parse(blob.store.get(path)!.text) as RadarRunDoc;

function post(body: unknown, keyId = "radar", secret = RADAR_SECRET): Request {
  const text = JSON.stringify(body);
  return new Request("https://lab.example/api/ingest", {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      "x-wt-timestamp": String(NOW_S),
      "x-wt-signature": sign(secret, NOW_S, Buffer.from(text, "utf8")),
      "x-wt-key-id": keyId,
    },
  });
}
const send = async (body: unknown, keyId?: string, secret?: string) => {
  const res = await handleIngest(post(body, keyId, secret), NOW);
  return { status: res.status, body: (await res.json()) as { status?: string; errors?: string[] } };
};

beforeEach(() => {
  blob.reset();
  vi.unstubAllEnvs();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  // The loaders are read from the store here, whatever mode the suite runs in (CI sets DASHBOARD_FIXTURE=1).
  vi.stubEnv("DASHBOARD_FIXTURE", "");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", HOST_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});

describe("the Radar run beacon's contract", () => {
  it("takes the fixture, and is taken for no other Radar document", () => {
    expect(RADAR_RUN_SCHEMA).toBe("stocksdelta/radar-run");
    expect(isRadarRun(doc())).toBe(true);
    expect(isRadar(doc())).toBe(false);
    expect(isRadarDesk(doc())).toBe(false);
    const r = validateRadarRun(doc());
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("takes a beacon with only what is required, and one whose stage is still running", () => {
    const bare = doc((d) => {
      delete d.ended_at;
      delete d.exit_code;
      delete d.reason;
      delete d.checks;
    });
    expect(validateRadarRun(bare).ok).toBe(true);
    expect(validateRadarRun(started()).ok).toBe(true);
    expect(validateRadarRun(doc((d) => (d.checks = {}))).ok).toBe(true);
    expect(validateRadarRun(doc((d) => (d.exit_code = -1))).ok).toBe(true);
    expect(validateRadarRun(doc((d) => (d.exit_code = 255))).ok).toBe(true);
  });

  it("every stage, state, trigger and reason the routine has is taken; the stages are in its order", () => {
    expect(RADAR_RUN_STAGES).toEqual(["build", "send", "evidence", "desk"]);
    for (const stage of RADAR_RUN_STAGES) expect(validateRadarRun(doc((d) => (d.stage = stage))).ok).toBe(true);
    for (const state of ["started", "finished", "failed", "skipped"] as const) expect(validateRadarRun(doc((d) => (d.state = state))).ok).toBe(true);
    for (const trigger of ["scheduled", "catch-up", "manual"] as const) expect(validateRadarRun(doc((d) => (d.trigger = trigger))).ok).toBe(true);
    for (const reason of ["no-session", "already-stored", "tools-missing", "blocked", "not-stored", "late-start", "lock-held", "ok"] as const) {
      expect(validateRadarRun(doc((d) => (d.reason = reason))).ok).toBe(true);
    }
  });

  it("refuses a missing required field", () => {
    for (const key of ["schema", "schema_version", "run_id", "as_of", "session", "stage", "state", "trigger", "started_at"]) {
      const d = loose(doc());
      delete d[key];
      expect(validateRadarRun(d).ok, key).toBe(false);
    }
  });

  it("refuses an unknown field at either level", () => {
    const refused = [
      doc((d) => Object.assign(d, { note: "x" })),
      doc((d) => Object.assign(d, { tickers: ["AAPL"] })),
      doc((d) => Object.assign(d, { host: "runner-1" })),
      doc((d) => Object.assign(d.checks!, { alpaca: true })),
    ];
    for (const d of refused) expect(validateRadarRun(d).ok).toBe(false);
  });

  it("refuses a stage, state, trigger or reason outside its list", () => {
    const refused = [
      doc((d) => (loose(d).stage = "publish")),
      doc((d) => (loose(d).stage = "Build")),
      doc((d) => (loose(d).state = "running")),
      doc((d) => (loose(d).state = "ok")),
      doc((d) => (loose(d).trigger = "cron")),
      doc((d) => (loose(d).reason = "timeout")),
      doc((d) => (loose(d).reason = null)),
      doc((d) => (loose(d).schema_version = 2)),
    ];
    for (const d of refused) expect(validateRadarRun(d).ok).toBe(false);
  });

  it("refuses free text in every string it carries", () => {
    const refused = [
      doc((d) => (d.run_id = "the build failed on AAPL news")),
      doc((d) => (d.run_id = "")),
      doc((d) => (d.run_id = "r".repeat(201))),
      doc((d) => (d.as_of = "this morning")),
      doc((d) => (d.as_of = "2026-10-12 11:04")),
      doc((d) => (d.as_of = "2026-10-12")),
      doc((d) => (d.started_at = "about 06:52 New York")),
      doc((d) => (d.ended_at = "never, it crashed")),
      doc((d) => (d.session = "Monday")),
      doc((d) => (d.session = "2026-10-12 pre-market")),
      doc((d) => (loose(d).reason = "the broker gateway was down")),
      doc((d) => (loose(d).exit_code = "1")),
      doc((d) => (loose(d).exit_code = 1.5)),
      doc((d) => (d.exit_code = 256)),
      doc((d) => (d.exit_code = -2)),
      doc((d) => (loose(d.checks).ibkr = "down since 06:00")),
      doc((d) => (loose(d).checks = "all good")),
    ];
    for (const d of refused) expect(validateRadarRun(d).ok, JSON.stringify(d)).toBe(false);
  });

  it("the denylist refuses each of its keys inside this document, by name", () => {
    expect([...DENY_KEYS].sort()).toEqual(["catalyst_category", "catalyst_headline", "headlines", "review_url", "setup", "statement", "subject"]);
    for (const key of DENY_KEYS) {
      const r = validateRadarRun(doc((d) => Object.assign(d, { [key]: "x" })));
      expect(!r.ok && r.errors.some((e) => e === `/${key}: key is not allowed to be published`), key).toBe(true);
      const inner = validateRadarRun(doc((d) => Object.assign(d.checks!, { [key]: true })));
      expect(!inner.ok && inner.errors.some((e) => e === `/checks/${key}: key is not allowed to be published`), key).toBe(true);
    }
    // none of the contract's own field names is one of them
    for (const key of [...Object.keys(doc()), ...Object.keys(doc().checks!)]) expect(DENY_KEYS.has(key)).toBe(false);
  });
});

describe("POST /api/ingest with a Radar run beacon", () => {
  const BUILD = radarRunPath(SESSION, "build");

  it("the radar's key stores it under its session and stage, and as the newest beacon", async () => {
    const r = await send(doc());
    expect(r).toEqual({ status: 200, body: { status: "stored", run_id: doc().run_id } });
    expect(BUILD).toBe("radar-run/2026-10-12/build.json");
    expect([...blob.store.keys()].sort()).toEqual([BUILD, RADAR_RUN_PATHS.latest].sort());
    expect(stored(BUILD)).toEqual(doc());
    expect(stored(RADAR_RUN_PATHS.latest)).toEqual(doc());
  });

  it("the same beacon again is a duplicate, and nothing is written", async () => {
    await send(doc());
    const before = blob.store.get(BUILD)!.etag;
    expect(await send(doc())).toEqual({ status: 200, body: { status: "duplicate", run_id: doc().run_id } });
    expect(blob.store.get(BUILD)!.etag).toBe(before);
  });

  it("a stage's end replaces its start", async () => {
    expect((await send(started())).body.status).toBe("stored");
    expect(stored(BUILD).state).toBe("started");
    expect((await send(doc())).body.status).toBe("stored");
    expect(stored(BUILD)).toEqual(doc());
    expect(stored(RADAR_RUN_PATHS.latest).state).toBe("finished");
  });

  it("an end that keeps its start's run_id is stored, not answered as a duplicate", async () => {
    const start = started((d) => (d.run_id = "radar-2026-10-12-build"));
    const end = doc((d) => (d.run_id = "radar-2026-10-12-build"));
    await send(start);
    expect((await send(end)).body.status).toBe("stored");
    expect(stored(BUILD).state).toBe("finished");
    // and written in the very same second as its start, the end still wins; the start never takes it back
    blob.reset();
    const sameSecond = { ...end, as_of: start.as_of };
    await send(start);
    expect((await send(sameSecond)).body.status).toBe("stored");
    expect(stored(BUILD).state).toBe("finished");
    expect((await send(start)).status).toBe(409);
    expect(stored(BUILD).state).toBe("finished");
  });

  it("an older beacon never replaces a newer one", async () => {
    await send(doc());
    const late = await send(started());
    expect(late).toEqual({ status: 409, body: { status: "older", run_id: started().run_id } });
    expect(stored(BUILD)).toEqual(doc());
    expect(stored(RADAR_RUN_PATHS.latest)).toEqual(doc());
    // another run at the very same instant does not replace it either
    expect((await send(doc((d) => (d.run_id = "another-run")))).status).toBe(409);
  });

  it("each stage has its own slot: a stage's late end is stored after the next stage has started", async () => {
    const sendStarted = started((d) => {
      d.stage = "send";
      d.run_id = "radar-2026-10-12-send-start";
      d.as_of = "2026-10-12T11:05:00Z";
      d.started_at = "2026-10-12T11:05:00Z";
    });
    await send(started());
    await send(sendStarted);
    // the build's end, written before the send started, arrives last
    expect((await send(doc())).body.status).toBe("stored");
    expect(stored(BUILD).state).toBe("finished");
    expect(stored(radarRunPath(SESSION, "send"))).toEqual(sendStarted);
    // the newest beacon of any stage is still the send's
    expect(stored(RADAR_RUN_PATHS.latest)).toEqual(sendStarted);
  });

  it("another session's beacon leaves this session's alone", async () => {
    await send(doc());
    const friday = doc((d) => {
      d.session = "2026-10-09";
      d.run_id = "radar-2026-10-09-build-catch-up";
      d.trigger = "catch-up";
    });
    expect((await send(friday)).body.status).toBe("stored");
    expect(stored(BUILD)).toEqual(doc());
    expect(stored(radarRunPath("2026-10-09", "build"))).toEqual(friday);
  });

  it("an invalid beacon is refused, nothing is stored and no refusal is recorded for the feed watch", async () => {
    const r = await send(doc((d) => Object.assign(d, { note: "the gateway was down" })));
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual(['/: unknown key "note"']);
    expect((await send(doc((d) => (loose(d).stage = "publish")))).status).toBe(422);
    expect((await send(doc((d) => Object.assign(d, { subject: "x" })))).status).toBe(422);
    expect(blob.store.size).toBe(0);
  });

  it("a beacon dated ahead of the clock is refused; a time that is no instant is too", async () => {
    expect((await send(doc((d) => (d.as_of = "2026-10-12T11:30:00Z")))).status).toBe(422);
    expect((await send(doc((d) => (d.as_of = "2026-10-12T25:61:00Z")))).status).toBe(422);
    expect(blob.store.size).toBe(0);
    // within the clock's allowance it is taken
    expect((await send(doc((d) => (d.as_of = "2026-10-12T11:15:00Z")))).status).toBe(200);
  });

  it("a stored beacon dated ahead of the clock gives way to a true one", async () => {
    blob.put(BUILD, JSON.stringify(doc((d) => ((d.as_of = "2026-10-13T11:04:10Z"), (d.run_id = "ahead")))));
    expect((await send(doc())).body.status).toBe("stored");
    expect(stored(BUILD)).toEqual(doc());
  });

  it("a wrong signature is 401 and stores nothing", async () => {
    const r = await send(doc(), "radar", "not-the-secret");
    expect(r).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(blob.store.size).toBe(0);
  });

  it("the trading host's key may store it too, as for the Radar desk file; a key scoped to a desk may not", async () => {
    expect((await send(doc(), "default", HOST_SECRET)).status).toBe(200);
    blob.reset();
    vi.stubEnv("DASHBOARD_INGEST_KEYS", JSON.stringify({ "hft-pub": "test-hft-secret" }));
    vi.stubEnv("DASHBOARD_INGEST_SCOPES", JSON.stringify({ "hft-pub": { desks: ["hft"] } }));
    const r = await send(doc(), "hft-pub", "test-hft-secret");
    expect(r).toEqual({ status: 403, body: { error: "this key may not publish this document" } });
    expect(blob.store.size).toBe(0);
    // an unknown key id has no secret
    expect((await send(doc(), "nobody", RADAR_SECRET)).status).toBe(401);
    expect(blob.store.size).toBe(0);
  });

  it("a write that loses the race twice is a conflict, and the stage's file is not half-replaced", async () => {
    await send(started());
    const { writeText } = await import("@/lib/blob");
    vi.mocked(writeText).mockRejectedValueOnce(new blob.PreconditionFailed()).mockRejectedValueOnce(new blob.PreconditionFailed());
    expect((await send(doc())).status).toBe(503);
    expect(stored(BUILD).state).toBe("started");
    // lost once only: the retry stores it
    vi.mocked(writeText).mockRejectedValueOnce(new blob.PreconditionFailed());
    expect((await send(doc())).body.status).toBe("stored");
    expect(stored(BUILD).state).toBe("finished");
  });

  it("the newest-beacon copy failing does not change the answer", async () => {
    const { writeText } = await import("@/lib/blob");
    const real = vi.mocked(writeText).getMockImplementation()!;
    vi.mocked(writeText).mockImplementation(async (pathname, body, opts) => {
      if (pathname === RADAR_RUN_PATHS.latest) throw new Error("store down");
      return real(pathname, body, opts);
    });
    expect(await send(doc())).toEqual({ status: 200, body: { status: "stored", run_id: doc().run_id } });
    expect([...blob.store.keys()]).toEqual([BUILD]);
    vi.mocked(writeText).mockImplementation(real);
  });
});

describe("health", () => {
  it("advertises the format it accepts, and the newest beacon by its run only", () => {
    expect(RADAR_RUN_ACCEPTS).toBe(1);
    const h = radarRunHealth({ status: "ok", doc: doc(), source: "blob" });
    expect(h).toEqual({ status: "ok", accepts: 1, session: SESSION, run_id: doc().run_id, as_of: doc().as_of, schema_version: 1 });
    expect(radarRunHealth({ status: "missing" })).toEqual({ status: "missing", accepts: 1, session: null, run_id: null, as_of: null, schema_version: null });
    expect(radarRunHealth({ status: "error" })).toMatchObject({ status: "error", accepts: 1, run_id: null });
  });

  it("GET /api/health carries editions.radar_run, missing before the first beacon and ok after it", async () => {
    type Health = { editions: Record<string, { status: string; accepts: number; run_id: string | null }> };
    const health = async () => (await (await healthRoute.GET()).json()) as Health;
    const before = await health();
    expect(before.editions.radar_run).toEqual({ status: "missing", accepts: 1, session: null, run_id: null, as_of: null, schema_version: null });
    // added after every older edition, so none of them moves
    expect(Object.keys(before.editions).at(-1)).toBe("radar_run");
    expect(before.editions.radar_desk).toMatchObject({ status: "missing", accepts: 1 });
    await send(doc());
    expect((await health()).editions.radar_run).toEqual({ status: "ok", accepts: 1, session: SESSION, run_id: doc().run_id, as_of: doc().as_of, schema_version: 1 });
  });

  it("is not watched yet: no feed row, and no refusal kind (a kind there must have a row)", () => {
    expect(FEEDS.some((f) => f.id.startsWith("radar-run"))).toBe(false);
    expect((INGEST_REJECT_KINDS as readonly string[]).includes("radar-run")).toBe(false);
  });
});

describe("the reader", () => {
  const sendStage = (stage: RadarRunDoc["stage"], state: RadarRunDoc["state"], asOf: string) =>
    send(
      doc((d) => {
        d.stage = stage;
        d.state = state;
        d.run_id = `radar-${SESSION}-${stage}-${state}`;
        d.as_of = asOf;
        if (state === "started") {
          d.ended_at = null;
          d.exit_code = null;
          delete d.reason;
        }
      }),
    );

  it("returns the stages on file for the session, in the routine's order", async () => {
    await sendStage("send", "started", "2026-10-12T11:05:00Z");
    await sendStage("build", "started", "2026-10-12T10:52:04Z");
    await sendStage("build", "finished", "2026-10-12T11:04:10Z");
    const r = await loadRadarRun(SESSION);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r).toMatchObject({ session: SESSION, source: "blob" });
    expect(r.stages.map((s) => [s.stage, s.state])).toEqual([
      ["build", "finished"],
      ["send", "started"],
    ]);
  });

  it("is missing for a session with no beacon, and for anything that is not a date", async () => {
    await sendStage("build", "finished", "2026-10-12T11:04:10Z");
    expect(await loadRadarRun("2026-10-13")).toEqual({ status: "missing" });
    for (const bad of ["", "latest", "../radar", "2026-10-12/build", "2026-10-12.json"]) expect(await loadRadarRun(bad)).toEqual({ status: "missing" });
    expect(await loadRadarRun(undefined as unknown as string)).toEqual({ status: "missing" });
  });

  it("leaves out a stage whose file is not a beacon, or is filed under another session or stage", async () => {
    await sendStage("build", "finished", "2026-10-12T11:04:10Z");
    blob.put(radarRunPath(SESSION, "send"), "not json");
    blob.put(radarRunPath(SESSION, "evidence"), JSON.stringify(doc((d) => Object.assign(d, { stage: "evidence", note: "free text" }))));
    blob.put(radarRunPath(SESSION, "desk"), JSON.stringify(doc((d) => (d.stage = "build"))));
    const r = await loadRadarRun(SESSION);
    expect(r.status === "ok" && r.stages.map((s) => s.stage)).toEqual(["build"]);
    blob.put(radarRunPath(SESSION, "build"), JSON.stringify(doc((d) => (d.session = "2026-10-09"))));
    expect(await loadRadarRun(SESSION)).toEqual({ status: "missing" });
  });

  it("a failing store is an error only when no stage could be read", async () => {
    await sendStage("build", "finished", "2026-10-12T11:04:10Z");
    blob.broken.add(radarRunPath(SESSION, "send"));
    const partial = await loadRadarRun(SESSION);
    expect(partial.status === "ok" && partial.stages.map((s) => s.stage)).toEqual(["build"]);
    for (const stage of RADAR_RUN_STAGES) blob.broken.add(radarRunPath(SESSION, stage));
    expect(await loadRadarRun(SESSION)).toEqual({ status: "error" });
  });

  it("parseRadarRun takes a stored beacon and nothing else", () => {
    expect(parseRadarRun(JSON.stringify(doc()))).toEqual(doc());
    expect(parseRadarRun(JSON.stringify(doc()), SESSION, "build")).toEqual(doc());
    expect(parseRadarRun(JSON.stringify(doc()), SESSION, "send")).toBeNull();
    expect(parseRadarRun("[]")).toBeNull();
    expect(parseRadarRun("null")).toBeNull();
    expect(parseRadarRun("")).toBeNull();
  });

  it("the newest beacon is read back for health; one that is not a beacon is an error", async () => {
    expect(await loadRadarRunLatest()).toEqual({ status: "missing" });
    await sendStage("build", "finished", "2026-10-12T11:04:10Z");
    expect(await loadRadarRunLatest()).toMatchObject({ status: "ok", source: "blob", doc: { stage: "build", state: "finished" } });
    blob.put(RADAR_RUN_PATHS.latest, "{}");
    expect(await loadRadarRunLatest()).toEqual({ status: "error" });
    blob.broken.add(RADAR_RUN_PATHS.latest);
    expect(await loadRadarRunLatest()).toEqual({ status: "error" });
  });

  it("in fixture mode returns the fixture's one stage for its session, and never on production", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await loadRadarRun(SESSION)).toEqual({ status: "ok", session: SESSION, stages: [doc()], source: "fixture" });
    expect(await loadRadarRun("2026-10-13")).toEqual({ status: "missing" });
    expect(await loadRadarRunLatest()).toEqual({ status: "ok", doc: doc(), source: "fixture" });
    vi.stubEnv("VERCEL_ENV", "production");
    expect(await loadRadarRun(SESSION)).toEqual({ status: "missing" });
  });
});

describe("the beacon's code stays outside the engine and signal hashes", () => {
  it("no radar-run file is in either import closure, and both hashes are unchanged", async () => {
    // @ts-expect-error: a plain .mjs script, no types
    const engine = (await import("../scripts/gen-engine.mjs")) as { engineFiles(): string[]; engineVersion(): string };
    // @ts-expect-error: a plain .mjs script, no types
    const signal = (await import("../scripts/gen-signal.mjs")) as { signalFiles(): string[]; signalHash(): string };
    const files = [...engine.engineFiles(), ...signal.signalFiles()].map((f) => f.replace(/\\/g, "/"));
    expect(files.filter((f) => /\/radar-run[^/]*$/.test(f))).toEqual([]);
    // nor any file this change edits to carry it
    expect(files.filter((f) => /\/(ingest|validate|desk|editions|snapshot)\.ts$/.test(f))).toEqual([]);
    expect(engine.engineVersion()).toBe(ENGINE_VERSION);
    expect(signal.signalHash()).toBe(SIGNAL_CODE_HASH);
  });
});
