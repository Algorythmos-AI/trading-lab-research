// The owner's "done for today" flag: the pure document and its day, the route's runner on an in-memory store with
// real etag rules, the alerts' fail-safe read, and the hero once today is done.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreconditionFailed, type StoredText } from "@/lib/blob";
import {
  DESK_FLAGS_PATH,
  EMPTY_FLAGS,
  flagsView,
  isDoneToday,
  markDone,
  nyDay,
  parseDeskFlags,
  parseFlagsView,
  undo,
  UNDO_MS,
  type DeskFlagsDoc,
} from "@/lib/desk-flags";
import { defaultDeps, doneForAlerts, handleDeskFlags, loadFlagsView, MAX_BODY, parseAction, readFlags, resetMemoryFlags, sameOrigin, type DeskFlagsDeps } from "@/lib/desk-flags-run";
import { DONE_LINE, DoneTodayContext, type DoneToday } from "@/components/client/done-today";
import { announceLine, DoneSync, failedLine, NOT_SAVED, type Answer } from "@/lib/done-sync";
import { boardAlt, BoardContext, boardSide, TradeNow, type Board } from "@/components/client/trade-now";
import { BoardChip, GlanceTile } from "@/components/client/focus-glance";
import { NowHero } from "@/components/client/now-hero";
import { focusOptions } from "@/lib/fixture-variants";
import { SCRIPT_ANSWER_LAG_MS, SCRIPT_SYMBOLS, scriptBars, scriptQuote, stepInstant } from "@/lib/fixture-script";
import type { LiveQuote, Options } from "@/lib/options";
import { type BoardInput, boardRows, DONE_ROW_VIEW, DONE_WORD, doneMask, doneMasked, entryPrompt, IN_TRADE_WORD, rowView, spokenChanges } from "@/lib/trade-now";
import { SERVER_SETTLE_MS, type NameState, type NameStateName } from "@/lib/trade-state";
import { stateRows } from "@/lib/desk-eval";
import { pageBody } from "@/lib/desk-shadow-client";
import { StatusRail } from "@/components/client/status-rail";
import { dayFacts, journalLive, railDay, unreadLine, withUnread } from "@/lib/session-timeline";
import { roomAfterStop } from "@/lib/what-if";
import type { ManageView } from "@/lib/trade-manage";
import optionsJson from "./fixtures/options.v1.json";

const at = (iso: string) => new Date(iso);
const doc = (day: string, iso: string): DeskFlagsDoc => ({ v: 1, done: { day, at: iso } });

// ---- the document ------------------------------------------------------------------------------------------------
describe("parseDeskFlags", () => {
  const good = doc("2026-11-10", "2026-11-10T15:00:00.000Z");

  it("reads exactly the document", () => {
    expect(parseDeskFlags(JSON.stringify(good))).toEqual(good);
    expect(parseDeskFlags(JSON.stringify(EMPTY_FLAGS))).toEqual(EMPTY_FLAGS);
  });

  it("returns null for garbage, never throwing", () => {
    const garbage: unknown[] = [
      undefined, null, 1, true, {}, [], "", " ", "null", "1", "true", "[]", '"x"', "{", "{]", "}{", "\u0000", "NaN",
      "{\"v\":1", "x".repeat(5000), JSON.stringify([good]), `${JSON.stringify(good)}x`,
    ];
    for (const g of garbage) expect(parseDeskFlags(g)).toBeNull();
  });

  it("returns null for wrong types", () => {
    const bad = [
      { v: "1", done: null },
      { v: 1, done: false },
      { v: 1, done: "2026-11-10" },
      { v: 1, done: [] },
      { v: 1, done: { day: 20261110, at: "2026-11-10T15:00:00.000Z" } },
      { v: 1, done: { day: "2026-11-10", at: 1_762_786_800_000 } },
      { v: 1, done: { day: "2026-11-10", at: null } },
      { v: 1, done: { day: "10/11/2026", at: "2026-11-10T15:00:00.000Z" } },
      { v: 1, done: { day: "2026-11-10", at: "yesterday" } },
      { v: 1, done: { day: "2026-11-10", at: "2026-11-10T15:00:00+00:00" } },
      { v: 1, done: { day: "2026-13-40", at: "2026-13-40T15:00:00.000Z" } },
      { v: 1, done: { day: "2026-11-10" } },
      { v: 1 },
      { done: null },
    ];
    for (const b of bad) expect(parseDeskFlags(JSON.stringify(b))).toBeNull();
  });

  it("returns null for extra fields, at any level, and never carries one on", () => {
    expect(parseDeskFlags(JSON.stringify({ ...good, alerts: true }))).toBeNull();
    expect(parseDeskFlags(JSON.stringify({ v: 1, done: { ...good.done, by: "phone" } }))).toBeNull();
    expect(parseDeskFlags('{"v":1,"done":null,"__proto__":{"polluted":true}}')).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns null for any other version, future ones included", () => {
    for (const v of [0, 2, 1.5, -1, 99]) expect(parseDeskFlags(JSON.stringify({ ...good, v }))).toBeNull();
  });

  it("returns null for a mark whose day is not the New York day of its own instant", () => {
    // 03:00Z on the 11th is 22:00 on the 10th in New York
    expect(parseDeskFlags(JSON.stringify(doc("2026-11-11", "2026-11-11T03:00:00.000Z")))).toBeNull();
    expect(parseDeskFlags(JSON.stringify(doc("2026-11-10", "2026-11-11T03:00:00.000Z")))).not.toBeNull();
  });

  it("random byte strings never parse", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 500; i++) {
      const s = Array.from({ length: Math.floor(rnd() * 60) }, () => String.fromCharCode(Math.floor(rnd() * 128))).join("");
      expect(() => parseDeskFlags(s)).not.toThrow();
      expect(parseDeskFlags(s)).toBeNull();
    }
  });
});

