import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/hmac";
import type { ReplayInput } from "@/lib/owner-labels";
import optionsJson from "./fixtures/options.v1.json";

// The Options edition copies (EXP-0033 labeller_rules.edition): every edition that became latest is kept once, never
// overwritten, with the store's own receipt time, and read back in receipt order.

// In-memory stand-in for the private Blob store: etags, create-only, the store's upload time by a clock the tests
// set, and switches that make a copy's write or the metadata read fail, or another run land right after a write.
const blob = vi.hoisted(() => {
  class PreconditionFailed extends Error {}
  const store = new Map<string, { text: string; etag: string }>();
  const uploaded = new Map<string, string>();
  const clock = { now: "2026-10-09T21:30:00.000Z" };
  const faults = { copyWrites: 0, meta: 0 };
  const hooks: { afterLatestWrite?: () => void } = {};
  let seq = 0;
  const put = (pathname: string, text: string) => {
    const etag = `"e${++seq}"`;
    store.set(pathname, { text, etag });
    uploaded.set(pathname, clock.now);
    return etag;
  };
  return {
    store,
    uploaded,
    clock,
    faults,
    hooks,
    put,
    PreconditionFailed,
    reset() {
      store.clear();
      uploaded.clear();
      clock.now = "2026-10-09T21:30:00.000Z";
      faults.copyWrites = 0;
      faults.meta = 0;
      hooks.afterLatestWrite = undefined;
      seq = 0;
    },
  };
});

vi.mock("@/lib/blob", () => ({
  LATEST_PATH: "snapshots/latest.json",
  SHADOW_LATEST_PATH: "shadow/latest.json",
  HISTORY_PREFIX: "snapshots/history/",
  ALERT_STATE_PATH: "alerts/state.json",
  PreconditionFailed: blob.PreconditionFailed,
  readText: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  readForUpdate: vi.fn(async (pathname: string) => {
    const b = blob.store.get(pathname);
    return b ? { ...b, uploadedAt: blob.uploaded.get(pathname) } : null;
  }),
  exists: vi.fn(async (pathname: string) => blob.store.has(pathname)),
  storedMeta: vi.fn(async (pathname: string) => {
    if (blob.faults.meta > 0) {
      blob.faults.meta--;
      throw new Error("store down");
    }
    const b = blob.store.get(pathname);
    return b ? { etag: b.etag, uploadedAt: blob.uploaded.get(pathname)! } : null;
  }),
  writeText: vi.fn(async (pathname: string, body: string, opts: { ifMatch?: string | null; createOnly?: boolean } = {}) => {
    if (pathname.startsWith("options/copies/") && blob.faults.copyWrites > 0) {
      blob.faults.copyWrites--;
      const e = new Error("store down");
      e.name = "BlobServiceNotAvailable";
      throw e;
    }
    const cur = blob.store.get(pathname);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    if (opts.createOnly && cur) throw new blob.PreconditionFailed();
    const etag = blob.put(pathname, body);
    if (pathname === "options/latest.json" && blob.hooks.afterLatestWrite) {
      const h = blob.hooks.afterLatestWrite;
      blob.hooks.afterLatestWrite = undefined;
      h();
    }
    return { etag };
  }),
  listPaths: vi.fn(async (prefix: string) =>
    [...blob.store.keys()].filter((k) => k.startsWith(prefix)).map((pathname) => ({ pathname, url: `https://blob.test/${pathname}` })),
  ),
}));

const { handleIngest } = await import("@/lib/ingest");
const { optionsEditionCopies } = await import("@/lib/edition-copies");
const { editionCopyPath, editionCopyText, parseEditionCopy, runSegment } = await import("@/lib/edition-copy");
const { repairOptionsCopy, resetCopyRepairMemo, startOptionsCopyRepair } = await import("@/lib/edition-copy-repair");
type CopyRepairDeps = import("@/lib/edition-copy-repair").CopyRepairDeps;
type StoredEditionCopy = import("@/lib/edition-copies").StoredEditionCopy;

