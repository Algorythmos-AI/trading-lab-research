// DEC-0051 section 8's engine identity check over the last logged sessions: the half the fixtures cannot give.
// The steps are in docs/runbooks/engine-identity-sessions.md. Two parts:
// - always (CI): the collector's rules and the replay's own parts are tested on synthetic inputs, and a commit's
//   extracted engine is proved to be the running one (the fixture morning gives the same states through both);
// - only with IDENTITY_BUNDLE set (a folder the collector wrote) and IDENTITY_ENGINES (two or more git refs, oldest
//   first, e.g. origin/main,origin/integration): every logged slot is run through each engine and the counts printed.
//   It prints counts, labels and state words only; the slots and names that differ go to a report file in that folder,
//   which is private and never committed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type EvalInput, evaluateSlotStates, serverRecord } from "@/lib/desk-eval";
import { editionCopyText } from "@/lib/edition-copy";
import { ENGINE_VERSION } from "@/lib/engine-version.gen";
import type { LiveQuote } from "@/lib/options";
import type { NameState } from "@/lib/trade-state";
import { evalCases } from "../guards-off-cases";
// @ts-expect-error: a plain .mjs script, no types
import * as collect from "../../scripts/identity-collect.mjs";
import {
  addSlot,
  buildInput,
  changedFiles,
  type CollectedSession,
  differs,
  dropEngines,
  editionFor,
  emptyPair,
  type Engine,
  type EngineRun,
  loadEngine,
  nameKey,
  readBundle,
  reportLines,
  rowKeys,
  withDayLimit,
} from "./identity-sessions";

const C = collect as {
  outsideRepo(out: string, root?: string): boolean;
  realOut(p: string): string;
  isServerRecordPath(p: string): boolean;
  logDays(folders: string[], until?: string | null): string[];
  nyInstant(day: string, minutes: number): number;
  focusSymbolsOf(edition: unknown): string[];
  feedOf(env: Record<string, string | undefined>): string;
  REPO_ROOT: string;
};
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
vi.setConfig({ testTimeout: 600_000 });