describe("isDoneToday", () => {
  it("holds until New York midnight and clears at it", () => {
    const d = markDone(EMPTY_FLAGS, at("2026-11-10T15:00:00Z")); // 10:00 EST
    if (!d.ok) throw new Error("mark");
    expect(d.doc.done?.day).toBe("2026-11-10");
    expect(isDoneToday(d.doc, at("2026-11-11T04:59:59Z"))).toBe(true); // 23:59:59 EST
    expect(isDoneToday(d.doc, at("2026-11-11T05:00:00Z"))).toBe(false); // midnight EST
  });

  it("goes by New York's day, never a Sydney clock's", () => {
    // Tuesday 01:30 in Sydney (AEDT) is Monday 09:30 in New York (EST)
    const d = markDone(EMPTY_FLAGS, at("2026-11-09T14:30:00Z"));
    if (!d.ok) throw new Error("mark");
    expect(d.doc.done?.day).toBe("2026-11-09");
    expect(isDoneToday(d.doc, at("2026-11-09T20:59:00Z"))).toBe(true); // Tue 07:59 Sydney, Mon 15:59 NY
    // Tuesday 23:00 in Sydney is still the Sydney day it was set on, but Tuesday 07:00 in New York: a new day
    expect(isDoneToday(d.doc, at("2026-11-10T12:00:00Z"))).toBe(false);
  });

  it("clears over a weekend: Friday's mark is not Saturday's, Sunday's or Monday's", () => {
    const d = markDone(EMPTY_FLAGS, at("2026-11-06T20:00:00Z")); // Fri 15:00 EST
    if (!d.ok) throw new Error("mark");
    for (const t of ["2026-11-07T15:00:00Z", "2026-11-08T15:00:00Z", "2026-11-09T15:00:00Z"]) expect(isDoneToday(d.doc, at(t))).toBe(false);
  });

  it("follows the clock change: midnight is 04:00Z before it and 05:00Z after", () => {
    // Saturday 31 October, EDT; the clocks go back early on Sunday 1 November 2026
    const sat = markDone(EMPTY_FLAGS, at("2026-10-31T20:00:00Z"));
    if (!sat.ok) throw new Error("mark");
    expect(isDoneToday(sat.doc, at("2026-11-01T03:59:00Z"))).toBe(true);
    expect(isDoneToday(sat.doc, at("2026-11-01T04:00:00Z"))).toBe(false);
    // Monday 2 November, EST
    const mon = markDone(EMPTY_FLAGS, at("2026-11-02T14:40:00Z"));
    if (!mon.ok) throw new Error("mark");
    expect(isDoneToday(mon.doc, at("2026-11-03T04:30:00Z"))).toBe(true); // 23:30 EST, a time EDT would call the 3rd
    expect(isDoneToday(mon.doc, at("2026-11-03T05:00:00Z"))).toBe(false);
  });

  it("is false for no document and no mark", () => {
    expect(isDoneToday(null, at("2026-11-10T15:00:00Z"))).toBe(false);
    expect(isDoneToday(EMPTY_FLAGS, at("2026-11-10T15:00:00Z"))).toBe(false);
  });

  it("nyDay is New York's calendar day", () => {
    expect(nyDay(at("2026-11-11T04:59:00Z"))).toBe("2026-11-10");
    expect(nyDay(at("2026-07-01T03:59:00Z"))).toBe("2026-06-30");
  });
});

describe("the undo window", () => {
  const T = Date.parse("2026-11-10T15:00:00.000Z");
  const marked = (() => {
    const d = markDone(EMPTY_FLAGS, new Date(T));
    if (!d.ok) throw new Error("mark");
    return d.doc;
  })();

  it("is 60 seconds", () => expect(UNDO_MS).toBe(60_000));

  it("allows undo at 59 s, not at 60 s or 61 s", () => {
    expect(undo(marked, new Date(T + 59_000))).toEqual({ ok: true, changed: true, doc: EMPTY_FLAGS });
    expect(undo(marked, new Date(T + 59_999)).ok).toBe(true);
    expect(undo(marked, new Date(T + 60_000))).toEqual({ ok: false, reason: "undo-closed" });
    expect(undo(marked, new Date(T + 61_000))).toEqual({ ok: false, reason: "undo-closed" });
  });

  it("has nothing to undo on the next day, or on a day never marked", () => {
    expect(undo(marked, new Date(T + 24 * 3_600_000))).toEqual({ ok: false, reason: "not-done" });
    expect(undo(EMPTY_FLAGS, new Date(T))).toEqual({ ok: false, reason: "not-done" });
  });

  it("the view counts it down and shuts it", () => {
    expect(flagsView(marked, new Date(T + 1_500))).toEqual({ done: true, day: "2026-11-10", at: "2026-11-10T15:00:00.000Z", canUndo: true, undoLeftS: 59 });
    expect(flagsView(marked, new Date(T + 59_000))).toMatchObject({ canUndo: true, undoLeftS: 1 });
    expect(flagsView(marked, new Date(T + 60_000))).toMatchObject({ done: true, canUndo: false, undoLeftS: 0 });
    expect(flagsView(marked, new Date(T + 24 * 3_600_000))).toEqual({ done: false, day: null, at: null, canUndo: false, undoLeftS: 0 });
  });

  it("marking again the same day keeps the first time, so it cannot reopen the window", () => {
    const again = markDone(marked, new Date(T + 120_000));
    expect(again).toEqual({ ok: true, changed: false, doc: marked });
  });

  it("the browser's check of an answer accepts only a view", () => {
    expect(parseFlagsView(flagsView(marked, new Date(T)))).toEqual(flagsView(marked, new Date(T)));
    expect(parseFlagsView({ done: "yes" })).toBeNull();
    expect(parseFlagsView({ done: true, day: null, at: null, canUndo: false, undoLeftS: 0 })).toBeNull();
    expect(parseFlagsView({ done: false, day: null, at: null, canUndo: false, undoLeftS: 999 })).toBeNull();
    expect(parseFlagsView(null)).toBeNull();
  });
});

// ---- the runner --------------------------------------------------------------------------------------------------
const HOST = "lab.example.test";
const URL_ = `https://${HOST}/api/desk/flags`;
const NOW = at("2026-11-10T15:00:00.000Z");

