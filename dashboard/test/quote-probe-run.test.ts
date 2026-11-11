// GET /api/desk/probe (quote-probe-run.ts): the owner's read of the snapshot probe for one New York day, from the
// server check's own records. Hardened like /api/desk/eval-status; reads only the server records of the day asked for;
// never touches the store when dry; a failed read is counted, never thrown.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEvalStatus } from "@/lib/desk-page-run";
import { presentsBypass } from "@/lib/desk-flags-run";
import {
  CACHED_DAYS,
  defaultProbeReadDeps,
  handleProbeSummary,
  MAX_RECORDS,
  parseDay,
  type ProbeReadDeps,
  READ_CONCURRENCY,
  readProbeDay,
  resetProbeCache,
} from "@/lib/quote-probe-run";
import { probeSnapshot } from "@/lib/quote-probe";

const HOST = "desk.example";
const DAY = "2026-10-12";
const NOW = Date.parse(`${DAY}T15:00:00-04:00`);
const req = (q = `?day=${DAY}`, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://${HOST}/api/desk/probe${q}`, { method, headers: { "sec-fetch-site": "same-origin", host: HOST, ...headers } });

const trade = (p: number) => ({ latestTrade: { t: new Date(NOW - 1_000).toISOString(), x: "V", p, s: 1, c: ["@"] }, dailyBar: { t: `${DAY}T04:00:00Z`, o: 100, h: 101, l: 99, c: 100 } });
const record = (p: number) => JSON.stringify({ v: 1, status: "ok", feed: "iex", probe: { v: 1, names: [probeSnapshot("SPY", trade(p), NOW)] } });

function deps(store: Record<string, string | Error>, over: Partial<ProbeReadDeps> = {}) {
  const list = vi.fn(async (prefix: string) => Object.keys(store).filter((k) => k.startsWith(prefix)));
  const read = vi.fn(async (path: string) => {
    const v = store[path];
    if (v instanceof Error) throw v;
    return v ?? null;
  });
  const d: ProbeReadDeps = { now: () => NOW, dry: false, list, read, ...over };
  return { d, list, read };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  resetProbeCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/desk/probe", () => {
  it("counts the day's server records only (never the page's), per name and in total", async () => {
    const f = deps({
      [`desk/log/${DAY}/1030.json`]: record(100),
      [`desk/log/${DAY}/1032.json`]: record(102),
      [`desk/log/${DAY}/1030.page.json`]: '{"v":1,"source":"page"}',
      [`desk/log/${DAY}/1030.page-hidden.json`]: '{"v":1}',
      [`desk/log/2026-10-13/1030.json`]: record(90),
      [`desk/eval.json`]: '{"v":1,"eval":"log"}',
    });
    const res = await handleProbeSummary(req(), f.d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ day: DAY, listed: 2, unreadable: 0, capped: false });
    expect(body.summary).toMatchObject({ records: 2, with_probe: 2, without_probe: 0 });
    expect(body.summary.by_feed.iex.by_symbol.SPY.counts.trade_vs_day).toMatchObject({ inside: 1, "above-high": 1 });
    expect(f.list).toHaveBeenCalledWith(`desk/log/${DAY}/`);
    expect(f.read.mock.calls.map(([p]) => p)).toEqual([`desk/log/${DAY}/1030.json`, `desk/log/${DAY}/1032.json`]);
  });

  it("today's New York day by default", async () => {
    const f = deps({});
    const late = Date.parse("2026-10-13T02:00:00Z"); // 22:00 on the 12th in New York
    expect((await (await handleProbeSummary(req(""), { ...f.d, now: () => late })).json()).day).toBe(DAY);
  });

  it("an unreadable or unparseable record is counted, not thrown; a failed listing is a plain 503", async () => {
    const f = deps({ [`desk/log/${DAY}/1030.json`]: record(100), [`desk/log/${DAY}/1032.json`]: "{", [`desk/log/${DAY}/1034.json`]: new Error("blob 500") });
    const body = await (await handleProbeSummary(req(), f.d)).json();
    expect(body).toMatchObject({ listed: 3, unreadable: 2 });
    expect(body.summary.records).toBe(1);
    const broken = deps({}, { list: () => Promise.reject(new Error("secret detail")) });
    const res = await handleProbeSummary(req(), broken.d);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "read-failed" });
    expect(text).not.toContain("secret");
  });

  it("reads at most MAX_RECORDS, a few at a time", async () => {
    const store: Record<string, string> = {};
    for (let i = 0; i < MAX_RECORDS + 4; i++) store[`desk/log/${DAY}/${String(i).padStart(4, "0")}.json`] = record(100);
    let inFlight = 0;
    let most = 0;
    const f = deps(store, {
      read: async (p) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await Promise.resolve();
        inFlight--;
        return store[p] ?? null;
      },
    });
    const r = await readProbeDay(f.d, DAY);
    expect(r).toMatchObject({ listed: MAX_RECORDS + 4, capped: true });
    expect(r.summary.records).toBe(MAX_RECORDS);
    expect(most).toBeLessThanOrEqual(READ_CONCURRENCY);
  });

  it("is hardened like eval-status: GET and HEAD only, cross-site and the bypass header refused, a bad day refused", async () => {
    const f = deps({ [`desk/log/${DAY}/1030.json`]: record(100) });
    expect((await handleProbeSummary(req(`?day=${DAY}`, {}, "POST"), f.d)).status).toBe(405);
    expect((await handleProbeSummary(req(`?day=${DAY}`, { "sec-fetch-site": "cross-site" }), f.d)).status).toBe(403);
    expect((await handleProbeSummary(req(`?day=${DAY}`, { "x-vercel-protection-bypass": "x" }), f.d)).status).toBe(403);
    for (const bad of ["2026-13-01", "2026-02-30", "../x", "2026-1-1", "", "2026-10-12T00"]) {
      expect((await handleProbeSummary(req(`?day=${encodeURIComponent(bad)}`), f.d)).status, bad).toBe(400);
    }
    expect(f.list).not.toHaveBeenCalled();
    const head = await handleProbeSummary(req(`?day=${DAY}`, {}, "HEAD"), f.d);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("no-store");
    // a HEAD answers from validation alone: nothing listed, nothing read
    expect(f.list).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect((await handleProbeSummary(req("?day=nope", {}, "HEAD"), f.d)).status).toBe(400);
    expect(parseDay("2026-02-28")).toBe("2026-02-28");
    expect(parseDay(null)).toBeNull();
  });

  it("dry (fixture mode or not production) never touches the store", async () => {
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    const d = defaultProbeReadDeps();
    expect(d.dry).toBe(true);
    const body = await (await handleProbeSummary(req(), d)).json();
    expect(body).toMatchObject({ day: DAY, dry: true, listed: 0, summary: { records: 0 } });
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(defaultProbeReadDeps().dry).toBe(true);
    const f = deps({}, { dry: true });
    await handleProbeSummary(req(), f.d);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  it("keeps a past New York day's summary in memory (a handful of days); today's is read every time", async () => {
    const past = "2026-10-09";
    const store: Record<string, string> = { [`desk/log/${past}/1030.json`]: record(100), [`desk/log/${DAY}/1030.json`]: record(100) };
    const f = deps(store);
    const first = await (await handleProbeSummary(req(`?day=${past}`), f.d)).json();
    expect(first.cached).toBe(false);
    const again = await (await handleProbeSummary(req(`?day=${past}`), f.d)).json();
    expect(again.cached).toBe(true);
    expect({ ...again, cached: false }).toEqual(first);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledTimes(1);
    // today, by name or by default, is never kept
    for (const q of [`?day=${DAY}`, `?day=${DAY}`, ""]) expect((await (await handleProbeSummary(req(q), f.d)).json()).cached).toBe(false);
    expect(f.list).toHaveBeenCalledTimes(4);
    // a future day is not kept either
    await handleProbeSummary(req("?day=2026-10-20"), f.d);
    await handleProbeSummary(req("?day=2026-10-20"), f.d);
    expect(f.list).toHaveBeenCalledTimes(6);
  });

  it("keeps at most CACHED_DAYS past days, and never a day read with a failed record", async () => {
    const f = deps({ "desk/log/2026-09-30/1030.json": new Error("blob 500") });
    await handleProbeSummary(req("?day=2026-09-30"), f.d);
    expect((await (await handleProbeSummary(req("?day=2026-09-30"), f.d)).json()).cached).toBe(false);
    const days = Array.from({ length: CACHED_DAYS + 1 }, (_, i) => `2026-10-0${i + 1}`);
    for (const d of days) await handleProbeSummary(req(`?day=${d}`), f.d);
    const calls = f.list.mock.calls.length;
    // the newest CACHED_DAYS are kept; the first was dropped and is read again
    for (const d of days.slice(1)) expect((await (await handleProbeSummary(req(`?day=${d}`), f.d)).json()).cached, d).toBe(true);
    expect(f.list).toHaveBeenCalledTimes(calls);
    expect((await (await handleProbeSummary(req(`?day=${days[0]}`), f.d)).json()).cached).toBe(false);
    expect(f.list).toHaveBeenCalledTimes(calls + 1);
  });
});

