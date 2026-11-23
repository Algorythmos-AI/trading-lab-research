// flow-request.ts: the market bar's request stamping and freshness rules, and market-view.ts: what the bar shows for
// the fixture's answers. Plain numbers for both clocks; no browser and no network.
import { describe, expect, it, vi } from "vitest";
import { fetchFlow, FLOW_CLOSED_POLL_MS, FLOW_FRESH_MS, FLOW_POLL_MS, FLOW_TIMEOUT_MS, flowPollMs, type HeldFlow, judgeFlow, stampRequest } from "@/lib/flow-request";
import { type FlowAnswer, handleFlow } from "@/lib/flow-route";
import { FROZEN_NOW } from "@/lib/fixture-variants";
import { marketView } from "@/lib/market-view";

const AS_OF = Date.parse(FROZEN_NOW);
const answer = { as_of: new Date(AS_OF).toISOString(), feed: "sip", baseline: null, names: {}, missing: [] } as FlowAnswer;
/** Sent at monotonic `sentPerf` with the wall clock at as_of, received `latency` later; both clocks agree throughout. */
const held = (sentPerf: number, latency = 200): HeldFlow => ({ body: answer, asOf: AS_OF, stamp: stampRequest(sentPerf, AS_OF), receivedPerf: sentPerf + latency, receivedWall: AS_OF + latency });
/** The wall clock at monotonic `perf` for an answer sent at `sentPerf`: the clocks run together. */
const wallAt = (h: HeldFlow, perf: number) => h.stamp.sentWall + (perf - h.stamp.sentPerf);

describe("judgeFlow", () => {
  it("fresh until 20 s from the send on the monotonic clock: exactly 20 s still is", () => {
    const h = held(1_000);
    expect(judgeFlow(h, 1_000 + FLOW_FRESH_MS, wallAt(h, 1_000 + FLOW_FRESH_MS), -Infinity)).toEqual({ fresh: true, ageMs: FLOW_FRESH_MS, checkedMs: FLOW_FRESH_MS });
    const late = 1_000 + FLOW_FRESH_MS + 0.001;
    expect(judgeFlow(h, late, AS_OF + FLOW_FRESH_MS, -Infinity)).toMatchObject({ fresh: false, why: "old" });
  });

  it("an answer to a request sent before the tab was last shown is never fresh", () => {
    expect(judgeFlow(held(500), 1_200, AS_OF + 700, 1_000)).toMatchObject({ fresh: false, why: "before-show", ageMs: null });
    // sent at the very instant it was shown: that request was asked for by the show, and counts
    expect(judgeFlow(held(1_000), 1_200, AS_OF + 200, 1_000).fresh).toBe(true);
  });

  it("a request in flight across a hide and a show: its answer arrives after the show and is still not fresh", () => {
    // sent at 100, the tab hidden at 120 and shown again at 150, the answer in at 200
    const h = held(100, 100);
    expect(judgeFlow(h, 200, wallAt(h, 200), 150)).toMatchObject({ fresh: false, why: "before-show" });
    // the request the show sent (at 150) answers fresh
    const again = held(150, 50);
    expect(judgeFlow(again, 200, wallAt(again, 200), 150).fresh).toBe(true);
  });

  it("a slow answer is as old as its send, not its arrival", () => {
    const slow = held(0, 18_000); // asked at 0, answered 18 s later
    expect(judgeFlow(slow, 19_000, wallAt(slow, 19_000), -Infinity).fresh).toBe(true);
    expect(judgeFlow(slow, 21_000, wallAt(slow, 21_000), -Infinity)).toMatchObject({ fresh: false, why: "old", checkedMs: 21_000 }); // arrived 3 s ago
  });

  it("the age is bounded below by the time since arrival on the monotonic clock", () => {
    const h = { ...held(0, 200), receivedPerf: 5_000 }; // an arrival stamp later than any send-based age
    expect(judgeFlow(h, 4_000, wallAt(h, 4_000), -Infinity)).toMatchObject({ fresh: true, ageMs: 4_000 });
    expect(judgeFlow({ ...held(0), receivedPerf: -10_000 }, 1_000, wallAt(held(0), 1_000), -Infinity)).toMatchObject({ fresh: true, ageMs: 11_000 });
  });

  it("a monotonic clock standing still while the wall clock runs on is a clock jump: not fresh, no age", () => {
    expect(judgeFlow(held(5_000), 5_000, AS_OF + 30_000, -Infinity)).toMatchObject({ fresh: false, why: "clock-jump", ageMs: null });
    // within 20 s the two clocks agree well enough, and the wall clock's age counts
    expect(judgeFlow(held(5_000), 5_000, AS_OF + FLOW_FRESH_MS, -Infinity)).toMatchObject({ fresh: true, ageMs: FLOW_FRESH_MS });
  });

  it("the reviewer's case: perf 10 and the wall clock an hour before as_of is never fresh", () => {
    expect(judgeFlow(held(0), 10, AS_OF - 3_600_000, -Infinity).fresh).toBe(false);
    // and an answer that arrived with the device an hour behind the server says the device's clock is off
    const off = { ...held(0), stamp: stampRequest(0, AS_OF - 3_600_000), receivedWall: AS_OF - 3_600_000 + 200 };
    expect(judgeFlow(off, 10, AS_OF - 3_600_000 + 10, -Infinity)).toMatchObject({ fresh: false, why: "device-clock", ageMs: null });
  });

  it("the device's clock against as_of at arrival: 20 s apart still counts, 20.001 s does not", () => {
    const at = (gap: number) => ({ ...held(0), stamp: stampRequest(0, AS_OF + gap - 200), receivedWall: AS_OF + gap });
    expect(judgeFlow(at(-FLOW_FRESH_MS), 300, AS_OF - FLOW_FRESH_MS + 100, -Infinity).fresh).toBe(true);
    expect(judgeFlow(at(FLOW_FRESH_MS + 0.001), 300, AS_OF + FLOW_FRESH_MS + 100, -Infinity)).toMatchObject({ why: "device-clock" });
  });

  it("an answer without a readable as_of has no age that counts", () => {
    expect(judgeFlow({ ...held(0), asOf: NaN }, 100, AS_OF + 100, -Infinity)).toMatchObject({ fresh: false, why: "no-as-of", ageMs: null });
  });
});

