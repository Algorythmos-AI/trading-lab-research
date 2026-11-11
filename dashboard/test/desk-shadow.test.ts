// The page's side of the shadow check: the page-state route (hardened like /api/desk/flags, with a strict schema),
// the status route, the page's own helpers (what it sends, when, and the rail's line), and the shadow summary's maths.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreconditionFailed } from "@/lib/blob";
import { ENGINE_VERSION, type PageRecord, type ServerRecord, expectedSlots, serverLogPath } from "@/lib/desk-eval";
import { DeskShadowCore, type ShadowDeps } from "@/lib/desk-shadow-client";
import { type EvalStatusDeps, handleEvalStatus, handlePageState, lastLoggedSlot, MAX_PAGE_BODY, type PageStateDeps, parsePagePost, STATUS_PROBES } from "@/lib/desk-page-run";
import { median, shadowSummary } from "@/lib/desk-shadow";
import { parseEvalStatus, pausedLine, ServerCheckNote } from "@/components/client/desk-shadow";
import { BoardContext, type Board } from "@/components/client/trade-now";
import { focusOptions } from "@/lib/fixture-variants";
import type { Options } from "@/lib/options";
import type { NameState } from "@/lib/trade-state";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, EDT
const ny = (hhmmss: string, day = S) => Date.parse(`${day}T${hhmmss}-04:00`);
const HOST = "desk.example";
const URL_ = `https://${HOST}/api/desk/page-state`;
const LOG = '{"v":1,"eval":"log"}';
const SLOT = ny("10:30:00");
const NOW = SLOT + 61_000;
const iso = (t: number) => new Date(t).toISOString();

const goodRows = [
  { symbol: "SPY", side: "call", state: "get_ready" },
  { symbol: "SPY", side: "put", state: "watch" },
  { symbol: "QQQ", side: "call", state: "enter_zone" },
];
const settleRows = goodRows.map((r) => ({ ...r, state: "watch" }));
const good = (over: Record<string, unknown> = {}) => ({ slot_end: iso(SLOT), engine: ENGINE_VERSION, as_of: iso(SLOT + 5_000), bars_delayed: false, rows: goodRows, rows_at_settle: settleRows, ...over });