/** An in-memory store with the store's etag rules: ifMatch must match, create-only must find nothing. */
function fakeStore() {
  let seq = 0;
  let cur: StoredText | null = null;
  const hooks: { beforeWrite?: () => void; readFails?: boolean; writeFails?: boolean } = {};
  const reads = vi.fn(async () => {
    if (hooks.readFails) throw new Error("store down");
    return cur ? { ...cur } : null;
  });
  const views = vi.fn(async () => {
    if (hooks.readFails) throw new Error("store down");
    return cur ? { text: cur.text } : null;
  });
  const writes = vi.fn(async (body: string, opts: { ifMatch?: string; createOnly?: boolean }) => {
    hooks.beforeWrite?.();
    if (hooks.writeFails) throw new Error("store down");
    if (opts.createOnly && cur) throw new PreconditionFailed();
    if (opts.ifMatch !== undefined && cur?.etag !== opts.ifMatch) throw new PreconditionFailed();
    cur = { text: body, etag: `"e${++seq}"` };
    return { etag: cur.etag };
  });
  return {
    hooks,
    reads,
    views,
    writes,
    put: (text: string) => {
      cur = { text, etag: `"e${++seq}"` };
    },
    get text() {
      return cur?.text ?? null;
    },
    deps(now: () => Date = () => NOW): DeskFlagsDeps {
      return { readView: views, read: reads, write: writes, now, memory: false };
    },
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `https://${HOST}`, "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const get = (headers: Record<string, string> = {}) => new Request(URL_, { method: "GET", headers });

describe("the route's runner", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    resetMemoryFlags();
  });

  it("GET answers the view, uncached, with no CORS header", async () => {
    const s = fakeStore();
    const res = await handleDeskFlags(get(), s.deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.json()).toEqual({ done: false, day: null, at: null, canUndo: false, undoLeftS: 0, memory: false });
  });

  it("POST done writes the document create-only, then GET reads it back", async () => {
    const s = fakeStore();
    const res = await handleDeskFlags(post({ action: "done" }), s.deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true, day: "2026-11-10", at: NOW.toISOString(), canUndo: true, undoLeftS: 60 });
    expect(s.writes).toHaveBeenCalledWith(JSON.stringify({ v: 1, done: { day: "2026-11-10", at: NOW.toISOString() } }), { createOnly: true });
    const back = await handleDeskFlags(get(), s.deps(() => new Date(NOW.getTime() + 10_000)));
    expect(await back.json()).toMatchObject({ done: true, canUndo: true, undoLeftS: 50 });
  });

  it("POST undo within the window clears it with an ifMatch write; after it, 409 and nothing written", async () => {
    const s = fakeStore();
    await handleDeskFlags(post({ action: "done" }), s.deps());
    const ok = await handleDeskFlags(post({ action: "undo" }), s.deps(() => new Date(NOW.getTime() + 30_000)));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ done: false });
    expect(s.writes.mock.calls[1]![1]).toEqual({ ifMatch: '"e1"' });
    await handleDeskFlags(post({ action: "done" }), s.deps(() => new Date(NOW.getTime() + 40_000)));
    const late = await handleDeskFlags(post({ action: "undo" }), s.deps(() => new Date(NOW.getTime() + 101_000)));
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "undo-closed" });
    expect(s.writes).toHaveBeenCalledTimes(3);
  });

  it("POST done when already done is a no-op that writes nothing", async () => {
    const s = fakeStore();
    s.put(JSON.stringify(doc("2026-11-10", "2026-11-10T14:00:00.000Z")));
    const res = await handleDeskFlags(post({ action: "done" }), s.deps());
    expect(await res.json()).toMatchObject({ done: true, at: "2026-11-10T14:00:00.000Z", canUndo: false });
    expect(s.writes).not.toHaveBeenCalled();
  });

  it("refuses every other method with 405", async () => {
    const s = fakeStore();
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await handleDeskFlags(new Request(URL_, { method }), s.deps());
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(s.reads).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON by its content type", async () => {
    const s = fakeStore();
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", ""]) {
      const res = await handleDeskFlags(post({ action: "done" }, { "content-type": ct }), s.deps());
      expect(res.status).toBe(415);
    }
    expect((await handleDeskFlags(post({ action: "done" }, { "content-type": "application/json; charset=utf-8" }), s.deps())).status).toBe(200);
  });

  it("refuses cross-site requests with 403, before reading anything", async () => {
    const s = fakeStore();
    const cases: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: `https://${HOST}.evil.example` },
      { origin: "null" },
      { origin: "not a url" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: `https://${HOST}`, "sec-fetch-site": "cross-site" },
    ];
    for (const h of cases) {
      const res = await handleDeskFlags(post({ action: "done" }, h), s.deps());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    // no Origin at all, and no Sec-Fetch-Site to vouch for it
    const bare = new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"done"}' });
    expect((await handleDeskFlags(bare, s.deps())).status).toBe(403);
    expect(s.reads).not.toHaveBeenCalled();
    expect(s.writes).not.toHaveBeenCalled();
    // a cross-site read is refused too
    expect((await handleDeskFlags(get({ "sec-fetch-site": "cross-site" }), s.deps())).status).toBe(403);
  });

  it("same origin is the request's own host, by Origin or by Sec-Fetch-Site alone", () => {
    expect(sameOrigin(post({}, { "sec-fetch-site": "" }))).toBe(false);
    const viaSite = new Request(URL_, { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    expect(sameOrigin(viaSite)).toBe(true);
    const viaOrigin = new Request(URL_, { method: "POST", headers: { origin: `https://${HOST}` } });
    expect(sameOrigin(viaOrigin)).toBe(true);
    const otherPort = new Request(URL_, { method: "POST", headers: { origin: `https://${HOST}:8443` } });
    expect(sameOrigin(otherPort)).toBe(false);
  });

  it("refuses an oversize body with 413, declared or not", async () => {
    const s = fakeStore();
    const big = JSON.stringify({ action: "done", pad: "x".repeat(MAX_BODY) });
    expect((await handleDeskFlags(post(big), s.deps())).status).toBe(413);
    expect((await handleDeskFlags(post({ action: "done" }, { "content-length": "100000" }), s.deps())).status).toBe(413);
    expect(s.writes).not.toHaveBeenCalled();
  });

  it("refuses anything but one known action with 400, and echoes none of it", async () => {
    const s = fakeStore();
    const bad = ['{"action":"DONE"}', '{"action":"reset"}', '{"action":"done","day":"2026-11-11"}', "[]", '"done"', "", "{", '{"action":null}', '{"Action":"done"}', '{"action":["done"]}'];
    for (const b of bad) {
      const res = await handleDeskFlags(post(b), s.deps());
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe('{"error":"bad-request"}');
    }
    const odd = await handleDeskFlags(post('{"action":"<script>alert(1)</script>"}'), s.deps());
    expect(await odd.text()).not.toContain("script");
    expect(s.writes).not.toHaveBeenCalled();
    expect(parseAction('{"action":"undo"}')).toBe("undo");
  });

  it("an etag conflict re-reads and re-applies once, then succeeds", async () => {
    const s = fakeStore();
    s.put(JSON.stringify(EMPTY_FLAGS));
    let first = true;
    s.hooks.beforeWrite = () => {
      // the other device's write lands between our read and our write, once
      if (first) {
        first = false;
        s.put(JSON.stringify(EMPTY_FLAGS));
      }
    };
    const res = await handleDeskFlags(post({ action: "done" }), s.deps());
    expect(res.status).toBe(200);
    expect(s.reads).toHaveBeenCalledTimes(2);
    expect(s.writes).toHaveBeenCalledTimes(2);
    expect(parseDeskFlags(s.text!)).toEqual(doc("2026-11-10", NOW.toISOString()));
  });

  it("a conflict where the other device already marked the day done ends done, without a second write", async () => {
    const s = fakeStore();
    s.hooks.beforeWrite = () => {
      s.hooks.beforeWrite = undefined;
      s.put(JSON.stringify(doc("2026-11-10", "2026-11-10T14:59:58.000Z")));
    };
    const res = await handleDeskFlags(post({ action: "done" }), s.deps());
    expect(await res.json()).toMatchObject({ done: true, at: "2026-11-10T14:59:58.000Z" });
    expect(s.writes).toHaveBeenCalledTimes(1);
  });

  it("two conflicts in a row answer 409 and claim nothing saved", async () => {
    const s = fakeStore();
    s.put(JSON.stringify(EMPTY_FLAGS));
    s.hooks.beforeWrite = () => s.put(JSON.stringify(EMPTY_FLAGS));
    const res = await handleDeskFlags(post({ action: "done" }), s.deps());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
    expect(parseDeskFlags(s.text!)).toEqual(EMPTY_FLAGS);
  });

  it("a store read failure is 503 on GET and POST, and nothing is written", async () => {
    const s = fakeStore();
    s.hooks.readFails = true;
    expect((await handleDeskFlags(get(), s.deps())).status).toBe(503);
    const res = await handleDeskFlags(post({ action: "done" }), s.deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "read-failed" });
    expect(s.writes).not.toHaveBeenCalled();
  });

  it("a store write failure is 503 and says nothing was saved", async () => {
    const s = fakeStore();
    s.hooks.writeFails = true;
    const res = await handleDeskFlags(post({ action: "done" }), s.deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "write-failed" });
    expect(s.text).toBeNull();
  });

  it("a stored document that is not this one reads as an error, and a done replaces it", async () => {
    const s = fakeStore();
    s.put('{"v":2,"done":null}');
    expect((await handleDeskFlags(get(), s.deps())).status).toBe(503);
    expect((await handleDeskFlags(post({ action: "undo" }), s.deps())).status).toBe(409);
    expect((await handleDeskFlags(post({ action: "done" }), s.deps())).status).toBe(200);
    expect(parseDeskFlags(s.text!)?.done?.day).toBe("2026-11-10");
  });

  it("in memory (fixture mode, or not production) never calls the store, and says so", async () => {
    const read = vi.fn(async () => {
      throw new Error("must not read");
    });
    const write = vi.fn(async () => {
      throw new Error("must not write");
    });
    const deps: DeskFlagsDeps = { readView: read, read, write, now: () => NOW, memory: true };
    expect(await (await handleDeskFlags(get(), deps)).json()).toMatchObject({ done: false, memory: true });
    expect(await (await handleDeskFlags(post({ action: "done" }), deps)).json()).toMatchObject({ done: true, memory: true });
    expect(await (await handleDeskFlags(get(), deps)).json()).toMatchObject({ done: true, memory: true });
    expect(await loadFlagsView(deps)).toMatchObject({ done: true });
    const later: DeskFlagsDeps = { ...deps, now: () => new Date(NOW.getTime() + 20_000) };
    expect(await (await handleDeskFlags(post({ action: "undo" }), later)).json()).toMatchObject({ done: false, memory: true });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("uses memory unless this is production without fixture mode", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    expect(defaultDeps().memory).toBe(true);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(defaultDeps().memory).toBe(true);
    vi.stubEnv("DASHBOARD_FIXTURE", "1");
    expect(defaultDeps().memory).toBe(true);
    vi.stubEnv("VERCEL_ENV", "production");
    expect(defaultDeps().memory).toBe(false); // production refuses fixture mode
    vi.stubEnv("DASHBOARD_FIXTURE", "");
    expect(defaultDeps().memory).toBe(false);
  });

  it("the path is fixed", () => expect(DESK_FLAGS_PATH).toBe("desk/flags.json"));

  it("GET reads the store once, for display; only a write reads the etag", async () => {
    const s = fakeStore();
    await handleDeskFlags(get(), s.deps());
    await loadFlagsView(s.deps());
    expect(s.views).toHaveBeenCalledTimes(2);
    expect(s.reads).not.toHaveBeenCalled();
    await handleDeskFlags(post({ action: "done" }), s.deps());
    expect(s.reads).toHaveBeenCalledTimes(1);
  });

  it("HEAD answers like GET, with no body", async () => {
    const s = fakeStore();
    const res = await handleDeskFlags(new Request(URL_, { method: "HEAD" }), s.deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("accepts JSON with its charset in any case", async () => {
    const s = fakeStore();
    expect((await handleDeskFlags(post({ action: "done" }, { "content-type": "Application/JSON; Charset=UTF-8" }), s.deps())).status).toBe(200);
    expect((await handleDeskFlags(post({ action: "done" }, { "content-type": "application/json; charset=latin1" }), s.deps())).status).toBe(415);
  });

  it("refuses any request that carries the deployment-protection bypass header, GET and POST", async () => {
    const s = fakeStore();
    const bypass = { "x-vercel-protection-bypass": "publisher-secret" };
    for (const req of [get(bypass), post({ action: "done" }, bypass), post({ action: "undo" }, bypass), new Request(URL_, { method: "HEAD", headers: bypass })]) {
      const res = await handleDeskFlags(req, s.deps());
      expect(res.status).toBe(403);
    }
    expect(s.views).not.toHaveBeenCalled();
    expect(s.reads).not.toHaveBeenCalled();
    expect(s.writes).not.toHaveBeenCalled();
    // memory mode refuses it too
    const mem: DeskFlagsDeps = { ...s.deps(), memory: true };
    expect((await handleDeskFlags(post({ action: "done" }, bypass), mem)).status).toBe(403);
  });
});

describe("doneForAlerts", () => {
  it("counts a failed read as done, so no entry alert goes out", async () => {
    const s = fakeStore();
    s.hooks.readFails = true;
    const r = await readFlags(s.deps());
    expect(r.status).toBe("error");
    expect(doneForAlerts(r, NOW)).toBe(true);
    expect(await loadFlagsView(s.deps())).toBeNull(); // the page says "could not check", not "open"
  });

  it("counts a malformed document as done", async () => {
    const s = fakeStore();
    s.put("{not json");
    expect(doneForAlerts(await readFlags(s.deps()), NOW)).toBe(true);
  });

  it("follows the flag when it was read", async () => {
    const s = fakeStore();
    expect(doneForAlerts(await readFlags(s.deps()), NOW)).toBe(false);
    s.put(JSON.stringify(doc("2026-11-10", "2026-11-10T14:00:00.000Z")));
    expect(doneForAlerts(await readFlags(s.deps()), NOW)).toBe(true);
    expect(doneForAlerts(await readFlags(s.deps()), at("2026-11-11T15:00:00Z"))).toBe(false); // the next day
  });
});

describe("the browser's words", () => {
  const view = (done: boolean) => ({ status: "ok" as const, view: { done, day: done ? "2026-11-10" : null, at: done ? NOW.toISOString() : null, canUndo: false, undoLeftS: 0 } });

  it("announces a change once, and nothing for a read that failed or did not change", () => {
    expect(announceLine(view(false), view(true))).toBe("Today is marked done.");
    expect(announceLine(view(true), view(false))).toBe("Today is open again.");
    expect(announceLine(view(true), view(true))).toBeNull();
    expect(announceLine(view(false), { status: "error" })).toBeNull();
    expect(announceLine({ status: "error" }, view(true))).toBeNull();
  });

  it("a failed write says it did not save", () => {
    expect(failedLine(null)).toBe(NOT_SAVED);
    expect(failedLine("write-failed")).toBe(NOT_SAVED);
    expect(failedLine("undo-closed")).toBe("Undo time has passed. Today stays done.");
  });
});

// ---- the hero once today is done ---------------------------------------------------------------------------------
const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session;
const ITEMS = E.focus!.items;

function atStep(step: number): BoardInput {
  const quotes: Record<string, LiveQuote> = {};
  for (const s of SCRIPT_SYMBOLS) quotes[s] = scriptQuote(s, S, step)!;
  const t = stepInstant(S, step) + SCRIPT_ANSWER_LAG_MS;
  return {
    session: S,
    halfDay: false,
    items: ITEMS,
    tickers: E.tickers,
    quotes,
    trails: {},
    serverBars: Object.fromEntries(ITEMS.map((i) => [i.symbol, scriptBars(i.symbol, S, step)])),
    serverFetchedAt: Object.fromEntries(ITEMS.map((i) => [i.symbol, stepInstant(S, step) + SERVER_SETTLE_MS])),
    now: t + 1_000,
    receivedAt: t,
    dayLimitUsed: false,
    wonToday: false,
  };
}

function board(done: boolean, managed: readonly string[] = ["QQQ"], first?: string): Board {
  const input = atStep(3);
  let rows = boardRows(input, true);
  if (first) rows = [rows.find((r) => r.symbol === first)!, ...rows.filter((r) => r.symbol !== first)];
  const views = managed.map((symbol) => ({ id: `t-${symbol}`, key: `t-${symbol}`, symbol, side: "call", action: "hold", tone: "good", line: "Holding above the stop" }) as unknown as ManageView);
  const held = new Set(managed);
  return {
    on: true,
    session: S,
    halfDay: false,
    items: [...ITEMS].sort((a, b) => a.rank - b.rank),
    ticker: (s) => E.tickers.find((t) => t.symbol === s),
    premarket: {},
    closeDate: E.built_from ?? null,
    ageS: {},
    mode: { kind: "live" } as Board["mode"],
    now: input.now,
    rows,
    states: rows.map((r) => r.state!).filter(Boolean),
    paused: false,
    barsDelayed: false,
    manage: {
      cards: createElement("div", { "data-manage-card": "t1" }, "Stop 600.00"),
      rowExtra: () => null,
      notices: null,
      views,
      provisional: 0,
      journalLive: true,
    } as unknown as Board["manage"],
    notices: [],
    dropNotice: () => undefined,
    log: [],
    spoken: "",
    doneFor: (symbol) => {
      const row = rows.find((r) => r.symbol === symbol);
      return !!row && doneMasked(done, row, held);
    },
    maskFor: (symbol) => {
      const row = rows.find((r) => r.symbol === symbol);
      return row ? doneMask(done, row, held) : null;
    },
  };
}

function flags(done: boolean): DoneToday {
  return {
    read: { status: "ok", view: { done, day: done ? S : null, at: done ? "2026-10-12T14:40:00.000Z" : null, canUndo: false, undoLeftS: 0 } },
    done,
    stale: false,
    busy: false,
    failed: null,
    canUndo: false,
    mark: async () => true,
    undo: async () => true,
    clearFailed: () => undefined,
    setPolling: () => undefined,
  };
}

const draw = (b: Board, d: DoneToday, node: ReactNode) => renderToStaticMarkup(createElement(DoneTodayContext.Provider, { value: d }, createElement(BoardContext.Provider, { value: b }, node)));

describe("the hero once today is done", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the entry call to action while today is open (the case the next test removes)", () => {
    const b = board(false);
    expect(b.rows[0]!.state!.state).toBe("enter_zone");
    const html = draw(b, flags(false), createElement(NowHero));
    expect(html).toContain('data-hero-word="enter_zone"');
    expect(html).toContain("data-hero-tiles");
    expect(html).not.toContain(DONE_LINE);
  });

  it("shows no entry call to action, says the calm line, and keeps the manage word", () => {
    const b = board(true);
    const html = draw(b, flags(true), createElement(NowHero));
    expect(html).toContain(DONE_LINE);
    expect(html).toContain('data-hero-today="done"');
    expect(html).not.toContain("data-hero-word");
    expect(html).not.toContain("data-hero-side");
    expect(html).not.toContain("data-hero-tiles");
    expect(html).not.toContain("data-hero-ticket");
    expect(html).not.toContain("data-hero-checks");
    expect(html).not.toContain("data-hero-cautions");
    expect(html).toContain('data-hero-manage="hold"');
    expect(html).toContain("Holding above the stop");
  });

  it("hides a live alternative's word and side too (SPY's failed break)", () => {
    const open = draw(board(false, [], "SPY"), flags(false), createElement(NowHero));
    expect(open).toContain("FAILED BREAK");
    const html = draw(board(true, [], "SPY"), flags(true), createElement(NowHero));
    expect(html).not.toContain("FAILED BREAK");
    expect(html).not.toContain("data-hero-word");
    expect(html).not.toContain("data-hero-side");
    expect(html).toContain(DONE_LINE);
  });

  it("the board's manage card still renders", () => {
    const html = draw(board(true), flags(true), createElement(TradeNow));
    expect(html).toContain('data-manage-card="t1"');
  });
});

