// The board-feed stamp (EXP-0033, DEC-0050): the frozen rules (board-feed-judge.ts sessionEnds, covered, boardOff), each
// placing a stamp by its `at`; the chain check (verifyChain); and the per-minute writer, its seal and the day reader
// (board-feed-stamp.ts) on an in-memory store. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreconditionFailed } from "@/lib/blob";
import {
  type BoardFeedManifest,
  boardOff,
  bodyHash,
  type ChainBody,
  covered,
  type JudgeStamp,
  minuteOf,
  parseManifest,
  parseStamp,
  sessionEnds,
  stampKey,
  verifyChain,
} from "@/lib/board-feed-judge";
import { dayToSeal, nextOpenAfter, probeSpy, readBoardFeedDay, resetStampWarnings, type StampDeps, type StampStore, stampBoardFeed } from "@/lib/board-feed-stamp";
import { resetFeedWarning } from "@/lib/alpaca-feed";
import { fetchQuotes, resetQuoteCache } from "@/lib/quote";

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  resetFeedWarning();
  resetQuoteCache();
  resetStampWarnings();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const MIN = 60_000;
const T = Date.parse("2026-11-12T14:30:00Z"); // 09:30 New York, the open (EST)
const at = (min: number, sec = 0) => T + min * MIN + sec * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
/** A stamp written `min` minutes (and `sec` seconds) after the open: its key minute is the floor, its `at` exact. */
const st = (min: number, over: Partial<JudgeStamp> = {}, sec = 0): JudgeStamp => ({
  minute: Math.floor(at(min, sec) / MIN) * MIN,
  feed: "sip",
  answered: "ok",
  deployment: "dpl_a",
  at: iso(at(min, sec)),
  ...over,
});
/** NY wall clock 09:mm:ss on the session day, as epoch ms. */
const ny = (hh: number, mm: number, ss = 0) => T + ((hh - 9) * 60 + mm - 30) * MIN + ss * 1000;

describe("sessionEnds", () => {
  it("not_sip on any stamp whose feed is not sip; a mixed feed included", () => {
    expect(sessionEnds([st(0), st(1), st(2)])).toEqual({ not_sip: false, hidden_change: false });
    expect(sessionEnds([st(0), st(1, { feed: "iex" }), st(2)]).not_sip).toBe(true);
    expect(sessionEnds([st(0, { feed: "refused" })]).not_sip).toBe(true);
    expect(sessionEnds([])).toEqual({ not_sip: false, hidden_change: false });
  });

  it("hidden_change: a gap by `at` over 10 minutes with different deployments; 10:00 apart is not, 10:01 is", () => {
    expect(sessionEnds([st(0), st(10, { deployment: "dpl_b" })]).hidden_change).toBe(false);
    expect(sessionEnds([st(0), st(10, { deployment: "dpl_b" }, 1)]).hidden_change).toBe(true);
  });

  it("the gap is measured by `at`, not by the key minutes", () => {
    // keys 09:30 and 09:40 (10 minutes), but written at 09:30:00 and 09:40:30: 10:30 apart
    expect(sessionEnds([st(0), st(10, { deployment: "dpl_b" }, 30)]).hidden_change).toBe(true);
    // keys 09:30 and 09:41 (11 minutes), written at 09:30:50 and 09:41:00: 10:10 apart, still hidden
    expect(sessionEnds([st(0, {}, 50), st(11, { deployment: "dpl_b" })]).hidden_change).toBe(true);
    // keys 09:30 and 09:41, written at 09:30:59 and 09:41:00: 10:01 apart
    expect(sessionEnds([st(0, {}, 59), st(11, { deployment: "dpl_b" })]).hidden_change).toBe(true);
    // keys 09:30 and 09:40, written at 09:30:30 and 09:40:00: 9:30 apart
    expect(sessionEnds([st(0, {}, 30), st(10, { deployment: "dpl_b" })]).hidden_change).toBe(false);
  });

  it("the same deployment across a long gap is not a hidden change; null on either side counts as differing", () => {
    expect(sessionEnds([st(0), st(30)]).hidden_change).toBe(false);
    expect(sessionEnds([st(0, { deployment: null }), st(30)]).hidden_change).toBe(true);
    expect(sessionEnds([st(0, { deployment: null }), st(30, { deployment: null })]).hidden_change).toBe(true);
    expect(sessionEnds([st(0, { deployment: null }), st(5, { deployment: "dpl_b" })]).hidden_change).toBe(false);
  });

  it("the night between two sessions is not a gap; the order the stamps come in does not matter", () => {
    const next = { ...st(0), minute: Date.parse("2026-11-13T14:30:00Z"), at: "2026-11-13T14:30:00.000Z", deployment: "dpl_b" };
    expect(sessionEnds([next, st(389)]).hidden_change).toBe(false);
  });
});

describe("covered", () => {
  it("a sip stamp whose `at` is in [t0 − 2 min, t0] covers: 2:00 back does, 2:01 back does not", () => {
    expect(covered([st(0)], at(0))).toBe(true);
    expect(covered([st(0)], at(2))).toBe(true);
    expect(covered([st(0)], at(2, 1))).toBe(false);
    expect(covered([], at(0))).toBe(false);
  });

  it("the reviewer's case: a first stamp at 09:30:40 does not cover t0 = 09:30:10 (its key minute does not count)", () => {
    expect(covered([st(0, {}, 40)], ny(9, 30, 10))).toBe(false);
    expect(covered([st(0, {}, 40)], ny(9, 30, 40))).toBe(true);
    // the rule-1 window is read from `at`: written 09:30:40, it covers up to 09:32:40, not only to 09:32:00
    expect(covered([st(0, {}, 40)], ny(9, 32, 40))).toBe(true);
    expect(covered([st(0, {}, 40)], ny(9, 32, 41))).toBe(false);
  });

  it("between the `at` of two consecutive sip stamps of the day, however far apart and whatever their deployments", () => {
    expect(covered([st(0), st(10)], at(5))).toBe(true);
    expect(covered([st(0), st(60, { deployment: "dpl_b" })], at(30))).toBe(true);
    expect(covered([st(0, { deployment: null }), st(60, { deployment: null })], at(30))).toBe(true);
    // the pair is found by `at`: keys 09:40 and 09:45 written late, t0 between them by `at`
    expect(covered([st(10, {}, 50), st(15, {}, 20)], at(13))).toBe(true);
  });

  it("a mixed feed: either side iex or refused does not cover between them; the sip side's 2 minutes still do", () => {
    const s = [st(0), st(6, { feed: "iex" })];
    expect(covered(s, at(3))).toBe(false);
    expect(covered(s, at(2))).toBe(true);
    expect(covered(s, at(6))).toBe(false);
    expect(covered([st(0, { feed: "iex" }), st(6)], at(3))).toBe(false);
    expect(covered([st(0, { feed: "refused" })], at(0))).toBe(false);
  });

  it("a deleted run of the newest stamps followed by a later sip stamp still covers t0", () => {
    const all: JudgeStamp[] = [];
    for (let m = 0; m <= 51; m++) all.push(st(m));
    const kept = all.filter((x) => Date.parse(x.at) <= at(30) || Date.parse(x.at) >= at(51));
    expect(covered(kept, at(45))).toBe(true);
  });

  it("t0 after the last stamp of the day is not covered past its 2 minutes", () => {
    const s = [st(0), st(1), st(2)];
    expect(covered(s, at(4))).toBe(true);
    expect(covered(s, at(4, 1))).toBe(false);
    const nextDay = { ...st(0), minute: Date.parse("2026-11-13T14:30:00Z"), at: "2026-11-13T14:30:00.000Z" };
    expect(covered([...s, nextDay], at(30))).toBe(false);
  });
});