const SECRET = "test-default-secret";
const NOW = new Date("2026-10-09T21:30:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const SESSION = "2026-10-12";
const PREFIX = "options/copies/";

function edition(runId: string, asOf: string, mutate?: (r: Record<string, unknown>) => void): string {
  const r = structuredClone(optionsJson) as unknown as Record<string, unknown>;
  r.run_id = runId;
  r.as_of = asOf;
  mutate?.(r);
  return JSON.stringify(r);
}

function post(text: string, opts: { secret?: string; headers?: Record<string, string> } = {}): Request {
  return new Request("https://lab.example/api/ingest", {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      "x-wt-timestamp": String(NOW_S),
      "x-wt-signature": sign(opts.secret ?? SECRET, NOW_S, Buffer.from(text, "utf8")),
      ...opts.headers,
    },
  });
}

const send = async (text: string, opts: Parameters<typeof post>[1] = {}) => {
  const res = await handleIngest(post(text, opts), NOW);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const copyPaths = () => [...blob.store.keys()].filter((k) => k.startsWith(PREFIX)).sort();
const copyAt = (path: string) => blob.store.get(path)!.text;
const events = (): Record<string, unknown>[] =>
  vi.mocked(console.log).mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
const ingestOutcomes = () => events().filter((e) => e.evt === "ingest").map((e) => e.outcome);

beforeEach(() => {
  blob.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.mocked(console.log).mockClear();
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", SECRET);
});

describe("an accepted Options edition gets one copy, with the store's receipt time", () => {
  it("the first edition of a session: one copy, received when latest took it, holding the published bytes", async () => {
    const a = edition("run-a", "2026-10-09T21:00:00+00:00");
    blob.clock.now = "2026-10-09T21:30:01.234Z";
    expect(await send(a)).toEqual({ status: 200, body: { status: "stored", run_id: "run-a" } });
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213001234Z-run-a.json"]);
    const text = copyAt(copyPaths()[0]!);
    expect(text).toBe(
      `{"schema":"stocksdelta/edition-copy","version":1,"received_at":"2026-10-09T21:30:01.234Z","session":"2026-10-12","run_id":"run-a","edition":${a}}`,
    );
    expect(await optionsEditionCopies(SESSION)).toEqual({ copies: [{ edition: JSON.parse(a), receivedAt: "2026-10-09T21:30:01.234Z" }], unreadable: 0 });
    // the existing files are as before
    expect(blob.store.get("options/latest.json")!.text).toBe(a);
    expect(blob.store.get("options/editions/2026-10-12.json")!.text).toBe(a);
  });

  it("a same-session refresh: two copies, the first untouched, both read in receipt order", async () => {
    const a = edition("run-a", "2026-10-09T21:00:00+00:00");
    const b = edition("run-b", "2026-10-09T21:20:00+00:00");
    blob.clock.now = "2026-10-09T21:30:00.000Z";
    await send(a);
    const first = copyAt("options/copies/2026-10-12/20261009T213000000Z-run-a.json");
    blob.clock.now = "2026-10-09T21:31:00.000Z";
    expect((await send(b)).body).toEqual({ status: "stored", run_id: "run-b" });
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213000000Z-run-a.json", "options/copies/2026-10-12/20261009T213100000Z-run-b.json"]);
    expect(copyAt("options/copies/2026-10-12/20261009T213000000Z-run-a.json")).toBe(first);
    const read = await optionsEditionCopies(SESSION);
    expect(read.unreadable).toBe(0);
    expect(read.copies.map((c) => [c.edition.run_id, c.receivedAt])).toEqual([
      ["run-a", "2026-10-09T21:30:00.000Z"],
      ["run-b", "2026-10-09T21:31:00.000Z"],
    ]);
    // the per-session file is still replaced by the refresh, exactly as before
    expect(blob.store.get("options/editions/2026-10-12.json")!.text).toBe(b);
  });

  it("an older edition: 409 and no copy", async () => {
    await send(edition("run-b", "2026-10-09T21:20:00+00:00"));
    blob.clock.now = "2026-10-09T21:35:00.000Z";
    expect((await send(edition("run-a", "2026-10-09T21:00:00+00:00"))).status).toBe(409);
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213000000Z-run-b.json"]);
  });

  it("a duplicate: no second copy, and the first one's receipt time and bytes unchanged", async () => {
    const a = edition("run-a", "2026-10-09T21:00:00+00:00");
    await send(a);
    const before = copyAt(copyPaths()[0]!);
    blob.clock.now = "2026-10-09T21:40:00.000Z";
    expect(await send(a)).toEqual({ status: 200, body: { status: "duplicate", run_id: "run-a" } });
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213000000Z-run-a.json"]);
    expect(copyAt(copyPaths()[0]!)).toBe(before);
  });

  it("an invalid or badly signed edition: no copy", async () => {
    expect((await send(edition("bad", "2026-10-09T21:00:00+00:00", (r) => (r.received_at = "2026-10-09T21:30:00.000Z")))).status).toBe(422);
    expect((await send(edition("bad2", "2026-10-09T21:00:00+00:00", (r) => (r.session = "Monday")))).status).toBe(422);
    expect((await send(edition("unsigned", "2026-10-09T21:00:00+00:00"), { secret: "wrong" })).status).toBe(401);
    expect((await send(edition("ahead", "2026-10-09T22:00:00+00:00"))).status).toBe(422);
    expect(copyPaths()).toEqual([]);
  });

  it("an edition for the next session, published after the close, goes under the next session's date", async () => {
    blob.clock.now = "2026-10-12T20:45:00.000Z";
    const next = edition("run-next", "2026-10-09T21:00:00+00:00", (r) => (r.session = "2026-10-13"));
    expect((await send(next)).status).toBe(200);
    expect(copyPaths()).toEqual(["options/copies/2026-10-13/20261012T204500000Z-run-next.json"]);
    expect((await optionsEditionCopies("2026-10-13")).copies).toHaveLength(1);
    expect(await optionsEditionCopies("2026-10-12")).toEqual({ copies: [], unreadable: 0 });
  });

  it("two editions accepted in the same millisecond: two distinct paths, both read", async () => {
    blob.clock.now = "2026-10-09T21:30:00.500Z";
    await send(edition("run-a", "2026-10-09T21:00:00+00:00"));
    await send(edition("run-b", "2026-10-09T21:01:00+00:00"));
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213000500Z-run-a.json", "options/copies/2026-10-12/20261009T213000500Z-run-b.json"]);
    expect((await optionsEditionCopies(SESSION)).copies.map((c) => c.edition.run_id)).toEqual(["run-a", "run-b"]);
  });

  it("a run id that is not a plain path segment is hashed into one, still one copy per run", async () => {
    const odd = "options 2026/10/12 #1";
    await send(edition(odd, "2026-10-09T21:00:00+00:00"));
    expect(runSegment(odd)).toMatch(/^h[0-9a-f]{32}$/);
    expect(copyPaths()).toEqual([`options/copies/2026-10-12/20261009T213000000Z-${runSegment(odd)}.json`]);
    expect((await optionsEditionCopies(SESSION)).copies.map((c) => c.edition.run_id)).toEqual([odd]);
  });

  it("only the Options edition is copied", async () => {
    const radar = JSON.parse(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/radar.v1.json"), "utf8")) as Record<string, unknown>;
    await send(JSON.stringify(radar));
    expect(copyPaths()).toEqual([]);
  });
});

describe("receipt time cannot be influenced by the request", () => {
  it("as_of, headers and a body field named like the envelope's play no part", async () => {
    blob.clock.now = "2026-10-09T21:31:07.250Z";
    const a = edition("run-a", "2026-10-09T21:39:00+00:00", (r) => (r.source = '"received_at":"2000-01-01T00:00:00.000Z","run_id":"forged"'));
    const res = await send(a, {
      headers: {
        date: "Fri, 01 Jan 1999 00:00:00 GMT",
        "last-modified": "Fri, 01 Jan 1999 00:00:00 GMT",
        "x-wt-received-at": "1999-01-01T00:00:00.000Z",
        "x-received-at": "1999-01-01T00:00:00.000Z",
        "received-at": "1999-01-01T00:00:00.000Z",
      },
    });
    expect(res.status).toBe(200);
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213107250Z-run-a.json"]);
    const env = parseEditionCopy(copyAt(copyPaths()[0]!))!;
    expect([env.receivedAt, env.runId, env.session]).toEqual(["2026-10-09T21:31:07.250Z", "run-a", SESSION]);
    const [copy] = (await optionsEditionCopies(SESSION)).copies;
    expect(copy!.receivedAt).toBe("2026-10-09T21:31:07.250Z");
    expect(copy!.edition.as_of).toBe("2026-10-09T21:39:00+00:00"); // later than its receipt: kept as published
  });

  it("a top-level received_at in the body is not an Options edition: refused, nothing copied", async () => {
    const res = await send(edition("run-x", "2026-10-09T21:00:00+00:00", (r) => (r.received_at = "1999-01-01T00:00:00.000Z")));
    expect(res.status).toBe(422);
    expect(copyPaths()).toEqual([]);
  });
});

// The repair's store, on the same in-memory blobs, with its own switches.
function repairDeps(over: Partial<CopyRepairDeps> = {}): { deps: CopyRepairDeps; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const deps: CopyRepairDeps = {
    meta: async (path) => {
      const b = blob.store.get(path);
      return b ? { etag: b.etag, uploadedAt: blob.uploaded.get(path)! } : null;
    },
    read: async (path) => blob.store.get(path)?.text ?? null,
    exists: async (path) => blob.store.has(path),
    create: async (path, body) => {
      if (blob.store.has(path)) throw new blob.PreconditionFailed();
      blob.put(path, body);
    },
    log: (evt, fields) => {
      lines.push({ evt, ...fields });
    },
    ...over,
  };
  return { deps, lines };
}

describe("a failed copy never changes what the ingest answers, and the repair makes it", () => {
  beforeEach(() => resetCopyRepairMemo());

  it("the copy write failing: 200 stored as ever, one log line, and the repair writes the copy at the ORIGINAL receipt time", async () => {
    const a = edition("run-a", "2026-10-09T21:00:00+00:00");
    blob.clock.now = "2026-10-09T21:30:00.111Z";
    blob.faults.copyWrites = 1;
    expect(await send(a)).toEqual({ status: 200, body: { status: "stored", run_id: "run-a" } });
    expect(blob.store.get("options/editions/2026-10-12.json")!.text).toBe(a); // the per-session file as before
    expect(copyPaths()).toEqual([]);
    expect(ingestOutcomes()).toEqual(["stored"]);
    const failed = events().filter((e) => e.evt === "ingest.copy");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ outcome: "error", run_id: "run-a", session: SESSION, error: "BlobServiceNotAvailable" });
    expect(JSON.stringify(failed[0])).not.toContain("focus"); // nothing of the edition

    blob.clock.now = "2026-10-09T21:40:00.000Z"; // the watchdog comes ten minutes later
    const { deps, lines } = repairDeps();
    expect(await repairOptionsCopy(deps)).toBe("repaired");
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213000111Z-run-a.json"]);
    const copy = parseEditionCopy(copyAt(copyPaths()[0]!))!;
    expect(copy.receivedAt).toBe("2026-10-09T21:30:00.111Z");
    expect(copy.edition).toEqual(JSON.parse(a));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ evt: "edition-copy.repair", outcome: "repaired", run_id: "run-a", session: SESSION });

    // a second run finds it there and leaves the bytes alone, also on a cold instance
    const before = copyAt(copyPaths()[0]!);
    expect(await repairOptionsCopy(deps)).toBe("present");
    resetCopyRepairMemo();
    expect(await repairOptionsCopy(deps)).toBe("present");
    expect(copyPaths()).toHaveLength(1);
    expect(copyAt(copyPaths()[0]!)).toBe(before);
  });

  it("the store's metadata failing: 200 stored, and a retry of the run (a duplicate) also makes the copy", async () => {
    const a = edition("run-a", "2026-10-09T21:00:00+00:00");
    blob.faults.meta = 1;
    expect((await send(a)).status).toBe(200);
    expect(copyPaths()).toEqual([]);
    blob.clock.now = "2026-10-09T21:32:00.000Z";
    expect(await send(a)).toEqual({ status: 200, body: { status: "duplicate", run_id: "run-a" } });
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213000000Z-run-a.json"]);
  });

  it("an edition already on latest with no copy, as at the first deploy, is repaired", async () => {
    blob.clock.now = "2026-10-09T20:15:00.250Z";
    blob.put("options/latest.json", edition("run-old", "2026-10-09T20:00:00+00:00"));
    const { deps } = repairDeps();
    expect(await repairOptionsCopy(deps)).toBe("repaired");
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T201500250Z-run-old.json"]);
  });

  it("an edition replaced before any copy of it was made is said to be lost, and gets no copy with a false time", async () => {
    const a = edition("run-a", "2026-10-09T21:00:00+00:00");
    const b = edition("run-b", "2026-10-09T21:10:00+00:00");
    blob.faults.copyWrites = 1;
    expect((await send(a)).status).toBe(200);
    blob.clock.now = "2026-10-09T21:31:00.000Z";
    expect(await send(b)).toEqual({ status: 200, body: { status: "stored", run_id: "run-b" } });
    expect(events().filter((e) => e.evt === "ingest.copy" && e.outcome === "lost")).toEqual([
      expect.objectContaining({ run_id: "run-a", session: SESSION }),
    ]);
    blob.clock.now = "2026-10-09T21:32:00.000Z";
    expect(await send(a)).toEqual({ status: 409, body: { status: "older", run_id: "run-a" } });
    expect(await repairOptionsCopy(repairDeps().deps)).toBe("present");
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213100000Z-run-b.json"]);
    expect(ingestOutcomes()).toEqual(["stored", "stored", "older"]);
  });

  it("latest replaced between the write and its time being read: 200 stored, unconfirmed, never the newer run's time", async () => {
    const a = edition("run-a", "2026-10-09T21:00:00+00:00");
    const b = edition("run-b", "2026-10-09T21:10:00+00:00");
    blob.hooks.afterLatestWrite = () => {
      blob.clock.now = "2026-10-09T21:30:00.400Z";
      blob.put("options/latest.json", b); // another instance's accept lands first
    };
    expect(await send(a)).toEqual({ status: 200, body: { status: "stored", run_id: "run-a" } });
    const line = events().find((e) => e.evt === "ingest.copy")!;
    expect(line).toMatchObject({ outcome: "unconfirmed", run_id: "run-a", session: SESSION });
    // etag shapes only, never their values
    expect(line.written_etag).toEqual({ len: 4, quoted: true, weak: false });
    expect(JSON.stringify(line)).not.toMatch(/e\d+\\"/);
    expect(copyPaths()).toEqual([]);
    // the repair copies what latest holds now, at that write's own time
    expect(await repairOptionsCopy(repairDeps().deps)).toBe("repaired");
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213000400Z-run-b.json"]);
  });

  it("the repair makes no copy when latest moves under its read, and repairs the new one on the next run", async () => {
    blob.clock.now = "2026-10-09T21:30:00.000Z";
    blob.put("options/latest.json", edition("run-a", "2026-10-09T21:00:00+00:00"));
    let moved = false;
    const base = repairDeps();
    const { deps, lines } = repairDeps({
      read: async (path) => {
        const text = await base.deps.read(path);
        if (!moved) {
          moved = true;
          blob.clock.now = "2026-10-09T21:30:05.000Z";
          blob.put("options/latest.json", edition("run-b", "2026-10-09T21:10:00+00:00"));
        }
        return text;
      },
    });
    expect(await repairOptionsCopy(deps)).toBe("error");
    expect(lines[0]).toMatchObject({ outcome: "error", error: "LatestMoved" });
    expect(copyPaths()).toEqual([]);
    expect(await repairOptionsCopy(deps)).toBe("repaired");
    expect(copyPaths()).toEqual(["options/copies/2026-10-12/20261009T213005000Z-run-b.json"]);
  });

  it("the repair never rejects: no latest, a store error and a hang are each one log line", async () => {
    expect(await repairOptionsCopy(repairDeps().deps)).toBe("no-latest");
    const down = repairDeps({
      meta: async () => {
        const e = new Error("secret detail");
        e.name = "BlobServiceNotAvailable";
        throw e;
      },
    });
    expect(await repairOptionsCopy(down.deps)).toBe("error");
    expect(down.lines).toHaveLength(1);
    expect(down.lines[0]).toMatchObject({ outcome: "error", error: "BlobServiceNotAvailable" });
    expect(JSON.stringify(down.lines[0])).not.toContain("secret detail");
    const hung = repairDeps({ meta: () => new Promise(() => undefined) });
    expect(await repairOptionsCopy(hung.deps, 20)).toBe("error");
    expect(hung.lines[0]).toMatchObject({ outcome: "error", error: "Timeout" });
  });

  it("starting the repair beside the watchdog returns at once and never throws, whatever the repair or the platform does", async () => {
    const kept: Promise<unknown>[] = [];
    expect(() => startOptionsCopyRepair((w) => kept.push(w), () => Promise.reject(new Error("boom")))).not.toThrow();
    expect(kept).toHaveLength(1);
    await expect(kept[0]).resolves.toBeUndefined();
    expect(() =>
      startOptionsCopyRepair(
        () => {
          throw new Error("no request scope");
        },
        async () => undefined,
      ),
    ).not.toThrow();
    expect(() =>
      startOptionsCopyRepair(
        () => undefined,
        () => {
          throw new Error("sync");
        },
      ),
    ).not.toThrow();
  });
});