describe("the protection bypass, in every form Vercel documents, on both routes", () => {
  const forms: [string, string, Record<string, string>][] = [
    ["the header", "", { "x-vercel-protection-bypass": "secret" }],
    ["the header, any case", "", { "X-Vercel-Protection-Bypass": "secret" }],
    ["the query parameter", "x-vercel-protection-bypass=secret", {}],
    ["the query parameter, any case", "X-Vercel-Protection-Bypass=secret", {}],
    ["the set-cookie ask as a header", "", { "x-vercel-set-bypass-cookie": "true" }],
    ["the set-cookie ask as a query parameter", "x-vercel-set-bypass-cookie=samesitenone", {}],
  ];
  const evalDeps = () => {
    const exists = vi.fn(async () => true);
    const readSwitch = vi.fn(async () => '{"v":1,"eval":"log"}');
    return { d: { now: () => NOW, dry: false, readSwitch, exists }, exists, readSwitch };
  };

  for (const [what, query, headers] of forms) {
    it(`refuses ${what} before anything is read`, async () => {
      const f = deps({ [`desk/log/${DAY}/1030.json`]: record(100) });
      const probe = await handleProbeSummary(req(`?day=${DAY}${query ? `&${query}` : ""}`, headers), f.d);
      expect(probe.status).toBe(403);
      expect(f.list).not.toHaveBeenCalled();
      const e = evalDeps();
      const status = await handleEvalStatus(new Request(`https://${HOST}/api/desk/eval-status${query ? `?${query}` : ""}`, { headers: { "sec-fetch-site": "same-origin", ...headers } }), e.d);
      expect(status.status).toBe(403);
      expect(e.readSwitch).not.toHaveBeenCalled();
    });
  }

  it("lets an ordinary request through on both routes", async () => {
    expect(presentsBypass(req())).toBe(false);
    expect(presentsBypass(new Request(`https://${HOST}/api/desk/probe?day=${DAY}&x=x-vercel-protection-bypass`))).toBe(false);
    expect((await handleProbeSummary(req(), deps({}).d)).status).toBe(200);
    const e = evalDeps();
    expect((await handleEvalStatus(new Request(`https://${HOST}/api/desk/eval-status`, { headers: { "sec-fetch-site": "same-origin" } }), e.d)).status).toBe(200);
  });
});