describe("the board, the glance and the ladders once today is done", () => {
  it("the board's entry rows read DONE TODAY, with no entry word, no side and no numbers", () => {
    const open = draw(board(false, []), flags(false), createElement(TradeNow));
    expect(open).toContain('data-board-state="enter_zone"');
    expect(open).toContain("ENTER");
    const html = draw(board(true, []), flags(true), createElement(TradeNow));
    expect(html).not.toContain('data-board-state="enter_zone"');
    expect(html).not.toContain("ENTER");
    expect(html).not.toContain("FAILED BREAK");
    expect(html).not.toContain("data-board-grid");
    expect(html).toContain('data-board-row="QQQ" data-board-state="done"');
    expect(html).toContain('data-board-row="SPY" data-board-state="done"');
    expect(html).toContain(DONE_WORD);
  });

  it("a name in a managed trade reads In a trade once today is done: no entry sentence, no Enter figures, its card as it was", () => {
    const managed = draw(board(true, ["QQQ"]), flags(true), createElement(TradeNow));
    const open = draw(board(false, ["QQQ"]), flags(false), createElement(TradeNow));
    const row = (h: string) => h.slice(h.indexOf('data-board-row="QQQ"'), h.indexOf("</li>", h.indexOf('data-board-row="QQQ"')));
    // Not done: unchanged, the entry with its numbers.
    expect(row(open)).toContain('data-board-state="enter_zone"');
    expect(row(open)).toContain("data-board-grid");
    // Done: the neutral chip, no entry word, no headline, no Enter, Stop or Target.
    expect(row(managed)).toContain('data-board-state="in_trade"');
    expect(row(managed)).toContain(IN_TRADE_WORD);
    expect(row(managed)).not.toContain("ENTER");
    expect(row(managed)).not.toContain("data-board-grid");
    expect(row(managed)).not.toContain(rowView(board(false, ["QQQ"]).rows.find((r) => r.symbol === "QQQ")!.state!).headline);
    // The manage card is drawn exactly as it was.
    const card = (h: string) => h.slice(h.indexOf('data-manage-card="t1"'), h.indexOf("</div>", h.indexOf('data-manage-card="t1"')));
    expect(card(managed)).toBe(card(open));
    expect(card(managed)).toContain("Stop 600.00");
  });

  it("a managed name's glance tile and focus chip read in_trade once done, and their entry state while open", () => {
    const tile = (done: boolean) => draw(board(done, ["QQQ"]), flags(done), createElement(GlanceTile as (p: { symbol: string; children?: ReactNode }) => ReactNode, { symbol: "QQQ" }));
    expect(tile(false)).toContain('data-glance-state="enter_zone"');
    expect(tile(false)).toContain("ENTER");
    expect(tile(true)).toContain('data-glance-state="in_trade"');
    expect(tile(true)).toContain('data-chip-state="in_trade"');
    expect(tile(true)).toContain(IN_TRADE_WORD);
    expect(tile(true)).not.toContain("ENTER");
    expect(doneMask(true, { symbol: "QQQ", state: null }, new Set(["QQQ"]))).toBeNull();
    expect(doneMask(false, board(false, ["QQQ"]).rows[0]!, new Set(["QQQ"]))).toBeNull();
  });

  it("the glance tile and its chip (also the cockpit's) read done, not the entry", () => {
    const tile = (done: boolean) => draw(board(done, []), flags(done), createElement(GlanceTile as (p: { symbol: string; children?: ReactNode }) => ReactNode, { symbol: "QQQ" }));
    expect(tile(false)).toContain('data-glance-state="enter_zone"');
    const html = tile(true);
    expect(html).toContain('data-glance-state="done"');
    expect(html).toContain('data-chip-state="done"');
    expect(html).toContain(DONE_WORD);
    expect(html).not.toContain("ENTER");
    expect(draw(board(true, []), flags(true), createElement(BoardChip, { symbol: "SPY" }))).not.toContain("FAILED BREAK");
  });

  it("the ladders and card strips are told no side and no live alternative", () => {
    const read = (b: Board, symbol: string) => {
      const row = b.rows.find((r) => r.symbol === symbol)!;
      const done = b.doneFor(symbol);
      return { row, view: done ? DONE_ROW_VIEW : rowView(row.state!), paused: false, done, mask: b.maskFor?.(symbol) ?? null };
    };
    expect(boardSide(read(board(false, []), "QQQ"))).toBe("call");
    expect(boardSide(read(board(true, []), "QQQ"))).toBeNull();
    expect(boardAlt(read(board(false, []), "SPY"))).not.toBeNull();
    expect(boardAlt(read(board(true, []), "SPY"))).toBeNull();
    // In a trade with today done: the chip says IN A TRADE, so no strip or ladder points at the entry side either.
    expect(boardSide(read(board(true, ["QQQ"]), "QQQ"))).toBeNull();
    expect(boardSide(read(board(false, ["QQQ"]), "QQQ"))).toBe("call");
  });

  it("entry words are not spoken; other changes still are", () => {
    const rows = boardRows(atStep(3), true).map((r) => r.state!);
    const words = Object.fromEntries(rows.map((s) => [s.symbol, rowView(s).badge.word]));
    const qqq = rows.find((s) => s.symbol === "QQQ")!;
    const aapl = rows.find((s) => s.symbol === "AAPL")!;
    expect(spokenChanges([qqq, aapl], words, false)).toContain("QQQ enter zone");
    const said = spokenChanges([qqq, aapl], words, true);
    expect(said).not.toContain("QQQ");
    expect(said).toContain("AAPL");
    expect(spokenChanges([qqq], words, true)).toBeNull();
  });

  it("an entry prompt is a get-ready, an entry or a live alternative, never a paused row", () => {
    const rows = boardRows(atStep(3), true).map((r) => r.state!);
    expect(entryPrompt(rows.find((s) => s.symbol === "QQQ"))).toBe(true);
    expect(entryPrompt(rows.find((s) => s.symbol === "SPY"))).toBe(true); // plan off, failed break live
    expect(entryPrompt(rows.find((s) => s.symbol === "AAPL"))).toBe(false);
    expect(entryPrompt(boardRows(atStep(2), true)[0]!.state)).toBe(true); // get ready
    expect(entryPrompt({ ...rows[0]!, state: "paused" })).toBe(false);
    expect(entryPrompt(null)).toBe(false);
  });
});

