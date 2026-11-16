// Validation of determinism: the same inputs give byte-identical signal records (signal-run.ts buildSignalRecord) and
// identical words (signal.ts signalWord / signalFor) whatever the order keys were inserted in, and every slot of a full
// session is filed under its own path, slot, day and focus names. The frozen hashes are mocked to the code's own (as
// test/signal.test.ts does) so CALL, PUT and WAIT occur among the words compared.
import { describe, expect, it, vi } from "vitest";
import { fixtureChain } from "@/lib/chain-route";
import { expectedSlots, nyHhmm } from "@/lib/desk-eval";
import { type GateId, MARKET_GATES, signalFor, signalWord, type WordInput } from "@/lib/signal";
import { parseSignalRecord, signalLogPath } from "@/lib/signal-record";
import { type BuildInput, buildSignalRecord, runSignalStep } from "@/lib/signal-run";
import { deskRun, FOCUS, flowAt, RUN_AT, S, signalDeps, signalKeys, storeWith } from "./harness-pipeline";
import { allGates, chain, flow, type GateSet, mulberry32, nameBars, nameState, row, side, signalInput, STATES } from "./harness-scene";

vi.mock("@/lib/signal-freeze", async () => {
  const p = await import("@/lib/signal-params");
  const g = await import("@/lib/signal-version.gen");
  return { FROZEN_PARAMS_HASH: p.paramsHash(), FROZEN_CODE_HASH: g.SIGNAL_CODE_HASH };
});

/** A deep copy whose every object has its keys inserted in a shuffled order (arrays keep their order). */
function shuffled<T>(v: T, r: () => number): T {
  if (Array.isArray(v)) return v.map((x) => shuffled(x, r)) as T;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v as object);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = shuffled((v as Record<string, unknown>)[k], r);
    return out as T;
  }
  return v;
}

