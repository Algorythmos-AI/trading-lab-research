import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/hmac";
import { OPTIONS_LIVE_SCHEMA } from "@/lib/validate";

// In-memory stand-in for the private Blob store, with etags, and a switch that makes the reject record's write
// fail or hang.
const blob = vi.hoisted(() => {
  class PreconditionFailed extends Error {}
  const store = new Map<string, { text: string; etag: string }>();
  /** When each path was last written, by a clock the tests set. */
  const uploaded = new Map<string, string>();
  const clock = { now: "2026-11-11T15:00:00.000Z" };
  let seq = 0;
  const state = { rejects: "ok" as "ok" | "fail" | "hang", reads: "ok" as "ok" | "fail" };
  return {
    store,
    uploaded,
    clock,
    state,
    PreconditionFailed,
    reset() {
      store.clear();
      uploaded.clear();
      clock.now = "2026-11-11T15:00:00.000Z";
      seq = 0;
      state.rejects = "ok";
      state.reads = "ok";
    },
    put(pathname: string, text: string) {
      const etag = `"e${++seq}"`;
      store.set(pathname, { text, etag });
      uploaded.set(pathname, clock.now);
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
  readText: vi.fn(async (pathname: string) => {
    if (blob.state.reads === "fail") throw new Error("store down");
    return blob.store.get(pathname) ?? null;
  }),
  storedAt: vi.fn(async (pathname: string) => {
    if (blob.state.reads === "fail") throw new Error("store down");
    return blob.uploaded.get(pathname) ?? null;
  }),
  readForUpdate: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  writeText: vi.fn(async (pathname: string, body: string, opts: { ifMatch?: string | null; createOnly?: boolean } = {}) => {
    if (pathname.startsWith("ops/ingest-rejects/")) {
      if (blob.state.rejects === "fail") throw new Error("store down");
      if (blob.state.rejects === "hang") return new Promise<never>(() => undefined);
    }
    const cur = blob.store.get(pathname);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    if (opts.createOnly && cur) throw new blob.PreconditionFailed();
    return { etag: blob.put(pathname, body) };
  }),
}));

const { handleIngest, EDITION_AHEAD_MS, OPTIONS_LIVE_AHEAD_MS, earliestInstant, isAheadOfClock, orderInstant } = await import("@/lib/ingest");
const { INGEST_REJECT_KINDS, INGEST_REJECT_WRITE_MS, ingestRejectPath, parseIngestReject, readIngestReject, readIngestRejectStatus, rejectIsCurrent } =
  await import("@/lib/ingest-reject");

const DEFAULT_SECRET = "test-default-secret";
const RADAR_SECRET = "test-radar-secret";
const NOW = new Date("2026-11-11T15:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const fixtureOf = (name: string) => () =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.v1.json`), "utf8")) as Record<string, unknown>;

interface Kind {
  kind: (typeof INGEST_REJECT_KINDS)[number];
  /** A valid document of this kind. */
  base: () => Record<string, unknown>;
  latest: string;
  /** The dated copy's path for `base()`, when the kind keeps one. */
  dated?: string;
  /** The research environment's key (true) or the trading host's default key. */
  research: boolean;
}

const KINDS: Kind[] = [
  { kind: "options", base: fixtureOf("options"), latest: "options/latest.json", dated: "options/editions/2026-10-12.json", research: true },
  { kind: "radar", base: fixtureOf("radar"), latest: "radar/latest.json", dated: "radar/editions/2026-09-21.json", research: true },
  { kind: "ledger", base: fixtureOf("ledger"), latest: "ledger/latest.json", dated: "ledger/editions/2026-10-28.json", research: true },
  { kind: "journal", base: fixtureOf("journal"), latest: "journal/latest.json", research: true },
  {
    kind: "options-live",
    base: () => ({ schema: OPTIONS_LIVE_SCHEMA, run_id: "live-1", as_of: "2026-11-11T14:00:00Z", paper: true, positions: [] }),
    latest: "options-live/latest.json",
    research: false,
  },
  { kind: "options-clone", base: fixtureOf("options-clone"), latest: "options-clone/latest.json", research: false },
  { kind: "calendar", base: fixtureOf("calendar"), latest: "calendar/latest.json", research: false },
];

function doc(k: Kind, runId: string, asOf: string | null, mutate?: (d: Record<string, unknown>) => void): Record<string, unknown> {
  const d = k.base();
  d.run_id = runId;
  d.as_of = asOf;
  mutate?.(d);
  return d;
}

function post(k: Kind, body: unknown): Request {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-wt-timestamp": String(NOW_S),
    "x-wt-signature": sign(k.research ? RADAR_SECRET : DEFAULT_SECRET, NOW_S, Buffer.from(text, "utf8")),
  };
  if (k.research) headers["x-wt-key-id"] = "radar";
  return new Request("https://lab.example/api/ingest", { method: "POST", body: text, headers });
}

const send = (k: Kind, body: unknown) => handleIngest(post(k, body), NOW);
const seed = (path: string, d: Record<string, unknown>) => blob.put(path, JSON.stringify(d));
const runIdAt = (path: string) => (JSON.parse(blob.store.get(path)!.text) as { run_id: string }).run_id;
const events = () => log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
const outcomes = () => events().filter((e) => e.evt === "ingest").map((e) => e.outcome);
const documents = () => [...blob.store.keys()].filter((p) => !p.startsWith("ops/")).sort();

let log: { mock: { calls: unknown[][] } };
beforeEach(() => {
  blob.reset();
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", DEFAULT_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the allowance", () => {
  it("is the host documents' ten minutes, for every edition", () => {
    expect(EDITION_AHEAD_MS).toBe(OPTIONS_LIVE_AHEAD_MS);
    expect(EDITION_AHEAD_MS).toBe(10 * 60_000);
  });

  it("reads every form that carries a zone exactly, and only a date or a zoneless wall time as early as any zone could mean it", () => {
    const exact = Date.parse("2026-11-11T15:00:00Z");
    for (const zoned of [
      "2026-11-11T15:00:00Z",
      "2026-11-12T02:00:00+11:00",
      "2026-11-11T15:00Z",
      "2026-11-11 15:00:00+00:00", // Python's str(datetime)
      "2026-11-11T15:00:00+0000",
      "2026-11-11T15:00:00z",
      "2026-11-11t15:00:00Z",
      "Wed, 11 Nov 2026 15:00:00 GMT",
    ]) {
      expect(earliestInstant(zoned), zoned).toBe(exact);
      expect(orderInstant(zoned), zoned).toBe(exact);
    }
    // Never this server's zone: the same answer wherever it runs; ordered as UTC, guarded 14 hours earlier.
    expect(orderInstant("2026-11-12")).toBe(Date.parse("2026-11-12T00:00:00Z"));
    expect(earliestInstant("2026-11-12")).toBe(Date.parse("2026-11-11T10:00:00Z"));
    expect(orderInstant("2026-11-12T02:00:00")).toBe(Date.parse("2026-11-12T02:00:00Z"));
    expect(orderInstant("2026-11-12 02:00:00")).toBe(Date.parse("2026-11-12T02:00:00Z"));
    expect(earliestInstant("2026-11-12T02:00:00")).toBe(Date.parse("2026-11-11T12:00:00Z"));
    expect(earliestInstant("2026-11-12 02:00:00")).toBe(Date.parse("2026-11-11T12:00:00Z"));
    expect(earliestInstant("not a time")).toBeNull();
    expect(isAheadOfClock(null, NOW.getTime())).toBe(false);
    expect(isAheadOfClock("not a time", NOW.getTime())).toBe(false);
  });
});

describe.each(KINDS)("an edition dated ahead of the clock: $kind", (k) => {
  it("is taken just inside the allowance and exactly at it", async () => {
    expect(await (await send(k, doc(k, "inside", at(EDITION_AHEAD_MS - 1000)))).json()).toEqual({ status: "stored", run_id: "inside" });
    blob.reset();
    expect(await (await send(k, doc(k, "boundary", at(EDITION_AHEAD_MS)))).json()).toEqual({ status: "stored", run_id: "boundary" });
    expect(runIdAt(k.latest)).toBe("boundary");
  });

  it("is refused just beyond it with 422 ahead-of-clock, nothing stored but the refusal's record", async () => {
    const res = await send(k, doc(k, "beyond", at(EDITION_AHEAD_MS + 1000)));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid", errors: ["/as_of: is ahead of the server's clock"] });
    expect(outcomes()).toEqual(["ahead-of-clock"]);
    expect(documents()).toEqual([]);
    expect(JSON.parse(blob.store.get(ingestRejectPath(k.kind))!.text)).toEqual({
      at: NOW.toISOString(),
      kind: k.kind,
      outcome: "ahead-of-clock",
      n_errors: 1,
    });
  });

  it("a stored one dated beyond the allowance gives way to a valid current edition, which is then the latest", async () => {
    seed(k.latest, doc(k, "poison", at(24 * 3_600_000)));
    if (k.dated) seed(k.dated, doc(k, "poison", at(24 * 3_600_000)));
    const res = await send(k, doc(k, "true", at(-60_000)));
    expect(await res.json()).toEqual({ status: "stored", run_id: "true" });
    expect(outcomes()).toEqual(["superseded-ahead"]);
    expect(runIdAt(k.latest)).toBe("true");
    if (k.dated) expect(runIdAt(k.dated)).toBe("true");
    // From then on the ordinary rule holds again.
    expect((await send(k, doc(k, "older", at(-120_000)))).status).toBe(409);
    expect(runIdAt(k.latest)).toBe("true");
  });

  it("an ahead edition never takes the place of a poisoned one", async () => {
    seed(k.latest, doc(k, "poison", at(24 * 3_600_000)));
    expect((await send(k, doc(k, "also-ahead", at(3_600_000)))).status).toBe(422);
    expect(runIdAt(k.latest)).toBe("poison");
  });

  it("an ordinary older edition is still refused when the stored one is not ahead, even at the allowance's edge", async () => {
    seed(k.latest, doc(k, "edge", at(EDITION_AHEAD_MS)));
    const res = await send(k, doc(k, "older", at(-60_000)));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "older", run_id: "older" });
    expect(runIdAt(k.latest)).toBe("edge");
    blob.reset();
    seed(k.latest, doc(k, "now", at(0)));
    expect((await send(k, doc(k, "older", at(-60_000)))).status).toBe(409);
    expect(runIdAt(k.latest)).toBe("now");
    expect([...blob.store.keys()].some((p) => p.startsWith("ops/"))).toBe(false);
  });

  it("a duplicate of a poisoned one is still a duplicate, and nothing is recorded", async () => {
    seed(k.latest, doc(k, "poison", at(24 * 3_600_000)));
    expect(await (await send(k, doc(k, "poison", at(-60_000)))).json()).toEqual({ status: "duplicate", run_id: "poison" });
    expect([...blob.store.keys()].some((p) => p.startsWith("ops/"))).toBe(false);
  });
});