describe("boardOff", () => {
  const off = (min: number, sec = 0, answered = min % 3 === 0 ? "stale" : min % 2 ? "error" : "plan") => st(min, { answered }, sec);
  const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => off(from + i));

  it("a run whose `at` span is 9 minutes is not off, 10 minutes is; 9:59 is not", () => {
    expect(boardOff([st(0), ...run(1, 10)], at(10))).toBe(false); // 9 minutes
    expect(boardOff([st(0), ...run(1, 11)], at(11))).toBe(true); // 10 minutes
    expect(boardOff([off(1), off(10, 59)], at(11))).toBe(false); // 9:59
    expect(boardOff([off(1), off(11)], at(11))).toBe(true); // two stamps, nothing between: span 10, never filled in
  });

  it("stale answers count as not ok", () => {
    const stale = Array.from({ length: 11 }, (_, i) => st(i, { answered: "stale" }));
    expect(boardOff(stale, at(10))).toBe(true);
  });

  it("the span and the window are read from `at`, not from the key minutes", () => {
    // keys 09:31 and 09:41 (10 minutes) but written 09:31:00 and 09:40:59
    const s = [off(1), { ...off(11), at: iso(at(10, 59)) }];
    expect(boardOff(s, at(11))).toBe(false);
    // the run's last `at` at 09:40:30: off until 09:42:30, not after
    const late = [off(0, 30), off(10, 30)];
    expect(boardOff(late, at(12, 30))).toBe(true);
    expect(boardOff(late, at(12, 31))).toBe(false);
  });

  it("the reviewer's case: not-ok stamps from 09:50:05 to 10:00:50, t0 = 10:00:10, is not off", () => {
    const s = [...Array.from({ length: 10 }, (_, i) => off(20 + i, 5)), off(30, 50)]; // 09:50:05 … 09:59:05, 10:00:50
    expect(boardOff(s, ny(10, 0, 10))).toBe(false);
    expect(boardOff(s, ny(10, 0, 50))).toBe(true);
  });

  it("the run's last stamp must lie in [t0 − 2 min, t0]: 2:00 after it is off, 2:01 is not", () => {
    const s = run(10, 20);
    expect(boardOff(s, at(20))).toBe(true);
    expect(boardOff(s, at(22))).toBe(true);
    expect(boardOff(s, at(22, 1))).toBe(false);
  });

  it("reads only stamps at or before t0: inside a run, its span so far is what counts", () => {
    const s = run(10, 30);
    expect(boardOff(s, at(19))).toBe(false);
    expect(boardOff(s, at(20))).toBe(true);
    expect(boardOff(s, at(5))).toBe(false);
  });

  it("an ok stamp ends the run, and so does a New York day change", () => {
    expect(boardOff([...run(0, 5), st(6), ...run(7, 12)], at(12))).toBe(false);
    expect(boardOff([], at(0))).toBe(false);
    // 23:55 to 23:59 one day, then 00:00 to 00:06 the next (NY): never one run
    const night = Date.parse("2026-11-13T04:55:00Z"); // 23:55 New York, 12 Nov
    const n = (m: number) => ({ minute: night + m * MIN, feed: "sip", answered: "error", deployment: "d", at: iso(night + m * MIN) });
    const across = Array.from({ length: 12 }, (_, i) => n(i));
    expect(boardOff(across, night + 11 * MIN)).toBe(false);
    expect(boardOff(Array.from({ length: 11 }, (_, i) => n(i + 5)), night + 15 * MIN)).toBe(true);
  });
});

// A day's stamp bodies as the writer chains them: each one's prev is the hash of the one before.
function chain(n: number, step = 1): ChainBody[] {
  const out: ChainBody[] = [];
  for (let i = 0; i < n; i++) {
    const prev = i === 0 ? null : bodyHash(out[i - 1]!.text);
    const t = at(i * step, 7);
    out.push({ minute: Math.floor(t / MIN) * MIN, text: JSON.stringify({ v: 1, feed: "sip", answered: "ok", at: iso(t), deployment: "dpl_a", commit: null, prev }) });
  }
  return out;
}
const NEXT_OPEN = Date.parse("2026-11-13T14:30:00Z");
const sealOf = (b: ChainBody[], atIso = "2026-11-12T21:02:30.000Z"): BoardFeedManifest => ({
  v: 1,
  count: b.length,
  last: b.length ? bodyHash(b.at(-1)!.text) : null,
  at: atIso,
});
/** A body re-chained from `i` on, as an attacker who edits one body and fixes up the hashes after it would do. */
function rechain(b: ChainBody[], from: number): ChainBody[] {
  const out = b.map((x) => ({ ...x }));
  for (let i = from + 1; i < out.length; i++) {
    const v = JSON.parse(out[i]!.text);
    v.prev = bodyHash(out[i - 1]!.text);
    out[i]!.text = JSON.stringify(v);
  }
  return out;
}