// ---- the browser's copy, on fake timers ---------------------------------------------------------------------------
describe("DoneSync", () => {
  const T0 = Date.parse("2026-11-10T15:00:00.000Z");
  const OPEN = { done: false, day: null, at: null, canUndo: false, undoLeftS: 0 };
  const DONE = (left = 0) => ({ done: true, day: "2026-11-10", at: "2026-11-10T15:00:00.000Z", canUndo: left > 0, undoLeftS: left });
  /** A request whose answer the test hands over when it likes. */
  function pending() {
    let resolve!: (a: Answer) => void;
    const promise = new Promise<Answer>((r) => (resolve = r));
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("a failed mark clears once a later read finds the day done (the other device marked it)", async () => {
    let view: typeof OPEN | ReturnType<typeof DONE> = OPEN;
    const sync = new DoneSync(OPEN, { get: async () => ({ ok: true, view }), post: async () => ({ ok: false, reason: null }), now: () => Date.now() });
    expect(await sync.send("done")).toBe(false);
    expect(sync.getState().failed).toBe(NOT_SAVED);
    await sync.reread(); // still open: the failure stays
    expect(sync.getState().failed).toBe(NOT_SAVED);
    view = DONE(); // the phone marked it
    await sync.reread();
    expect(sync.done).toBe(true);
    expect(sync.getState().failed).toBeNull();
  });

  it("a read that began before a write and answers after it is dropped", async () => {
    const gets = [pending(), pending()];
    let g = 0;
    const sync = new DoneSync(OPEN, { get: () => gets[g++]!.promise, post: async () => ({ ok: true, view: DONE(60) }), now: () => Date.now() });
    const slow = sync.reread(); // starts before the tap
    expect(await sync.send("done")).toBe(true);
    expect(sync.done).toBe(true);
    gets[0]!.resolve({ ok: true, view: OPEN }); // the old answer arrives late
    await slow;
    expect(sync.done).toBe(true);
  });

  it("overlapping reads land in order: an older answer never replaces a newer one", async () => {
    const gets = [pending(), pending()];
    let g = 0;
    const sync = new DoneSync(OPEN, { get: () => gets[g++]!.promise, post: async () => ({ ok: false, reason: null }), now: () => Date.now() });
    const first = sync.reread();
    const second = sync.reread();
    gets[1]!.resolve({ ok: true, view: DONE() });
    await second;
    gets[0]!.resolve({ ok: true, view: OPEN });
    await first;
    expect(sync.done).toBe(true);
  });

  it("a failed poll keeps a known done while its day is New York's day, and only adds the warning", async () => {
    const sync = new DoneSync(DONE(), { get: async () => ({ ok: false, reason: null }), post: async () => ({ ok: false, reason: null }), now: () => Date.now() });
    await sync.reread();
    expect(sync.done).toBe(true);
    expect(sync.state.stale).toBe(true);
    // the next New York day: the kept view is not today's, so the page says it could not check
    vi.setSystemTime(Date.parse("2026-11-11T15:00:00.000Z"));
    await sync.reread();
    expect(sync.done).toBe(false);
    expect(sync.state.read.status).toBe("error");
  });

  it("a failed poll never turns a not-done view into an all-clear: it becomes could-not-check", async () => {
    const sync = new DoneSync(OPEN, { get: async () => ({ ok: false, reason: null }), post: async () => ({ ok: false, reason: null }), now: () => Date.now() });
    await sync.reread();
    expect(sync.state.read.status).toBe("error");
  });

  it("a lost write answer is checked with one read, and the read's truth is shown", async () => {
    const get = vi.fn(async (): Promise<Answer> => ({ ok: true, view: DONE(55) }));
    const sync = new DoneSync(OPEN, { get, post: async () => ({ ok: false, reason: null }), now: () => Date.now() });
    expect(await sync.send("done")).toBe(true); // it had landed
    expect(get).toHaveBeenCalledTimes(1);
    expect(sync.done).toBe(true);
    expect(sync.state.failed).toBeNull();
  });

  it("a write that did not land says it did not save, beside what the read found", async () => {
    const sync = new DoneSync(OPEN, { get: async () => ({ ok: true, view: OPEN }), post: async () => ({ ok: false, reason: "write-failed" }), now: () => Date.now() });
    expect(await sync.send("done")).toBe(false);
    expect(sync.done).toBe(false);
    expect(sync.state.failed).toBe(NOT_SAVED);
  });

  it("an undo answered not-done has landed: not done, and no failure", async () => {
    const get = vi.fn(async (): Promise<Answer> => ({ ok: false, reason: null }));
    const sync = new DoneSync(DONE(30), { get, post: async () => ({ ok: false, reason: "not-done" }), now: () => Date.now() });
    expect(await sync.send("undo")).toBe(true);
    expect(sync.done).toBe(false);
    expect(sync.state.failed).toBeNull();
  });

  it("Undo shows for the server's window, then goes and the flag is read again", async () => {
    const get = vi.fn(async (): Promise<Answer> => ({ ok: true, view: DONE() }));
    const sync = new DoneSync(OPEN, { get, post: async () => ({ ok: true, view: DONE(60) }), now: () => Date.now() });
    sync.subscribe(() => undefined);
    await sync.send("done");
    expect(sync.state.undoUntil).toBe(T0 + 60_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sync.state.undoUntil).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync.state.undoUntil).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    sync.dispose();
  });

  it("announces each change once", async () => {
    const sync = new DoneSync(OPEN, { get: async () => ({ ok: true, view: DONE() }), post: async () => ({ ok: true, view: DONE(60) }), now: () => Date.now() });
    await sync.send("done");
    expect(sync.state.spoken).toBe("Today is marked done.");
    const before = sync.state;
    await sync.reread();
    expect(sync.state.spoken).toBe(before.spoken);
  });
});

