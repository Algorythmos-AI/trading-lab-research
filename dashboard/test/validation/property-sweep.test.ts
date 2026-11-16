// Validation sweep: test/signal.test.ts's two properties (lines 579-649), copied unchanged, run over many seeds. The
// 5,000-case word property over the seeds in VALIDATION_SEEDS (default "1-40"), and the 600-scene real-gate property
// over VALIDATION_SCENE_SEEDS (default "1-40"). The frozen hashes are mocked to the code's own, as signal.test.ts does.
import { describe, expect, it, vi } from "vitest";
import { type GateId, MARKET_GATES, signalFor, type SignalWordName, signalWord, type WordInput } from "@/lib/signal";
import { allGates, chain, expected, flow, type GateSet, mulberry32, nameBars, nameState, parseSeeds, row, side, signalInput, STATES } from "./harness-scene";

vi.mock("@/lib/signal-freeze", async () => {
  const p = await import("@/lib/signal-params");
  const g = await import("@/lib/signal-version.gen");
  return { FROZEN_PARAMS_HASH: p.paramsHash(), FROZEN_CODE_HASH: g.SIGNAL_CODE_HASH };
});

const SEEDS = parseSeeds(process.env.VALIDATION_SEEDS || "1-40");
const SCENE_SEEDS = parseSeeds(process.env.VALIDATION_SCENE_SEEDS || "1-40");
const CASES = 5_000;
const SCENES = 600;

/** The 5,000-case word property for one seed (signal.test.ts:579-613, with mulberry32(51) replaced by the seed). */
function wordProperty(seed: number): { clean: number; seen: Map<SignalWordName, number> } {
  const r = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const results = [true, true, true, false, null] as const;
  const seen = new Map<SignalWordName, number>();
  let clean = 0;
  for (let i = 0; i < CASES; i++) {
    const s = pick(["call", "put"] as const);
    const x: WordInput =
      r() < 0.25
        ? { side: s, rowState: "enter_zone", sideState: { brokeEarlier: false, gap: false }, gates: allGates(), unusable: [] }
        : (() => {
            const over: GateSet = {};
            for (const id of [...MARKET_GATES, "contract"] as GateId[]) over[id] = pick(results);
            if (r() < 0.1) over.volume = "not_yet";
            return { side: s, rowState: pick(STATES), sideState: { brokeEarlier: r() < 0.15, gap: r() < 0.15 }, gates: allGates(over), unusable: r() < 0.1 ? ["data"] : [], volumeFailedEarlier: r() < 0.05 };
          })();
    const w = signalWord(x);
    seen.set(w.word, (seen.get(w.word) ?? 0) + 1);
    expect(w.word, `seed ${seed} case ${i}`).toBe(expected(x));
    if (w.word === "CALL" || w.word === "PUT") {
      clean++;
      expect(w.word).toBe(s === "call" ? "CALL" : "PUT");
      expect(x.rowState).toBe("enter_zone");
      expect(x.sideState).toEqual({ brokeEarlier: false, gap: false });
      expect(x.unusable).toEqual([]);
      expect(x.volumeFailedEarlier ?? false).toBe(false);
      for (const id of [...MARKET_GATES, "contract"] as GateId[]) expect(x.gates[id].pass).toBe(true);
      expect(w.scoring).toBe("a");
    } else expect(w.scoring).not.toBe("a");
    if (w.word === "WAIT") expect(["get_ready", "enter_zone"]).toContain(x.rowState);
  }
  return { clean, seen };
}

/** The 600-scene real-gate property for one seed (signal.test.ts:615-649, with mulberry32(7) replaced by the seed). */
function sceneProperty(seed: number): Set<SignalWordName> {
  const r = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const words = new Set<SignalWordName>();
  for (let i = 0; i < SCENES; i++) {
    const sd = pick(["call", "put"] as const);
    const st = r() < 0.4 ? "enter_zone" : pick(STATES);
    const clean = r() < 0.3;
    const name = nameState(sd === "call" ? side("call", st === "paused" ? "watch" : st) : side("call", "watch"), sd === "put" ? side("put", st === "paused" ? "watch" : st) : side("put", "watch"), { state: st });
    const v = clean ? 2_000 : pick([1_000, 1_500, 2_000, 3_000]);
    const f = flow(
      {
        feed: clean || r() < 0.9 ? "sip" : "iex",
        names: {
          ...flow({}, { SPY: clean ? (sd === "call" ? "up" : "down") : pick(["up", "down", "range"] as const), QQQ: clean ? (sd === "call" ? "up" : "down") : pick(["up", "down", "range"] as const) }).names,
          AAPL: row(nameBars((k) => (k === 27 ? { v } : k === 29 && !clean && r() < 0.2 ? { h: 102, l: 99 } : {})), { bid: 100.19, ask: clean || r() < 0.8 ? 100.21 : 100.4 }),
        },
      },
      {},
    );
    const c = chain(() => (clean || r() < 0.8 ? {} : { volume: 5 }));
    const x = signalInput(name, { side: sd, flow: f, chain: c, flowAgeMs: clean || r() < 0.9 ? 500 : 30_000 });
    const sig = signalFor(x)!;
    words.add(sig.word);
    if (sig.word === "CALL" || sig.word === "PUT") {
      expect(sig.rowState, `seed ${seed} scene ${i}`).toBe("enter_zone");
      for (const id of [...MARKET_GATES, "contract"] as GateId[]) expect(sig.gates[id].pass).toBe(true);
      expect(f.feed).toBe("sip");
    }
  }
  return words;
}

describe("property sweep", () => {
  it(`word property: ${SEEDS.length} seeds × ${CASES} cases = ${SEEDS.length * CASES} cases`, { timeout: 600_000 }, () => {
    // Proves signal.ts:398-445 (signalWord) matches section 1 as written apart (expected()) on every seed, not just 51.
    for (const seed of SEEDS) {
      const { clean, seen } = wordProperty(seed);
      expect(clean, `seed ${seed}`).toBeGreaterThanOrEqual(1_000);
      for (const wd of ["CALL", "PUT", "WAIT", "NO TRADE"] as const) expect(seen.get(wd) ?? 0, `seed ${seed} ${wd}`).toBeGreaterThan(100);
    }
  });

  it(`real-gate property: ${SCENE_SEEDS.length} seeds × ${SCENES} scenes = ${SCENE_SEEDS.length * SCENES} scenes`, { timeout: 600_000 }, () => {
    // Proves signal.ts:485-503 (signalFor through the real gates): CALL/PUT only on a clean enter zone with SIP, every seed.
    for (const seed of SCENE_SEEDS) {
      const words = sceneProperty(seed);
      expect(words.has("CALL") || words.has("PUT"), `seed ${seed}`).toBe(true);
      expect(words.has("NO TRADE"), `seed ${seed}`).toBe(true);
    }
  });
});
