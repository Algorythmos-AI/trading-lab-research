import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "@/lib/hmac";
import type { OptionsEdition } from "@/lib/options.types";
import {
  FOCUS_FREEZE_MIN,
  focusFrozen,
  parseStoredPremarket,
  premarketLate,
  premarketOf,
  premarketPath,
  sameApartFromPremarket,
  storedPremarketText,
  within,
  withPremarket,
  type StoredPremarket,
} from "@/lib/premarket";
import { parseIngestReject } from "@/lib/ingest-reject";
import { premarketStamp } from "@/lib/feed-watch";
import optionsJson from "./fixtures/options.v1.json";

// The pre-market check kept apart from the edition, and the 09:25 New York focus freeze (src/lib/premarket.ts). The
// owner's rules of 2026-11-16: a re-run of the evening pick never takes the check away, and from 09:25 on its session
// an edition never changes the session's names or levels.

const blob = vi.hoisted(() => {
  class PreconditionFailed extends Error {}
  const store = new Map<string, { text: string; etag: string }>();
  let seq = 0;
  return {
    store,
    PreconditionFailed,
    put(pathname: string, text: string) {
      const etag = `"e${++seq}"`;
      store.set(pathname, { text, etag });
      return etag;
    },
    reset() {
      store.clear();
      seq = 0;
    },
  };
});

vi.mock("@/lib/blob", () => ({
  LATEST_PATH: "snapshots/latest.json",
  SHADOW_LATEST_PATH: "shadow/latest.json",
  HISTORY_PREFIX: "snapshots/history/",
  ALERT_STATE_PATH: "alerts/state.json",
  PreconditionFailed: blob.PreconditionFailed,
  readText: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  readTextIfChanged: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  readForUpdate: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  exists: vi.fn(async (pathname: string) => blob.store.has(pathname)),
  storedMeta: vi.fn(async (pathname: string) => {
    const b = blob.store.get(pathname);
    return b ? { etag: b.etag, uploadedAt: "2026-10-12T12:00:00.000Z" } : null;
  }),
  storedAt: vi.fn(async () => null),
  writeText: vi.fn(async (pathname: string, body: string, opts: { ifMatch?: string | null; createOnly?: boolean } = {}) => {
    const cur = blob.store.get(pathname);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    if (opts.createOnly && cur) throw new blob.PreconditionFailed();
    return { etag: blob.put(pathname, body) };
  }),
  listPaths: vi.fn(async (prefix: string) =>
    [...blob.store.keys()].filter((k) => k.startsWith(prefix)).map((pathname) => ({ pathname, url: `https://blob.test/${pathname}` })),
  ),
}));

const { handleIngest } = await import("@/lib/ingest");
const { loadOptions } = await import("@/lib/snapshot");
const { blobFeedDeps } = await import("@/lib/feed-watch-run");
const blobMod = await import("@/lib/blob");

const SECRET = "test-default-secret";
const SESSION = "2026-10-12"; // a Monday in EDT: 09:25 New York is 13:25Z
const LATEST = "options/latest.json";
const PRE_PATH = premarketPath(SESSION);

const FOCUS_ITEMS = [
  { symbol: "SPY", rank: 1, bias: "breakout", close: 778.55, atr: 6.26, resistance: { price: 779.4, name: "PDH" }, support: { price: 775.16, name: "PDL" } },
  { symbol: "QQQ", rank: 2, bias: "support", close: 751.24, atr: 8.53, resistance: { price: 752.86, name: "PDH" }, support: { price: 748.39, name: "PDL" } },
];

function check(asOf: string, spy = 780.1, second = "QQQ") {
  return {
    as_of: asOf,
    items: [
      { symbol: "SPY", price: spy, gap_pct: 0.2, where: "above_resistance", note: "n" },
      { symbol: second, price: 751.0, gap_pct: -0.03, where: "between", note: null },
    ],
  };
}

function edition(runId: string, asOf: string, mutate?: (r: Record<string, unknown>) => void): string {
  const r = structuredClone(optionsJson) as unknown as Record<string, unknown>;
  r.run_id = runId;
  r.as_of = asOf;
  r.focus = { picked_at: "2026-10-09T21:54:00Z", method: "test", items: structuredClone(FOCUS_ITEMS), premarket: null };
  mutate?.(r);
  return JSON.stringify(r);
}

const withCheck = (asOf: string, spy?: number, second?: string) => (r: Record<string, unknown>) => {
  (r.focus as Record<string, unknown>).premarket = check(asOf, spy, second);
};
const otherNames = (r: Record<string, unknown>) => {
  const f = r.focus as { items: { symbol: string }[] };
  f.items[1]!.symbol = "NVDA";
};

