// Per-key scopes (ADR 0006, addendum of 2026-10-11): a key id can be the primary publisher of its own desk and
// of nothing else. The decision is a pure function; the second half drives it through /api/ingest against a fake
// of the Blob SDK, so "nothing is written anywhere" is a statement about the whole store.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESK_PATHS, DESKS, OPTIONS_LIVE_PATHS, OPTIONS_PATHS, RADAR_PATHS, type DeskName } from "@/lib/desk";
import { fixtureOptionsLive } from "@/lib/fixture-variants";
import { sign } from "@/lib/hmac";
import { KEY_ID_RE, decideScope, parseScopes, type ScopeError } from "@/lib/ingest-scope";
import type { Options } from "@/lib/options";
import cryptoFixture from "./fixtures/crypto.v1.json";
import hftFixture from "./fixtures/hft.v1.json";
import optionsFixture from "./fixtures/options.v1.json";
import radarFixture from "./fixtures/radar.v1.json";
import { makeFakeBlobSdk } from "./blob-sdk";
import { fixture } from "./helpers";

const sdk = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof makeFakeBlobSdk> }));
vi.mock("@vercel/blob", async () => {
  const { makeFakeBlobSdk: make } = await import("./blob-sdk");
  sdk.current = make();
  return sdk.current;
});

const { handleIngest, RADAR_KEY_ID, SCOPES_ENV } = await import("@/lib/ingest");

// Placeholder ids and secrets. `host-a` is the trading host's key, `hft-pub` the other platform's.
const HOST = "host-a";
const HFT = "hft-pub";
const SECRETS: Record<string, string> = { default: "test-default-secret", [HOST]: "test-host-secret", [HFT]: "test-hft-secret", other: "test-other-secret" };
const HFT_ONLY = JSON.stringify({ [HFT]: { desks: ["hft"] } });
const NOW = new Date("2026-10-12T16:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

type Kind = DeskName | "radar" | "options" | "options-live";
const DOCS: Record<Kind, () => unknown> = {
  stocks: () => ({ ...fixture(), run_id: "s1", as_of: "2026-10-12T15:46:00Z" }),
  crypto: () => ({ ...structuredClone(cryptoFixture), run_id: "c1", as_of: "2026-10-12T15:46:00Z" }),
  hft: () => ({ ...structuredClone(hftFixture), run_id: "h1", as_of: "2026-10-12T15:46:00Z", generated_at: "2026-10-12T15:46:01Z" }),
  radar: () => structuredClone(radarFixture),
  options: () => structuredClone(optionsFixture),
  "options-live": () => fixtureOptionsLive(optionsFixture as unknown as Options, NOW, new Set()),
};
const KINDS = Object.keys(DOCS) as Kind[];
const NOT_DESKS = KINDS.filter((k) => !(DESKS as string[]).includes(k)) as Exclude<Kind, DeskName>[];
const LATEST: Record<Exclude<Kind, DeskName>, string> = { radar: RADAR_PATHS.latest, options: OPTIONS_PATHS.latest, "options-live": OPTIONS_LIVE_PATHS.latest };

function send(kind: Kind, keyId: string, secret: string = SECRETS[keyId]!): Promise<Response> {
  const text = JSON.stringify(DOCS[kind]());
  const headers: Record<string, string> = { "x-wt-timestamp": String(NOW_S), "x-wt-signature": sign(secret, NOW_S, Buffer.from(text, "utf8")) };
  if (keyId !== "default") headers["x-wt-key-id"] = keyId;
  return handleIngest(new Request("https://lab.example/api/ingest", { method: "POST", body: text, headers }), NOW);
}
const paths = () => [...sdk.current.store.keys()].sort();
const has = (path: string) => sdk.current.store.has(path);
/** Every path and what is stored at it: what a run left behind. */
const dump = () => paths().map((p) => [p, sdk.current.store.get(p)!.text]);

let log: ReturnType<typeof vi.spyOn>;
const events = (): Record<string, unknown>[] => log.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])) as Record<string, unknown>);