describe("the forms of as_of the research editions carry", () => {
  // The options and radar schemas leave as_of free (a string up to 40 characters, or null); the other kinds
  // require a time with its zone.
  const free = KINDS.filter((k) => k.kind === "options" || k.kind === "radar");

  it.each(free)("$kind: a date alone, a zoneless wall time and an offset are taken when some zone has reached them", async (k) => {
    const taken = [
      "2026-11-11", // today
      "2026-11-12", // tomorrow's date, already begun east of UTC+5
      "2026-11-11T09:00:00", // a New York wall time, no zone
      "2026-11-12T02:00:00", // a Sydney wall time, no zone: read as UTC it is 11 hours ahead
      "2026-11-12T02:00:00+11:00",
      "2026-11-11T10:00:00-05:00",
      "2026-11-11T15:05",
    ];
    for (const [i, asOf] of taken.entries()) {
      blob.reset();
      const res = await send(k, doc(k, `r${i}`, asOf));
      expect(res.status, asOf).toBe(200);
    }
  });

  it.each(free)("$kind: a date or a zoneless wall time no zone has reached is refused", async (k) => {
    for (const asOf of ["2026-11-13", "2026-11-12T06:00:00"]) {
      blob.reset();
      const res = await send(k, doc(k, "far", asOf));
      expect(res.status, asOf).toBe(422);
      expect(parseIngestReject(blob.store.get(ingestRejectPath(k.kind))!.text)?.outcome).toBe("ahead-of-clock");
    }
  });

  it.each(free)("$kind: a null as_of is refused as before (it is not a timestamp), and recorded as invalid", async (k) => {
    const res = await send(k, doc(k, "no-time", null));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid", errors: ["/run_id and /as_of must be set; as_of must be a timestamp"] });
    expect(parseIngestReject(blob.store.get(ingestRejectPath(k.kind))!.text)).toEqual({ at: NOW.toISOString(), kind: k.kind, outcome: "invalid", n_errors: 1 });
  });
});