function post(body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return new Request(URL_, {
    method,
    headers: { "content-type": "application/json", origin: `https://${HOST}`, "sec-fetch-site": "same-origin", host: HOST, ...headers },
    body: method === "GET" || method === "HEAD" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function pageDeps(over: Partial<PageStateDeps> = {}) {
  const store = new Map<string, string>();
  const writes = vi.fn(async (p: string, b: string) => {
    if (store.has(p)) throw new PreconditionFailed();
    store.set(p, b);
  });
  const reads = vi.fn(async () => LOG as string | null);
  const deps: PageStateDeps = { now: () => NOW, dry: false, readSwitch: reads, loadEdition: async () => ({ status: "ok", edition: E }), write: writes, ...over };
  return { deps, store, writes, reads };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("POST /api/desk/page-state", () => {
  it("writes the page's rows create-only beside the server's record, and the first page wins", async () => {
    const f = pageDeps();
    const res = await handlePageState(post(good()), f.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.json()).toEqual({ ok: true, saved: true });
    const rec = JSON.parse(f.store.get(`desk/log/${S}/1030.page.json`)!) as PageRecord;
    expect(rec).toEqual({ v: 1, engine: ENGINE_VERSION, source: "page", slot_end: iso(SLOT), received_at: iso(NOW), hidden: false, as_of: iso(SLOT + 5_000), bars_delayed: false, rows: goodRows, rows_at_settle: settleRows });
    const second = await handlePageState(post(good({ rows: [{ symbol: "SPY", side: "call", state: "watch" }] })), f.deps);
    expect(await second.json()).toEqual({ ok: true, saved: false });
    expect(JSON.parse(f.store.get(`desk/log/${S}/1030.page.json`)!).rows).toEqual(goodRows);
  });

  it("takes hidden: true instead of rows, apart, so a hidden tab sending first never takes a visible tab's place", async () => {
    const f = pageDeps();
    const res = await handlePageState(post({ slot_end: iso(SLOT), engine: ENGINE_VERSION, hidden: true }), f.deps);
    expect(res.status).toBe(200);
    expect(JSON.parse(f.store.get(`desk/log/${S}/1030.page-hidden.json`)!)).toMatchObject({ hidden: true, rows: [], rows_at_settle: [], as_of: null, bars_delayed: null });
    expect(f.store.has(`desk/log/${S}/1030.page.json`)).toBe(false);
    expect(await (await handlePageState(post(good()), f.deps)).json()).toEqual({ ok: true, saved: true });
    expect(JSON.parse(f.store.get(`desk/log/${S}/1030.page.json`)!)).toMatchObject({ hidden: false, rows: goodRows });
  });

  it("refuses every other method with 405, and the bypass header with 403, before reading anything", async () => {
    const f = pageDeps();
    for (const m of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await handlePageState(post(good(), {}, m), f.deps);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    expect((await handlePageState(post(good(), { "x-vercel-protection-bypass": "s" }), f.deps)).status).toBe(403);
    expect(f.reads).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("refuses cross-site requests and a missing Origin with no Sec-Fetch-Site", async () => {
    const f = pageDeps();
    const cases: Record<string, string>[] = [{ origin: "https://evil.example" }, { origin: `https://${HOST}.evil.example` }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }];
    for (const h of cases) {
      const res = await handlePageState(post(good(), h), f.deps);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    const bare = new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good()) });
    expect((await handlePageState(bare, f.deps)).status).toBe(403);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON (415) or too large (413), declared or not", async () => {
    const f = pageDeps();
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "", "application/jsonp"]) expect((await handlePageState(post(good(), { "content-type": ct }), f.deps)).status).toBe(415);
    expect((await handlePageState(post(JSON.stringify(good({ pad: "x".repeat(MAX_PAGE_BODY) }))), f.deps)).status).toBe(413);
    expect((await handlePageState(post(good(), { "content-length": "100000" }), f.deps)).status).toBe(413);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("schema: refuses unknown symbols and states, extra fields, prices, notes and duplicates, echoing none of it", async () => {
    const f = pageDeps();
    const bad: unknown[] = [
      good({ rows: [{ symbol: "TSLA", side: "call", state: "watch" }] }), // not a focus name
      good({ rows: [{ symbol: "SPY", side: "call", state: "ENTER ZONE" }] }), // not the enum
      good({ rows: [{ symbol: "SPY", side: "call", state: "buy" }] }),
      good({ rows: [{ symbol: "SPY", side: "both", state: "watch" }] }),
      good({ rows: [{ symbol: "SPY", side: "call", state: "watch", price: 779.4 }] }),
      good({ rows: [{ symbol: "SPY", side: "call", state: "watch" }, { symbol: "SPY", side: "call", state: "watch" }] }),
      good({ note: "took it" }),
      good({ fill: 1.23 }),
      good({ rows: [] }),
      good({ rows_at_settle: [] }),
      good({ rows_at_settle: [{ symbol: "TSLA", side: "call", state: "watch" }] }),
      good({ rows_at_settle: [{ symbol: "SPY", side: "call", state: "go" }] }),
      good({ hidden: true }),
      good({ as_of: iso(SLOT + 4_999) }), // before the slot's close
      good({ as_of: iso(SLOT + 60_000) }), // at settle: not as of the slot
      good({ as_of: "soon" }),
      good({ bars_delayed: "no" }),
      good({ bars_delayed: null }),
      { slot_end: iso(SLOT), engine: ENGINE_VERSION, as_of: iso(SLOT + 5_000), bars_delayed: false, rows: goodRows },
      { slot_end: iso(SLOT), engine: ENGINE_VERSION, hidden: false },
      { slot_end: iso(SLOT), engine: ENGINE_VERSION, hidden: true, rows: goodRows },
      { slot_end: iso(SLOT), rows: goodRows },
      good({ slot_end: iso(SLOT + 1_000) }), // off the 2-minute grid
      good({ slot_end: "10:30" }),
      good({ rows: "SPY" }),
      "[]",
      "{",
      "",
    ];
    for (const b of bad) {
      const res = await handlePageState(post(b), f.deps);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(await res.json()).toEqual({ error: "bad-request" });
    }
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("refuses a slot that is not today's, not settled yet, or too old (409), and an older engine's tab", async () => {
    const f = pageDeps();
    for (const t of [SLOT + 2 * 60_000, SLOT - 10 * 60_000, ny("09:30:00"), ny("16:00:00"), ny("10:30:00", "2026-10-09")]) {
      const res = await handlePageState(post(good({ slot_end: iso(t), as_of: iso(t + 5_000) })), f.deps);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "slot" });
    }
    expect((await handlePageState(post(good({ engine: "2026-01-01.0" })), f.deps)).status).toBe(409);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("refuses everything while the switch is off, missing or malformed", async () => {
    for (const sw of [null, '{"v":1,"eval":"off"}', "{"]) {
      const f = pageDeps({ readSwitch: async () => sw });
      const res = await handlePageState(post(good()), f.deps);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "off" });
      expect(f.writes).not.toHaveBeenCalled();
    }
  });

  it("an edition for another day refuses the slot; a store failure is 503", async () => {
    const f = pageDeps({ loadEdition: async () => ({ status: "ok", edition: { ...E, session: "2026-10-09" } }) });
    expect((await handlePageState(post(good()), f.deps)).status).toBe(409);
    const g = pageDeps({ write: async () => Promise.reject(new Error("store down")) });
    expect((await handlePageState(post(good()), g.deps)).status).toBe(503);
    const h = pageDeps({ loadEdition: async () => ({ status: "error" }) });
    expect((await handlePageState(post(good()), h.deps)).status).toBe(503);
  });

  it("dry (fixture or not production) never writes", async () => {
    const f = pageDeps({ dry: true });
    const res = await handlePageState(post(good()), f.deps);
    expect(await res.json()).toEqual({ ok: true, saved: false, dry: true });
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("parsePagePost takes exactly the schema", () => {
    const focus = new Set(["SPY", "QQQ", "AAPL"]);
    expect(parsePagePost(JSON.stringify(good()), focus)).toMatchObject({ slotEnd: SLOT, hidden: false, rows: goodRows });
    // at most one row per name and side
    const all = ["SPY", "QQQ", "AAPL"].flatMap((symbol) => ["call", "put"].map((side) => ({ symbol, side, state: "watch" })));
    expect(parsePagePost(JSON.stringify(good({ rows: all })), focus)?.rows).toHaveLength(6);
    expect(parsePagePost(JSON.stringify(good({ rows: [...all, all[0]] })), focus)).toBeNull();
  });
});

// ---- the status read ------------------------------------------------------------------------------------------------
function statusDeps(have: readonly number[], over: Partial<EvalStatusDeps> = {}) {
  const paths = new Set(have.map((t) => serverLogPath(S, t)));
  const exists = vi.fn(async (p: string) => paths.has(p));
  const deps: EvalStatusDeps = { now: () => NOW, dry: false, readSwitch: async () => LOG, exists, ...over };
  return { deps, exists };
}
const getStatus = (headers: Record<string, string> = {}, method = "GET") => new Request(`https://${HOST}/api/desk/eval-status`, { method, headers });

describe("GET /api/desk/eval-status", () => {
  it("answers the switch and the last slot logged, from one head() when all is well", async () => {
    const f = statusDeps([SLOT - 120_000, SLOT]);
    const res = await handleEvalStatus(getStatus(), f.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ eval: "log", last_slot_end: iso(SLOT) });
    expect(f.exists).toHaveBeenCalledTimes(1);
  });

  it("looks back by a bounded number of head() calls only, never a listing: none there is null", async () => {
    const f = statusDeps([ny("10:00:00")]);
    expect(await (await handleEvalStatus(getStatus(), f.deps)).json()).toEqual({ eval: "log", last_slot_end: null });
    expect(f.exists).toHaveBeenCalledTimes(STATUS_PROBES);
    const near = statusDeps([SLOT - 8 * 60_000]);
    expect(await lastLoggedSlot(near.deps, NOW)).toBe(SLOT - 8 * 60_000);
    expect(Object.keys(near.deps)).not.toContain("listDay");
  });

  it("says off, and reads nothing else, while the switch is off; and off when dry", async () => {
    const f = statusDeps([SLOT], { readSwitch: async () => null });
    expect(await (await handleEvalStatus(getStatus(), f.deps)).json()).toEqual({ eval: "off", last_slot_end: null });
    expect(f.exists).not.toHaveBeenCalled();
  });

  it("is hardened like the flags read: cross-site 403, the bypass header 403, other methods 405, HEAD with no body", async () => {
    const f = statusDeps([SLOT]);
    expect((await handleEvalStatus(getStatus({ "sec-fetch-site": "cross-site" }), f.deps)).status).toBe(403);
    expect((await handleEvalStatus(getStatus({ "x-vercel-protection-bypass": "s" }), f.deps)).status).toBe(403);
    for (const m of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const res = await handleEvalStatus(getStatus({}, m), f.deps);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
    const head = await handleEvalStatus(getStatus({}, "HEAD"), f.deps);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await handleEvalStatus(getStatus({}, "GET"), { ...f.deps, readSwitch: () => Promise.reject(new Error("x")) })).status).toBe(503);
  });
});

// ---- the page's helpers ---------------------------------------------------------------------------------------------
const state = (symbol: string, s: NameState["state"], call: NameState["state"], put: NameState["state"]) =>
  ({ symbol, state: s, call: { state: call }, put: { state: put } }) as unknown as NameState;

function coreDeps(over: Partial<ShadowDeps> & { clock?: { t: number }; vis?: { v: boolean } } = {}) {
  const clock = over.clock ?? { t: SLOT - 200_000 };
  const vis = over.vis ?? { v: true };
  const sent: { url: string; body: unknown }[] = [];
  let timer: (() => void) | null = null;
  const deps: ShadowDeps = {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(url.endsWith("eval-status") ? { eval: "log", last_slot_end: null } : { ok: true });
    }),
    browserNow: () => clock.t,
    visible: () => vis.v,
    setInterval: (fn) => ((timer = fn), 1),
    clearInterval: () => (timer = null),
    publish: () => undefined,
    ...over,
  };
  return { deps, sent, clock, vis, fire: () => timer?.() };
}
const tick = (core: DeskShadowCore, now: number, states: NameState[], live = true) => core.tick({ live, session: S, states, now, browserNow: now, barsDelayed: false });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("what the page sends", () => {
  const asOfStates = [state("SPY", "get_ready", "get_ready", "watch"), state("QQQ", "enter_zone", "enter_zone", "watch")];
  const laterStates = [state("SPY", "watch", "watch", "watch"), state("QQQ", "get_ready", "get_ready", "watch")];

  it("sends its states as of the slot (its first render after the close), with the states at settle beside them", async () => {
    const f = coreDeps();
    const core = new DeskShadowCore(f.deps);
    core.start();
    await flush();
    f.clock.t = SLOT + 1_000;
    tick(core, SLOT + 1_000, laterStates); // still inside the slot's grace: not as of the slot
    tick(core, SLOT + 5_200, asOfStates); // the first render after the close
    tick(core, SLOT + 30_000, laterStates);
    tick(core, SLOT + 60_400, laterStates); // settled: sent now
    tick(core, SLOT + 61_400, laterStates); // once per slot
    await flush();
    // (the slot before, the one the page opened inside, went as hidden)
    const posts = f.sent.filter((x) => x.url.endsWith("page-state") && (x.body as { slot_end: string }).slot_end === iso(SLOT));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      slot_end: iso(SLOT),
      engine: ENGINE_VERSION,
      as_of: iso(SLOT + 5_200),
      bars_delayed: false,
      rows: asOfStates.flatMap((s) => [
        { symbol: s.symbol, side: "call", state: s.call.state },
        { symbol: s.symbol, side: "put", state: s.put.state },
      ]),
      rows_at_settle: laterStates.flatMap((s) => [
        { symbol: s.symbol, side: "call", state: s.call.state },
        { symbol: s.symbol, side: "put", state: s.put.state },
      ]),
    });
    // and the route takes exactly what the page sends
    expect(parsePagePost(JSON.stringify(posts[0]!.body), new Set(["SPY", "QQQ"]))).not.toBeNull();
  });

  it("sends nothing for a slot whose close it did not render, and hidden for a slot it was hidden in or opened inside", async () => {
    const f = coreDeps({ clock: { t: SLOT - 30_000 } }); // opened 30 s before the slot's end: the first slot is partial
    const core = new DeskShadowCore(f.deps);
    core.start();
    await flush();
    tick(core, SLOT + 5_000, asOfStates);
    tick(core, SLOT + 60_000, asOfStates);
    // the next slot: whole and visible, but its close never rendered (the tab was busy) -> nothing
    tick(core, SLOT + 180_000, asOfStates);
    // the one after: hidden for a moment inside it
    f.vis.v = false;
    core.onVisibility();
    f.vis.v = true;
    f.clock.t = SLOT + 250_000;
    core.onVisibility();
    tick(core, SLOT + 245_000, asOfStates);
    tick(core, SLOT + 300_000, asOfStates);
    await flush();
    const posts = f.sent.filter((x) => x.url.endsWith("page-state")).map((x) => x.body as Record<string, unknown>);
    expect(posts).toEqual([
      { slot_end: iso(SLOT), engine: ENGINE_VERSION, hidden: true },
      { slot_end: iso(SLOT + 240_000), engine: ENGINE_VERSION, hidden: true },
    ]);
  });

  it("reads the status at start and then at most once a minute, not on every return to the tab", async () => {
    const f = coreDeps();
    const core = new DeskShadowCore(f.deps);
    core.start();
    await flush();
    for (let i = 0; i < 5; i++) {
      f.clock.t += 5_000;
      core.onVisibility();
    }
    await flush();
    expect(f.sent.filter((x) => x.url.endsWith("eval-status"))).toHaveLength(1);
    f.clock.t += 60_000;
    core.onVisibility();
    f.fire();
    await flush();
    expect(f.sent.filter((x) => x.url.endsWith("eval-status")).length).toBeLessThanOrEqual(3);
  });

  it("with the switch off the page makes no request at all: the hook builds no core, and a core never started sends nothing", async () => {
    const f = coreDeps();
    const core = new DeskShadowCore(f.deps); // never started: the status is unknown, so nothing is "log"
    for (let t = SLOT; t < SLOT + 600_000; t += 1_000) tick(core, t, asOfStates);
    core.onVisibility();
    await flush();
    expect(f.deps.fetch).not.toHaveBeenCalled();
    // the hook's own rule: no core unless the server render said the switch is on
    const src = (await import("node:fs")).readFileSync(new URL("../src/components/client/desk-shadow.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/const on = enabled && reading;\s+useEffect\(\(\) => \{\s+if \(!on\) return;/);
  });
});

describe("the rail's line", () => {
  const st = (last: number | null, readAt: number, ev: "off" | "log" = "log") => parseEvalStatus({ eval: ev, last_slot_end: last === null ? null : iso(last) }, readAt);

  it("says nothing while the server's last slot is recent, and when the switch is off", () => {
    expect(pausedLine(st(SLOT, SLOT + 61_000), S, SLOT + 61_000)).toBeNull();
    expect(pausedLine(st(SLOT, SLOT + 179_000), S, SLOT + 179_000)).toBeNull(); // the next slot is not due yet
    expect(pausedLine(st(SLOT, SLOT + 240_000), S, SLOT + 240_000)).toBeNull(); // exactly 3 minutes after it settled
    expect(pausedLine(st(SLOT - 600_000, NOW, "off"), S, NOW)).toBeNull();
    expect(pausedLine(null, S, NOW)).toBeNull();
  });

  it("says since when once the last slot settled over 3 minutes before the read, in session only", () => {
    expect(pausedLine(st(SLOT, SLOT + 241_000), S, SLOT + 241_000)).toBe("Server check paused since 10:30 NY");
    expect(pausedLine(st(null, ny("09:36:00")), S, ny("09:36:00"))).toBe("Server check paused: no recent slot logged");
    expect(pausedLine(st(null, ny("09:33:30")), S, ny("09:33:30"))).toBeNull();
    expect(pausedLine(st(SLOT, ny("16:01:30")), S, ny("16:01:30"))).toBeNull(); // after the session
    // an old read is not trusted to say anything
    expect(pausedLine(st(SLOT, SLOT + 241_000), S, SLOT + 241_000 + 4 * 60_000)).toBeNull();
  });

  it("the answer's check takes exactly { eval, last_slot_end }", () => {
    expect(parseEvalStatus({ eval: "log", last_slot_end: iso(SLOT) }, 1)).toEqual({ eval: "log", last: SLOT, readAt: 1 });
    for (const bad of [null, [], { eval: "on", last_slot_end: null }, { eval: "log", last_slot_end: 5 }, { eval: "log", last_slot_end: "x" }]) expect(parseEvalStatus(bad, 1)).toBeNull();
  });

  it("draws nothing at all with the switch off: no element on the rail", () => {
    const board = { on: true, mode: { kind: "live" }, session: S, now: NOW } as unknown as Board;
    expect(renderToStaticMarkup(createElement(BoardContext.Provider, { value: board }, createElement(ServerCheckNote)))).toBe("");
  });
});

// ---- the shadow numbers ---------------------------------------------------------------------------------------------
const srv = (t: number, rows: [string, "call" | "put", NameState["state"]][], delay = 61_000, status: ServerRecord["status"] = "ok", engine = ENGINE_VERSION): ServerRecord => ({
  v: 1,
  engine,
  source: "server",
  status,
  reason: null,
  slot_end: iso(t),
  evaluated_at: iso(t + delay),
  session: S,
  edition_session: S,
  edition_as_of: null,
  board: "live",
  rows: rows.map(([symbol, side, st]) => ({ symbol, side, state: st, bar_end: iso(t) })),
  degraded_names: [],
  snapshot_ok: true,
  day: { journal_current: true, break_today: false, day_limit_used: false, done: false, half_day: false, gap: false, broke_earlier: false, stale: false },
});
type R = [string, "call" | "put", NameState["state"]][];
const pg = (t: number, rows: R | "hidden", atSettle?: R): PageRecord => ({
  v: 1,
  engine: ENGINE_VERSION,
  source: "page",
  slot_end: iso(t),
  received_at: iso(t + 62_000),
  hidden: rows === "hidden",
  as_of: rows === "hidden" ? null : iso(t + 5_000),
  bars_delayed: rows === "hidden" ? null : false,
  rows: rows === "hidden" ? [] : rows.map(([symbol, side, st]) => ({ symbol, side, state: st })),
  rows_at_settle: rows === "hidden" ? [] : (atSettle ?? rows).map(([symbol, side, st]) => ({ symbol, side, state: st })),
});

describe("the shadow summary", () => {
  const slots = expectedSlots(S);

  it("counts OK slots apart from any record, compares only like with like, and leaves nothing out quietly", () => {
    const [a, b, c, d, e2, f2, g] = slots;
    const server = [
      srv(a!, [["SPY", "call", "watch"], ["SPY", "put", "watch"]], 61_000),
      srv(b!, [["SPY", "call", "enter_zone"], ["SPY", "put", "watch"]], 63_000),
      srv(c!, [["SPY", "call", "enter_zone"], ["SPY", "put", "watch"]], 65_000),
      srv(d!, [["SPY", "call", "get_ready"], ["SPY", "put", "watch"]], 119_000),
      srv(e2!, [], 70_000, "degraded"),
      srv(f2!, [["SPY", "call", "enter_zone"]], 62_000, "ok", "e-000000000000"),
      srv(g!, [["SPY", "call", "watch"]], 62_000, "wrong-day"),
      srv(a!, [["SPY", "call", "missed"]], 1), // a second record for a slot: the first stands
      srv(ny("10:30:00", "2026-10-13"), [["SPY", "call", "watch"]]), // another day: not counted
    ];
    const page = [
      pg(a!, [["SPY", "call", "watch"], ["SPY", "put", "watch"]]), // agrees
      pg(b!, [["SPY", "call", "get_ready"], ["SPY", "put", "watch"]], [["SPY", "call", "plan_off"], ["SPY", "put", "watch"]]), // critical
      pg(c!, "hidden"), // a hidden page first...
      pg(c!, [["SPY", "call", "paused"], ["SPY", "put", "get_ready"]]), // ...but the visible one is preferred
      pg(d!, "hidden"),
      pg(e2!, [["SPY", "call", "watch"]]), // the server's slot is degraded: not compared
      pg(f2!, [["SPY", "call", "watch"]]), // another engine
    ];
    const r = shadowSummary([S], server, page);
    expect(r).toMatchObject({ expected: 194, logged: 7, ok: 5, okPct: 2.6, byStatus: { ok: 5, "wrong-day": 1, "no-focus": 0, degraded: 1 } });
    expect(r).toMatchObject({ compared: 3, coveragePct: 60, noPage: 0, hiddenOnly: 1, engineMismatch: 1, agreed: 1, agreedPct: 33.3 });
    expect(r).toMatchObject({ rowsCompared: 6, rowsAgreed: 3 });
    expect(r.disagreements).toEqual({ "enter_zone>get_ready": 1, "enter_zone>paused": 1, "watch>get_ready": 1 });
    expect(r.critical).toEqual({ total: 2, byPage: { get_ready: 1, plan_off: 0, missed: 0, paused: 1, other: 0 } });
    expect(r.criticalAtSettle).toEqual({ total: 2, byPage: { get_ready: 0, plan_off: 1, missed: 0, paused: 1, other: 0 } });
    expect(r.delayMedianMs).toBe(63_000);
    expect(r.delayWorstMs).toBe(119_000);
  });

  it("an enter zone with no page row for that name and side is critical (other), and breaks the slot's agreement", () => {
    const r = shadowSummary([S], [srv(slots[0]!, [["SPY", "call", "enter_zone"], ["SPY", "put", "watch"]])], [pg(slots[0]!, [["SPY", "put", "watch"]])]);
    expect(r).toMatchObject({ compared: 1, agreed: 0, rowsCompared: 1, rowsAgreed: 1, rowsUnmatched: 1 });
    expect(r.critical.byPage.other).toBe(1);
  });

  it("an OK slot with no page record at all is counted, not dropped", () => {
    const r = shadowSummary([S], [srv(slots[0]!, [["SPY", "call", "watch"]])], []);
    expect(r).toMatchObject({ ok: 1, compared: 0, noPage: 1, coveragePct: 0 });
  });

  it("is all zeros with nothing logged, and counts a half day's and a holiday's slots right", () => {
    const r = shadowSummary(["2026-11-26", "2026-11-27"], [], []);
    expect(r).toMatchObject({ expected: 104, logged: 0, ok: 0, okPct: 0, compared: 0, agreedPct: 0, delayMedianMs: null, delayWorstMs: null });
  });

  it("median is the middle value, or the mean of the middle two", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