describe("verifyChain", () => {
  it("an intact day verifies; an empty day sealed as empty verifies", () => {
    const b = chain(5);
    expect(verifyChain(b, sealOf(b), NEXT_OPEN)).toEqual({ ok: true, reason: "ok" });
    expect(verifyChain([], sealOf([]), NEXT_OPEN)).toEqual({ ok: true, reason: "ok" });
  });

  it("no manifest", () => {
    expect(verifyChain(chain(3), null, NEXT_OPEN)).toEqual({ ok: false, reason: "no_manifest" });
  });

  it("a manifest written at or after the next open is late", () => {
    const b = chain(3);
    expect(verifyChain(b, sealOf(b, "2026-11-13T14:29:59.999Z"), NEXT_OPEN).reason).toBe("ok");
    expect(verifyChain(b, sealOf(b, "2026-11-13T14:30:00.000Z"), NEXT_OPEN)).toEqual({ ok: false, reason: "late_manifest" });
  });

  it("a deleted middle stamp breaks the chain", () => {
    const b = chain(5);
    expect(verifyChain([...b.slice(0, 2), ...b.slice(3)], sealOf(b), NEXT_OPEN)).toEqual({ ok: false, reason: "prev_mismatch" });
  });

  it("an edited body breaks the chain, the last one included (against the manifest)", () => {
    const b = chain(5);
    const m = sealOf(b);
    const edited = b.map((x) => ({ ...x }));
    edited[2]!.text = edited[2]!.text.replace('"sip"', '"iex"');
    expect(verifyChain(edited, m, NEXT_OPEN)).toEqual({ ok: false, reason: "prev_mismatch" });
    const lastEdited = b.map((x) => ({ ...x }));
    lastEdited[4]!.text = lastEdited[4]!.text.replace('"ok"', '"plan"');
    expect(verifyChain(lastEdited, m, NEXT_OPEN)).toEqual({ ok: false, reason: "prev_mismatch" });
    expect(verifyChain(b.slice(0, 4), m, NEXT_OPEN)).toEqual({ ok: false, reason: "prev_mismatch" });
    expect(verifyChain([{ minute: b[0]!.minute, text: "{" }, ...b.slice(1)], m, NEXT_OPEN)).toEqual({ ok: false, reason: "prev_mismatch" });
  });

  it("a stamp whose `at` is not in its key's minute is misplaced", () => {
    const b = chain(3);
    const moved = b.map((x, i) => (i === 1 ? { ...x, minute: x.minute + MIN } : x));
    expect(verifyChain(moved, sealOf(moved), NEXT_OPEN)).toEqual({ ok: false, reason: "misplaced" });
  });

  it("`at` must strictly increase", () => {
    const b = chain(3);
    const v = JSON.parse(b[2]!.text);
    v.at = JSON.parse(b[1]!.text).at; // the same instant as the stamp before
    const same = rechain([b[0]!, b[1]!, { minute: b[1]!.minute, text: JSON.stringify(v) }], 2);
    expect(verifyChain(same, sealOf(same), NEXT_OPEN)).toEqual({ ok: false, reason: "misplaced" });
  });

  it("a wrong count", () => {
    const b = chain(5);
    expect(verifyChain(b, { ...sealOf(b), count: 6 }, NEXT_OPEN)).toEqual({ ok: false, reason: "count_mismatch" });
    expect(verifyChain(b, { ...sealOf(b), count: 4 }, NEXT_OPEN)).toEqual({ ok: false, reason: "count_mismatch" });
  });
});

describe("stamp keys", () => {
  it("keys, stamps and manifests read back", () => {
    expect(stampKey("2026-11-12", 571)).toBe("desk/feeds/board/2026-11-12/0931.json");
    expect(minuteOf("0931")).toBe(571);
    for (const bad of ["931", "2460", "0960", "ab12"]) expect(minuteOf(bad)).toBeNull();
    const good = { v: 1, feed: "sip", answered: "ok", at: "2026-11-12T14:31:00.000Z", deployment: null, commit: "abc", prev: null };
    expect(parseStamp(JSON.stringify(good))).toEqual(good);
    expect(parseStamp(JSON.stringify({ ...good, answered: "stale" }))?.answered).toBe("stale");
    expect(parseStamp(JSON.stringify({ ...good, prev: "a".repeat(64) }))?.prev).toBe("a".repeat(64));
    for (const bad of [{ ...good, v: 2 }, { ...good, feed: "SIP" }, { ...good, answered: "maybe" }, { ...good, at: "x" }, { ...good, commit: 1 }, { ...good, prev: "abc" }])
      expect(parseStamp(JSON.stringify(bad))).toBeNull();
    expect(parseStamp("{")).toBeNull();
    const m = { v: 1, count: 2, last: "b".repeat(64), at: "2026-11-12T21:00:00.000Z" };
    expect(parseManifest(JSON.stringify(m))).toEqual(m);
    for (const bad of [{ ...m, v: 2 }, { ...m, count: -1 }, { ...m, count: 1.5 }, { ...m, last: "x" }, { ...m, at: "" }]) expect(parseManifest(JSON.stringify(bad))).toBeNull();
  });

  it("the next open after a day, and which day a run seals", () => {
    expect(nextOpenAfter("2026-11-12")).toBe(Date.parse("2026-11-13T14:30:00Z"));
    expect(nextOpenAfter("2026-11-13")).toBe(Date.parse("2026-11-16T14:30:00Z")); // Friday to Monday
    expect(nextOpenAfter("2026-11-25")).toBe(Date.parse("2026-11-27T14:30:00Z")); // over Thanksgiving
    expect(dayToSeal("2026-11-12", 960)).toBeNull(); // 16:00
    expect(dayToSeal("2026-11-12", 961)).toBeNull(); // 16:01
    expect(dayToSeal("2026-11-12", 962)).toBe("2026-11-12"); // 16:02
    expect(dayToSeal("2026-11-12", 600)).toBeNull(); // in the session
    expect(dayToSeal("2026-11-13", 540)).toBe("2026-11-12"); // 09:00 the next day, before its open
    expect(dayToSeal("2026-11-13", 570)).toBeNull(); // at its open
    expect(dayToSeal("2026-11-14", 600)).toBe("2026-11-13"); // Saturday
    expect(dayToSeal("2026-11-27", 782)).toBe("2026-11-27"); // 13:02 on the half day
    expect(dayToSeal("2026-11-27", 781)).toBeNull();
  });
});