async function send(text: string, now: Date) {
  const ts = Math.floor(now.getTime() / 1000);
  const req = new Request("https://lab.example/api/ingest", {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json", "x-wt-timestamp": String(ts), "x-wt-signature": sign(SECRET, ts, Buffer.from(text, "utf8")) },
  });
  const res = await handleIngest(req, now);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const latest = () => JSON.parse(blob.store.get(LATEST)!.text) as Record<string, unknown>;
const kept = () => {
  const b = blob.store.get(PRE_PATH);
  return b ? parseStoredPremarket(b.text) : null;
};

beforeEach(() => {
  blob.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", SECRET);
});

describe("the freeze clock", () => {
  it("is 09:25 New York", () => expect(FOCUS_FREEZE_MIN).toBe(565));

  it("starts at 09:25:00 New York on the session, in EDT and in EST, and holds every day after", () => {
    expect(focusFrozen("2026-10-12", new Date("2026-10-12T13:24:59Z"))).toBe(false);
    expect(focusFrozen("2026-10-12", new Date("2026-10-12T13:25:00Z"))).toBe(true);
    expect(focusFrozen("2026-11-16", new Date("2026-11-16T14:24:59Z"))).toBe(false);
    expect(focusFrozen("2026-11-16", new Date("2026-11-16T14:25:00Z"))).toBe(true);
    expect(focusFrozen("2026-11-16", new Date("2026-11-17T12:00:00Z"))).toBe(true);
    // the evening before (New York's own date, not UTC's: 21:30 New York on the 15th is the 16th in UTC)
    expect(focusFrozen("2026-11-16", new Date("2026-11-16T02:30:00Z"))).toBe(false);
  });

  it("calls a check late only when it was made at or after the freeze", () => {
    expect(premarketLate({ as_of: "2026-10-12T12:50:00Z" }, SESSION)).toBe(false);
    expect(premarketLate({ as_of: "2026-10-12T13:40:00Z" }, SESSION)).toBe(true);
    expect(premarketLate({ as_of: "not a time" }, SESSION)).toBe(false);
  });
});

describe("the stored check", () => {
  const good: StoredPremarket = { session: SESSION, as_of: "2026-10-12T12:50:00Z", items: check("x").items as StoredPremarket["items"] };

  it("round-trips, in a fixed key order", () => {
    expect(parseStoredPremarket(storedPremarketText(good))).toEqual(good);
    expect(storedPremarketText(good).startsWith('{"session":"2026-10-12","as_of":')).toBe(true);
  });

  it("refuses anything else: bad JSON, an extra field, a bad session, time, item or place", () => {
    expect(parseStoredPremarket("{")).toBeNull();
    expect(parseStoredPremarket(JSON.stringify({ ...good, extra: 1 }))).toBeNull();
    expect(parseStoredPremarket(JSON.stringify({ ...good, session: "12/10/2026" }))).toBeNull();
    expect(parseStoredPremarket(JSON.stringify({ ...good, as_of: "soon" }))).toBeNull();
    expect(parseStoredPremarket(JSON.stringify({ ...good, items: [{ symbol: "" }] }))).toBeNull();
    expect(parseStoredPremarket(JSON.stringify({ ...good, items: [{ symbol: "SPY", where: "moon" }] }))).toBeNull();
    expect(parseStoredPremarket(JSON.stringify({ ...good, items: [{ symbol: "SPY", price: "1" }] }))).toBeNull();
    expect(parseStoredPremarket(JSON.stringify({ ...good, items: [{ symbol: "SPY", colour: "red" }] }))).toBeNull();
  });

  it("is read from an edition only when the edition carries one with a usable time", () => {
    const e = JSON.parse(edition("r", "2026-10-12T12:50:00+00:00", withCheck("2026-10-12T12:50:00Z"))) as OptionsEdition;
    expect(premarketOf(e)).toEqual({ session: SESSION, as_of: "2026-10-12T12:50:00Z", items: check("x").items });
    expect(premarketOf(JSON.parse(edition("r", "2026-10-12T12:50:00+00:00")) as OptionsEdition)).toBeNull();
  });
});

describe("putting the stored check back on an edition", () => {
  const bare = () => JSON.parse(edition("r", "2026-10-12T13:00:00+00:00")) as OptionsEdition;
  const stored = (asOf: string, session = SESSION, symbols = ["SPY", "QQQ"]): StoredPremarket => ({
    session,
    as_of: asOf,
    items: symbols.map((symbol) => ({ symbol, price: 1 })),
  });

  it("an edition with no check takes the stored one of its session", () => {
    const out = withPremarket(bare(), stored("2026-10-12T12:50:00Z"));
    expect(out.focus?.premarket).toEqual({ as_of: "2026-10-12T12:50:00Z", items: [{ symbol: "SPY", price: 1 }, { symbol: "QQQ", price: 1 }] });
    // nothing else changes, and the edition read is not mutated
    expect({ ...out, focus: { ...out.focus, premarket: null } }).toEqual(bare());
  });

  it("an edition's own later check is kept; a later stored check replaces an earlier own one", () => {
    const own = JSON.parse(edition("r", "2026-10-12T13:00:00+00:00", withCheck("2026-10-12T13:00:00Z"))) as OptionsEdition;
    expect(withPremarket(own, stored("2026-10-12T12:50:00Z"))).toBe(own);
    expect(withPremarket(own, stored("2026-10-12T13:00:00Z"))).toBe(own);
    expect(withPremarket(own, stored("2026-10-12T13:40:00Z")).focus?.premarket?.as_of).toBe("2026-10-12T13:40:00Z");
  });

  it("never: another session, a name the focus does not hold, no focus, nothing stored", () => {
    const e = bare();
    expect(withPremarket(e, stored("2026-10-12T12:50:00Z", "2026-10-13"))).toBe(e);
    expect(withPremarket(e, stored("2026-10-12T12:50:00Z", SESSION, ["SPY", "NVDA"]))).toBe(e);
    const noFocus = { ...e, focus: null } as OptionsEdition;
    expect(withPremarket(noFocus, stored("2026-10-12T12:50:00Z"))).toBe(noFocus);
    expect(withPremarket(e, null)).toBe(e);
  });
});

describe("same apart from the check", () => {
  const a = JSON.parse(edition("run-a", "2026-10-09T21:00:00+00:00")) as Record<string, unknown>;

  it("ignores the run, the time, the check and key order", () => {
    const b = JSON.parse(edition("run-b", "2026-10-12T12:50:00+00:00", withCheck("2026-10-12T12:50:00Z"))) as Record<string, unknown>;
    expect(sameApartFromPremarket(a, b)).toBe(true);
    const reordered = Object.fromEntries(Object.entries(b).reverse());
    expect(sameApartFromPremarket(a, reordered)).toBe(true);
  });

  it("sees a changed name, a moved level and a changed ticker", () => {
    expect(sameApartFromPremarket(a, JSON.parse(edition("b", "x", otherNames)))).toBe(false);
    const moved = JSON.parse(edition("b", "x", (r) => {
      ((r.focus as { items: { resistance: { price: number } }[] }).items[0]!.resistance.price = 779.5);
    }));
    expect(sameApartFromPremarket(a, moved)).toBe(false);
    const ticker = JSON.parse(edition("b", "x", (r) => {
      ((r.tickers as { last: number }[])[0]!.last = 1);
    }));
    expect(sameApartFromPremarket(a, ticker)).toBe(false);
  });
});

describe("ingest: the check is kept apart, whatever the edition's answer", () => {
  it("a pre-open edition's check is kept for its session", async () => {
    const now = new Date("2026-10-12T12:51:00Z");
    expect((await send(edition("pre", "2026-10-12T12:50:00+00:00", withCheck("2026-10-12T12:50:00Z")), now)).body.status).toBe("stored");
    expect(kept()).toEqual({ session: SESSION, as_of: "2026-10-12T12:50:00Z", items: check("x").items });
  });

  it("a re-run of the evening pick after the pre-open: the edition is replaced, the check survives and is shown", async () => {
    await send(edition("pre", "2026-10-12T12:50:00+00:00", withCheck("2026-10-12T12:50:00Z")), new Date("2026-10-12T12:51:00Z"));
    const rerun = edition("rerun", "2026-10-12T13:05:00+00:00");
    expect((await send(rerun, new Date("2026-10-12T13:06:00Z"))).body.status).toBe("stored");
    expect(blob.store.get(LATEST)!.text).toBe(rerun);
    expect(kept()?.as_of).toBe("2026-10-12T12:50:00Z");
    const read = await loadOptions();
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.edition.run_id).toBe("rerun");
      expect(read.edition.focus?.premarket?.as_of).toBe("2026-10-12T12:50:00Z");
    }
  });

  it("an older check never replaces a later one", async () => {
    await send(edition("late", "2026-10-12T13:00:00+00:00", withCheck("2026-10-12T13:00:00Z", 781)), new Date("2026-10-12T13:01:00Z"));
    await send(edition("early", "2026-10-12T12:40:00+00:00", withCheck("2026-10-12T12:40:00Z", 779)), new Date("2026-10-12T13:02:00Z"));
    expect(kept()?.as_of).toBe("2026-10-12T13:00:00Z");
    expect(kept()?.items[0]?.price).toBe(781);
  });

  it("a check dated ahead of the clock is not kept", async () => {
    await send(edition("ahead", "2026-10-12T12:50:00+00:00", withCheck("2026-10-12T15:00:00Z")), new Date("2026-10-12T12:51:00Z"));
    expect(kept()).toBeNull();
  });

  it("a store failure while keeping the check never changes the edition's answer", async () => {
    blob.store.set(PRE_PATH, { text: "not json", etag: '"bad"' });
    const { writeText } = await import("@/lib/blob");
    vi.mocked(writeText).mockImplementationOnce(async () => {
      throw Object.assign(new Error("down"), { name: "BlobServiceNotAvailable" });
    });
    expect((await send(edition("pre", "2026-10-12T12:50:00+00:00", withCheck("2026-10-12T12:50:00Z")), new Date("2026-10-12T12:51:00Z"))).body.status).toBe("stored");
  });
});