describe("every as_of form, as an incoming edition and as a stored one", () => {
  const options = KINDS.find((k) => k.kind === "options")!;
  const H = 3_600_000;
  // [form, incoming ahead?] at NOW = 2026-11-11T15:00Z.
  const forms: [string, boolean][] = [
    ["2026-11-12 04:00:00+00:00", true], // Python's str(datetime), 13 h ahead
    ["2026-11-11 15:05:00+00:00", false],
    ["2026-11-12T04:00:00+0000", true],
    ["2026-11-11T15:05:00+0000", false],
    ["2026-11-12T04:00:00z", true],
    ["2026-11-11T15:05:00z", false],
    ["Thu, 12 Nov 2026 04:00:00 GMT", true],
    ["2026-11-13", true], // no zone has reached it
    ["2026-11-12", false], // begun east of UTC+5, but ordered as 00:00Z on the 12th: stored, it is ahead
    ["2026-11-11", false],
    ["2026-11-12T06:00:00", true],
    ["2026-11-12T02:00:00", false], // a Sydney wall time, ordered as 02:00Z: stored, it is ahead
    ["2026-11-12 02:00:00", false],
    ["2026-11-11T15:05:00", false],
    [at(EDITION_AHEAD_MS), false],
    [at(EDITION_AHEAD_MS + 1000), true],
  ];

  it.each(forms)("incoming %s: ahead is %s", async (asOf, ahead) => {
    const res = await send(options, doc(options, "in", asOf));
    expect(res.status).toBe(ahead ? 422 : 200);
    if (ahead) expect(outcomes()).toEqual(["ahead-of-clock"]);
  });

  it.each(forms)("stored %s: a true edition at now is stored, directly or by superseding it, unless the stored one is within the allowance", async (asOf) => {
    seed(options.latest, doc(options, "stored", asOf));
    if (options.dated) seed(options.dated, doc(options, "stored", asOf));
    const res = await send(options, doc(options, "true", at(0)));
    const storedOrder = orderInstant(asOf)!;
    // The invariant: a 409 only ever comes from a stored document ordered within now + the allowance.
    if (storedOrder > NOW.getTime() + EDITION_AHEAD_MS) {
      expect(res.status).toBe(200);
      expect(outcomes()).toEqual(["superseded-ahead"]);
      expect(runIdAt(options.latest)).toBe("true");
      if (options.dated) expect(runIdAt(options.dated)).toBe("true");
    } else if (storedOrder < NOW.getTime()) {
      expect(res.status).toBe(200);
      expect(outcomes()).toEqual(["stored"]);
    } else {
      expect(res.status).toBe(409);
      expect(storedOrder).toBeLessThanOrEqual(NOW.getTime() + EDITION_AHEAD_MS);
    }
  });

  it("a stored zoneless or zone-carrying value 13 h ahead never holds up the next true edition", async () => {
    for (const asOf of ["2026-11-12 04:00:00+00:00", "2026-11-12T04:00:00+0000", "2026-11-12T04:00:00z", "2026-11-12", "2026-11-12T02:00:00"]) {
      blob.reset();
      seed(options.latest, doc(options, "stored", asOf));
      expect((await send(options, doc(options, "true", at(-H)))).status, asOf).toBe(200);
      expect(runIdAt(options.latest)).toBe("true");
    }
  });
});

