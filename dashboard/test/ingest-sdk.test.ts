// Ingest against a fake of the Blob SDK itself (not the app's blob wrapper), so the etag round trip is real.
// "publishes three times in a row" fails on the code that took the etag from get().
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/hmac";
import { makeFakeBlobSdk } from "./blob-sdk";
import { fixture } from "./helpers";

const sdk = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof makeFakeBlobSdk> }));
vi.mock("@vercel/blob", async () => {
  const { makeFakeBlobSdk: make } = await import("./blob-sdk");
  sdk.current = make();
  return sdk.current;
});

const { handleIngest } = await import("@/lib/ingest");
const LATEST = "snapshots/latest.json";
const SECRET = "test-ingest-secret";
const NOW = new Date("2026-09-29T21:46:00Z");

function body(runId: string, asOf: string): string {
  const s = fixture() as unknown as Record<string, unknown>;
  s.run_id = runId;
  s.as_of = asOf;
  return JSON.stringify(s);
}

function post(text: string): Request {
  const ts = Math.floor(NOW.getTime() / 1000);
  return new Request("https://lab.example/api/ingest", {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      "x-wt-timestamp": String(ts),
      "x-wt-signature": sign(SECRET, ts, Buffer.from(text, "utf8")),
    },
  });
}

const latestRun = () => JSON.parse(sdk.current.store.get(LATEST)!.text).run_id;

beforeEach(() => {
  sdk.current.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", SECRET);
});

describe("ingest through the Blob SDK", () => {
  it("stores publish after publish (the conditional write presents head()'s etag)", async () => {
    for (const [i, t] of ["21:15", "21:30", "21:45"].entries()) {
      const res = await handleIngest(post(body(`r${i}`, `2026-09-29T${t}:00+00:00`)), NOW);
      expect(await res.json()).toEqual({ status: "stored", run_id: `r${i}` });
    }
    expect(latestRun()).toBe("r2");
  });

  it("a newer write landing between head() and get() never lets an older snapshot win", async () => {
    await handleIngest(post(body("a", "2026-09-29T21:00:00+00:00")), NOW);
    sdk.current.hooks.betweenHeadAndGet = () => {
      sdk.current.hooks.betweenHeadAndGet = undefined;
      sdk.current.write(LATEST, body("c", "2026-09-29T21:30:00+00:00")); // another publisher, newer
    };
    const res = await handleIngest(post(body("b", "2026-09-29T21:15:00+00:00")), NOW);
    expect(res.status).toBe(409);
    expect(latestRun()).toBe("c");
  });

  it("a newer snapshot that races another write retries and stores", async () => {
    await handleIngest(post(body("a", "2026-09-29T21:00:00+00:00")), NOW);
    sdk.current.hooks.betweenHeadAndGet = () => {
      sdk.current.hooks.betweenHeadAndGet = undefined;
      sdk.current.write(LATEST, body("c", "2026-09-29T21:30:00+00:00"));
    };
    const res = await handleIngest(post(body("d", "2026-09-29T21:45:00+00:00")), NOW);
    expect(await res.json()).toEqual({ status: "stored", run_id: "d" });
    expect(latestRun()).toBe("d");
  });

  it("creates latest.json with a create-only write when the store is empty", async () => {
    const res = await handleIngest(post(body("first", "2026-09-29T21:45:00+00:00")), NOW);
    expect(res.status).toBe(200);
    expect(latestRun()).toBe("first");
  });
});