describe("ingest: from 09:25 New York the session's names and levels stay", () => {
  const evening = () => send(edition("evening", "2026-10-09T21:52:00+00:00"), new Date("2026-10-09T21:53:00Z"));

  it("before 09:25 a same-session edition may still change the names", async () => {
    await evening();
    expect((await send(edition("pre", "2026-10-12T13:20:00+00:00", otherNames), new Date("2026-10-12T13:24:59Z"))).body.status).toBe("stored");
    expect((latest().focus as { items: { symbol: string }[] }).items.map((i) => i.symbol)).toEqual(["SPY", "NVDA"]);
  });

  it("after 09:25 a change of names is refused as frozen, recorded for the feed watch, and latest is untouched", async () => {
    await evening();
    const before = blob.store.get(LATEST)!.text;
    const late = edition("late", "2026-10-12T13:40:00+00:00", (r) => {
      otherNames(r);
      withCheck("2026-10-12T13:40:00Z", undefined, "NVDA")(r);
    });
    expect(await send(late, new Date("2026-10-12T13:41:00Z"))).toEqual({ status: 409, body: { status: "frozen", run_id: "late" } });
    expect(blob.store.get(LATEST)!.text).toBe(before);
    expect(blob.store.get("options/editions/2026-10-12.json")!.text).toBe(before);
    expect(JSON.parse(blob.store.get("ops/ingest-rejects/options.json")!.text)).toEqual({ at: "2026-10-12T13:41:00.000Z", kind: "options", outcome: "frozen", n_errors: 1 });
    // its check names NVDA, which the frozen focus does not hold: kept, but never put on the edition
    expect(kept()?.as_of).toBe("2026-10-12T13:40:00Z");
    const read = await loadOptions();
    if (read.status !== "ok") throw new Error("no edition");
    expect(read.edition.focus?.premarket ?? null).toBeNull();
  });

  it("after 09:25 a moved level is refused too", async () => {
    await evening();
    const moved = edition("moved", "2026-10-12T13:40:00+00:00", (r) => {
      ((r.focus as { items: { support: { price: number } }[] }).items[0]!.support.price = 770);
    });
    expect((await send(moved, new Date("2026-10-12T13:41:00Z"))).body.status).toBe("frozen");
  });

  it("after 09:25 a late pre-open that only adds its check is stored, and its check is late", async () => {
    await evening();
    const late = edition("late-pre", "2026-10-12T13:40:00+00:00", withCheck("2026-10-12T13:40:00Z"));
    expect((await send(late, new Date("2026-10-12T13:41:00Z"))).body.status).toBe("stored");
    const p = (latest().focus as { premarket: { as_of: string } }).premarket;
    expect(premarketLate(p, SESSION)).toBe(true);
  });

  it("the first edition for a session is stored whenever it comes: nothing of that session is there to keep", async () => {
    await send(edition("old", "2026-10-08T21:52:00+00:00", (r) => (r.session = "2026-10-09")), new Date("2026-10-08T21:53:00Z"));
    expect((await send(edition("first", "2026-10-12T13:40:00+00:00"), new Date("2026-10-12T13:41:00Z"))).body.status).toBe("stored");
  });

  it("a duplicate after 09:25 is still a duplicate, and an older edition still older", async () => {
    await evening();
    expect((await send(edition("evening", "2026-10-09T21:52:00+00:00"), new Date("2026-10-12T13:41:00Z"))).body.status).toBe("duplicate");
    expect((await send(edition("older", "2026-10-09T21:00:00+00:00", otherNames), new Date("2026-10-12T13:41:00Z"))).body.status).toBe("older");
  });

  it("the next session's evening edition after the close is not frozen by today's", async () => {
    await evening();
    const next = edition("next", "2026-10-12T21:52:00+00:00", (r) => {
      r.session = "2026-10-13";
      otherNames(r);
    });
    expect((await send(next, new Date("2026-10-12T21:53:00Z"))).body.status).toBe("stored");
  });
});