const NAME_STATES: readonly NameStateName[] = ["no_trade", "watch", "get_ready", "enter_zone", "plan_off", "missed", "paused"];

describe("today done is display only, and only over entry prompts", () => {
  it("what the page posts to the server's shadow check is the engine's own states, never done or in_trade", () => {
    const b = board(true, ["QQQ"]);
    expect(b.maskFor!("QQQ")).toBe("in_trade");
    expect(b.rows.some((r) => b.maskFor!(r.symbol) === "done")).toBe(true);
    // BoardProvider hands the shadow hook `states`, the rows' own NameStates; the mask lives in the views only.
    const body = JSON.parse(pageBody(Date.parse("2026-10-12T14:32:00Z"), { rows: b.states.flatMap(stateRows), asOf: b.now!, barsDelayed: false }, b.states));
    const posted = [...body.rows, ...body.rows_at_settle] as { symbol: string; state: string }[];
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every((r) => (NAME_STATES as readonly string[]).includes(r.state))).toBe(true);
    expect(posted.some((r) => r.state === "done" || r.state === "in_trade")).toBe(false);
    expect((body.rows_at_settle as { symbol: string; state: string }[]).filter((r) => r.symbol === "QQQ").map((r) => r.state)).toEqual(stateRows(b.rows.find((r) => r.symbol === "QQQ")!.state!).map((r) => r.state));
  });

  it("a managed name keeps its real state unless it asks for an entry", () => {
    const qqq = board(false, ["QQQ"]).rows.find((r) => r.symbol === "QQQ")!;
    const held = new Set(["QQQ"]);
    const as = (state: NameStateName) => ({ symbol: "QQQ", state: { ...qqq.state!, state, alt: null } as NameState });
    for (const st of ["plan_off", "missed", "watch", "no_trade", "paused"] as const) expect(doneMask(true, as(st), held)).toBeNull();
    for (const st of ["get_ready", "enter_zone"] as const) expect(doneMask(true, as(st), held)).toBe("in_trade");
    // A live alternative on a plan that is off is an entry prompt too.
    const spy = board(false, []).rows.find((r) => r.symbol === "SPY")!;
    expect(doneMask(true, spy, new Set(["SPY"]))).toBe("in_trade");
    expect(doneMask(false, as("enter_zone"), held)).toBeNull();
  });
});