describe("the refusal's record", () => {
  const options = KINDS.find((k) => k.kind === "options")!;
  const radar = KINDS.find((k) => k.kind === "radar")!;
  const recordOf = (kind: Kind["kind"]) => JSON.parse(blob.store.get(ingestRejectPath(kind))!.text) as Record<string, unknown>;

  it("on a schema failure: the time, the kind, the outcome and the number of errors, nothing else", async () => {
    const res = await send(options, doc(options, "bad", at(-60_000), (d) => ((d.private_note = "do-not-record"), (d.other_note = 1))));
    expect(res.status).toBe(422);
    const { errors } = (await res.json()) as { errors: string[] };
    expect(errors.length).toBeGreaterThan(0);
    const rec = recordOf("options");
    expect(Object.keys(rec).sort()).toEqual(["at", "kind", "n_errors", "outcome"]);
    expect(rec).toEqual({ at: NOW.toISOString(), kind: "options", outcome: "invalid", n_errors: errors.length });
    expect(blob.store.get(ingestRejectPath("options"))!.text).not.toMatch(/do-not-record|private_note|other_note/);
    expect(documents()).toEqual([]);
  });

  it("on a denylist failure, without the key or the value", async () => {
    const res = await send(radar, doc(radar, "bad", at(-60_000), (d) => (d.headlines = ["a restricted headline"])));
    expect(res.status).toBe(422);
    const { errors } = (await res.json()) as { errors: string[] };
    expect(errors.join(" ")).toContain("/headlines: key is not allowed to be published");
    const rec = recordOf("radar");
    expect(rec).toEqual({ at: NOW.toISOString(), kind: "radar", outcome: "invalid", n_errors: errors.length });
    expect(blob.store.get(ingestRejectPath("radar"))!.text).not.toMatch(/headline/);
  });

  it("the latest refusal replaces the one before it, per kind", async () => {
    await send(options, doc(options, "bad", at(-60_000), (d) => (d.private_note = 1)));
    await send(options, doc(options, "ahead", at(3_600_000)));
    await send(radar, doc(radar, "ahead", at(3_600_000)));
    expect(recordOf("options")).toMatchObject({ outcome: "ahead-of-clock", n_errors: 1 });
    expect(recordOf("radar")).toMatchObject({ kind: "radar", outcome: "ahead-of-clock" });
  });

  it("is not written for a stored edition, a duplicate or an older one", async () => {
    await send(options, doc(options, "a", at(-60_000)));
    expect((await send(options, doc(options, "a", at(-60_000)))).status).toBe(200);
    expect((await send(options, doc(options, "older", at(-120_000)))).status).toBe(409);
    expect([...blob.store.keys()].some((p) => p.startsWith("ops/"))).toBe(false);
  });

  it("is not written for a refusal that is not about an edition's content (a bad signature, bad JSON)", async () => {
    const bad = post(options, doc(options, "a", at(-60_000)));
    bad.headers.set("x-wt-signature", "sha256=00");
    expect((await handleIngest(bad, NOW)).status).toBe(401);
    expect(blob.store.size).toBe(0);
  });

  it("a failing write is logged and the answer is still 422", async () => {
    blob.state.rejects = "fail";
    const res = await send(options, doc(options, "bad", at(-60_000), (d) => (d.private_note = 1)));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid");
    expect(events()).toContainEqual(expect.objectContaining({ evt: "ingest.reject-record", outcome: "error", desk: "options", error: "Error" }));
    expect(blob.store.size).toBe(0);
  });

  it("a write that hangs does not hold the answer past its limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    blob.state.rejects = "hang";
    const pending = send(options, doc(options, "ahead", at(3_600_000)));
    await vi.advanceTimersByTimeAsync(INGEST_REJECT_WRITE_MS);
    const res = await pending;
    expect(res.status).toBe(422);
    expect(events()).toContainEqual(expect.objectContaining({ evt: "ingest.reject-record", outcome: "timeout", desk: "options" }));
  });
});