describe("review follow-ups", () => {
  const evening = () => send(edition("evening", "2026-10-09T21:52:00+00:00"), new Date("2026-10-09T21:53:00Z"));
  const pre = () => send(edition("pre", "2026-10-12T12:50:00+00:00", withCheck("2026-10-12T12:50:00Z")), new Date("2026-10-12T12:51:00Z"));

  it("the feed watch's cron reads the edition as the pages do: after an evening re-run its pre-open row still has the check", async () => {
    await pre();
    await send(edition("rerun", "2026-10-12T13:05:00+00:00"), new Date("2026-10-12T13:06:00Z"));
    const text = await blobFeedDeps().readDoc(LATEST);
    const stamp = premarketStamp(JSON.parse(text!));
    expect(stamp).toEqual({ session: SESSION, at: Date.parse("2026-10-12T12:50:00Z") });
    // any other document is passed through untouched
    blob.store.set("radar/latest.json", { text: "{ \"x\": 1 }", etag: '"r"' });
    expect(await blobFeedDeps().readDoc("radar/latest.json")).toBe('{ "x": 1 }');
  });

  it("the freeze holds the session's own dated file when latest holds another session's edition", async () => {
    await evening();
    // a manual send for the next session takes latest during the session
    await send(edition("next", "2026-10-12T13:30:00+00:00", (r) => (r.session = "2026-10-13")), new Date("2026-10-12T13:31:00Z"));
    const changed = edition("changed", "2026-10-12T13:40:00+00:00", otherNames);
    expect((await send(changed, new Date("2026-10-12T13:41:00Z"))).body.status).toBe("frozen");
  });

  it("a later day is frozen too, at the ingest", async () => {
    await evening();
    expect((await send(edition("tue", "2026-10-13T13:00:00+00:00", otherNames), new Date("2026-10-13T13:01:00Z"))).body.status).toBe("frozen");
  });

  it("the check is kept from a duplicate's or an older edition's body only when it is later", async () => {
    await pre();
    // an older edition carrying a later check (as_of of the edition older, the check newer): edition 409, check kept
    const older = edition("older", "2026-10-09T21:00:00+00:00", withCheck("2026-10-12T13:00:00Z", 782));
    expect((await send(older, new Date("2026-10-12T13:01:00Z"))).body.status).toBe("older");
    expect(kept()?.as_of).toBe("2026-10-12T13:00:00Z");
  });

  it("a check the reader could not read back is not kept and never replaces a good one", async () => {
    await pre();
    const bad = edition("bad", "2026-10-12T13:00:00+00:00", (r) => {
      (r.focus as Record<string, unknown>).premarket = { as_of: "2026-10-12T13:00:00Z", items: [{ symbol: "" }] };
    });
    await send(bad, new Date("2026-10-12T13:01:00Z"));
    expect(kept()?.as_of).toBe("2026-10-12T12:50:00Z");
  });

  it("the loader shows the edition as stored when the side file cannot be read", async () => {
    await evening();
    blob.store.set(PRE_PATH, { text: storedPremarketText({ session: SESSION, as_of: "2026-10-12T12:50:00Z", items: [] }), etag: '"p"' });
    vi.mocked(blobMod.readText).mockImplementation(async (pathname: string) => {
      if (pathname === PRE_PATH) throw Object.assign(new Error("down"), { name: "BlobServiceNotAvailable" });
      return blob.store.get(pathname) ?? null;
    });
    try {
      const read = await loadOptions();
      expect(read.status).toBe("ok");
      if (read.status === "ok") expect(read.edition.run_id).toBe("evening");
    } finally {
      vi.mocked(blobMod.readText).mockImplementation(async (pathname: string) => blob.store.get(pathname) ?? null);
    }
  });

  it("a store that hangs is given up on: the cap rejects", async () => {
    await expect(within(new Promise(() => undefined), 5)).rejects.toThrow("timed out");
    await expect(within(Promise.resolve(1), 5)).resolves.toBe(1);
  });

  it("a frozen refusal round-trips through the reject record", () => {
    const r = { at: "2026-10-12T13:41:00.000Z", kind: "options" as const, outcome: "frozen" as const, n_errors: 1 };
    expect(parseIngestReject(JSON.stringify(r))).toEqual(r);
  });
});
