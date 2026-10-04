// Desks (ADR 0005): one site, two snapshots, and nothing crossing between them. Ingest files a body by the
// `schema` inside the signed body; each desk has its own slot, history and watchdog state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cryptoHealth } from "@/lib/crypto";
import type { CryptoSnapshot } from "@/lib/crypto.types";
import { DESK_PATHS, deskOfPath } from "@/lib/desk";
import { freshness } from "@/lib/freshness";
import { sign } from "@/lib/hmac";
import { deskOf, validateCryptoSnapshot, validateSnapshot } from "@/lib/validate";
import cryptoFixture from "./fixtures/crypto.v1.json";
import { makeFakeBlobSdk } from "./blob-sdk";
import { fixture } from "./helpers";

const sdk = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof makeFakeBlobSdk> }));
vi.mock("@vercel/blob", async () => {
  const { makeFakeBlobSdk: make } = await import("./blob-sdk");
  sdk.current = make();
  return sdk.current;
});
const pages = vi.hoisted(() => ({ sent: [] as { kind: string; title: string }[] }));
vi.mock("@/lib/ntfy", async (orig) => ({
  ...(await orig<typeof import("@/lib/ntfy")>()),
  sendNtfy: vi.fn(async (n: { kind: string; title: string }) => {
    pages.sent.push(n);
    return "sent" as const;
  }),
}));

const { handleIngest } = await import("@/lib/ingest");
const { runCryptoWatchdog, runWatchdog } = await import("@/lib/watchdog-run");

const SECRET = "test-ingest-secret";
const NOW = new Date("2026-10-03T03:00:00Z"); // a Saturday, 23:00 on Friday in New York: no equity window
const crypto = (over: Partial<CryptoSnapshot> = {}): CryptoSnapshot =>
  ({
    ...(cryptoFixture as unknown as CryptoSnapshot),
    run_id: "c1",
    as_of: "2026-10-03T02:46:00Z",
    expected_windows: [{ session: "always", start: "2026-10-02T02:46:00Z", end: "2026-10-17T02:46:00Z" }],
    ...over,
  }) as CryptoSnapshot;

function signed(body: string): Request {
  const ts = Math.floor(NOW.getTime() / 1000);
  return new Request("https://lab.example/api/ingest", {
    method: "POST",
    body,
    headers: { "x-wt-timestamp": String(ts), "x-wt-signature": sign(SECRET, ts, Buffer.from(body, "utf8")) },
  });
}

const stored = (path: string) => sdk.current.store.get(path)?.text ?? null;

beforeEach(() => {
  sdk.current.reset();
  pages.sent.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", SECRET);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("which desk", () => {
  it("comes from the path for pages and from the body for snapshots", () => {
    expect(["/", "/risk", "/engineering", "/cryptography"].map(deskOfPath)).toEqual(["stocks", "stocks", "stocks", "stocks"]);
    expect(["/crypto", "/crypto/risk"].map(deskOfPath)).toEqual(["crypto", "crypto"]);
    expect(deskOf(crypto())).toBe("crypto");
    expect(deskOf(fixture())).toBe("stocks");
    expect(deskOf({ schema: "something-else" })).toBe("stocks");
    expect(deskOf(null)).toBe("stocks");
  });

  it("keeps the stocks desk on its original paths", () => {
    expect(DESK_PATHS.stocks).toEqual({
      latest: "snapshots/latest.json",
      shadow: "shadow/latest.json",
      history: "snapshots/history/",
      alertState: "alerts/state.json",
    });
    const all = Object.values(DESK_PATHS).flatMap((p) => Object.values(p));
    expect(new Set(all).size).toBe(all.length);
    // the stocks history prune lists "snapshots/history/": the crypto history must not sit under it
    expect(DESK_PATHS.crypto.history.startsWith(DESK_PATHS.stocks.history)).toBe(false);
  });
});

describe("the crypto contract", () => {
  it("accepts the committed fixture and refuses unknown keys and the stocks schema id", () => {
    expect(validateCryptoSnapshot(cryptoFixture).ok).toBe(true);
    expect(validateCryptoSnapshot({ ...cryptoFixture, account_id: "x" }).ok).toBe(false);
    expect(validateCryptoSnapshot({ ...cryptoFixture, schema: "trading-lab/snapshot" }).ok).toBe(false);
    expect(validateSnapshot(cryptoFixture).ok).toBe(false); // and it is not a stocks snapshot either
  });
});