/** Where two strings first differ, with some context on each side. */
const firstDiff = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: want …${a.slice(Math.max(0, i - 80), i + 80)}… got …${b.slice(Math.max(0, i - 80), i + 80)}…`;
};

describe("buildSignalRecord: the same inputs give the same bytes", () => {
  it.each(["dry", "log"] as const)("%s: 200 builds with shuffled key insertion order are byte-identical", { timeout: 30_000 }, async (mode) => {
    // Proves signal-run.ts:373-536 is pure and its output order is fixed by its own literals, not by its inputs' key order.
    const store = storeWith();
    const { logged } = await deskRun(store);
    const syms = [...new Set([...FOCUS, "SPY", "QQQ"])];
    const chains = Object.fromEntries(await Promise.all(FOCUS.map(async (s) => [s, { chain: await fixtureChain(s, new Date(RUN_AT + 3_000), false, null, "opra"), receivedAt: RUN_AT + 3_000 }] as const)));
    const input: BuildInput = {
      mode,
      switch: mode,
      logged: logged!,
      evaluatedAt: RUN_AT + 3_100,
      stamp: { stamp: { key: `desk/feeds/board/${S}/1031.json`, feed: "sip", answered: "ok", at: new Date(RUN_AT - 500).toISOString() }, usable: true },
      flow: flowAt(syms, RUN_AT + 2_500),
      flowWhy: null,
      chains,
      history: { breaks: [{ symbol: "AAPL", side: "call", broke_at: new Date(RUN_AT - 300_000).toISOString(), confirmed_at: null, occ: null, volume_failed_at: null }], from: null, usable: mode === "log" },
    };
    const want = JSON.stringify(buildSignalRecord(input));
    const r = mulberry32(2026);
    let same = 0;
    let diff: string | null = null;
    for (let i = 0; i < 200; i++) {
      const got = JSON.stringify(buildSignalRecord(shuffled(input, r)));
      if (got === want) same++;
      else diff ??= firstDiff(want, got);
    }
    expect({ same, diff }).toEqual({ same: 200, diff: null });
  });
});

describe("signalWord and signalFor: the same inputs give the same word", () => {
  it("signalWord: 10,000 random inputs, each answered identically on a key-shuffled copy", () => {
    // Proves signal.ts:398-445 depends on its inputs' values only.
    const r = mulberry32(99);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const results = [true, true, true, false, null] as const;
    for (let i = 0; i < 10_000; i++) {
      const over: GateSet = {};
      for (const id of [...MARKET_GATES, "contract"] as GateId[]) over[id] = pick(results);
      if (r() < 0.1) over.volume = "not_yet";
      const x: WordInput = { side: pick(["call", "put"] as const), rowState: pick(STATES), sideState: { brokeEarlier: r() < 0.15, gap: r() < 0.15 }, gates: allGates(over), unusable: r() < 0.1 ? ["data"] : [], volumeFailedEarlier: r() < 0.05 };
      expect(JSON.stringify(signalWord(shuffled(x, r))), `case ${i}`).toBe(JSON.stringify(signalWord(x)));
    }
  });

  it("signalFor: 2,000 random scenes × 5 calls (10,000 calls) on key-shuffled copies are identical", { timeout: 120_000 }, () => {
    // Proves signal.ts:485-503 (the real gates included) depends on its inputs' values only.
    const r = mulberry32(7_007);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    for (let i = 0; i < 2_000; i++) {
      const sd = pick(["call", "put"] as const);
      const st = r() < 0.4 ? "enter_zone" : pick(STATES);
      const name = nameState(sd === "call" ? side("call", st === "paused" ? "watch" : st) : side("call", "watch"), sd === "put" ? side("put", st === "paused" ? "watch" : st) : side("put", "watch"), { state: st });
      const f = flow(
        { names: { ...flow({}, { SPY: pick(["up", "down", "range"] as const), QQQ: pick(["up", "down", "range"] as const) }).names, AAPL: row(nameBars((k) => (k === 27 ? { v: pick([1_000, 1_500, 2_000, 3_000]) } : {})), { ask: pick([100.21, 100.4]) }) } },
        {},
      );
      const x = signalInput(name, { side: sd, flow: f, chain: chain(() => (r() < 0.8 ? {} : { volume: 5 })), flowAgeMs: pick([500, 30_000]) });
      const want = JSON.stringify(signalFor(x));
      for (let k = 0; k < 4; k++) expect(JSON.stringify(signalFor(shuffled(x, r))), `scene ${i} call ${k + 2}`).toBe(want);
    }
  });
});

describe("every slot of a full session is filed under its own path, slot, day and names", () => {
  it(`all ${expectedSlots(S).length} slots of ${S}: the dry record's key, slot_end, session, DEC-0044 key and names`, { timeout: 300_000 }, async () => {
    // Proves signal-run.ts:612 (path = signalLogPath(day, slot.end)), :391/:399 and the blind (:381, names ⊆ focus).
    const slots = expectedSlots(S);
    expect(slots).toHaveLength(194);
    for (const end of slots) {
      const store = storeWith("dry");
      const run = end + 61_000;
      const { logged, outcome } = await deskRun(store, run);
      expect(outcome, nyHhmm(end)).toBe("logged");
      expect(await runSignalStep(logged, signalDeps(store, { at: run + 3_000 }).deps), nyHhmm(end)).toBe("written");
      const keys = signalKeys(store);
      expect(keys, nyHhmm(end)).toEqual([signalLogPath(S, end)]);
      const rec = parseSignalRecord(store.get(keys[0]!)!)!;
      expect(rec.mode).toBe("dry");
      expect(rec.session).toBe(S);
      expect(rec.slot_end).toBe(new Date(end).toISOString());
      expect(rec.dec0044.key).toBe(`desk/log/${S}/${nyHhmm(end)}.json`);
      expect(keys[0]!.endsWith(`/${nyHhmm(end)}.json`)).toBe(true);
      const names = rec.names.map((n) => n.symbol);
      expect(names.every((s) => FOCUS.includes(s)), nyHhmm(end)).toBe(true);
      expect(names).toEqual(FOCUS);
    }
  });
});
