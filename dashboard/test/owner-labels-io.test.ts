// The labels' bars fetch (IEX by name, DEC-0049 point 1) and their create-only store (DEC-0045 section 3: written once
// per session). Injected fetch and in-memory stores only: no network, no Blob.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({ readText: vi.fn(), writeText: vi.fn() }));
vi.mock("@/lib/blob", async (orig) => ({ ...(await orig<typeof import("@/lib/blob")>()), readText: blob.readText, writeText: blob.writeText }));

import { PreconditionFailed } from "@/lib/blob";
import { EXP_0031_RULES, EXP_0033_RULES, LABEL_ROW_KEYS, labelSessionBounds, type LabelFeed, type LabelRow } from "@/lib/owner-labels";
import { dataBase, fetchLabelBars, labelBarsUrl, MAX_PAGES, normaliseLabelBar } from "@/lib/owner-labels-fetch";
import { defaultLabelStore, labelsPath, memoryLabelStore, parseLabels, readSessionLabels, resetMemoryLabels, writeSessionLabels } from "@/lib/owner-labels-store";

afterEach(() => {
  resetMemoryLabels();
  vi.unstubAllEnvs();
  blob.readText.mockReset();
  blob.writeText.mockReset();
});

const S = "2026-11-12";
const B = labelSessionBounds(S)!;
const KEYS = { id: "key-id", secret: "key-secret" };
const t = (hhmm: string) => new Date(Date.parse(`${S}T${hhmm}:00-05:00`)).toISOString();

function answering(pages: unknown[], status = 200, headers: Record<string, string> = {}) {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    inits.push(init);
    const body = pages[Math.min(urls.length - 1, pages.length - 1)];
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { impl, urls, inits };
}