describe("ingest files a snapshot by the schema in its signed body", () => {
  it("stores a crypto snapshot in the crypto slot and its own history, and leaves the stocks slot alone", async () => {
    sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify(fixture()));
    const before = stored(DESK_PATHS.stocks.latest);
    const res = await handleIngest(signed(JSON.stringify(crypto())), NOW);
    expect(res.status).toBe(200);
    expect(JSON.parse(stored(DESK_PATHS.crypto.latest)!).run_id).toBe("c1");
    expect(stored("snapshots/crypto/history/2026-10-03/02.json")).not.toBeNull();
    expect(stored(DESK_PATHS.stocks.latest)).toBe(before);
    expect([...sdk.current.store.keys()].filter((k) => k.startsWith("snapshots/history/"))).toEqual([]);
  });

  it("refuses a stocks snapshot relabelled as crypto, and a crypto one relabelled as stocks", async () => {
    const asCrypto = JSON.stringify({ ...fixture(), schema: "trading-lab/crypto-snapshot" });
    expect((await handleIngest(signed(asCrypto), NOW)).status).toBe(422);
    const asStocks = JSON.stringify({ ...crypto(), schema: "trading-lab/snapshot" });
    expect((await handleIngest(signed(asStocks), NOW)).status).toBe(422);
    expect(sdk.current.store.size).toBe(0);
  });

  it("keeps the older / duplicate rules per desk", async () => {
    expect((await handleIngest(signed(JSON.stringify(crypto())), NOW)).status).toBe(200);
    expect(await (await handleIngest(signed(JSON.stringify(crypto())), NOW)).json()).toMatchObject({ status: "duplicate" });
    const older = crypto({ run_id: "c0", as_of: "2026-10-03T02:31:00Z" });
    expect((await handleIngest(signed(JSON.stringify(older)), NOW)).status).toBe(409);
  });

  it("a non-primary host's crypto snapshot goes to the crypto shadow slot", async () => {
    vi.stubEnv("PRIMARY_HOST", "gcp-use1"); // the default key is no longer the primary
    const res = await handleIngest(signed(JSON.stringify(crypto())), NOW);
    expect(await res.json()).toMatchObject({ shadow: true });
    expect(stored(DESK_PATHS.crypto.shadow)).not.toBeNull();
    expect(stored(DESK_PATHS.crypto.latest)).toBeNull();
  });
});

describe("the crypto desk's watchdog", () => {
  it("does nothing, and pages nobody, while the desk has never published", async () => {
    expect(await runCryptoWatchdog(NOW)).toMatchObject({ skipped: "never published" });
    expect(pages.sent).toEqual([]);
    expect(stored(DESK_PATHS.crypto.alertState)).toBeNull();
  });

  it("pages a late desk on a weekend, says which desk, and keeps its own state", async () => {
    sdk.current.write(DESK_PATHS.crypto.latest, JSON.stringify(crypto({ as_of: "2026-10-03T02:15:00Z" }))); // 45 min old
    sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify(fixture()));
    const r = await runCryptoWatchdog(NOW);
    expect(r).toMatchObject({ desk: "crypto", level: "late", in_window: true });
    expect(pages.sent.map((p) => p.kind)).toEqual(["late"]);
    expect(pages.sent[0]!.title.startsWith("Crypto desk: ")).toBe(true);
    expect(JSON.parse(stored(DESK_PATHS.crypto.alertState)!).level).toBe("late");
    expect(stored(DESK_PATHS.stocks.alertState)).toBeNull();
    pages.sent.length = 0;
    expect((await runCryptoWatchdog(NOW)).notices).toEqual([]); // quiet until it changes
    sdk.current.write(DESK_PATHS.crypto.latest, JSON.stringify(crypto({ as_of: "2026-10-03T02:59:00Z" })));
    await runCryptoWatchdog(NOW);
    expect(pages.sent.map((p) => p.kind)).toEqual(["recovered"]);
  });

  it("keeps paging once it has published and then gone silent, even with the snapshot gone", async () => {
    sdk.current.write(DESK_PATHS.crypto.alertState, JSON.stringify({ level: "ok", last_prune_day: "2026-10-03" }));
    const r = await runCryptoWatchdog(NOW);
    expect(r.skipped).toBeUndefined();
  });

  it("the stocks tick is not affected by a stale crypto desk", async () => {
    sdk.current.write(DESK_PATHS.crypto.latest, JSON.stringify(crypto({ as_of: "2026-10-02T20:00:00Z" })));
    sdk.current.write(DESK_PATHS.stocks.latest, JSON.stringify(fixture()));
    const before = pages.sent.length;
    await runWatchdog(NOW);
    expect(pages.sent.slice(before).every((p) => !p.title.startsWith("Crypto desk"))).toBe(true);
    expect(stored(DESK_PATHS.crypto.alertState)).toBeNull();
  });
});

describe("crypto health", () => {
  const at = (s: CryptoSnapshot, now = NOW.getTime()) =>
    cryptoHealth(s, freshness(s.as_of ?? null, (s.expected_windows ?? []) as never, now));

  it("is amber with the kill switch on and red when the desk stops or has no data", () => {
    const base = crypto({ kill: { on: false, since: null }, alerts: { firing: [] }, activity: { cycles_24h: 96, expected_24h: 96 } });
    expect(at(base).level).toBe("green");
    expect(at(crypto({ ...base, kill: { on: true, since: null } })).reasons.map((r) => r.code)).toEqual(["kill"]);
    expect(at(base, NOW.getTime() + 3 * 3_600_000).level).toBe("red");
    const stale = crypto({ ...base, alerts: { firing: [{ key: "crypto:data-stale", since: null }] } });
    expect(at(stale).level).toBe("red");
    expect(at(crypto({ ...base, activity: { cycles_24h: 40, expected_24h: 96 } })).reasons.map((r) => r.code)).toEqual(["cycles"]);
  });
});