describe("flowPollMs", () => {
  const ny = (iso: string) => Date.parse(iso);
  it("every 5 s in the session, the open and the last instant before the close included", () => {
    expect(flowPollMs(ny("2026-11-12T14:30:00Z"))).toBe(FLOW_POLL_MS); // 09:30 New York
    expect(flowPollMs(ny("2026-11-12T20:59:59Z"))).toBe(FLOW_POLL_MS);
    expect(flowPollMs(null)).toBe(FLOW_POLL_MS);
  });

  it("outside it the earlier of 5 minutes and the next 09:30 New York open", () => {
    expect(flowPollMs(ny("2026-11-12T21:00:00Z"))).toBe(FLOW_CLOSED_POLL_MS); // the close
    expect(flowPollMs(ny("2026-11-12T14:28:00Z"))).toBe(2 * 60_000); // 09:28: the open in 2 minutes
    expect(flowPollMs(ny("2026-11-12T14:29:59.500Z"))).toBe(1_000); // never under a second
    expect(flowPollMs(ny("2026-11-14T16:00:00Z"))).toBe(FLOW_CLOSED_POLL_MS); // Saturday
    expect(flowPollMs(ny("2026-11-27T18:00:00Z"))).toBe(FLOW_CLOSED_POLL_MS); // a half day after its 13:00 close
    expect(flowPollMs(ny("2026-11-26T15:00:00Z"))).toBe(FLOW_CLOSED_POLL_MS); // Thanksgiving
  });
});

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fetchFlow", () => {
  it("stamps the request before the fetch goes out, and the answer's arrival after", async () => {
    let perf = 100;
    const order: string[] = [];
    const f = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => {
      order.push(`fetch@${perf}`);
      perf = 900;
      return ok(answer);
    });
    const r = await fetchFlow("/api/flow?s=SPY,QQQ", { fetch: f, perf: () => (order.push(`perf@${perf}`), perf), wall: () => AS_OF + 3 });
    expect(order).toEqual(["perf@100", "fetch@100", "perf@900"]);
    expect(r).toMatchObject({ result: "ok", held: { asOf: AS_OF, stamp: { sentPerf: 100, sentWall: AS_OF + 3 }, receivedPerf: 900 } });
    expect(f.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
  });

  it("a hung fetch is aborted by its signal and counts as an error; the held answer keeps ageing meanwhile", async () => {
    const ctl = new AbortController();
    const f = vi.fn(
      (_: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")))),
    );
    const p = fetchFlow("/api/flow", { fetch: f, perf: () => 0, wall: () => AS_OF, signal: () => ctl.signal });
    ctl.abort();
    expect(await p).toEqual({ result: "error" });
    // the answer from before the hung request is judged from its own send: stale 20 s on, whatever is in flight
    expect(judgeFlow(held(0), FLOW_FRESH_MS + 1, AS_OF, -Infinity).fresh).toBe(false);
  });

  it("by default the fetch carries a 5 s timeout signal", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await fetchFlow("/api/flow", { fetch: async () => ok(answer), perf: () => 0, wall: () => 0 });
    expect(spy).toHaveBeenCalledWith(FLOW_TIMEOUT_MS);
  });

  it("our own 503 not-configured is off (plan when SIP is not on the plan); another 503, 429 and broken bodies are not", async () => {
    const run = (res: Response | Error) => fetchFlow("/api/flow", { fetch: async () => (res instanceof Error ? Promise.reject(res) : res), perf: () => 0, wall: () => 0 });
    expect(await run(ok({ error: "not-configured" }, 503))).toEqual({ result: "off", plan: false });
    expect(await run(ok({ error: "not-configured", why: "plan" }, 503))).toEqual({ result: "off", plan: true });
    expect(await run(new Response("<html>busy</html>", { status: 503 }))).toEqual({ result: "error" });
    expect(await run(ok({ error: "rate-limited" }, 429))).toEqual({ result: "limited" });
    expect(await run(ok({ error: "upstream" }, 502))).toEqual({ result: "error" });
    expect(await run(ok({ names: {} }))).toEqual({ result: "error" });
    expect(await run(new TypeError("network"))).toEqual({ result: "error" });
  });
});