// 2026-11-12 is a Thursday session (EST, New York = UTC−5); 2026-11-27 a half day (13:00 close).
const AT = (s: string) => new Date(s);
function memStore() {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const s: StampStore = {
    list: async (prefix, signal) => (calls.push(`list ${prefix}`), expect(signal).toBeInstanceOf(AbortSignal), [...store.keys()].filter((k) => k.startsWith(prefix))),
    read: async (p, signal) => (calls.push(`read ${p}`), expect(signal).toBeInstanceOf(AbortSignal), store.get(p) ?? null),
    exists: async (p, signal) => (calls.push(`head ${p}`), expect(signal).toBeInstanceOf(AbortSignal), store.has(p)),
    create: async (p, b, signal) => {
      calls.push(`create ${p}`);
      expect(signal).toBeInstanceOf(AbortSignal);
      if (store.has(p)) throw new PreconditionFailed();
      store.set(p, b);
    },
  };
  return { store, calls, s };
}
function stampDeps(over: Partial<StampDeps> = {}) {
  const mem = memStore();
  const deps: Partial<StampDeps> = {
    env: { VERCEL_ENV: "production", ALPACA_FEED: "sip", VERCEL_DEPLOYMENT_ID: "dpl_123" },
    commitSha: "0123456789abcdef0123",
    now: () => AT("2026-11-12T14:31:20Z"), // 09:31 New York
    store: mem.s,
    probe: async () => "ok",
    timeoutMs: 1_000,
    ...over,
  };
  const reader = {
    list: async (p: string) => [...mem.store.keys()].filter((k) => k.startsWith(p)).map((pathname) => ({ pathname })),
    read: async (p: string) => (mem.store.has(p) ? { text: mem.store.get(p)! } : null),
  };
  const writes = () => mem.calls.filter((c) => c.startsWith("create "));
  return { deps, store: mem.store, calls: mem.calls, writes, reader };
}