describe("readIngestReject", () => {
  const options = KINDS.find((k) => k.kind === "options")!;

  it("reads back what a refusal wrote", async () => {
    await send(options, doc(options, "ahead", at(3_600_000)));
    expect(await readIngestReject("options")).toEqual({ at: NOW.toISOString(), kind: "options", outcome: "ahead-of-clock", n_errors: 1 });
  });

  it("is null when nothing is recorded, or what is stored is not a record", async () => {
    expect(await readIngestReject("radar")).toBeNull();
    const good = { at: NOW.toISOString(), kind: "radar", outcome: "invalid", n_errors: 2 };
    for (const text of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ ...good, errors: ["/x"] }), // an extra field
      JSON.stringify({ ...good, kind: "stocks" }),
      JSON.stringify({ ...good, outcome: "older" }),
      JSON.stringify({ ...good, n_errors: -1 }),
      JSON.stringify({ ...good, n_errors: 1.5 }),
      JSON.stringify({ ...good, at: "yesterday" }),
      JSON.stringify({ at: good.at, kind: good.kind, outcome: good.outcome }),
    ]) {
      blob.put(ingestRejectPath("radar"), text);
      expect(await readIngestReject("radar"), text).toBeNull();
    }
    blob.put(ingestRejectPath("radar"), JSON.stringify(good));
    expect(await readIngestReject("radar")).toEqual(good);
  });

  it("throws when the store cannot be read, so a caller can tell that from nothing recorded", async () => {
    blob.state.reads = "fail";
    await expect(readIngestReject("options")).rejects.toThrow("store down");
  });

  it("says whether a refusal still stands: true until an edition of the kind is stored after it", async () => {
    expect(await readIngestRejectStatus("options")).toEqual({ reject: null, stored_at: null, current: false });
    blob.clock.now = "2026-11-11T14:00:00.000Z";
    await send(options, doc(options, "good", at(-2 * 3_600_000)));
    blob.clock.now = NOW.toISOString();
    await send(options, doc(options, "ahead", at(3_600_000)));
    expect(await readIngestRejectStatus("options")).toEqual({
      reject: { at: NOW.toISOString(), kind: "options", outcome: "ahead-of-clock", n_errors: 1 },
      stored_at: "2026-11-11T14:00:00.000Z",
      current: true,
    });
    blob.clock.now = "2026-11-11T15:01:00.000Z";
    await send(options, doc(options, "next", at(-60_000)));
    expect(await readIngestRejectStatus("options")).toMatchObject({ stored_at: "2026-11-11T15:01:00.000Z", current: false });
    // A refusal is never undone by another kind's edition.
    expect((await readIngestRejectStatus("radar")).current).toBe(false);
  });

  it("a refusal with nothing ever stored stands; one at or before the last store does not", () => {
    const r = { at: "2026-11-11T15:00:00.000Z", kind: "options" as const, outcome: "invalid" as const, n_errors: 1 };
    expect(rejectIsCurrent(r, null)).toBe(true);
    expect(rejectIsCurrent(r, "2026-11-11T14:59:59.000Z")).toBe(true);
    expect(rejectIsCurrent(r, "2026-11-11T15:00:00.000Z")).toBe(false);
    expect(rejectIsCurrent(null, null)).toBe(false);
  });

  it("the status throws when the store cannot be read", async () => {
    blob.state.reads = "fail";
    await expect(readIngestRejectStatus("options")).rejects.toThrow("store down");
  });

  it("has one path per kind under ops/ingest-rejects/", () => {
    expect(INGEST_REJECT_KINDS.map(ingestRejectPath)).toEqual(INGEST_REJECT_KINDS.map((k) => `ops/ingest-rejects/${k}.json`));
  });
});