beforeEach(() => {
  sdk.current.reset();
  vi.unstubAllEnvs();
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", SECRETS.default!);
  vi.stubEnv("DASHBOARD_INGEST_KEYS", JSON.stringify({ [HOST]: SECRETS[HOST], [HFT]: SECRETS[HFT], other: SECRETS.other }));
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("reading the scopes map", () => {
  it("unset, blank and {} all mean no scopes", () => {
    for (const raw of [undefined, null, "", "  ", "{}", " { } "]) {
      const s = parseScopes(raw);
      expect(s.ok && s.byKey.size === 0 && s.owner.size === 0, String(raw)).toBe(true);
    }
  });

  it("reads a key's desks, and which key owns each desk", () => {
    const s = parseScopes(JSON.stringify({ [HFT]: { desks: ["hft"] }, [HOST]: { desks: ["stocks", "crypto"] } }));
    if (!s.ok) throw new Error(s.reason);
    expect([...s.byKey.get(HFT)!]).toEqual(["hft"]);
    expect([...s.byKey.get(HOST)!]).toEqual(["stocks", "crypto"]);
    expect([...s.owner]).toEqual([["hft", HFT], ["stocks", HOST], ["crypto", HOST]]);
  });

  const refused: [string, string, ScopeError][] = [
    ["text that is not JSON", `{"${HFT}": {"desks": ["hft"]}`, "not-json"],
    ["an array", `[{"${HFT}": {"desks": ["hft"]}}]`, "not-an-object"],
    ["a string", `"${HFT}"`, "not-an-object"],
    ["null", "null", "not-an-object"],
    ["a key id with a character outside the pattern", `{"hft pub": {"desks": ["hft"]}}`, "bad-key-id"],
    ["a key id that is too long", `{"${"k".repeat(41)}": {"desks": ["hft"]}}`, "bad-key-id"],
    ["an empty key id", `{"": {"desks": ["hft"]}}`, "bad-key-id"],
    ["the research key's id", `{"radar": {"desks": ["hft"]}}`, "reserved-key-id"],
    ["an entry that is a list", `{"${HFT}": ["hft"]}`, "bad-entry"],
    ["an entry that is a string", `{"${HFT}": "hft"}`, "bad-entry"],
    ["a misspelt field", `{"${HFT}": {"desk": ["hft"]}}`, "bad-entry"],
    ["a field beside desks", `{"${HFT}": {"desks": ["hft"], "secret": "x"}}`, "bad-entry"],
    ["desks that is not a list", `{"${HFT}": {"desks": "hft"}}`, "bad-entry"],
    ["an empty desk list", `{"${HFT}": {"desks": []}}`, "empty-desks"],
    ["an unknown desk name", `{"${HFT}": {"desks": ["fx"]}}`, "unknown-desk"],
    ["a desk name in the wrong case", `{"${HFT}": {"desks": ["HFT"]}}`, "unknown-desk"],
    ["a document kind that is not a desk", `{"${HFT}": {"desks": ["hft", "radar"]}}`, "unknown-desk"],
    ["a desk that is not a string", `{"${HFT}": {"desks": [1]}}`, "unknown-desk"],
    ["one desk listed twice", `{"${HFT}": {"desks": ["hft", "hft"]}}`, "desk-claimed-twice"],
    ["one desk given to two keys", `{"${HFT}": {"desks": ["hft"]}, "other": {"desks": ["hft"]}}`, "desk-claimed-twice"],
  ];
  it.each(refused)("refuses %s, whole", (_name, raw, reason) => {
    const s = parseScopes(raw, [RADAR_KEY_ID]);
    expect(s).toMatchObject({ ok: false, reason });
    // one good entry beside a bad one is not applied either
    const mixed = parseScopes(`{"${HOST}": {"desks": ["stocks"]}, ${raw.trim().replace(/^\{/, "")}`, [RADAR_KEY_ID]);
    expect(mixed.ok).toBe(false);
  });

  it("remembers every word of a refused value that could be a key id, matched whole", () => {
    const s = parseScopes(`{"${HFT}": {"desks": ["fx"]}, "host-b": `);
    if (s.ok) throw new Error("accepted");
    expect([...s.named].sort()).toEqual(["desks", "fx", HFT, "host-b"].sort());
    expect(s.named.has("hft")).toBe(false); // part of a word is not the word
    for (const w of s.named) expect(KEY_ID_RE.test(w)).toBe(true);
  });
});

describe("the decision", () => {
  const none = parseScopes(undefined);
  const hftOnly = parseScopes(HFT_ONLY);
  const all: (DeskName | null)[] = [...DESKS, null];

  it("with no scopes, a key is primary exactly when it is PRIMARY_HOST, for every desk and document kind", () => {
    for (const scopes of [none, parseScopes("{}")]) {
      for (const desk of all) {
        expect(decideScope(scopes, "default", desk, "default")).toEqual({ allow: true, primary: true });
        expect(decideScope(scopes, HOST, desk, "default")).toEqual({ allow: true, primary: false });
        expect(decideScope(scopes, HOST, desk, HOST)).toEqual({ allow: true, primary: true });
        expect(decideScope(scopes, "default", desk, HOST)).toEqual({ allow: true, primary: false });
        expect(decideScope(scopes, HFT, desk, HOST)).toEqual({ allow: true, primary: false });
      }
    }
  });

  it("a scoped key is primary for its desks whatever PRIMARY_HOST says, and refused for everything else", () => {
    for (const primaryHost of ["default", HOST, HFT]) {
      expect(decideScope(hftOnly, HFT, "hft", primaryHost)).toEqual({ allow: true, primary: true });
      for (const desk of ["stocks", "crypto", null] as const) {
        expect(decideScope(hftOnly, HFT, desk, primaryHost)).toEqual({ allow: false, outcome: "key-scope" });
      }
    }
  });

  it("an unscoped key is never primary for a desk a scoped key owns, and is unchanged everywhere else", () => {
    expect(decideScope(hftOnly, HOST, "hft", HOST)).toEqual({ allow: true, primary: false });
    for (const desk of ["stocks", "crypto", null] as const) {
      expect(decideScope(hftOnly, HOST, desk, HOST)).toEqual({ allow: true, primary: true });
      expect(decideScope(hftOnly, "other", desk, HOST)).toEqual({ allow: true, primary: false });
    }
    expect(decideScope(hftOnly, "other", "hft", HOST)).toEqual({ allow: true, primary: false });
  });

  it("an unreadable map refuses the key ids it names and leaves every other key on PRIMARY_HOST alone", () => {
    const broken = parseScopes(`{"${HFT}": {"desks": ["fx"]}}`);
    for (const desk of all) {
      expect(decideScope(broken, HFT, desk, HOST)).toEqual({ allow: false, outcome: "key-scope-config" });
      expect(decideScope(broken, HFT, desk, HFT)).toEqual({ allow: false, outcome: "key-scope-config" });
      expect(decideScope(broken, HOST, desk, HOST)).toEqual({ allow: true, primary: true });
      expect(decideScope(broken, "other", desk, HOST)).toEqual({ allow: true, primary: false });
    }
  });
});

describe("ingest with the scopes unset or {}", () => {
  // desk, key id, PRIMARY_HOST, the slot it must land in
  const table: [DeskName, string, string, "latest" | "shadow"][] = DESKS.flatMap((desk): [DeskName, string, string, "latest" | "shadow"][] => [
    [desk, "default", "", "latest"],
    [desk, HOST, "", "shadow"],
    [desk, HFT, "", "shadow"],
    [desk, HOST, HOST, "latest"],
    [desk, "default", HOST, "shadow"],
    [desk, HFT, HOST, "shadow"],
  ]);

  for (const [name, value] of [["unset", undefined], ["{}", "{}"]] as const) {
    it.each(table)(`${name}: a %s snapshot signed as %s with PRIMARY_HOST "%s" goes to the %s slot`, async (desk, keyId, primaryHost, slot) => {
      if (value !== undefined) vi.stubEnv(SCOPES_ENV, value);
      vi.stubEnv("PRIMARY_HOST", primaryHost);
      const res = await send(desk, keyId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("stored");
      expect(body.shadow).toBe(slot === "shadow" ? true : undefined);
      expect(has(DESK_PATHS[desk][slot])).toBe(true);
      expect(has(DESK_PATHS[desk][slot === "latest" ? "shadow" : "latest"])).toBe(false);
      expect(paths().every((p) => p === DESK_PATHS[desk][slot] || (slot === "latest" && p.startsWith(DESK_PATHS[desk].history)))).toBe(true);
    });
  }

  it("{} leaves the store exactly as unset does, for every document kind and key", async () => {
    const run = async (value: string | undefined) => {
      sdk.current.reset();
      vi.stubEnv(SCOPES_ENV, value ?? "");
      const answers: unknown[] = [];
      for (const primaryHost of ["", HOST]) {
        vi.stubEnv("PRIMARY_HOST", primaryHost);
        for (const kind of KINDS) {
          for (const keyId of ["default", HOST, HFT]) {
            const res = await send(kind, keyId);
            answers.push([primaryHost, kind, keyId, res.status, await res.json()]);
          }
        }
      }
      return { answers, store: dump() };
    };
    const unset = await run(undefined);
    expect(await run("{}")).toEqual(unset);
    expect(unset.store.length).toBeGreaterThan(8); // every kind was stored somewhere
    expect(events().some((e) => e.evt === "ingest.scopes")).toBe(false);
  });
});

describe("ingest with a key scoped to the HFT desk", () => {
  beforeEach(() => {
    vi.stubEnv(SCOPES_ENV, HFT_ONLY);
    vi.stubEnv("PRIMARY_HOST", HOST);
  });

  it("stores its HFT snapshot in the HFT primary slot, with PRIMARY_HOST pointing elsewhere", async () => {
    const res = await send("hft", HFT);
    expect([res.status, await res.json()]).toEqual([200, { status: "stored", run_id: "h1" }]);
    expect(paths()).toEqual([`${DESK_PATHS.hft.history}2026-10-12/15.json`, DESK_PATHS.hft.latest]);
  });

  it.each(KINDS.filter((k) => k !== "hft"))("refuses its %s document with 403 and its own reason, and writes nothing anywhere", async (kind) => {
    const res = await send(kind, HFT);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "this key may not publish this document" });
    expect(paths()).toEqual([]);
    const line = events().find((e) => e.evt === "ingest")!;
    expect(line).toMatchObject({ outcome: "key-scope", status: 403, key_id: HFT });
    expect(line.outcome).not.toBe("radar-key-scope");
  });

  it("refuses a body that names no schema at all, or an unknown one, the same way", async () => {
    for (const body of [{}, { schema: "something-else" }, [], "text", null]) {
      const text = JSON.stringify(body);
      const headers = { "x-wt-key-id": HFT, "x-wt-timestamp": String(NOW_S), "x-wt-signature": sign(SECRETS[HFT]!, NOW_S, Buffer.from(text, "utf8")) };
      const res = await handleIngest(new Request("https://lab.example/api/ingest", { method: "POST", body: text, headers }), NOW);
      expect(res.status, text).toBe(403);
    }
    expect(paths()).toEqual([]);
  });

  it("the documents it is refused for are ones an unscoped primary key may publish", async () => {
    for (const kind of KINDS.filter((k) => k !== "hft")) expect((await send(kind, HOST)).status, kind).toBe(200);
  });

  it("the PRIMARY_HOST key's HFT snapshot goes to the HFT shadow slot; its stocks and crypto snapshots stay primary", async () => {
    await send("hft", HFT);
    const before = sdk.current.store.get(DESK_PATHS.hft.latest)!.text;
    const res = await send("hft", HOST);
    expect([res.status, await res.json()]).toEqual([200, { status: "stored", run_id: "h1", shadow: true }]);
    expect(has(DESK_PATHS.hft.shadow)).toBe(true);
    expect(sdk.current.store.get(DESK_PATHS.hft.latest)!.text).toBe(before);

    for (const desk of ["stocks", "crypto"] as const) {
      const r = await send(desk, HOST);
      expect([r.status, await r.json()]).toEqual([200, { status: "stored", run_id: desk === "stocks" ? "s1" : "c1" }]);
      expect(has(DESK_PATHS[desk].latest)).toBe(true);
      expect(has(DESK_PATHS[desk].shadow)).toBe(false);
    }
  });

  it("the PRIMARY_HOST key keeps the research editions and the options live document", async () => {
    for (const kind of NOT_DESKS) {
      expect((await send(kind, HOST)).status, kind).toBe(200);
      expect(has(LATEST[kind])).toBe(true);
    }
  });

  it("a key that is neither scoped nor primary is filed in the shadow slots, as before", async () => {
    for (const desk of DESKS) {
      expect(await (await send(desk, "other")).json()).toMatchObject({ status: "stored", shadow: true });
    }
    expect(paths()).toEqual(DESKS.map((d) => DESK_PATHS[d].shadow).sort());
  });

  it("the signature comes first: a scoped key id with a wrong signature is answered like any wrong signature", async () => {
    const answers: unknown[] = [];
    for (const keyId of [HFT, HOST, "default", "stranger"]) {
      for (const kind of ["hft", "stocks", "radar"] as const) {
        const res = await send(kind, keyId, "wrong-secret");
        answers.push([res.status, await res.json(), [...res.headers].sort()]);
      }
    }
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify([401, { error: "unauthorized" }, [...Response.json({}, { headers: { "cache-control": "no-store" } }).headers].sort()])]));
    expect(paths()).toEqual([]);
    expect(events().every((e) => e.outcome === "unauthorized")).toBe(true);
  });

  it("a scoped key with no secret configured is unauthorized, and still owns its desk", async () => {
    vi.stubEnv("DASHBOARD_INGEST_KEYS", JSON.stringify({ [HOST]: SECRETS[HOST] }));
    expect((await send("hft", HFT)).status).toBe(401);
    expect(await (await send("hft", HOST)).json()).toMatchObject({ shadow: true });
    expect(paths()).toEqual([DESK_PATHS.hft.shadow]);
  });
});