describe("stampBoardFeed", () => {
  it("in production in the session: one create-only stamp at the minute's key", async () => {
    const f = stampDeps();
    expect(await stampBoardFeed(f.deps)).toBe("written");
    expect(f.writes()).toEqual(["create desk/feeds/board/2026-11-12/0931.json"]);
    const body = f.store.get("desk/feeds/board/2026-11-12/0931.json")!;
    expect(JSON.parse(body)).toEqual({ v: 1, feed: "sip", answered: "ok", at: "2026-11-12T14:31:20.000Z", deployment: "dpl_123", commit: "0123456789ab", prev: null });
    expect(Object.keys(JSON.parse(body))).toEqual(["v", "feed", "answered", "at", "deployment", "commit", "prev"]);
    expect(logged).toEqual([]);
  });

  it("a second run in the same minute is refused by the store: duplicate, the first stamp kept", async () => {
    const f = stampDeps();
    await stampBoardFeed(f.deps);
    const first = f.store.get("desk/feeds/board/2026-11-12/0931.json");
    expect(await stampBoardFeed({ ...f.deps, now: () => AT("2026-11-12T14:31:40Z") })).toBe("duplicate");
    expect(f.store.get("desk/feeds/board/2026-11-12/0931.json")).toBe(first);
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "board-feed.stamp", outcome: "duplicate" });
  });

  it("prev: the minute before found by the walk-back's heads, without listing", async () => {
    let now = AT("2026-11-12T14:31:20Z");
    const f = stampDeps({ now: () => now });
    await stampBoardFeed(f.deps);
    now = AT("2026-11-12T14:32:05Z");
    f.calls.length = 0;
    await stampBoardFeed(f.deps);
    expect(f.calls).toEqual([
      "head desk/feeds/board/2026-11-12/0931.json",
      "head desk/feeds/board/2026-11-12/0930.json",
      "read desk/feeds/board/2026-11-12/0931.json",
      "create desk/feeds/board/2026-11-12/0932.json",
    ]);
    expect(JSON.parse(f.store.get("desk/feeds/board/2026-11-12/0932.json")!).prev).toBe(bodyHash(f.store.get("desk/feeds/board/2026-11-12/0931.json")!));
  });

  it("prev: across missed minutes the walk-back's heads (all at once) find it, without listing; another day is never the previous stamp", async () => {
    let now = AT("2026-11-12T14:31:20Z");
    const f = stampDeps({ now: () => now });
    f.store.set("desk/feeds/board/2026-11-11/1559.json", "yesterday");
    await stampBoardFeed(f.deps);
    now = AT("2026-11-12T14:34:05Z");
    f.calls.length = 0;
    await stampBoardFeed(f.deps);
    const first = f.store.get("desk/feeds/board/2026-11-12/0931.json")!;
    expect(JSON.parse(first).prev).toBeNull();
    expect(JSON.parse(f.store.get("desk/feeds/board/2026-11-12/0934.json")!).prev).toBe(bodyHash(first));
    expect(f.calls.filter((c) => c.startsWith("list "))).toEqual([]);
    expect(f.calls).toEqual([
      "head desk/feeds/board/2026-11-12/0933.json",
      "head desk/feeds/board/2026-11-12/0932.json",
      "head desk/feeds/board/2026-11-12/0931.json",
      "head desk/feeds/board/2026-11-12/0930.json",
      "read desk/feeds/board/2026-11-12/0931.json",
      "create desk/feeds/board/2026-11-12/0934.json",
    ]);
  });

  it("prev: the walk-back stops at 15 minutes (and at the open), then lists the day", async () => {
    let now = AT("2026-11-12T14:31:20Z"); // 09:31
    const f = stampDeps({ now: () => now });
    await stampBoardFeed(f.deps);
    now = AT("2026-11-12T14:47:20Z"); // 09:47: 16 minutes on
    f.calls.length = 0;
    await stampBoardFeed(f.deps);
    const heads = f.calls.filter((c) => c.startsWith("head "));
    expect(heads).toHaveLength(15);
    expect(heads.at(-1)).toBe("head desk/feeds/board/2026-11-12/0932.json");
    expect(f.calls).toContain("list desk/feeds/board/2026-11-12/");
    expect(JSON.parse(f.store.get("desk/feeds/board/2026-11-12/0947.json")!).prev).toBe(bodyHash(f.store.get("desk/feeds/board/2026-11-12/0931.json")!));
    // the day's first stamp heads nothing before the open
    const g = stampDeps({ now: () => AT("2026-11-12T14:30:10Z") });
    await stampBoardFeed(g.deps);
    expect(g.calls.filter((c) => c.startsWith("head "))).toEqual([]);
  });

  it("a list that lags by the newest stamp still chains correctly through the walk-back", async () => {
    let now = AT("2026-11-12T14:31:20Z");
    const f = stampDeps({ now: () => now });
    await stampBoardFeed(f.deps);
    now = AT("2026-11-12T14:33:20Z");
    await stampBoardFeed(f.deps);
    // 09:35: 09:34 missed, and a lagging list does not yet show 09:33 (the newest stamp)
    now = AT("2026-11-12T14:35:20Z");
    const lagging = { ...f.deps.store!, list: async (p: string) => [...f.store.keys()].filter((k) => k.startsWith(p) && !k.endsWith("0933.json")) };
    expect(await stampBoardFeed({ ...f.deps, store: lagging })).toBe("written");
    expect(JSON.parse(f.store.get("desk/feeds/board/2026-11-12/0935.json")!).prev).toBe(bodyHash(f.store.get("desk/feeds/board/2026-11-12/0933.json")!));
    now = AT("2026-11-12T21:02:00Z");
    expect(await stampBoardFeed(f.deps)).toBe("manifest-written");
    const day = await readBoardFeedDay("2026-11-12", f.reader);
    expect(verifyChain(day.bodies, day.manifest, day.nextOpen!)).toEqual({ ok: true, reason: "ok" });
  });

  it("a seal over an inconsistent listing waits (seal-wait), then seals once the listing is consistent", async () => {
    let now = AT("2026-11-12T20:57:20Z");
    const f = stampDeps({ now: () => now });
    for (const t of ["2026-11-12T20:57:20Z", "2026-11-12T20:58:20Z", "2026-11-12T20:59:20Z"]) {
      now = AT(t);
      await stampBoardFeed(f.deps);
    }
    const key = "desk/feeds/board/2026-11-12/manifest.json";
    // the listing lags: it does not yet show 15:58, so 15:59's prev does not link to the body before it in the list
    const lagging = { ...f.deps.store!, list: async (p: string) => [...f.store.keys()].filter((k) => k.startsWith(p) && !k.endsWith("1558.json")) };
    now = AT("2026-11-12T21:02:00Z");
    logged = [];
    expect(await stampBoardFeed({ ...f.deps, store: lagging })).toBe("seal-wait");
    expect(f.store.has(key)).toBe(false);
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "board-feed.stamp", outcome: "seal-wait" });
    // a body that cannot be read yet waits too
    const unreadable = { ...f.deps.store!, read: async (p: string) => (p.endsWith("1559.json") ? null : (f.store.get(p) ?? null)) };
    expect(await stampBoardFeed({ ...f.deps, store: unreadable })).toBe("seal-wait");
    // the next run (here the next morning, before the open) sees a consistent listing and seals
    now = AT("2026-11-13T14:20:00Z");
    expect(await stampBoardFeed(f.deps)).toBe("manifest-written");
    expect(JSON.parse(f.store.get(key)!)).toMatchObject({ count: 3, last: bodyHash(f.store.get("desk/feeds/board/2026-11-12/1559.json")!) });
    const day = await readBoardFeedDay("2026-11-12", f.reader);
    expect(verifyChain(day.bodies, day.manifest, day.nextOpen!)).toEqual({ ok: true, reason: "ok" });
  });

  it("the seal's write is not started at or past the next open: late", async () => {
    const f = stampDeps({ now: () => AT("2026-11-12T20:59:20Z") });
    await stampBoardFeed(f.deps);
    // the run starts at 09:29:59.5 the next morning; by the write the open (09:30) has come
    const clock = [AT("2026-11-13T14:29:59.500Z"), AT("2026-11-13T14:29:59.500Z"), AT("2026-11-13T14:30:00Z")];
    let i = 0;
    logged = [];
    expect(await stampBoardFeed({ ...f.deps, now: () => clock[Math.min(i++, clock.length - 1)]! })).toBe("late");
    expect(f.store.has("desk/feeds/board/2026-11-12/manifest.json")).toBe(false);
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "board-feed.stamp", outcome: "late" });
  });

  it("a listed earlier stamp that cannot be read leaves the minute unstamped, with one log line", async () => {
    const f = stampDeps();
    f.store.set("desk/feeds/board/2026-11-12/0929.json", "x");
    const store = { ...f.deps.store!, read: async (p: string) => (p.endsWith("0929.json") ? null : (f.store.get(p) ?? null)) };
    expect(await stampBoardFeed({ ...f.deps, store })).toBe("store-failed");
    expect(f.writes()).toEqual([]);
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "board-feed.stamp", outcome: "store-failed", error: "ChainBroken" });
  });

  it("late: once the clock has moved into the next minute, or past the deadline, before the write, nothing is written", async () => {
    const clock = [AT("2026-11-12T14:31:59Z"), AT("2026-11-12T14:31:59.500Z"), AT("2026-11-12T14:32:00Z")];
    let i = 0;
    const f = stampDeps({ now: () => clock[Math.min(i++, clock.length - 1)]! });
    expect(await stampBoardFeed(f.deps)).toBe("late");
    expect(f.writes()).toEqual([]);
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "board-feed.stamp", outcome: "late" });
    // the same minute, but past the deadline (the store's limit, 1 s here)
    const clock2 = [AT("2026-11-12T14:31:10Z"), AT("2026-11-12T14:31:10Z"), AT("2026-11-12T14:31:11.001Z")];
    let j = 0;
    const g = stampDeps({ now: () => clock2[Math.min(j++, clock2.length - 1)]! });
    expect(await stampBoardFeed(g.deps)).toBe("late");
    expect(g.writes()).toEqual([]);
  });

  it("the put is not started past second 45 of the minute: 44.9 s writes, 45.0 s is late", async () => {
    const run = (iso0: string, isoPut: string) => {
      const clock = [AT(iso0), AT(iso0), AT(isoPut)];
      let i = 0;
      return stampDeps({ now: () => clock[Math.min(i++, clock.length - 1)]! });
    };
    const ok = run("2026-11-12T14:31:44Z", "2026-11-12T14:31:44.900Z");
    expect(await stampBoardFeed(ok.deps)).toBe("written");
    expect(ok.writes()).toEqual(["create desk/feeds/board/2026-11-12/0931.json"]);
    const late = run("2026-11-12T14:31:44Z", "2026-11-12T14:31:45.000Z");
    expect(await stampBoardFeed(late.deps)).toBe("late");
    expect(late.writes()).toEqual([]);
    expect(JSON.parse(logged.at(-1)!)).toMatchObject({ evt: "board-feed.stamp", outcome: "late" });
  });

  it("no VERCEL_DEPLOYMENT_ID in production: the stamp is written with deployment null, and one log line per instance", async () => {
    let now = AT("2026-11-12T14:31:20Z");
    const f = stampDeps({ env: { VERCEL_ENV: "production", ALPACA_FEED: "sip", VERCEL_DEPLOYMENT_ID: "" }, now: () => now });
    expect(await stampBoardFeed(f.deps)).toBe("written");
    now = AT("2026-11-12T14:32:20Z");
    expect(await stampBoardFeed(f.deps)).toBe("written");
    expect(JSON.parse(f.store.get("desk/feeds/board/2026-11-12/0931.json")!).deployment).toBeNull();
    expect(logged.map((l) => JSON.parse(l)).filter((l) => l.outcome === "no-deployment-id")).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "board-feed.stamp", outcome: "no-deployment-id" });
  });

  it("a slow store is aborted: timeout, and its signal fires", async () => {
    let seen: AbortSignal | null = null;
    const f = stampDeps({ timeoutMs: 20 });
    const store = {
      ...f.deps.store!,
      exists: (_p: string, signal: AbortSignal) => {
        seen = signal;
        return new Promise<boolean>(() => undefined);
      },
    };
    expect(await stampBoardFeed({ ...f.deps, store })).toBe("timeout");
    await vi.waitFor(() => expect(seen!.aborted).toBe(true));
    expect(f.writes()).toEqual([]);
  });

  it("writes nothing outside production (preview, development, unset), in the session or after the close", async () => {
    for (const VERCEL_ENV of ["preview", "development", undefined]) {
      for (const t of ["2026-11-12T14:31:20Z", "2026-11-12T21:05:00Z", "2026-11-13T13:00:00Z"]) {
        let probed = 0;
        const f = stampDeps({ env: { VERCEL_ENV, ALPACA_FEED: "sip" }, now: () => AT(t), probe: async () => (probed++, "ok") });
        expect(await stampBoardFeed(f.deps)).toBe("not-production");
        expect(f.calls).toEqual([]);
        expect(probed).toBe(0);
      }
    }
  });

  it("no stamp before the open, on a weekend or a holiday; the session's last minute is stamped (half-open)", async () => {
    for (const t of ["2026-11-12T14:29:59Z", "2026-11-14T15:00:00Z", "2026-11-26T15:00:00Z"]) {
      const f = stampDeps({ now: () => AT(t) });
      await stampBoardFeed(f.deps);
      expect(f.writes().filter((w) => !w.endsWith("manifest.json"))).toEqual([]);
    }
    const last = stampDeps({ now: () => AT("2026-11-12T20:59:44Z") }); // 15:59:44, before the put cutoff
    expect(await stampBoardFeed(last.deps)).toBe("written");
    expect(last.writes()).toEqual(["create desk/feeds/board/2026-11-12/1559.json"]);
    const half = stampDeps({ now: () => AT("2026-11-27T17:59:00Z") });
    expect(await stampBoardFeed(half.deps)).toBe("written");
    expect(half.writes()).toEqual(["create desk/feeds/board/2026-11-27/1259.json"]);
  });

  it("seals from close + 2 min, once; the close and close + 1 min seal nothing; later runs never overwrite", async () => {
    let now = AT("2026-11-12T20:58:10Z");
    const f = stampDeps({ now: () => now });
    await stampBoardFeed(f.deps);
    now = AT("2026-11-12T20:59:10Z");
    await stampBoardFeed(f.deps);
    const key = "desk/feeds/board/2026-11-12/manifest.json";
    for (const t of ["2026-11-12T21:00:00Z", "2026-11-12T21:01:59Z"]) {
      now = AT(t);
      expect(await stampBoardFeed(f.deps)).toBe("closed");
      expect(f.store.has(key)).toBe(false);
    }
    now = AT("2026-11-12T21:02:00Z");
    expect(await stampBoardFeed(f.deps)).toBe("manifest-written");
    const sealed = f.store.get(key)!;
    expect(JSON.parse(sealed)).toEqual({ v: 1, count: 2, last: bodyHash(f.store.get("desk/feeds/board/2026-11-12/1559.json")!), at: "2026-11-12T21:02:00.000Z" });
    now = AT("2026-11-12T21:30:00Z");
    expect(await stampBoardFeed(f.deps)).toBe("closed");
    expect(await stampBoardFeed({ ...f.deps, store: { ...f.deps.store!, exists: async () => false } })).toBe("closed");
    expect(f.store.get(key)).toBe(sealed);
    const day = await readBoardFeedDay("2026-11-12", f.reader);
    expect(day.nextOpen).toBe(Date.parse("2026-11-13T14:30:00Z"));
    expect(verifyChain(day.bodies, day.manifest, day.nextOpen!)).toEqual({ ok: true, reason: "ok" });
  });

  it("a pre-open run (or a weekend run) seals the previous session when it was left unsealed", async () => {
    const f = stampDeps({ now: () => AT("2026-11-12T20:59:10Z") });
    await stampBoardFeed(f.deps);
    // no run after the close that day; the next morning's 09:00 run seals it
    expect(await stampBoardFeed({ ...f.deps, now: () => AT("2026-11-13T14:00:00Z") })).toBe("manifest-written");
    expect(JSON.parse(f.store.get("desk/feeds/board/2026-11-12/manifest.json")!)).toMatchObject({ count: 1, at: "2026-11-13T14:00:00.000Z" });
    // a Saturday run seals Friday
    const sat = stampDeps({ now: () => AT("2026-11-14T15:00:00Z") });
    expect(await stampBoardFeed(sat.deps)).toBe("manifest-written");
    expect(JSON.parse(sat.store.get("desk/feeds/board/2026-11-13/manifest.json")!)).toMatchObject({ count: 0, last: null });
    // once the next open has passed, the previous day is not sealed any more (in the session the run stamps)
    const g = stampDeps({ now: () => AT("2026-11-13T14:31:00Z") });
    await stampBoardFeed(g.deps);
    expect(g.store.has("desk/feeds/board/2026-11-12/manifest.json")).toBe(false);
    // a half day seals from 13:02
    const half = stampDeps({ now: () => AT("2026-11-27T18:02:00Z") });
    expect(await stampBoardFeed(half.deps)).toBe("manifest-written");
    expect(half.store.has("desk/feeds/board/2026-11-27/manifest.json")).toBe(true);
  });

  it("an iex board stamps iex; a refused setting stamps refused, answered error, with no read made", async () => {
    const iex = stampDeps({ env: { VERCEL_ENV: "production", ALPACA_FEED: "" }, commitSha: null });
    await stampBoardFeed(iex.deps);
    expect(JSON.parse(iex.store.get("desk/feeds/board/2026-11-12/0931.json")!)).toMatchObject({ feed: "iex", answered: "ok", deployment: null, commit: null });
    let probed = 0;
    const bad = stampDeps({ env: { VERCEL_ENV: "production", ALPACA_FEED: "delayed_sip" }, probe: async () => (probed++, "ok") });
    expect(await stampBoardFeed(bad.deps)).toBe("written");
    expect(JSON.parse(bad.store.get("desk/feeds/board/2026-11-12/0931.json")!)).toMatchObject({ feed: "refused", answered: "error" });
    expect(probed).toBe(0);
  });

  it("the probe is handed the stamp's `at`; plan, stale, a throw or a rejection never throw out", async () => {
    let seenAt: Date | null = null;
    const plan = stampDeps({ probe: async (_f, a) => ((seenAt = a), "plan") });
    await stampBoardFeed(plan.deps);
    expect(seenAt!.toISOString()).toBe("2026-11-12T14:31:20.000Z");
    expect(JSON.parse(plan.store.get("desk/feeds/board/2026-11-12/0931.json")!).answered).toBe("plan");
    const stale = stampDeps({ probe: async () => "stale" });
    await stampBoardFeed(stale.deps);
    expect(JSON.parse(stale.store.get("desk/feeds/board/2026-11-12/0931.json")!).answered).toBe("stale");
    const threw = stampDeps({
      probe: () => {
        throw new Error("boom");
      },
    });
    expect(await stampBoardFeed(threw.deps)).toBe("written");
    expect(JSON.parse(threw.store.get("desk/feeds/board/2026-11-12/0931.json")!).answered).toBe("error");
    const rejected = stampDeps({ probe: () => Promise.reject(new Error("boom")) });
    await stampBoardFeed(rejected.deps);
    expect(JSON.parse(rejected.store.get("desk/feeds/board/2026-11-12/0931.json")!).answered).toBe("error");
  });

  it("swallows a Blob failure: one log line, an outcome word, no throw", async () => {
    const f = stampDeps();
    const failing = { ...f.deps.store!, create: () => Promise.reject(Object.assign(new Error("store down"), { name: "BlobServiceNotAvailable" })) };
    expect(await stampBoardFeed({ ...f.deps, store: failing })).toBe("store-failed");
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "board-feed.stamp", outcome: "store-failed", error: "BlobServiceNotAvailable" });
    expect(logged[0]).not.toContain("store down");
    logged = [];
    const clockless = stampDeps({
      now: () => {
        throw new Error("no clock");
      },
    });
    expect(await stampBoardFeed(clockless.deps)).toBe("failed");
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "board-feed.stamp", outcome: "failed" });
  });
});