describe("marketView on the fixture's answers", () => {
  const fixture = async (flags: string): Promise<HeldFlow> => {
    const res = await handleFlow(new Request("https://lab.test/api/flow?s=SPY,QQQ", { headers: { cookie: `fx=${flags}` } }), { fixture: true });
    return { body: (await res.json()) as FlowAnswer, asOf: AS_OF, stamp: stampRequest(0, AS_OF), receivedPerf: 100, receivedWall: AS_OF + 100 };
  };
  const view = async (flags: string, clocks = { perf: 3_000, wall: AS_OF + 3_000 }) => marketView({ status: "ok", held: await fixture(flags) }, -Infinity, clocks);

  it("the default fixture at the frozen clock reads MARKET UP, with the evidence on both tiles", async () => {
    const v = await view("");
    expect(v.state).toBe("up");
    expect(v.footer).toEqual({ asOf: "11:01:00", checked: "just now" });
    for (const t of v.tiles) expect(t.reading).toMatchObject({ direction: "up", side: "above", volume: { sessions: 20 } });
  });

  it("flow-down, flow-mixed and flow-range give the other states", async () => {
    expect((await view("flow-down")).state).toBe("down");
    const mixed = await view("flow-mixed");
    expect(mixed).toMatchObject({ state: "mixed", line: "SPY up · QQQ down" });
    expect((await view("flow-range")).state).toBe("range");
  });

  it("flow-crossed: not available, the crossed one named", async () => {
    const v = await view("flow-crossed");
    expect(v).toMatchObject({ state: "none", line: "QQQ: quote is crossed" });
    expect(v.tiles.find((t) => t.symbol === "SPY")!.reading!.direction).toBe("up");
  });

  it("an old answer is not available, with its age; no clocks yet is loading", async () => {
    expect(await view("", { perf: 25_000, wall: AS_OF + 25_000 })).toMatchObject({ state: "none", line: "prices are 25 s old" });
    expect(marketView({ status: "ok", held: await fixture("") }, -Infinity, null).state).toBe("loading");
  });

  it("a device clock off against the server at arrival says so, never an age", async () => {
    const h = { ...(await fixture("")), receivedWall: AS_OF + 3_600_000 };
    expect(marketView({ status: "ok", held: h }, -Infinity, { perf: 1_000, wall: AS_OF + 1_000 })).toMatchObject({ state: "none", line: "this device's clock is off" });
  });

  it("one index up and the other ranging shows MIXED with both words", async () => {
    const h = await fixture("");
    const qqq = h.body.names.QQQ!;
    // QQQ's price put on its VWAP: its trend is still up, so it reads range
    const body = { ...h.body, names: { ...h.body.names, QQQ: { ...qqq, price: 753.04, bid: 753.03, ask: 753.05 } } };
    expect(marketView({ status: "ok", held: { ...h, body } }, -Infinity, { perf: 3_000, wall: AS_OF + 3_000 })).toMatchObject({ state: "mixed", line: "SPY up · QQQ range" });
  });

  it("before the fifth 10-minute close, each tile says when its first reading comes", async () => {
    const h = await fixture("");
    const early = AS_OF - 54 * 60_000; // 10:07 New York, two closes short of a trend
    const iso = new Date(early).toISOString();
    const cut = (row: (typeof h.body.names)[string]) => ({ ...row, trade_at: iso, quote_at: iso, bars: (row.bars ?? []).filter((b) => b.end <= early) });
    const names = Object.fromEntries(Object.entries(h.body.names).map(([k, row]) => [k, cut(row)]));
    const held = { ...h, body: { ...h.body, as_of: iso, names }, asOf: early, stamp: stampRequest(0, early), receivedWall: early + 100 };
    const v = marketView({ status: "ok", held }, -Infinity, { perf: 3_000, wall: early + 3_000 });
    expect(v).toMatchObject({ state: "none", line: "before 10:21: not enough bars yet" });
    for (const t of v.tiles) expect(t).toMatchObject({ reading: { direction: null, why: "too-early" }, wait: "10:21" });
    // a later reason clears the wait
    expect((await view("flow-crossed")).tiles.map((t) => t.wait)).toEqual([null, null]);
  });

  it("off, error and loading are calm", () => {
    expect(marketView({ status: "off", plan: true }, -Infinity, { perf: 0, wall: 0 })).toMatchObject({ state: "none", line: "data plan" });
    expect(marketView({ status: "error", limited: false }, -Infinity, { perf: 0, wall: 0 })).toMatchObject({ state: "none", line: "prices could not be read" });
    expect(marketView({ status: "loading" }, -Infinity, null).state).toBe("loading");
  });
});