describe("journal rows that could not be read (the Options page)", () => {
  const n = new Date("2026-10-12T14:30:00Z");
  const check = { status: "clear" as const, isToday: true, current: true, used: 1, net: -10, openLine: undefined };

  it("the rail says so in the warning style, and no room is said", () => {
    const rail = { ...railDay(withUnread(check, 2)), unread: unreadLine(2) };
    expect(railDay(check).room).not.toBeNull();
    expect(rail.room).toBeNull();
    const html = draw(board(false, []), flags(false), createElement(StatusRail, { day: rail, facts: dayFacts(withUnread(check, 2), n.toISOString(), n) }));
    expect(html).toContain("2 journal rows could not be read: today&#x27;s count and loss may be short; check Webull.");
    expect(html).toMatch(/data-rail-unread[^>]*text-warn/);
    expect(html).not.toContain("data-rail-room");
    expect(unreadLine(0)).toBeNull();
    expect(withUnread(check, 0)).toBe(check);
  });

  it("the hero and the manage card withhold the room as for a journal that is not current", () => {
    const facts = dayFacts(withUnread(check, 1), n.toISOString(), n);
    expect(facts.current).toBe(false);
    expect(journalLive(facts, n.getTime())).toBe(false);
    expect(roomAfterStop({ current: journalLive(facts, n.getTime()), net: facts.net }, 5000).kind).toBe("withheld");
    expect(railDay(withUnread(check, 1)).room).toBeNull(); // the hero's room is the rail's
  });
});