// The store's latency, which the in-memory tests above cannot see: every call waits `ms` (real timers, kept small).
describe("stampBoardFeed under store latency", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** An in-memory store whose every call takes `ms`, and which counts the calls in flight at once. */
  function slowStore(ms: number, base = new Map<string, string>()) {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow =
      <A extends unknown[], R>(fn: (...a: A) => R) =>
      async (...a: A): Promise<Awaited<R>> => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await sleep(ms);
          return await fn(...a);
        } finally {
          inFlight--;
        }
      };
    let hide: (k: string) => boolean = () => false;
    const store: StampStore = {
      list: slow((prefix: string) => [...base.keys()].filter((k) => k.startsWith(prefix) && !hide(k))),
      read: slow((p: string) => base.get(p) ?? null),
      exists: slow((p: string) => base.has(p)),
      create: slow((p: string, b: string) => {
        if (base.has(p)) throw new PreconditionFailed();
        base.set(p, b);
      }),
    };
    return { store, base, setHide: (h: (k: string) => boolean) => (hide = h), maxInFlight: () => maxInFlight };
  }
  /** A whole session's chained stamps, 09:30 to 15:59, written straight into `base`. */
  function fullDay(base: Map<string, string>, day = "2026-11-12", from = 570, to = 960) {
    let prev: string | null = null;
    for (let m = from; m < to; m++) {
      const t = Date.parse(`${day}T14:30:00Z`) + (m - 570) * MIN + 7_000;
      const body = JSON.stringify({ v: 1, feed: "sip", answered: "ok", at: iso(t), deployment: "dpl_a", commit: null, prev });
      base.set(stampKey(day, m), body);
      prev = bodyHash(body);
    }
  }
  const prod = { VERCEL_ENV: "production", ALPACA_FEED: "sip", VERCEL_DEPLOYMENT_ID: "dpl_a" };

  it("a 390-stamp day seals inside the seal limit at 50 ms a call, reading at most 25 at a time", { timeout: 15_000 }, async () => {
    const slow = slowStore(50);
    fullDay(slow.base);
    const started = Date.now();
    const out = await stampBoardFeed({ env: prod, now: () => AT("2026-11-12T21:02:00Z"), store: slow.store, probe: async () => "ok" });
    const took = Date.now() - started;
    expect(out).toBe("manifest-written");
    expect(took).toBeLessThan(5_000); // well inside SEAL_TIMEOUT_MS (20 s): 390 reads in ~16 rounds of 25
    expect(slow.maxInFlight()).toBeLessThanOrEqual(25);
    const m = JSON.parse(slow.base.get("desk/feeds/board/2026-11-12/manifest.json")!);
    expect(m).toMatchObject({ count: 390, last: bodyHash(slow.base.get("desk/feeds/board/2026-11-12/1559.json")!) });
  });

  it("a listing that drops the last two stamps gives seal-wait, then seals correctly once the listing is complete", { timeout: 15_000 }, async () => {
    const slow = slowStore(10);
    fullDay(slow.base);
    slow.setHide((k) => k.endsWith("1558.json") || k.endsWith("1559.json"));
    const run = () => stampBoardFeed({ env: prod, now: () => AT("2026-11-12T21:02:00Z"), store: slow.store, probe: async () => "ok" });
    expect(await run()).toBe("seal-wait");
    expect(slow.base.has("desk/feeds/board/2026-11-12/manifest.json")).toBe(false);
    slow.setHide(() => false);
    expect(await run()).toBe("manifest-written");
    expect(JSON.parse(slow.base.get("desk/feeds/board/2026-11-12/manifest.json")!)).toMatchObject({
      count: 390,
      last: bodyHash(slow.base.get("desk/feeds/board/2026-11-12/1559.json")!),
    });
  });

  it("after a 20-minute gap, at 200 ms a call, the next stamp is still written within 3 s", { timeout: 15_000 }, async () => {
    const slow = slowStore(200);
    fullDay(slow.base, "2026-11-12", 570, 600); // 09:30 to 09:59, then nothing until 10:20
    const started = Date.now();
    const out = await stampBoardFeed({ env: prod, now: () => AT("2026-11-12T15:20:10Z"), store: slow.store, probe: async () => "ok" }); // 10:20:10
    expect(out).toBe("written");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(JSON.parse(slow.base.get("desk/feeds/board/2026-11-12/1020.json")!).prev).toBe(bodyHash(slow.base.get("desk/feeds/board/2026-11-12/0959.json")!));
  });
});