describe("the labels' bars fetch", () => {
  it("asks for IEX by name, with ALPACA_FEED=sip in the environment", async () => {
    vi.stubEnv("ALPACA_FEED", "sip");
    const f = answering([{ bars: { ABC: [{ t: t("09:30"), o: 95, h: 95.2, l: 94.9, c: 95.1, v: 1200, vw: 95.05 }] }, next_page_token: null }]);
    const r = await fetchLabelBars("iex", ["ABC", "SMH"], B, { keys: KEYS, fetchImpl: f.impl, now: () => new Date("2026-11-12T21:30:00.000Z") });
    expect(f.urls).toHaveLength(1);
    const u = new URL(f.urls[0]!);
    expect(u.origin + u.pathname).toBe("https://data.alpaca.markets/v2/stocks/bars");
    expect(u.searchParams.get("feed")).toBe("iex");
    expect(f.urls[0]).not.toMatch(/sip/i);
    expect(u.searchParams.get("timeframe")).toBe("2Min");
    expect(u.searchParams.get("symbols")).toBe("ABC,SMH");
    expect(u.searchParams.get("start")).toBe(new Date(B.open).toISOString());
    expect(u.searchParams.get("end")).toBe(new Date(B.close).toISOString());
    expect(r).toEqual({
      ok: true,
      feed: "iex",
      bars: { ABC: [{ start: Date.parse(t("09:30")), end: Date.parse(t("09:32")), o: 95, h: 95.2, l: 94.9, c: 95.1, v: 1200, vw: 95.05 }], SMH: [] },
      fetchedAt: "2026-11-12T21:30:00.000Z",
      requests: [{ pages: 1, complete: true }],
    });
    expect(labelBarsUrl("https://data.alpaca.markets", "iex", ["X"], B, null)).toContain("feed=iex");
  });

  it("asks for SIP by name when told to, with ALPACA_FEED=iex in the environment", async () => {
    vi.stubEnv("ALPACA_FEED", "iex");
    const f = answering([{ bars: { ABC: [{ t: t("09:30"), o: 95, h: 95, l: 95, c: 95, v: 10, vw: 95 }] } }]);
    const r = await fetchLabelBars("sip", ["ABC"], B, { keys: KEYS, fetchImpl: f.impl });
    expect(new URL(f.urls[0]!).searchParams.get("feed")).toBe("sip");
    expect(f.urls[0]).not.toMatch(/iex/i);
    expect(r).toMatchObject({ ok: true, feed: "sip" });
    const g = answering([{}], 500);
    expect(await fetchLabelBars("sip", ["ABC"], B, { keys: KEYS, fetchImpl: g.impl })).toMatchObject({ ok: false, feed: "sip" });
  });

  it("takes its feed from the experiment's rules: EXP-0031 asks IEX, EXP-0033 asks SIP", async () => {
    for (const [rules, want] of [[EXP_0031_RULES, "iex"], [EXP_0033_RULES, "sip"]] as const) {
      const f = answering([{ bars: {} }]);
      await fetchLabelBars(rules.feed, ["ABC"], B, { keys: KEYS, fetchImpl: f.impl });
      expect(new URL(f.urls[0]!).searchParams.get("feed")).toBe(want);
    }
  });

  it("has no default feed: anything but iex or sip throws before a request", async () => {
    const f = answering([{ bars: {} }]);
    for (const bad of [undefined, "", "IEX", "opra", "indicative"]) {
      await expect(fetchLabelBars(bad as unknown as LabelFeed, ["ABC"], B, { keys: KEYS, fetchImpl: f.impl })).rejects.toThrow(TypeError);
      expect(() => labelBarsUrl("https://data.alpaca.markets", bad as unknown as LabelFeed, ["X"], B, null)).toThrow();
    }
    expect(f.urls).toEqual([]);
  });

  it("sends the keys to Alpaca only, refuses redirects, and never sends them to another host", async () => {
    const f = answering([{ bars: {} }]);
    await fetchLabelBars("iex", ["ABC"], B, { keys: KEYS, fetchImpl: f.impl });
    expect(f.inits[0]!.redirect).toBe("error");
    expect((f.inits[0]!.headers as Record<string, string>)["APCA-API-KEY-ID"]).toBe("key-id");
    for (const bad of ["http://data.alpaca.markets", "https://evil.example", "https://data.alpaca.markets:8443", "https://u:p@data.alpaca.markets"]) {
      const g = answering([{ bars: {} }]);
      expect(await fetchLabelBars("iex", ["ABC"], B, { keys: KEYS, fetchImpl: g.impl, baseUrl: bad })).toMatchObject({ ok: false, reason: "bad_host" });
      expect(g.urls).toEqual([]);
      expect(dataBase(bad)).toBeNull();
    }
    expect(dataBase("https://data.sandbox.alpaca.markets/")).toBe("https://data.sandbox.alpaca.markets");
  });

  it("follows every page, and reports a request still paging after MAX_PAGES as not complete", async () => {
    const f = answering([
      { bars: { ABC: [{ t: t("09:30"), o: 1, h: 1, l: 1, c: 1, v: 1, vw: 1 }] }, next_page_token: "p2" },
      { bars: { ABC: [{ t: t("09:32"), o: 2, h: 2, l: 2, c: 2, v: 1, vw: 2 }] }, next_page_token: null },
    ]);
    const r = await fetchLabelBars("iex", ["ABC"], B, { keys: KEYS, fetchImpl: f.impl });
    expect(f.urls).toHaveLength(2);
    expect(new URL(f.urls[1]!).searchParams.get("page_token")).toBe("p2");
    expect(new URL(f.urls[1]!).searchParams.get("feed")).toBe("iex");
    expect(r.ok && r.bars.ABC!.map((b) => b.c)).toEqual([1, 2]);
    const endless = answering([{ bars: {}, next_page_token: "again" }]);
    expect(r).toMatchObject({ requests: [{ pages: 2, complete: true }] });
    expect(await fetchLabelBars("iex", ["ABC"], B, { keys: KEYS, fetchImpl: endless.impl })).toMatchObject({ ok: true, requests: [{ pages: MAX_PAGES, complete: false }] });
    expect(endless.urls).toHaveLength(MAX_PAGES);
  });

  it("answers a typed failure, never a partial answer or a body", async () => {
    const r429 = await fetchLabelBars("iex", ["ABC"], B, { keys: KEYS, fetchImpl: answering([{}], 429, { "retry-after": "7" }).impl });
    expect(r429).toEqual({ ok: false, feed: "iex", reason: "rate_limited", status: 429, retryAfterMs: 7000 });
    expect(await fetchLabelBars("iex", ["ABC"], B, { keys: KEYS, fetchImpl: answering([{}], 403).impl })).toMatchObject({ ok: false, reason: "refused", status: 403 });
    expect(await fetchLabelBars("iex", ["ABC"], B, { keys: KEYS, fetchImpl: answering([{}], 500).impl })).toMatchObject({ ok: false, reason: "http", status: 500 });
    expect(await fetchLabelBars("iex", ["ABC"], B, { keys: KEYS, fetchImpl: answering([{ bars: { ABC: "x" } }]).impl })).toMatchObject({ ok: false, reason: "malformed" });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await fetchLabelBars("iex", ["ABC"], B, { keys: KEYS, fetchImpl: down })).toMatchObject({ ok: false, reason: "transport" });
    const slow = (async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    expect(await fetchLabelBars("iex", ["ABC"], B, { keys: KEYS, fetchImpl: slow })).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("keeps a bar only inside the session on the 2-minute grid, and volume and VWAP only when they are numbers", () => {
    expect(normaliseLabelBar({ t: t("09:28"), o: 1, h: 1, l: 1, c: 1 }, B)).toBeNull();
    expect(normaliseLabelBar({ t: t("15:58"), o: 1, h: 1, l: 1, c: 1 }, B)).not.toBeNull();
    expect(normaliseLabelBar({ t: t("16:00"), o: 1, h: 1, l: 1, c: 1 }, B)).toBeNull();
    expect(normaliseLabelBar({ t: "2026-11-12T14:31:00Z", o: 1, h: 1, l: 1, c: 1 }, B)).toBeNull();
    expect(normaliseLabelBar({ t: t("10:00"), o: 1, h: 1, l: 1, c: 1 }, B)).toMatchObject({ v: null, vw: null });
    expect(normaliseLabelBar({ t: t("10:00"), o: 1, h: 1, l: 1, c: 0 }, B)).toBeNull();
  });
});

// ---- the source scan --------------------------------------------------------------------------------------------
const FILES = ["owner-labels.ts", "owner-labels-fetch.ts", "owner-labels-store.ts"];
const src = (f: string) => readFileSync(fileURLToPath(new URL(`../src/lib/${f}`, import.meta.url)), "utf8");

describe("the labels never follow the site's feed setting", () => {
  it("no code in the three modules reads it, or reaches the board's bars fetch", () => {
    for (const f of FILES) {
      const text = src(f);
      expect(text, f).not.toMatch(/ALPACA_FEED|requireFeed|configuredFeed|feedSetting|DEFAULT_FEED|fetchSettledBars|fetchBars\b|alpaca-feed|["'](?:\.\/|@\/lib\/)bars["']/);
      expect(text, f).not.toMatch(/from\s+["'](?:\.\/|@\/lib\/)(?:alpaca-feed|bars|quote)["']/);
    }
  });
});

// ---- the store --------------------------------------------------------------------------------------------------
const row = (over: Partial<LabelRow> = {}): LabelRow => ({
  format: 1,
  experiment: "EXP-0031",
  symbol: "ABC",
  kind: "call",
  strike: 102.5,
  expiry: "2026-11-20",
  t0: "2026-11-12T15:05:00.000Z",
  session: S,
  label: "in_zone",
  reason: null,
  cautions: [],
  unknown: 0,
  edition_copy_received_at: "2026-11-12T05:00:00.000Z",
  covering_stamp_key: null,
  feed: "iex",
  engine_version: "e-test",
  bars_fetched_at: "2026-11-12T21:30:00.000Z",
  ...over,
});

describe("the labels' store", () => {
  const E1 = "EXP-0031" as const;
  const E3 = "EXP-0033" as const;
  const r3 = (over: Partial<LabelRow> = {}) => row({ experiment: E3, feed: "sip", covering_stamp_key: "desk/feeds/board/2026-11-12/1005.json", ...over });

  it("keeps an experiment's session at desk/labels/<experiment>/YYYY-MM-DD.json and nowhere else", () => {
    expect(labelsPath(E1, S)).toBe("desk/labels/EXP-0031/2026-11-12.json");
    expect(labelsPath(E3, S)).toBe("desk/labels/EXP-0033/2026-11-12.json");
    expect(() => labelsPath(E1, "2026-02-30")).toThrow();
    expect(() => labelsPath(E1, "../x")).toThrow();
    expect(() => labelsPath("EXP-0032" as never, S)).toThrow();
  });

  it("writes a session once per experiment: a second write is refused, reported, and the first is kept", async () => {
    const store = memoryLabelStore();
    expect(await writeSessionLabels(E1, S, [row()], store)).toEqual({ state: "written" });
    expect(await writeSessionLabels(E1, S, [row({ label: "off_plan" })], store)).toEqual({ state: "exists" });
    const read = await readSessionLabels(E1, S, store);
    expect(read.state === "ok" && read.doc.rows.map((r) => r.label)).toEqual(["in_zone"]);
    expect(await readSessionLabels(E1, "2026-11-13", store)).toEqual({ state: "missing" });
    // the other experiment's document for the same day is its own
    expect(await readSessionLabels(E3, S, store)).toEqual({ state: "missing" });
    expect(await writeSessionLabels(E3, S, [r3()], store)).toEqual({ state: "written" });
  });

  it("refuses a row of another session, another experiment, or with other keys", async () => {
    const store = memoryLabelStore();
    expect(await writeSessionLabels(E1, S, [row({ session: "2026-11-13" })], store)).toEqual({ state: "refused" });
    expect(await writeSessionLabels(E1, S, [row(), r3()], store)).toEqual({ state: "refused" });
    expect(await writeSessionLabels(E3, S, [row()], store)).toEqual({ state: "refused" });
    expect(await writeSessionLabels(E1, S, [{ ...row(), r25: 1 } as unknown as LabelRow], store)).toEqual({ state: "refused" });
    expect(await readSessionLabels(E1, S, store)).toEqual({ state: "missing" });
    expect(Object.keys(row())).toEqual([...LABEL_ROW_KEYS]);
  });

  it("reads back only a document of exactly one experiment and one day", async () => {
    expect(parseLabels(JSON.stringify({ format: 1, experiment: E1, session: S, rows: [row()] }))).not.toBeNull();
    expect(parseLabels(JSON.stringify({ format: 1, experiment: E1, session: S, rows: [row()], extra: 1 }))).toBeNull();
    expect(parseLabels(JSON.stringify({ format: 1, experiment: E1, session: S, rows: [row(), r3()] }))).toBeNull();
    expect(parseLabels(JSON.stringify({ format: 1, session: S, rows: [row()] }))).toBeNull();
    // a mixed document stored under an experiment's path is malformed, never served
    const store = memoryLabelStore();
    await store.createOnly(labelsPath(E1, S), JSON.stringify({ format: 1, experiment: E1, session: S, rows: [row(), r3()] }));
    expect(await readSessionLabels(E1, S, store)).toEqual({ state: "malformed" });
    // the right experiment's document under the other's path is malformed too
    await store.createOnly(labelsPath(E3, S), JSON.stringify({ format: 1, experiment: E1, session: S, rows: [row()] }));
    expect(await readSessionLabels(E3, S, store)).toEqual({ state: "malformed" });
  });

  it("is memory anywhere but production, and memory never touches Blob", async () => {
    for (const env of [{}, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development", DASHBOARD_FIXTURE: "1" }]) {
      const store = defaultLabelStore(env);
      expect(store.memory).toBe(true);
      await writeSessionLabels(E1, S, [row()], store);
      await readSessionLabels(E1, S, store);
      resetMemoryLabels();
    }
    expect(blob.readText).not.toHaveBeenCalled();
    expect(blob.writeText).not.toHaveBeenCalled();
  });

  it("writes create-only in production, and reports a lost race as exists", async () => {
    const store = defaultLabelStore({ VERCEL_ENV: "production" });
    expect(store.memory).toBe(false);
    blob.writeText.mockResolvedValueOnce({ etag: "e" });
    expect(await writeSessionLabels(E3, S, [r3()], store)).toEqual({ state: "written" });
    expect(blob.writeText).toHaveBeenCalledWith("desk/labels/EXP-0033/2026-11-12.json", expect.any(String), { createOnly: true });
    blob.writeText.mockRejectedValueOnce(new PreconditionFailed());
    expect(await writeSessionLabels(E3, S, [r3()], store)).toEqual({ state: "exists" });
    blob.writeText.mockRejectedValueOnce(new Error("down"));
    expect(await writeSessionLabels(E3, S, [r3()], store)).toEqual({ state: "error" });
  });
});