describe("ingest with a scopes map it cannot read", () => {
  const broken = [`{"${HFT}": {"desks": ["hft"]}`, `{"${HFT}": {"desks": ["fx"]}}`, `{"${HFT}": {"desks": []}}`, `{"${HFT}": {"desks": ["hft"]}, "bad id": {"desks": ["crypto"]}}`];

  it.each(broken)("%s: a key id it names is refused for everything and nothing is stored", async (raw) => {
    vi.stubEnv(SCOPES_ENV, raw);
    vi.stubEnv("PRIMARY_HOST", HOST);
    for (const kind of KINDS) {
      const res = await send(kind, HFT);
      expect([res.status, await res.json()], kind).toEqual([503, { error: "ingest is not configured for this key" }]);
    }
    expect(paths()).toEqual([]);
    expect(events().filter((e) => e.evt === "ingest.scopes").length).toBe(KINDS.length);
    expect(events().find((e) => e.evt === "ingest")).toMatchObject({ outcome: "key-scope-config", key_id: HFT });
  });

  it.each(broken)("%s: every other key behaves as if the variable were unset, and the fault is logged without the value", async (raw) => {
    vi.stubEnv(SCOPES_ENV, raw);
    vi.stubEnv("PRIMARY_HOST", HOST);
    for (const desk of DESKS) expect(await (await send(desk, HOST)).json(), desk).not.toHaveProperty("shadow");
    expect(await (await send("hft", "other")).json()).toMatchObject({ shadow: true });
    expect(DESKS.every((d) => has(DESK_PATHS[d].latest))).toBe(true);
    const faults = events().filter((e) => e.evt === "ingest.scopes");
    expect(faults.length).toBe(DESKS.length + 1);
    for (const f of faults) {
      expect(Object.keys(f).sort()).toEqual(["at", "evt", "outcome", "reason"]);
      expect(JSON.stringify(f)).not.toContain(HFT);
    }
  });

  it("a wrong signature is still answered first, and no fault is logged for it", async () => {
    vi.stubEnv(SCOPES_ENV, broken[0]!);
    const res = await send("hft", HFT, "wrong-secret");
    expect([res.status, await res.json()]).toEqual([401, { error: "unauthorized" }]);
    expect(events().some((e) => e.evt === "ingest.scopes")).toBe(false);
  });
});
