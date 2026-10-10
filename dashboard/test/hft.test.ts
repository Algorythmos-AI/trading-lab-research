// The HFT desk (ADR 0006): a third desk whose contract belongs to another repository. It gets its own slot, its own
// watchdog state and its own health field, and nothing of the stocks or crypto desks moves to make room for it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CryptoSnapshot } from "@/lib/crypto.types";
import { DESK_HOME, DESK_LABEL, DESK_PATHS, DESKS, deskOfPath } from "@/lib/desk";
import lock from "@/lib/hft.contract.lock.json";
import hftSchema from "@/lib/hft.schema.json";
import type { HftSnapshot } from "@/lib/hft.types";
import { sign } from "@/lib/hmac";
import { CONTRACTS, CRYPTO_SCHEMA, HFT_SCHEMA, STOCKS_SCHEMA, contractOf, deskOf, validateCryptoSnapshot, validateHftSnapshot, validateSnapshot } from "@/lib/validate";
import cryptoFixture from "./fixtures/crypto.v1.json";
import hftFixture from "./fixtures/hft.v1.json";
import { makeFakeBlobSdk } from "./blob-sdk";
import { fixture } from "./helpers";

const sdk = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof makeFakeBlobSdk> }));
vi.mock("@vercel/blob", async () => {
  const { makeFakeBlobSdk: make } = await import("./blob-sdk");
  sdk.current = make();
  return sdk.current;
});
// ntfy is recorded. `crashFor` makes delivery throw for one desk's pages, which is how a tick is made to fail.
const pages = vi.hoisted(() => ({ sent: [] as { kind: string; title: string; message: string }[], crashFor: null as string | null }));
vi.mock("@/lib/ntfy", async (orig) => ({
  ...(await orig<typeof import("@/lib/ntfy")>()),
  sendNtfy: vi.fn(async (n: { kind: string; title: string; message: string }) => {
    if (pages.crashFor && n.title.startsWith(pages.crashFor)) throw new Error("delivery crashed");
    pages.sent.push(n);
    return "sent" as const;
  }),
}));

const { handleIngest, RADAR_KEY_ID } = await import("@/lib/ingest");
const { loadHftSnapshot } = await import("@/lib/snapshot");
const { DESK_DEPS, runCryptoWatchdog, runDeskWatchdog, runWatchdog } = await import("@/lib/watchdog-run");
const watchdogRoute = await import("@/app/api/cron/watchdog/route");
const healthRoute = await import("@/app/api/health/route");

type Loose = Record<string, unknown>;
const SECRET = "test-ingest-secret";
const CRON = "test-cron-secret";

// One currency week, Sunday 17:00 to Friday 17:00 in New York (21:00 UTC while New York is on daylight time), and the next.
const WEEK = { session: "2026-W40", start: "2026-09-27T21:00:00Z", end: "2026-10-02T21:00:00Z" };
const NEXT_WEEK = { session: "2026-W41", start: "2026-10-04T21:00:00Z", end: "2026-10-09T21:00:00Z" };
const THURSDAY = new Date("2026-10-01T12:00:00Z"); // inside WEEK
const SATURDAY = new Date("2026-10-03T03:00:00Z"); // between WEEK and NEXT_WEEK; 23:00 on Friday in New York

const hft = (over: Partial<HftSnapshot> = {}): HftSnapshot =>
  ({
    ...structuredClone(hftFixture as unknown as HftSnapshot),
    run_id: "h1",
    as_of: "2026-10-01T11:46:00Z",
    generated_at: "2026-10-01T11:46:01Z",
    expected_windows: [WEEK, NEXT_WEEK],
    ...over,
  }) as HftSnapshot;
const crypto = (over: Partial<CryptoSnapshot> = {}): CryptoSnapshot =>
  ({
    ...(cryptoFixture as unknown as CryptoSnapshot),
    run_id: "c1",
    as_of: "2026-10-01T11:46:00Z",
    expected_windows: [{ session: "always", start: "2026-09-20T00:00:00Z", end: "2026-10-20T00:00:00Z" }],
    ...over,
  }) as CryptoSnapshot;

function signed(body: string, now: Date = THURSDAY, headers: Record<string, string> = {}, secret = SECRET): Request {
  const ts = Math.floor(now.getTime() / 1000);
  return new Request("https://lab.example/api/ingest", {
    method: "POST",
    body,
    headers: { "x-wt-timestamp": String(ts), "x-wt-signature": sign(secret, ts, Buffer.from(body, "utf8")), ...headers },
  });
}
const post = (data: unknown, now: Date = THURSDAY) => handleIngest(signed(JSON.stringify(data), now), now);
const stored = (path: string) => sdk.current.store.get(path)?.text ?? null;
const keys = () => [...sdk.current.store.keys()];

