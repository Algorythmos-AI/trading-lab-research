import { describe, expect, it, vi } from "vitest";
import { CONTRACT_FETCH_TIMEOUT_MS, requestContracts } from "@/lib/contract-request";
import { judgeQuote, SHOWN_AGAIN, type ContractResponse } from "@/lib/option-value";
import { type PollPage, startPoll } from "@/lib/quote-poll";

// One /api/contract request as the page sends it (contract-request.ts): stamped on both clocks before the fetch, given
// up after 5 s, our own not-configured 503 told from any other, and a hung request never stalling the poll.

const OCC = "SPY261016C00660000";
const ANSWER: ContractResponse = {
  as_of: "2026-10-12T16:00:00.000Z",
  served_at: "2026-10-12T16:00:00.000Z",
  feed: "opra",
  delay_min: 0,
  contracts: { [OCC]: { bid: 1.2, ask: 1.25, bid_size: 1, ask_size: 1, quote_at: "2026-10-12T15:59:58Z", last: null, last_at: null } },
  missing: [],
};

/** Clocks a test moves by hand. */
function clocks() {
  const c = { perf: 1_000, wall: 9_000_000 };
  return { c, perf: () => c.perf, wall: () => c.wall };
}

describe("one contract request", () => {
  it("stamps the send on both clocks before the fetch, and carries the stamps with the answer", async () => {
    const k = clocks();
    const fetchImpl = vi.fn(async () => {
      // the answer takes 4 s to come back
      k.c.perf += 4_000;
      k.c.wall += 4_000;
      return Response.json(ANSWER);
    });
    const r = await requestContracts(OCC, { fetchImpl: fetchImpl as unknown as typeof fetch, perf: k.perf, wall: k.wall });
    expect(r).toEqual({ result: "ok", feed: { status: "ok", answer: ANSWER, sentPerf: 1_000, sentWall: 9_000_000 } });
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(`/api/contract?s=${OCC}`);
  });

  it("asks with a 5 s timeout, and a timeout is a failure", async () => {
    const k = clocks();
    let ms = 0;
    const ctl = new AbortController();
    const fetchImpl = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")))));
    const p = requestContracts(OCC, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      perf: k.perf,
      wall: k.wall,
      timeout: (t) => {
        ms = t;
        return ctl.signal;
      },
    });
    ctl.abort();
    expect(await p).toEqual({ result: "error", feed: { status: "error" } });
    expect(ms).toBe(CONTRACT_FETCH_TIMEOUT_MS);
  });

  it("is off only for our own not-configured 503; any other 503 is a failure to retry", async () => {
    const k = clocks();
    const ask = (res: Response) => requestContracts(OCC, { fetchImpl: (async () => res) as unknown as typeof fetch, perf: k.perf, wall: k.wall });
    expect(await ask(Response.json({ error: "not-configured" }, { status: 503 }))).toEqual({ result: "off", feed: { status: "off" } });
    expect(await ask(Response.json({ error: "not-configured", why: "feed" }, { status: 503 }))).toEqual({ result: "off", feed: { status: "off" } });
    expect(await ask(new Response("<html>Service Unavailable</html>", { status: 503 }))).toEqual({ result: "error", feed: { status: "error" } });
    expect(await ask(Response.json({ error: "busy" }, { status: 503 }))).toEqual({ result: "error", feed: { status: "error" } });
    expect(await ask(Response.json({ error: "rate-limited" }, { status: 429 }))).toEqual({ result: "limited", feed: { status: "error" } });
    expect(await ask(Response.json({ error: "upstream" }, { status: 502 }))).toEqual({ result: "error", feed: { status: "error" } });
  });

  it("an answer to a request sent before the tab was hidden, arriving after it is shown again, is withheld", async () => {
    const k = clocks();
    let shownPerf: number | null = null;
    const fetchImpl = async () => {
      // hidden at 1 500, shown again at 5 000, answered at 5 100
      shownPerf = 5_000;
      k.c.perf = 5_100;
      return Response.json(ANSWER);
    };
    const r = await requestContracts(OCC, { fetchImpl: fetchImpl as unknown as typeof fetch, perf: k.perf, wall: k.wall });
    const j = judgeQuote({ feed: r.feed, occ: OCC, perfNow: 5_200, wallNow: k.c.wall, shownPerf });
    expect(j).toEqual({ ok: false, why: SHOWN_AGAIN });
  });

  it("a hung request does not stall the poll: it times out, counts as a failure, and the poll asks again", async () => {
    const k = clocks();
    const signals: AbortController[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          calls++;
          if (calls > 1) return resolve(Response.json(ANSWER));
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
    );
    const timers: { fn: () => void; ms: number }[] = [];
    const page: PollPage = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
    const feeds: string[] = [];
    const poll = startPoll({
      run: async () => {
        const r = await requestContracts(OCC, {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          perf: k.perf,
          wall: k.wall,
          timeout: () => {
            const c = new AbortController();
            signals.push(c);
            return c.signal;
          },
        });
        feeds.push(r.feed.status);
        return r.result;
      },
      page,
      now: () => k.c.wall,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => {},
      pollMs: 2_000,
      backoff: { capMs: 10_000, rand: () => 0 },
    });
    // the first request hangs until its 5 s timeout fires
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    signals[0]!.abort();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(feeds).toEqual(["error"]);
    expect(timers[0]!.ms).toBe(2_000); // the first backoff wait
    timers[0]!.fn();
    await vi.waitFor(() => expect(feeds).toEqual(["error", "ok"]));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    poll.stop();
  });
});