describe("probeSpy", () => {
  const env = { ALPACA_API_KEY_ID: "test-key-id", ALPACA_API_SECRET_KEY: "test-key-secret", ALPACA_DATA_URL: "https://data.example" };
  const AT0 = AT("2026-11-12T15:00:00Z");
  const tradeAt = (t: string) => ({ symbol: "SPY", trade: { t, p: 680.1, s: 100, x: "V" } });
  const answer = (status: number, body: unknown = {}) => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status }));

  it("reads SPY's latest trade directly on the feed, no-store, with the keys", async () => {
    const f = answer(200, tradeAt("2026-11-12T14:59:58Z"));
    expect(await probeSpy("sip", AT0, env, f as unknown as typeof fetch)).toBe("ok");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://data.example/v2/stocks/SPY/trades/latest?feed=sip");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.headers as Record<string, string>)["APCA-API-KEY-ID"]).toBe("test-key-id");
    const iex = answer(200, tradeAt("2026-11-12T14:59:58Z"));
    await probeSpy("iex", AT0, env, iex as unknown as typeof fetch);
    expect(iex.mock.calls[0]![0]).toBe("https://data.example/v2/stocks/SPY/trades/latest?feed=iex");
  });

  it("ok within 60 s of the stamp's `at`, stale beyond it", async () => {
    const r = (t: string) => probeSpy("sip", AT0, env, answer(200, tradeAt(t)) as unknown as typeof fetch);
    expect(await r("2026-11-12T14:59:00Z")).toBe("ok"); // 60 s
    expect(await r("2026-11-12T14:58:59.999Z")).toBe("stale");
    expect(await r("2026-11-12T15:01:00Z")).toBe("ok");
    expect(await r("2026-11-12T15:01:00.001Z")).toBe("stale");
  });

  it("plan on a 403 for sip (logged once); error on a 403 for iex, any other status, no trade, a network failure or no keys", async () => {
    const f = (status: number, body?: unknown) => answer(status, body) as unknown as typeof fetch;
    expect(await probeSpy("sip", AT0, env, f(403))).toBe("plan");
    expect(await probeSpy("sip", AT0, env, f(403))).toBe("plan");
    expect(logged.filter((l) => l.includes('"outcome":"plan"'))).toHaveLength(1);
    expect(await probeSpy("iex", AT0, env, f(403))).toBe("error");
    expect(await probeSpy("sip", AT0, env, f(401))).toBe("error");
    expect(await probeSpy("sip", AT0, env, f(500))).toBe("error");
    expect(await probeSpy("sip", AT0, env, f(200, {}))).toBe("error");
    expect(await probeSpy("sip", AT0, env, f(200, { trade: { t: "x", p: 1 } }))).toBe("error");
    expect(await probeSpy("sip", AT0, env, f(200, { trade: null }))).toBe("error");
    expect(await probeSpy("sip", AT0, env, (async () => new Response("not json")) as unknown as typeof fetch)).toBe("error");
    expect(await probeSpy("sip", AT0, env, (async () => Promise.reject(new TypeError("network"))) as unknown as typeof fetch)).toBe("error");
    const none = answer(200, tradeAt("2026-11-12T14:59:58Z"));
    expect(await probeSpy("sip", AT0, {}, none as unknown as typeof fetch)).toBe("error");
    expect(none).not.toHaveBeenCalled();
  });

  it("a stamp run leaves fetchQuotes' cache untouched: the next fetchQuotes still goes upstream", async () => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (seen.push(url), new Response(JSON.stringify(tradeAt("2026-11-12T14:31:19Z")), { status: 200 }))),
    );
    resetQuoteCache();
    const f = stampDeps();
    delete f.deps.probe; // the deployed probe
    expect(await stampBoardFeed(f.deps)).toBe("written");
    expect(JSON.parse(f.store.get("desk/feeds/board/2026-11-12/0931.json")!).answered).toBe("ok");
    expect(seen).toEqual(["https://data.example/v2/stocks/SPY/trades/latest?feed=sip"]);
    const upstream = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ SPY: { latestTrade: { t: "2026-11-12T14:31:00Z", p: 680 } } }), { status: 200 }));
    await fetchQuotes(["SPY"], { id: "test-key-id", secret: "test-key-secret" }, AT("2026-11-12T14:31:21Z"), upstream as unknown as typeof fetch, "https://data.example", { feed: "sip" });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]![0]).toContain("/v2/stocks/snapshots");
  });
});