beforeEach(() => {
  sdk.current.reset();
  pages.sent.length = 0;
  pages.crashFor = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", SECRET);
  vi.stubEnv("DASHBOARD_FIXTURE", "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("the desk registry", () => {
  it("has three desks, in the order the header shows them", () => {
    expect(DESKS).toEqual(["stocks", "crypto", "hft"]);
    expect(DESK_LABEL).toEqual({ stocks: "Stocks", crypto: "Crypto", hft: "HFT" });
    expect(DESK_HOME).toEqual({ stocks: "/", crypto: "/crypto", hft: "/hft" });
  });

  it("gives the HFT desk its own paths and leaves the other desks' paths as they were", () => {
    expect(DESK_PATHS.hft).toEqual({
      latest: "snapshots/hft/latest.json",
      shadow: "shadow/hft/latest.json",
      history: "snapshots/hft/history/",
      alertState: "alerts/hft-state.json",
    });
    expect(DESK_PATHS.stocks).toEqual({ latest: "snapshots/latest.json", shadow: "shadow/latest.json", history: "snapshots/history/", alertState: "alerts/state.json" });
    expect(DESK_PATHS.crypto).toEqual({
      latest: "snapshots/crypto/latest.json",
      shadow: "shadow/crypto/latest.json",
      history: "snapshots/crypto/history/",
      alertState: "alerts/crypto-state.json",
    });
    const all = Object.values(DESK_PATHS).flatMap((p) => Object.values(p));
    expect(new Set(all).size).toBe(all.length);
    // a desk's history prune lists its own prefix: no desk's history may sit under another's
    for (const a of DESKS) for (const b of DESKS) if (a !== b) expect(DESK_PATHS[a].history.startsWith(DESK_PATHS[b].history), `${a} under ${b}`).toBe(false);
  });

  it("reads the desk from the path: /hft and what is under it, and nothing that only starts with the letters", () => {
    expect(["/hft", "/hft/", "/hft/anything", "/hft/a/b"].map(deskOfPath)).toEqual(["hft", "hft", "hft", "hft"]);
    expect(["/hftx", "/hf", "/x/hft", "/crypto/hft", "/"].map(deskOfPath)).toEqual(["stocks", "stocks", "stocks", "crypto", "stocks"]);
    // what the two older desks answered before still holds
    expect(["/", "/risk", "/engineering", "/cryptography", "/options"].map(deskOfPath)).toEqual(["stocks", "stocks", "stocks", "stocks", "stocks"]);
    expect(["/crypto", "/crypto/risk"].map(deskOfPath)).toEqual(["crypto", "crypto"]);
  });
});

describe("which contract a body is held to", () => {
  it("is keyed by the schema id in the body, one entry per desk", () => {
    expect([...CONTRACTS.keys()]).toEqual([STOCKS_SCHEMA, CRYPTO_SCHEMA, HFT_SCHEMA]);
    expect([...CONTRACTS.values()].map((c) => c.desk)).toEqual(["stocks", "crypto", "hft"]);
    expect(HFT_SCHEMA).toBe("hft-lab/snapshot");
  });

  it("names the HFT desk only for the HFT schema id, exactly", () => {
    expect(deskOf(hft())).toBe("hft");
    expect(deskOf({ schema: "hft-lab/snapshot" })).toBe("hft");
    for (const schema of ["HFT-lab/snapshot", "hft-lab/snapshot ", "hft-lab/snapshot/v1", "hft", "", null, 1, ["hft-lab/snapshot"]]) {
      expect(deskOf({ schema }), String(schema)).toBe("stocks");
    }
    // the names every object has are not schema ids
    for (const schema of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(deskOf({ schema }), schema).toBe("stocks");
    expect(deskOf(fixture())).toBe("stocks");
    expect(deskOf(cryptoFixture)).toBe("crypto");
    expect(deskOf(null)).toBe("stocks");
  });

  it("takes the slot and the validator from the same entry", () => {
    expect(contractOf(hft()).validate).toBe(validateHftSnapshot);
    expect(contractOf(cryptoFixture).validate).toBe(validateCryptoSnapshot);
    expect(contractOf(fixture()).validate).toBe(validateSnapshot);
    expect(contractOf({ schema: "something-else" }).validate).toBe(validateSnapshot);
  });
});

describe("the HFT contract, version 1", () => {
  const refused = (data: unknown): string[] => {
    const r = validateHftSnapshot(data);
    expect(r.ok).toBe(false);
    return r.ok ? [] : r.errors;
  };
  const edit = (f: (s: Loose) => void): Loose => {
    const s = structuredClone(hftFixture) as unknown as Loose;
    f(s);
    return s;
  };

  it("accepts the committed fixture, with or without its optional sections", () => {
    expect(validateHftSnapshot(hftFixture)).toEqual({ ok: true, snapshot: hftFixture });
    const optional = ["recorder", "pairs", "sleeves", "books", "learning"];
    expect(validateHftSnapshot(edit((s) => optional.forEach((k) => delete s[k]))).ok).toBe(true);
    expect(validateHftSnapshot(edit((s) => optional.forEach((k) => (s[k] = null)))).ok).toBe(true);
    expect(validateHftSnapshot(edit((s) => (s.as_of = "2026-10-09T14:30:00.250Z"))).ok).toBe(true);
  });

  it("refuses an unknown key at any depth", () => {
    expect(refused(edit((s) => (s.account_id = "U1234567")))).toContain('/: unknown key "account_id"');
    expect(refused(edit((s) => ((s.desk as Loose).host = "hft-1")))).toContain('/desk: unknown key "host"');
    expect(refused(edit((s) => ((s.pairs as Loose[])[0]!.bid = 1.1)))).toContain('/pairs/0: unknown key "bid"');
    expect(refused(edit((s) => ((s.books as { shadow: Loose }).shadow.equity = 100_000)))).toContain('/books/shadow: unknown key "equity"');
  });

  it("refuses a value outside an enum, live mode first of all", () => {
    expect(refused(edit((s) => ((s.desk as Loose).mode = "live"))).join(" ")).toContain("/desk/mode");
    expect(refused(edit((s) => ((s.desk as Loose).stage = "live"))).join(" ")).toContain("/desk/stage");
    expect(refused(edit((s) => ((s.desk as Loose).venue = "ibkr_live"))).join(" ")).toContain("/desk/venue");
    expect(refused(edit((s) => ((s.phases as Loose[])[0]!.id = "F8"))).join(" ")).toContain("/phases/0/id");
    expect(refused(edit((s) => ((s.sleeves as Loose[])[0]!.name = "momentum"))).join(" ")).toContain("/sleeves/0/name");
    expect(refused(edit((s) => ((s.health as Loose).level = "green"))).join(" ")).toContain("/health/level");
    expect(refused(edit((s) => (s.schema_version = 2))).join(" ")).toContain("/schema_version");
  });

  it("refuses a string that is too long", () => {
    expect(refused(edit((s) => (s.run_id = "r".repeat(81)))).join(" ")).toContain("/run_id");
    expect(refused(edit((s) => ((s.health as Loose).reasons = ["a".repeat(61)]))).join(" ")).toContain("/health/reasons/0");
    expect(refused(edit((s) => ((s.learning as Loose).champion = "m".repeat(61)))).join(" ")).toContain("/learning/champion");
    expect(refused(edit((s) => ((s.health as Loose).reasons = Array.from({ length: 21 }, (_, i) => `code_${i}`)))).join(" ")).toContain("/health/reasons");
  });

  it("refuses free text, as an extra field and inside a field that takes a code", () => {
    const note = "Recorder restarted after the broker dropped the session";
    expect(refused(edit((s) => (s.note = note)))).toContain('/: unknown key "note"');
    expect(refused(edit((s) => ((s.sleeves as Loose[])[0]!.comment = note)))).toContain('/sleeves/0: unknown key "comment"');
    expect(refused(edit((s) => ((s.health as Loose).reasons = [note]))).join(" ")).toContain("/health/reasons/0");
    expect(refused(edit((s) => (s.run_id = "the 14:30 run"))).join(" ")).toContain("/run_id");
    expect(refused(edit((s) => ((s.expected_windows as Loose[])[0]!.session = "this week, probably"))).join(" ")).toContain("/expected_windows/0/session");
    expect(refused(edit((s) => (s.as_of = "Friday afternoon"))).join(" ")).toContain("/as_of");
    // and what it refuses is named by path: the text itself is never repeated in an error
    expect(refused(edit((s) => (s.note = note))).join(" ")).not.toContain("Recorder restarted");
    expect(refused(edit((s) => ((s.health as Loose).reasons = [note]))).join(" ")).not.toContain("Recorder restarted");
  });

  it("still applies the site's denylist", () => {
    expect(refused(edit((s) => (s.headlines = ["x"])))).toContain("/headlines: key is not allowed to be published");
    expect(refused(edit((s) => ((s.desk as Loose).setup = "x")))).toContain("/desk/setup: key is not allowed to be published");
  });

  it("refuses a body that is not an HFT snapshot, and the other desks' validators refuse an HFT one", () => {
    expect(refused(null)).toEqual(["/: must be an object"]);
    expect(refused([])).toEqual(["/: must be an object"]);
    expect(refused(edit((s) => (s.schema = STOCKS_SCHEMA))).join(" ")).toContain("/schema: not the HFT snapshot schema");
    expect(refused(edit((s) => delete s.schema)).join(" ")).toContain("/schema: not the HFT snapshot schema");
    expect(validateHftSnapshot(fixture()).ok).toBe(false);
    expect(validateHftSnapshot(cryptoFixture).ok).toBe(false);
    expect(validateSnapshot(hftFixture).ok).toBe(false);
    expect(validateCryptoSnapshot(hftFixture).ok).toBe(false);
  });

  it("refuses a snapshot without the fields freshness and the page depend on", () => {
    for (const key of ["run_id", "as_of", "expected_windows", "desk", "phases", "health"]) {
      expect(validateHftSnapshot(edit((s) => delete s[key])).ok, key).toBe(false);
    }
    expect(validateHftSnapshot(edit((s) => (s.as_of = null))).ok).toBe(false);
  });

  it("has no free-text field: every string is an enum or a short pattern, every object is closed, every list is capped", () => {
    const problems: string[] = [];
    const walk = (node: unknown, at: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}/${i}`));
      if (node === null || typeof node !== "object") return;
      const n = node as Loose;
      const types = ([] as unknown[]).concat(n.type ?? []);
      if (types.includes("string") && !Array.isArray(n.enum)) {
        if (typeof n.pattern !== "string" || !n.pattern.startsWith("^") || !n.pattern.endsWith("$")) problems.push(`${at}: string without an anchored pattern`);
        if (typeof n.maxLength !== "number" || n.maxLength > 80) problems.push(`${at}: string without a short maxLength`);
      }
      if (types.includes("object") && n.additionalProperties !== false) problems.push(`${at}: open object`);
      if (types.includes("array") && typeof n.maxItems !== "number") problems.push(`${at}: uncapped list`);
      // `properties` maps field names to schemas: a field may be called anything, its schema is what is checked
      for (const [k, v] of Object.entries(n)) {
        if (k === "properties") for (const [name, sub] of Object.entries(v as Loose)) walk(sub, `${at}/${name}`);
        else if (k !== "enum" && k !== "required" && k !== "description" && k !== "title") walk(v, `${at}/${k}`);
      }
    };
    walk(hftSchema, "");
    expect(problems).toEqual([]);
  });

  it("the fixture is internally consistent: the sleeves add up to the shadow book", () => {
    const f = hftFixture as unknown as HftSnapshot;
    const sum = (k: "net_today" | "net_total") => (f.sleeves ?? []).reduce((a, x) => a + (x[k] ?? 0), 0);
    expect(f.books?.shadow.net_today).toBeCloseTo(sum("net_today"), 9);
    expect(f.books?.shadow.net_total).toBeCloseTo(sum("net_total"), 9);
    expect(f.desk.stage).toBe("shadow");
    expect((f.sleeves ?? []).map((x) => [x.name, x.stage])).toEqual([["control", "shadow"], ["directional_change", "shadow"]]);
    expect((f.pairs ?? []).map((p) => p.pair)).toEqual(["EUR.USD", "USD.JPY"]);
    expect(Date.parse(f.as_of)).toBeGreaterThanOrEqual(Date.parse(f.expected_windows[0]!.start));
    expect(Date.parse(f.as_of)).toBeLessThanOrEqual(Date.parse(f.expected_windows[0]!.end));
  });
});

describe("the vendored contract's lock", () => {
  const bytes = readFileSync(new URL("../src/lib/hft.schema.json", import.meta.url));

  it("pins the schema file as committed, byte for byte", () => {
    expect(lock.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("says where the contract comes from, and its id is the id ingest files by", () => {
    expect(lock.source_repo).toBe("Algorythmos-AI/hft-lab");
    expect(lock.source_path).toBe("contracts/hft-snapshot.v1.schema.json");
    // empty until the contract lands in hft-lab; then the commit it was copied from
    expect(lock.source_commit).toMatch(/^([0-9a-f]{40})?$/);
    expect(Object.keys(lock)).toEqual(["source_repo", "source_path", "source_commit", "sha256"]);
    expect(hftSchema.$id).toBe(HFT_SCHEMA);
    expect(hftSchema.properties.schema.enum).toEqual([HFT_SCHEMA]);
    expect(hftSchema.properties.schema_version.enum).toEqual([1]);
    expect((hftFixture as Loose).schema).toBe(HFT_SCHEMA);
  });
});

describe("ingest files an HFT snapshot in the HFT slot and nowhere else", () => {
  it("stores it in its own slot and history and leaves the other desks' slots byte for byte", async () => {
    sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify(fixture()));
    sdk.current.write(DESK_PATHS.crypto.latest, JSON.stringify(crypto({ run_id: "c0", as_of: "2026-10-01T11:00:00Z" })));
    const before = [stored(DESK_PATHS.stocks.latest), stored(DESK_PATHS.crypto.latest)];
    const res = await post(hft());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "stored", run_id: "h1" });
    expect(JSON.parse(stored(DESK_PATHS.hft.latest)!).run_id).toBe("h1");
    expect(stored("snapshots/hft/history/2026-10-01/11.json")).not.toBeNull();
    expect([stored(DESK_PATHS.stocks.latest), stored(DESK_PATHS.crypto.latest)]).toEqual(before);
    expect(keys().sort()).toEqual([DESK_PATHS.crypto.latest, DESK_PATHS.hft.latest, "snapshots/hft/history/2026-10-01/11.json", DESK_PATHS.stocks.latest].sort());
  });

  it("no other body can be filed under HFT: a stocks or crypto snapshot renamed to the HFT schema is refused", async () => {
    for (const body of [{ ...fixture(), schema: HFT_SCHEMA }, { ...crypto(), schema: HFT_SCHEMA }, { schema: HFT_SCHEMA, run_id: "x", as_of: "2026-10-01T11:46:00Z" }]) {
      expect((await post(body)).status).toBe(422);
    }
    expect(keys()).toEqual([]);
  });

  it("an HFT body can be filed under no other desk: renamed to another schema, or to none, it is refused", async () => {
    for (const schema of [STOCKS_SCHEMA, CRYPTO_SCHEMA, "something-else", null]) {
      expect((await post({ ...hft(), schema })).status, String(schema)).toBe(422);
    }
    const unnamed = hft() as unknown as Loose;
    delete unnamed.schema;
    expect((await post(unnamed)).status).toBe(422);
    expect(keys()).toEqual([]);
  });

  it("the stocks and crypto desks' own snapshots still go where they went, and never under an HFT path", async () => {
    const stocks = { ...fixture(), run_id: "s1", as_of: "2026-10-01T11:46:00Z" };
    expect((await post(stocks)).status).toBe(200);
    expect((await post(crypto())).status).toBe(200);
    expect(keys().sort()).toEqual(["snapshots/crypto/history/2026-10-01/11.json", "snapshots/crypto/latest.json", "snapshots/history/2026-10-01/11.json", "snapshots/latest.json"]);
    expect(keys().filter((k) => k.includes("hft"))).toEqual([]);
  });

  it("keeps the duplicate and older rules for the HFT slot, apart from the other desks' clocks", async () => {
    // the other desks hold newer snapshots: that must not make an HFT snapshot "older"
    sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify({ ...fixture(), run_id: "s9", as_of: "2026-10-01T11:59:00Z" }));
    sdk.current.write(DESK_PATHS.crypto.latest, JSON.stringify(crypto({ run_id: "c9", as_of: "2026-10-01T11:59:00Z" })));
    expect((await post(hft())).status).toBe(200);
    const again = await post(hft());
    expect([again.status, await again.json()]).toEqual([200, { status: "duplicate", run_id: "h1" }]);
    const older = await post(hft({ run_id: "h0", as_of: "2026-10-01T11:31:00Z" }));
    expect([older.status, await older.json()]).toEqual([409, { status: "older", run_id: "h0" }]);
    const same = await post(hft({ run_id: "h1b" })); // a different run with the same as_of is not newer
    expect(same.status).toBe(409);
    expect((await post(hft({ run_id: "h2", as_of: "2026-10-01T11:47:00Z" }))).status).toBe(200);
    expect(JSON.parse(stored(DESK_PATHS.hft.latest)!).run_id).toBe("h2");
  });

  it("a non-primary host's HFT snapshot goes to the HFT shadow slot, which no page and no watchdog reads", async () => {
    vi.stubEnv("PRIMARY_HOST", "gcp-use1"); // the default key is no longer the primary
    const res = await post(hft());
    expect(await res.json()).toEqual({ status: "stored", run_id: "h1", shadow: true });
    expect(keys()).toEqual([DESK_PATHS.hft.shadow]);
    expect(await loadHftSnapshot()).toEqual({ status: "missing" });
    expect(await runDeskWatchdog("hft", THURSDAY)).toMatchObject({ skipped: "never published" });
  });

  it("refuses an HFT snapshot signed with the research key, an unsigned one, and one sent outside production", async () => {
    vi.stubEnv("RADAR_INGEST_SECRET", "radar-secret");
    const body = JSON.stringify(hft());
    expect((await handleIngest(signed(body, THURSDAY, { "x-wt-key-id": RADAR_KEY_ID }, "radar-secret"), THURSDAY)).status).toBe(403);
    expect((await handleIngest(signed(body, THURSDAY, {}, "wrong-secret"), THURSDAY)).status).toBe(401);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await post(hft())).status).toBe(403);
    expect(keys()).toEqual([]);
  });
});

describe("reading the HFT snapshot", () => {
  it("is missing until the desk has published, then the stored snapshot", async () => {
    expect(await loadHftSnapshot()).toEqual({ status: "missing" });
    await post(hft());
    expect(await loadHftSnapshot()).toEqual({ status: "ok", snapshot: hft(), source: "blob" });
  });

  it("reads only the HFT slot", async () => {
    sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify(fixture()));
    sdk.current.write(DESK_PATHS.crypto.latest, JSON.stringify(crypto()));
    sdk.current.write(DESK_PATHS.hft.shadow, JSON.stringify(hft()));
    expect(await loadHftSnapshot()).toEqual({ status: "missing" });
  });

  it("is an error, never a crash, when the stored text is not a snapshot or storage fails", async () => {
    for (const text of ["[]", "null", "7", "{not json"]) {
      sdk.current.write(DESK_PATHS.hft.latest, text);
      expect(await loadHftSnapshot(), text).toEqual({ status: "error" });
    }
    // with nothing stored a read answers "missing", so "error" here can only come from the failed read
    sdk.current.reset();
    const get = vi.spyOn(sdk.current, "get").mockRejectedValueOnce(new Error("store unavailable"));
    expect(await loadHftSnapshot()).toEqual({ status: "error" });
    expect(get).toHaveBeenCalledWith(DESK_PATHS.hft.latest, expect.anything());
  });

  it("serves the committed fixture in fixture mode, and never in production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    expect(await loadHftSnapshot()).toEqual({ status: "ok", snapshot: hftFixture, source: "fixture" });
    vi.stubEnv("VERCEL_ENV", "production");
    expect(await loadHftSnapshot()).toEqual({ status: "missing" });
  });
});

describe("the HFT desk's watchdog", () => {
  const write = (s: HftSnapshot) => sdk.current.write(DESK_PATHS.hft.latest, JSON.stringify(s));

  it("does nothing, and pages nobody, while the desk has never published", async () => {
    for (const now of [THURSDAY, SATURDAY, new Date("2026-12-25T15:00:00Z")]) {
      expect(await runDeskWatchdog("hft", now)).toEqual({ ok: true, desk: "hft", skipped: "never published" });
    }
    expect(pages.sent).toEqual([]);
    expect(keys()).toEqual([]);
  });

  it("stays silent for the HFT desk when the other two desks are publishing and it is not", async () => {
    sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify(fixture()));
    sdk.current.write(DESK_PATHS.crypto.latest, JSON.stringify(crypto()));
    sdk.current.write(DESK_PATHS.crypto.alertState, JSON.stringify({ level: "ok", last_prune_day: "2026-10-01" }));
    expect(await runDeskWatchdog("hft", THURSDAY)).toMatchObject({ skipped: "never published" });
    expect(pages.sent).toEqual([]);
    expect(stored(DESK_PATHS.hft.alertState)).toBeNull();
  });

  it("pages once the desk has published and then gone stale inside its window, says which desk, and keeps its own state", async () => {
    write(hft({ as_of: "2026-10-01T11:15:00Z" })); // 45 min old
    const r = await runDeskWatchdog("hft", THURSDAY);
    expect(r).toMatchObject({ desk: "hft", level: "late", in_window: true, has_snapshot: true });
    expect(pages.sent.map((p) => [p.kind, p.title])).toEqual([["late", "HFT desk: Dashboard late: no update for 45 min"]]);
    expect(pages.sent[0]!.message).toContain("2026-W40");
    expect(JSON.parse(stored(DESK_PATHS.hft.alertState)!).level).toBe("late");
    expect(stored(DESK_PATHS.stocks.alertState)).toBeNull();
    expect(stored(DESK_PATHS.crypto.alertState)).toBeNull();
    pages.sent.length = 0;
    expect((await runDeskWatchdog("hft", THURSDAY)).notices).toEqual([]); // quiet until it changes
    expect((await runDeskWatchdog("hft", new Date("2026-10-01T13:00:00Z"))).level).toBe("stopped"); // 105 min old
    expect(pages.sent.map((p) => p.kind)).toEqual(["stopped"]);
    write(hft({ run_id: "h2", as_of: "2026-10-01T12:59:00Z" }));
    await runDeskWatchdog("hft", new Date("2026-10-01T13:00:00Z"));
    expect(pages.sent.map((p) => p.kind)).toEqual(["stopped", "recovered"]);
    expect(pages.sent.every((p) => p.title.startsWith("HFT desk: "))).toBe(true);
  });

  it("keeps watching once it has published, even with the snapshot gone", async () => {
    sdk.current.write(DESK_PATHS.hft.alertState, JSON.stringify({ level: "ok", last_prune_day: "2026-10-01" }));
    expect((await runDeskWatchdog("hft", THURSDAY)).skipped).toBeUndefined();
  });

  it("is quiet over the weekend when the snapshot lists the next week's window", async () => {
    write(hft({ as_of: "2026-10-02T20:59:00Z" })); // the last snapshot before Friday's close, six hours old
    const r = await runDeskWatchdog("hft", SATURDAY);
    expect(r).toMatchObject({ level: "ok", in_window: false });
    expect(pages.sent).toEqual([]);
    // and it is watched again from the moment the next week opens, on Sunday evening in New York
    const sunday = await runDeskWatchdog("hft", new Date("2026-10-04T21:40:00Z"));
    expect(sunday).toMatchObject({ level: "stopped", in_window: true });
    expect(pages.sent.map((p) => p.kind)).toEqual(["stopped"]);
    expect(pages.sent[0]!.message).toContain("2026-W41");
    expect(pages.sent[0]!.message).not.toContain("a weekday window is assumed");
  });

  it("falls back to US equity weekday hours when every listed window has ended (why the next window must be listed)", async () => {
    write(hft({ as_of: "2026-10-02T20:59:00Z", expected_windows: [WEEK] }));
    // Friday 17:40 in New York: currencies have closed, but the assumed window runs to 18:00
    const friday = await runDeskWatchdog("hft", new Date("2026-10-02T21:40:00Z"));
    expect(friday).toMatchObject({ level: "late", in_window: true });
    expect(pages.sent.map((p) => p.kind)).toEqual(["late"]);
    expect(pages.sent[0]!.message).toContain("a weekday window is assumed");
    pages.sent.length = 0;
    // Sunday 17:40 in New York: currencies are open again, but no window is assumed on a weekend, so the desk is
    // not watched. All that is sent is the once-a-day note that the snapshot is over 48 hours old.
    const sunday = await runDeskWatchdog("hft", new Date("2026-10-04T21:40:00Z"));
    expect(sunday).toMatchObject({ in_window: false, level: "late" }); // Friday's level, carried: no new page for it
    expect(pages.sent.map((p) => [p.kind, p.title])).toEqual([["offline", "HFT desk: Trading host offline for 2 days"]]);
  });

  it("neither of the other desks' ticks reads or writes anything of the HFT desk's", async () => {
    write(hft({ as_of: "2026-10-01T09:00:00Z" })); // three hours stale, inside its window
    sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify(fixture()));
    sdk.current.write(DESK_PATHS.crypto.latest, JSON.stringify(crypto()));
    await runWatchdog(THURSDAY);
    await runCryptoWatchdog(THURSDAY);
    expect(pages.sent.filter((p) => p.title.startsWith("HFT desk"))).toEqual([]);
    expect(stored(DESK_PATHS.hft.alertState)).toBeNull();
  });

  describe("the cron route", () => {
    const tick = async () => {
      vi.useFakeTimers({ now: THURSDAY, toFake: ["Date"] });
      vi.stubEnv("CRON_SECRET", CRON);
      const res = await watchdogRoute.GET(new Request("https://lab.example/api/cron/watchdog", { headers: { authorization: `Bearer ${CRON}` } }));
      return { status: res.status, body: (await res.json()) as { ok: boolean; desks: Record<string, Loose> } };
    };
    const stale = () => {
      sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify({ ...fixture(), as_of: "2026-10-01T11:58:00Z", expected_windows: [] }));
      sdk.current.write(DESK_PATHS.crypto.latest, JSON.stringify(crypto({ as_of: "2026-10-01T11:15:00Z" })));
      write(hft({ as_of: "2026-10-01T11:15:00Z" }));
    };

    it("runs one tick per desk, in the registry's order, and reports each", async () => {
      expect(Object.keys(DESK_DEPS)).toEqual(["crypto", "hft"]);
      stale();
      const { status, body } = await tick();
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(Object.keys(body.desks)).toEqual(["crypto", "hft"]);
      expect(body.desks.crypto).toMatchObject({ desk: "crypto", level: "late" });
      expect(body.desks.hft).toMatchObject({ desk: "hft", level: "late" });
      expect(pages.sent.map((p) => p.title.split(":")[0])).toEqual(["Crypto desk", "HFT desk"]);
    });

    it("reports a desk that has never published as skipped, and pages nobody for it", async () => {
      sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify({ ...fixture(), as_of: "2026-10-01T11:58:00Z", expected_windows: [] }));
      const { status, body } = await tick();
      expect(status).toBe(200);
      expect(body.desks).toEqual({
        crypto: { ok: true, desk: "crypto", skipped: "never published" },
        hft: { ok: true, desk: "hft", skipped: "never published" },
      });
      expect(pages.sent).toEqual([]);
    });

    it("a failing HFT tick takes neither the stocks tick nor the crypto tick down", async () => {
      stale();
      pages.crashFor = "HFT desk";
      const { status, body } = await tick();
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, has_snapshot: true, level: "ok" }); // the stocks desk's own result
      expect(body.desks.crypto).toMatchObject({ desk: "crypto", level: "late", sent: 1 });
      expect(body.desks.hft).toEqual({ ok: false, desk: "hft" });
      expect(pages.sent.map((p) => p.title.split(":")[0])).toEqual(["Crypto desk"]);
    });

    it("a failing crypto tick does not stop the HFT tick", async () => {
      stale();
      pages.crashFor = "Crypto desk";
      const { status, body } = await tick();
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.desks.crypto).toEqual({ ok: false, desk: "crypto" });
      expect(body.desks.hft).toMatchObject({ desk: "hft", level: "late", sent: 1 });
      expect(pages.sent.map((p) => p.title.split(":")[0])).toEqual(["HFT desk"]);
    });

    it("still needs the cron secret", async () => {
      vi.stubEnv("CRON_SECRET", CRON);
      const res = await watchdogRoute.GET(new Request("https://lab.example/api/cron/watchdog", { headers: { authorization: "Bearer nope" } }));
      expect(res.status).toBe(401);
    });
  });
});

describe("GET /api/health", () => {
  const health = async () => (await (await healthRoute.GET()).json()) as Loose;
  const NO_EDITIONS = {
    options: { status: "missing", accepts: 1, session: null, run_id: null, as_of: null, schema_version: null },
    radar: { status: "missing", accepts: 1, edition_date: null, run_id: null, as_of: null, schema_version: null },
  };

  beforeEach(() => {
    vi.stubEnv("BUILD_SHA", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
  });

  it("gains desks.hft with the three fields the crypto desk has, and every older field keeps its place and shape", async () => {
    const stocks = { ...fixture(), run_id: "s1", as_of: "2026-10-01T11:46:00Z" };
    sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify(stocks));
    sdk.current.write(DESK_PATHS.crypto.latest, JSON.stringify(crypto()));
    const body = await health();
    expect(body).toEqual({
      ok: true,
      version: "dev",
      snapshot_as_of: "2026-10-01T11:46:00Z",
      snapshot_run_id: "s1",
      snapshot: "ok",
      desks: {
        crypto: { snapshot: "ok", as_of: "2026-10-01T11:46:00Z", run_id: "c1" },
        hft: { snapshot: "missing", as_of: null, run_id: null },
      },
      editions: NO_EDITIONS,
    });
    // key order too: a program that reads the body as text sees the old fields where they were
    expect(Object.keys(body)).toEqual(["ok", "version", "snapshot_as_of", "snapshot_run_id", "snapshot", "desks", "editions"]);
    expect(Object.keys(body.desks as Loose)).toEqual(["crypto", "hft"]);
    expect(Object.keys((body.desks as Loose).hft as Loose)).toEqual(Object.keys((body.desks as Loose).crypto as Loose));
  });

  it("reports the HFT snapshot on file, and it changes nothing the stocks desk's fields say", async () => {
    await post(hft());
    const body = await health();
    expect(body.desks).toEqual({
      crypto: { snapshot: "missing", as_of: null, run_id: null },
      hft: { snapshot: "ok", as_of: "2026-10-01T11:46:00Z", run_id: "h1" },
    });
    expect([body.snapshot, body.snapshot_as_of, body.snapshot_run_id]).toEqual(["missing", null, null]);
  });

  it("reports unreadable HFT storage as an error for that desk only", async () => {
    sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify(fixture()));
    sdk.current.write(DESK_PATHS.hft.latest, "[]");
    const body = await health();
    expect((body.desks as Loose).hft).toEqual({ snapshot: "error", as_of: null, run_id: null });
    expect(body.snapshot).toBe("ok");
    expect(body.ok).toBe(true);
  });
});
