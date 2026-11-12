// The desk cron and the board-feed stamp (EXP-0033): the stamp runs after the bearer check and before the shadow
// run, whatever the run's switch says, and can never change the run's answer or status. A fake Blob SDK, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeBlobSdk } from "./blob-sdk";

const sdk = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof makeFakeBlobSdk> }));
vi.mock("@vercel/blob", async () => {
  const { makeFakeBlobSdk: make } = await import("./blob-sdk");
  sdk.current = make();
  return sdk.current;
});

const AUTH = { authorization: "Bearer s3cret" };
const req = (headers: Record<string, string> = AUTH) => new Request("https://desk.example/api/cron/desk", { headers });

beforeEach(() => {
  sdk.current?.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("CRON_SECRET", "s3cret");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.doUnmock("@/lib/board-feed-stamp");
  vi.doUnmock("@/lib/desk-run");
  vi.resetModules();
});

// The route's first import loads most of the desk; under a full parallel run that alone can pass the default 5 s.
describe("cron/desk with the board-feed stamp", { timeout: 30_000 }, () => {
  it("in production in the session, with the eval switch off, the stamp is written and the run answers off", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ALPACA_FEED", "sip");
    // no market-data keys: the stamp's SPY read answers "error" without going anywhere
    for (const k of ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "APCA_API_KEY_ID", "APCA_API_SECRET_KEY"]) vi.stubEnv(k, "");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T15:07:00Z")); // 10:07 New York, a Thursday session
    const { GET } = await import("@/app/api/cron/desk/route"); // loads the fake store
    sdk.current.write("desk/eval.json", '{"v":1,"eval":"off"}');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "off" });
    const stamp = sdk.current.store.get("desk/feeds/board/2026-11-12/1007.json");
    expect(stamp).toBeDefined();
    expect(JSON.parse(stamp!.text)).toMatchObject({ v: 1, feed: "sip", answered: "error", at: "2026-11-12T15:07:00.000Z" });
    // the switch was not touched
    expect(sdk.current.store.get("desk/eval.json")!.text).toBe('{"v":1,"eval":"off"}');
  });

  it("without the bearer nothing is stamped", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T15:07:00Z"));
    const { GET } = await import("@/app/api/cron/desk/route");
    expect((await GET(req({}))).status).toBe(401);
    expect([...sdk.current.store.keys()]).toEqual([]);
  });

  it("a stamp that throws leaves runDeskEval's answer and status as they were, and runs before it", async () => {
    const order: string[] = [];
    vi.doMock("@/lib/board-feed-stamp", () => ({
      stampBoardFeed: vi.fn(async () => {
        order.push("stamp");
        throw new Error("stamp exploded");
      }),
    }));
    const result = { ok: false, outcome: "write-failed", slot: "1030" };
    vi.doMock("@/lib/desk-run", () => ({ runDeskEval: vi.fn(async () => (order.push("eval"), result)) }));
    const { GET } = await import("@/app/api/cron/desk/route");
    const res = await GET(req());
    expect(order).toEqual(["stamp", "eval"]);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(result);

    vi.resetModules();
    const logged = { ok: true, outcome: "logged", slot: "1030", status: "ok", reason: null };
    vi.doMock("@/lib/desk-run", () => ({ runDeskEval: vi.fn(async () => logged) }));
    const again = await (await import("@/app/api/cron/desk/route")).GET(req());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(logged);
  });
});