describe("readBoardFeedDay", () => {
  it("reads the day's stamps in key order, skipping and counting malformed ones, with every body, the manifest and the next open", async () => {
    const day = "2026-11-12";
    const stamp = (feed: string, answered = "ok") => JSON.stringify({ v: 1, feed, answered, at: "2026-11-12T14:31:00Z", deployment: null, commit: null, prev: null });
    const manifest = { v: 1, count: 4, last: "c".repeat(64), at: "2026-11-12T21:02:00.000Z" };
    const store = new Map<string, string>([
      [`desk/feeds/board/${day}/0932.json`, stamp("iex", "plan")],
      [`desk/feeds/board/${day}/0931.json`, stamp("sip")],
      [`desk/feeds/board/${day}/0933.json`, "not json"],
      [`desk/feeds/board/${day}/0934.json`, JSON.stringify({ v: 1, feed: "sip" })],
      [`desk/feeds/board/${day}/2499.json`, stamp("sip")],
      [`desk/feeds/board/${day}/notes.txt`, stamp("sip")],
      [`desk/feeds/board/${day}/manifest.json`, JSON.stringify(manifest)],
    ]);
    const seen: string[] = [];
    const got = await readBoardFeedDay(day, {
      list: async (prefix) => (seen.push(prefix), [...store.keys()].filter((k) => k.startsWith(prefix)).map((pathname) => ({ pathname }))),
      read: async (p) => (store.has(p) ? { text: store.get(p)! } : null),
    });
    expect(seen).toEqual([`desk/feeds/board/${day}/`]);
    expect(got.stamps).toEqual([
      { minute: Date.parse("2026-11-12T14:31:00Z"), hhmm: "0931", feed: "sip", answered: "ok", deployment: null, at: "2026-11-12T14:31:00Z" },
      { minute: Date.parse("2026-11-12T14:32:00Z"), hhmm: "0932", feed: "iex", answered: "plan", deployment: null, at: "2026-11-12T14:31:00Z" },
    ]);
    expect(got.malformed).toBe(4);
    expect(got.bodies.map((b) => b.text)).toEqual([stamp("sip"), stamp("iex", "plan"), "not json", JSON.stringify({ v: 1, feed: "sip" })]);
    expect(got.bodies[0]!.minute).toBe(Date.parse("2026-11-12T14:31:00Z"));
    expect(got.manifest).toEqual(manifest);
    expect(got.nextOpen).toBe(Date.parse("2026-11-13T14:30:00Z"));
  });
});