describe("the reader", () => {
  const put = (path: string, text: string) => {
    blob.store.set(path, { text, etag: '"x"' });
  };
  const copyOf = (runId: string, receivedAt: string, asOf: string) => {
    const text = edition(runId, asOf);
    put(editionCopyPath(PREFIX, SESSION, receivedAt, runId), editionCopyText(receivedAt, SESSION, runId, text));
    return JSON.parse(text) as unknown;
  };

  it("zero copies", async () => {
    expect(await optionsEditionCopies(SESSION)).toEqual({ copies: [], unreadable: 0 });
  });

  it("counts an unreadable copy instead of dropping it silently, and returns the rest", async () => {
    const good = copyOf("run-a", "2026-10-09T21:30:00.000Z", "2026-10-09T21:00:00+00:00");
    put(`${PREFIX}${SESSION}/20261009T213100000Z-junk.json`, "{not json");
    // a valid envelope whose path does not match it
    put(`${PREFIX}${SESSION}/20261009T213200000Z-run-z.json`, editionCopyText("2026-10-09T21:33:00.000Z", SESSION, "run-z", edition("run-z", "2026-10-09T21:00:00+00:00")));
    // a copy whose edition is not a valid Options edition
    put(
      editionCopyPath(PREFIX, SESSION, "2026-10-09T21:34:00.000Z", "run-y"),
      editionCopyText("2026-10-09T21:34:00.000Z", SESSION, "run-y", edition("run-y", "2026-10-09T21:00:00+00:00", (r) => (r.extra = 1))),
    );
    // an envelope run id that is not its edition's
    put(editionCopyPath(PREFIX, SESSION, "2026-10-09T21:35:00.000Z", "run-w"), editionCopyText("2026-10-09T21:35:00.000Z", SESSION, "run-w", edition("run-v", "2026-10-09T21:00:00+00:00")));
    expect(await optionsEditionCopies(SESSION)).toEqual({ copies: [{ edition: good, receivedAt: "2026-10-09T21:30:00.000Z" }], unreadable: 4 });
  });

  it("orders by receipt time and ignores as_of, even an as_of later than the receipt", async () => {
    copyOf("late-asof", "2026-10-09T21:30:00.000Z", "2026-10-09T23:59:00+00:00");
    copyOf("early-asof", "2026-10-09T21:40:00.000Z", "2026-10-09T20:00:00+00:00");
    copyOf("first", "2026-10-09T21:20:00.000Z", "2026-10-09T22:00:00+00:00");
    const read = await optionsEditionCopies(SESSION);
    expect(read.copies.map((c) => [c.edition.run_id, c.receivedAt])).toEqual([
      ["first", "2026-10-09T21:20:00.000Z"],
      ["late-asof", "2026-10-09T21:30:00.000Z"],
      ["early-asof", "2026-10-09T21:40:00.000Z"],
    ]);
  });

  it("reads only the session asked for, and refuses a session that is not a date", async () => {
    copyOf("run-a", "2026-10-09T21:30:00.000Z", "2026-10-09T21:00:00+00:00");
    expect((await optionsEditionCopies("2026-10-13")).copies).toEqual([]);
    await expect(optionsEditionCopies("../options")).rejects.toThrow();
  });

  it("gives the shape the labeller's replay takes", () => {
    const copies: StoredEditionCopy[] = [];
    const editions: ReplayInput["editions"] = copies;
    expect(editions).toEqual([]);
  });
});

describe("the reader is wired to nothing yet", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return files(p);
      return /\.(ts|tsx|mjs|js)$/.test(e.name) ? [p] : [];
    });
  const specifiers = (file: string): string[] => {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
      else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  };
  const importsReader = (f: string) => specifiers(f).some((s) => /(?:^|\/)edition-copies$/.test(s));

  it("no file under src/app or src/components imports the reader, and nothing else in src does either", () => {
    const scanned = [...files(join(ROOT, "src/app")), ...files(join(ROOT, "src/components"))];
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned.filter(importsReader).map((f) => relative(ROOT, f))).toEqual([]);
    expect(files(join(ROOT, "src")).filter(importsReader).map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("the scan sees an import when there is one", () => {
    expect(specifiers(join(ROOT, "src/lib/ingest.ts"))).toContain("./edition-copy");
    expect(importsReader(fileURLToPath(import.meta.url))).toBe(true); // this test's own dynamic import of the reader
  });
});