describe("the collector's rules", () => {
  it("writes only outside the repo", () => {
    expect(C.outsideRepo("/tmp/identity", "/Users/x/trading")).toBe(true);
    expect(C.outsideRepo("/Users/x/trading-identity", "/Users/x/trading")).toBe(true);
    expect(C.outsideRepo("/Users/x/trading/var/identity", "/Users/x/trading")).toBe(false);
    expect(C.outsideRepo("/Users/x/trading", "/Users/x/trading")).toBe(false);
    expect(C.outsideRepo(join(C.REPO_ROOT, "dashboard", "x"))).toBe(false);
    // a symlink into the repo is followed before the check
    const tmp = mkdtempSync(join(tmpdir(), "identity-out-"));
    try {
      symlinkSync(C.REPO_ROOT, join(tmp, "link"));
      expect(C.outsideRepo(C.realOut(join(tmp, "link", "new-folder")), realpathSync(C.REPO_ROOT))).toBe(false);
      expect(C.outsideRepo(C.realOut(join(tmp, "plain")), realpathSync(C.REPO_ROOT))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads server records only, never the page's, and picks days in order up to --until", () => {
    expect(C.isServerRecordPath("desk/log/2026-11-16/1030.json")).toBe(true);
    expect(C.isServerRecordPath("desk/log/2026-11-16/1030.page.json")).toBe(false);
    expect(C.isServerRecordPath("desk/log/2026-11-16/signal/1030.json")).toBe(false);
    const folders = ["desk/log/2026-11-13/", "desk/log/2026-11-16/", "desk/log/2026-11-12/", "desk/log/x/"];
    expect(C.logDays(folders)).toEqual(["2026-11-12", "2026-11-13", "2026-11-16"]);
    expect(C.logDays(folders, "2026-11-13")).toEqual(["2026-11-12", "2026-11-13"]);
  });

  it("puts 09:30 New York at the right instant either side of a clock change", () => {
    expect(new Date(C.nyInstant("2026-11-16", 570)).toISOString()).toBe("2026-11-16T14:30:00.000Z");
    expect(new Date(C.nyInstant("2026-07-01", 570)).toISOString()).toBe("2026-07-01T13:30:00.000Z");
    expect(new Date(C.nyInstant("2026-11-02", 960)).toISOString()).toBe("2026-11-02T21:00:00.000Z");
  });

  it("asks for an explicit feed, and only plain tickers", () => {
    expect(C.feedOf({ ALPACA_FEED: "sip" })).toBe("sip");
    expect(() => C.feedOf({})).toThrow();
    expect(() => C.feedOf({ ALPACA_FEED: "delayed_sip" })).toThrow();
    expect(C.focusSymbolsOf({ focus: { items: [{ symbol: "QQQ" }, { symbol: "BRK.B" }, { symbol: "../x" }, {}] } })).toEqual(["QQQ", "BRK.B"]);
  });

  it("only lists and reads the store: no write, copy or delete", () => {
    const src = readFileSync(fileURLToPath(new URL("../../scripts/identity-collect.mjs", import.meta.url)), "utf8");
    expect(src).toMatch(/blob\.list\(/);
    expect(src).toMatch(/blob\.get\(/);
    expect(src).not.toMatch(/blob\.(put|del|copy|head)\b|\b(put|del|copy)\(/);
    expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });
});

/** The eval cases as a collected session would hold them: a record, an edition copy and raw bars. */
function asCollected(c: { id: string; input: EvalInput; evaluatedAt: number }): { session: CollectedSession; record: string; original: EvalInput } {
  // The snapshot's high and low are not kept by a record: the original gives none either, so the two inputs match.
  const snapshots: Record<string, LiveQuote> = Object.fromEntries(Object.entries(c.input.snapshots).map(([s, q]) => [s, { ...q, high: null, low: null }]));
  const original: EvalInput = { ...c.input, snapshots, fetchedAt: Object.fromEntries(Object.keys(c.input.bars).map((s) => [s, c.input.slot.end + 3_600_000])) };
  const { evaluation } = evaluateSlotStates(original);
  const rec = serverRecord(evaluation, original.slot, c.evaluatedAt, original.edition) as unknown as Record<string, unknown>;
  const probe = { v: 1, phase: "regular", rate_limit: null, rate_remaining: null, names: Object.entries(snapshots).map(([symbol, q]) => ({ symbol, source: "fetched", trade_age_s: (c.evaluatedAt - Date.parse(q.at)) / 1000 })) };
  const record = JSON.stringify({ ...rec, feed: "sip", probe, guards: null, http_429: 0 });
  const raw = Object.fromEntries(Object.entries(c.input.bars).map(([s, bars]) => [s, bars.map((b) => ({ t: new Date(b.start).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c }))]));
  const copy = editionCopyText("2026-10-01T12:00:00.000Z", original.slot.day, "run-1", JSON.stringify(original.edition));
  return { session: { day: original.slot.day, records: [{ name: "x.json", text: record }], copies: [{ name: "c.json", text: copy }], bars: { feed: "sip", bars: raw } }, record, original };
}

describe("the replay's parts", () => {
  it("rebuilds every fixture slot's input from what a record and the store keep: the same states and rows", () => {
    let n = 0;
    for (const c of evalCases()) {
      const { session, record, original } = asCollected(c);
      const built = buildInput(record, session);
      expect("skip" in built ? built.skip : null, c.id).toBeNull();
      if ("skip" in built) continue;
      const a = evaluateSlotStates(original);
      const b = evaluateSlotStates(built.input);
      expect(b.evaluation, c.id).toEqual(a.evaluation);
      expect(b.states.map(nameKey), c.id).toEqual(a.states.map(nameKey));
      expect(built.loggedRows, c.id).toEqual(rowKeys(a.evaluation));
      expect(built.engine).toBe(ENGINE_VERSION);
      n++;
    }
    expect(n).toBe(evalCases().length);
  });

  it("skips, and says why, a slot whose edition the store did not keep", () => {
    const c = evalCases()[0]!;
    const { session, record } = asCollected(c);
    expect(buildInput(record, { ...session, copies: [] })).toEqual({ skip: "edition-not-kept" });
    expect(buildInput(JSON.stringify({ ...JSON.parse(record), edition_as_of: null }), session)).toEqual({ skip: "no-edition" });
    expect(buildInput("{", session)).toEqual({ skip: "unreadable-record" });
  });

  it("counts a side's state, brokeAt and card changes, and nothing when the two runs agree", () => {
    const side = (state: string, brokeAt: number | null) => ({ state, brokeAt }) as unknown as NameState["call"];
    const name = (callState: string, brokeAt: number | null, entry: number) =>
      ({ symbol: "ZZZ", state: callState, call: side(callState, brokeAt), put: side("watch", null), plan: { level: 1, entry, stop: 0.5, target1: 2, target2: null } }) as unknown as NameState;
    const run = (s: NameState): EngineRun => ({ evaluation: { status: "ok", reason: null, board: "live", rows: [{ symbol: "ZZZ", side: "call", state: s.state, bar_end: "" }], degraded_names: [], snapshot_ok: true, day: {} } as never, states: [s] });
    const same = emptyPair("e-a", "e-b");
    addSlot(same, "d/1030", run(name("enter_zone", 1, 1)), run(name("enter_zone", 1, 1)));
    expect(differs(same)).toBe(false);
    expect(reportLines(same)[0]).toBe("e-a → e-b: no, no row differs");
    const p = emptyPair("e-a", "e-b");
    addSlot(p, "d/1030", run(name("enter_zone", 1, 1)), run(name("get_ready", 1, 1)));
    addSlot(p, "d/1032", run(name("enter_zone", 1, 1)), run(name("enter_zone", 2, 1.1)));
    expect(differs(p)).toBe(true);
    expect(p).toMatchObject({ slots: 2, names: 2, namesDiffer: 2, sideStateDiffer: 1, brokeAtDiffer: 1, cardDiffer: 1, rowsDiffer: 2, transitions: { "enter_zone → get_ready": 1 } });
    expect(reportLines(p).join("\n")).not.toContain("ZZZ");
  });

  it("takes, of several copies of one edition, the latest received by the record's time; skips another feed or day", () => {
    const c = evalCases()[0]!;
    const { session, record } = asCollected(c);
    const r = JSON.parse(record) as Record<string, unknown>;
    const ed = JSON.parse(JSON.stringify(c.input.edition)) as Record<string, unknown>;
    const copy = (at: string, tag: string) => ({ name: `${at}.json`, text: editionCopyText(at, c.input.slot.day, "r", JSON.stringify({ ...ed, tag })) });
    const evaluated = Date.parse(r.evaluated_at as string);
    const iso = (d: number) => new Date(evaluated + d).toISOString();
    const copies = [copy(iso(-60_000), "early"), copy(iso(-1_000), "last-before"), copy(iso(60_000), "after")];
    expect((editionFor(copies, r.edition_as_of, evaluated) as unknown as { tag: string }).tag).toBe("last-before");
    expect(buildInput(JSON.stringify({ ...r, feed: "iex" }), session)).toEqual({ skip: "feed-differs" });
    expect(buildInput(JSON.stringify({ ...r, edition_session: "2001-01-02" }), session)).toEqual({ skip: "wrong-day-edition" });
  });

  it("without the probe, a name's last trade is left to settledQuote's own rule; a time near the slot's end is counted", () => {
    const c = evalCases().find((x) => Object.keys(x.input.snapshots).length > 0)!;
    const { session, record } = asCollected(c);
    const r = JSON.parse(record) as Record<string, unknown>;
    const built = buildInput(JSON.stringify({ ...r, probe: null }), session);
    if ("skip" in built) throw new Error(built.skip);
    expect(built.tradeFromProbe).toBe(0);
    for (const q of Object.values(built.input.snapshots)) expect(Date.parse(q.at)).toBeGreaterThanOrEqual(c.input.slot.end);
    const end = c.input.slot.end;
    const sym = Object.keys(built.input.snapshots)[0]!;
    const near = { ...r, evaluated_at: new Date(end + 2_000).toISOString(), probe: { names: [{ symbol: sym, source: "fetched", trade_age_s: 1 }] } };
    const b2 = buildInput(JSON.stringify(near), session);
    if ("skip" in b2) throw new Error(b2.skip);
    expect(b2.tradeTimeUncertain).toBe(1);
  });

  it("applies the record's day limit as the board does: every row no trade, a paused one kept", () => {
    const rows = ["ZZZ/call/enter_zone", "ZZZ/put/missed", "YYY/call/paused", "YYY/put/no_trade"];
    expect(withDayLimit(rows, false)).toEqual(rows);
    expect(withDayLimit(rows, true)).toEqual(["ZZZ/call/no_trade", "ZZZ/put/no_trade", "YYY/call/paused", "YYY/put/no_trade"]);
  });

  it("counts the differing names in a slot with the day's limit used apart, and says so", () => {
    const st = (state: string) => ({ symbol: "ZZZ", state, call: { state, brokeAt: null }, put: null, plan: null }) as unknown as NameState;
    const run = (s: NameState): EngineRun => ({ evaluation: { status: "ok", rows: [{ symbol: "ZZZ", side: "call", state: s.state, bar_end: "" }] } as never, states: [s] });
    const p = emptyPair("e-a", "e-b");
    addSlot(p, "d/1300", run(st("missed")), run(st("watch")), true);
    addSlot(p, "d/1030", run(st("enter_zone")), run(st("get_ready")));
    expect(p).toMatchObject({ namesDiffer: 2, namesDifferDayLimit: 1 });
    expect(reportLines(p)[1]).toContain("in slots with the day's limit used, where the board drew no trade: 1");
  });

  it("compares a name listed twice twice, and rows as a multiset", () => {
    const st = (state: string) => ({ symbol: "ZZZ", state, call: { state, brokeAt: null }, put: null, plan: null }) as unknown as NameState;
    const run = (states: NameState[], rows: string[]): EngineRun => ({ evaluation: { status: "ok", rows: rows.map((s) => ({ symbol: "ZZZ", side: "call", state: s, bar_end: "" })) } as never, states });
    const p = emptyPair("e-a", "e-b");
    addSlot(p, "d/1030", run([st("watch"), st("watch")], ["watch", "watch"]), run([st("watch"), st("get_ready")], ["watch", "get_ready"]));
    expect(p).toMatchObject({ names: 2, namesDiffer: 1, rowsDiffer: 2 });
  });

  // Only when src/lib is as committed: the extracted HEAD is then the running code (an engine edit not yet committed
  // would move the label and fail here for no fault of the loader).
  const libDirty = (() => {
    try {
      execFileSync("git", ["-C", REPO, "diff", "--quiet", "HEAD", "--", "dashboard/src/lib"]);
      return false;
    } catch {
      return true;
    }
  })();
  it.skipIf(libDirty)("a commit's extracted engine is the running one, as its own module: same label, same states on every fixture slot", async () => {
    const e = await loadEngine("HEAD", REPO);
    try {
      expect(e.label).toBe(ENGINE_VERSION);
      expect(e.evaluateSlotStates).not.toBe(evaluateSlotStates);
      for (const c of evalCases()) {
        const input = JSON.parse(JSON.stringify(c.input)) as EvalInput;
        const a = evaluateSlotStates(input);
        const b = e.evaluateSlotStates(input);
        expect(b.evaluation, c.id).toEqual(a.evaluation);
        expect(b.states.map(nameKey), c.id).toEqual(a.states.map(nameKey));
      }
    } finally {
      dropEngines([e]);
    }
    expect(existsSync(e.dir)).toBe(false);
  });
});

const BUNDLE = process.env.IDENTITY_BUNDLE;
const REFS = (process.env.IDENTITY_ENGINES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

describe.skipIf(!BUNDLE)("the last logged sessions through each engine (DEC-0051 section 8)", () => {
  it("runs every logged slot through each engine and prints the counts", async () => {
    expect(REFS.length, "IDENTITY_ENGINES: two or more git refs, oldest first").toBeGreaterThanOrEqual(2);
    expect(changedFiles(BUNDLE!), "the collected files are as the collector wrote them").toEqual([]);
    const engines: (Engine & { dir: string })[] = [];
    try {
      for (const ref of REFS) engines.push(await loadEngine(ref, REPO));
      run(engines);
    } finally {
      dropEngines(engines);
    }
  });
});

function run(engines: Engine[]): void {
  {
    expect(new Set(engines.map((e) => e.label)).size, "each engine is a different label").toBe(engines.length);

    const sessions = readBundle(BUNDLE!);
    const pairs = engines.slice(1).map((e, i) => emptyPair(engines[i]!.label, e.label));
    const whole = engines.length > 2 ? emptyPair(engines[0]!.label, engines[engines.length - 1]!.label) : null;
    const skips: Record<string, number> = {};
    const loggedEngines: Record<string, number> = {};
    const fidelity = { checked: 0, same: 0, sameWithoutDayLimit: 0 };
    let replayed = 0;
    let dayLimit = 0;
    let fromProbe = 0;
    let uncertain = 0;
    let guardsOn = 0;
    for (const s of sessions) {
      for (const r of s.records) {
        const built = buildInput(r.text, s);
        if ("skip" in built) {
          skips[built.skip] = (skips[built.skip] ?? 0) + 1;
          continue;
        }
        replayed++;
        loggedEngines[built.engine] = (loggedEngines[built.engine] ?? 0) + 1;
        if (built.dayLimitUsed) dayLimit++;
        fromProbe += built.tradeFromProbe;
        uncertain += built.tradeTimeUncertain;
        if (built.guardsOn) guardsOn++;
        const at = `${s.day}/${r.name.replace(/\.json$/, "")}`;
        const runs = engines.map((e) => e.evaluateSlotStates(JSON.parse(JSON.stringify(built.input)) as EvalInput));
        pairs.forEach((p, i) => addSlot(p, at, runs[i]!, runs[i + 1]!, built.dayLimitUsed));
        if (whole) addSlot(whole, at, runs[0]!, runs[runs.length - 1]!, built.dayLimitUsed);
        if (built.engine === engines[0]!.label && built.loggedStatus === "ok") {
          fidelity.checked++;
          const rebuilt = rowKeys(runs[0]!.evaluation);
          // As a multiset, as the pairs compare rows: the board orders its rows by state, so the ungated rebuild can
          // order the same no-trade rows differently.
          const set = (xs: readonly string[]) => JSON.stringify([...xs].sort());
          if (set(withDayLimit(rebuilt, built.dayLimitUsed)) === set(built.loggedRows)) fidelity.same++;
          if (JSON.stringify(rebuilt) === JSON.stringify(built.loggedRows)) fidelity.sameWithoutDayLimit++;
        }
      }
    }
    const lines = [
      "Engine identity check over logged sessions",
      `sessions ${sessions.length} (${sessions[0]?.day ?? "none"} to ${sessions[sessions.length - 1]?.day ?? "none"}); slots replayed ${replayed}; skipped ${JSON.stringify(skips)}`,
      `engines: ${engines.map((e) => `${e.label} (${e.ref} ${e.sha.slice(0, 8)})`).join(", ")}`,
      `records written under: ${JSON.stringify(loggedEngines)}`,
      ...pairs.flatMap(reportLines),
      ...(whole ? reportLines(whole) : []),
      `inputs check: ${engines[0]!.label} rebuilt the rows it logged in ${fidelity.same} of ${fidelity.checked} ok slots it wrote, with the record's day limit applied, rows as a set (${fidelity.sameWithoutDayLimit} without the limit, in order); slots with the day's limit used ${dayLimit}; last trade times from the probe ${fromProbe}, of which either side of the slot's end ${uncertain}`,
      `not exercised here: the journal's day flags, the bad-data guards' pauses (slots with a guard on: ${guardsOn}), the snapshot's own high and low; the answer counts rows only (not the evaluation's status or degraded names)`,
    ];
    process.stdout.write(`\n${lines.join("\n")}\n\n`);
    const report = { at: new Date().toISOString(), engines: engines.map(({ ref, sha, label }) => ({ ref, sha, label })), sessions: sessions.map((x) => x.day), replayed, skips, loggedEngines, fidelity, dayLimit, fromProbe, uncertain, guardsOn, pairs, whole };
    writeFileSync(join(BUNDLE!, `identity-report-${engines[0]!.label}-${engines[engines.length - 1]!.label}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
    expect(replayed).toBeGreaterThan(0);
  }
}
