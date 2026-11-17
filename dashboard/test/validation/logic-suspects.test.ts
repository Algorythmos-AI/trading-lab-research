// Validation of suspected logic faults in the signal's pure functions (trade-state.ts, signal.ts, signal-run.ts's
// record builder, contract-pick.ts), each tested for the INTENDED behaviour: a failure is a finding. The last block is
// characterisation only (owner decisions) and must pass.
//
// The frozen hashes are mocked to the code's own (as test/signal.test.ts does, as Amendment 1 would set them), so a
// word past "not usable" can be reached; with the real null hashes every word is NO TRADE and the faults are masked.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ChainResponse } from "@/lib/chain";
import { pickContract } from "@/lib/contract-pick";
import type { DeskLogRecord, LoggedSlot } from "@/lib/desk-run";
import type { NameStats } from "@/lib/flow";
import { SLOT_MS } from "@/lib/flow";
import type { ServerFlow } from "@/lib/flow-route";
import type { SidePlan } from "@/lib/focus-plan";
import type { LiveQuote, Options } from "@/lib/options";
import { gates, signalFor, type SlotRecord } from "@/lib/signal";
import { SIGNAL_PARAMS } from "@/lib/signal-params";
import type { LogSignalRecord } from "@/lib/signal-record";
import { buildSignalRecord, HISTORY_UNUSABLE } from "@/lib/signal-run";
import { doneMask } from "@/lib/trade-now";
import { atr2m, type Bar2, type Bars2m, CLOSE_GRACE_MS, sideState } from "@/lib/trade-state";
import { AS_OF, chain, DAY, edition, flow, gateInput, iso, NOW, nameState, OPEN, record, row, side, signalInput, SLOT, withAapl, nameBars } from "./harness-scene";

vi.mock("@/lib/signal-freeze", async () => {
  const p = await import("@/lib/signal-params");
  const g = await import("@/lib/signal-version.gen");
  return { FROZEN_PARAMS_HASH: p.paramsHash(), FROZEN_CODE_HASH: g.SIGNAL_CODE_HASH };
});

// ---- a. the retest touch, on its edge ------------------------------------------------------------------------------
// DEC-0052: the touch is the clone's (setups.retest): a bar's low (high, for a put) within RETEST_WITHIN_ATR (1.0) of the
// 2-minute ATR from the level, compared in floating point exactly as the clone writes it, `dip <= 1.0 * atr`. The
// exact ten-thousandths comparison of the 2026-11-16 defect fix belonged to the old 0.1-daily-ATR touch and is gone with
// it: rounding where the clone does not would make the board and the clone disagree on the edge. The shared vectors
// (test/retest-vectors.test.ts, generated from the clone) hold the two to the same bars.
describe("a. the retest touch at exactly one 2-minute ATR (trade-state.ts, setups.retest)", () => {
  const D = "2026-10-12"; // a Monday on EDT
  const at = (min: number) => Date.parse(`${D}T${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00-04:00`);
  const bar = (min: number, o: number, h: number, l: number, c: number): Bar2 => ({ start: at(min), end: at(min) + 120_000, o, h, l, c });

  /**
   * A break through L at 10:00 after a 09:30 bar and fourteen bars closing at L, a touch bar at 10:02 whose extreme is `dip` from L,
   * and a bar at 10:04 closing beyond the touch bar's close. Every true range is `atr` (the touch bar's too, for any dip
   * from 0 to `atr`), so the 2-minute ATR at the confirming close is `atr` itself, exactly when `atr` and L are binary
   * fractions. A put is the mirror about L.
   */
  function retest(kind: "call" | "put", L: number, atr: number, dip: number) {
    const s = kind === "call" ? 1 : -1;
    const p = (d: number) => L + s * d; // d: the distance beyond L
    const ohlc = (min: number, o: number, far: number, near: number, c: number) => (s > 0 ? bar(min, p(o), p(far), p(near), p(c)) : bar(min, p(o), p(near), p(far), p(c)));
    const warm = Array.from({ length: 14 }, (_, i) => ohlc(9 * 60 + 32 + 2 * i, -atr, 0, -atr, 0));
    // a 09:30 bar first, so the board has the session from its open (DEC-0053's lockUnseen); it moves no ATR read here
    const closed = [ohlc(9 * 60 + 30, -atr, -atr, -atr, -atr), ...warm, ohlc(10 * 60, 0, atr, 0, atr), ohlc(10 * 60 + 2, atr, dip + atr, dip, atr), ohlc(10 * 60 + 4, atr, 2 * atr, atr, 1.5 * atr)];
    const bars: Bars2m = { closed, partial: null, since: at(9 * 60 + 30), complete: true, missing: [], gaps: 0 };
    const now = new Date(at(10 * 60 + 6) + CLOSE_GRACE_MS);
    const quote = { price: p(1.5 * atr), at: new Date(now.getTime() - 1_000).toISOString(), open: p(-atr), high: Math.max(p(-atr), p(2 * atr)), low: Math.min(p(-atr), p(2 * atr)), day: D, prev_close: null, vwap: null } as LiveQuote;
    const plan: SidePlan = { side: kind, level: L, levelName: "test", entry: L, stop: p(-1), target1: p(5), target2: null };
    return { state: sideState(plan, 4, bars, quote, now, atr2m(closed)), atr: atr2m(closed)! };
  }

  it("control: a dip clearly inside one 2-minute ATR is enter_zone, one clearly outside is get_ready", () => {
    // Proves the scene reaches the confirmed retest at all, and that the band is the 2-minute ATR, not 0.1 daily ATR.
    for (const kind of ["call", "put"] as const) {
      expect(retest(kind, 100, 0.25, 0.125).state.state).toBe("enter_zone");
      expect(retest(kind, 100, 0.25, 0.375).state.state).toBe("get_ready");
    }
  });

  it.each(["call", "put"] as const)("%s: a dip of exactly one 2-minute ATR is a touch (dip <= 1.0 * atr), a hair more is not", (kind) => {
    const edge = retest(kind, 100, 0.25, 0.25);
    expect(edge.atr).toBe(0.25);
    expect(edge.state.state).toBe("enter_zone");
    expect(retest(kind, 100, 0.25, 0.25 + 2 ** -20).state.state).toBe("get_ready");
  });
});

// ---- the log record's scene: one clean AAPL call break on 2026-11-12 ------------------------------------------------
function serverFlowOf(): ServerFlow {
  const f = flow();
  const names: ServerFlow["names"] = Object.fromEntries(Object.entries(f.names).map(([k, r]) => [k, { ...r, bid_size: 5, ask_size: 5, day_volume: null }]));
  return {
    as_of: f.as_of,
    feed: "sip",
    baseline: { v: 2, for_session: DAY, built_at: iso(OPEN - 3_600_000), feed: "sip", sessions: Array.from({ length: 20 }, (_, i) => `s${i}`), built_for: Object.keys(f.names), names: f.baseline!.names as Record<string, NameStats> },
    names,
    missing: [],
  };
}

function loggedSlot(): LoggedSlot {
  const st = nameState(side("call", "enter_zone"));
  const rec = { ...record(st), reason: null, evaluated_at: iso(SLOT + 5_000) } as unknown as DeskLogRecord;
  return { path: `desk/log/${DAY}/1030.json`, body: JSON.stringify(rec), record: rec, slot: { day: DAY, end: SLOT }, edition: edition() as unknown as Options, states: [st] };
}

function logRecord(historyUsable: boolean, ch: ChainResponse = chain(), evaluatedAt = NOW + 500, receivedAt = NOW + 500): LogSignalRecord {
  return buildSignalRecord({
    mode: "log",
    switch: "log",
    logged: loggedSlot(),
    evaluatedAt,
    stamp: { stamp: { key: "k", feed: "sip", answered: "ok", at: iso(SLOT + 4_000) }, usable: true },
    flow: serverFlowOf(),
    flowWhy: null,
    chains: { AAPL: { chain: ch, receivedAt } },
    history: { breaks: [], from: null, usable: historyUsable },
  }) as LogSignalRecord;
}

// ---- b. history not usable -----------------------------------------------------------------------------------------
describe("b. a slot whose history cannot be read in full never carries CALL or PUT", () => {
  it("control: with the history usable, the scene's call side reads CALL", () => {
    // Proves the scene reaches signal-run.ts:451-483 with a CALL from signalFor.
    expect(logRecord(true).names[0]!.sides[0]!.word).toBe("CALL");
  });

  it("with HISTORY_UNUSABLE among the reasons, the stored word is NO TRADE", () => {
    // Proves signal-run.ts:466-477: HISTORY_UNUSABLE is pushed onto `unusable` after signalFor chose the word, and the
    // stored `word` is s.word unchanged (only `scoring` becomes not_usable), contradicting signal.ts:428.
    const s = logRecord(false).names[0]!.sides[0]!;
    expect(s.unusable).toContain(HISTORY_UNUSABLE);
    expect(s.word).toBe("NO TRADE");
  });
});

// ---- c. the chain's checked age ------------------------------------------------------------------------------------
describe("c. the contract's checked age is DEC-0051's: the chain's newest quote against when it was served", () => {
  // CORRECTED. This case first expected the age to count from when the chain was served (option-value.ts
  // checkedAgeMs, as the comment at signal.ts:108 says). That expectation was wrong: DEC-0051 section 2 (accepted,
  // research/decisions/DEC-0051-desk-signal-words.md:172-177) defines the checked age as the chain's newest quote,
  // across all strikes, against when the answer was served (contract.ts chainAge), plus the time since it arrived. The
  // code was right; the signal.ts comment is what is wrong, and it is handled separately.
  it("served 10:30:00, newest quote 10:29:45, received just now: checked age ≈ 15 s, so the 10 s check fails", () => {
    const served = SLOT; // 10:30:00 New York
    const ch = chain((c) => ({ ...c, at: iso(served - 15_000) }), { as_of: iso(served), served_at: iso(served) });
    const rec = logRecord(true, ch, served, served);
    const aapl = rec.names[0]!;
    expect(aapl.chain!.checked_age_ms).toBe(15_000);
    const quoteCheck = aapl.sides[0]!.gates.contract.value.candidates[0]!.checks.find((k) => k.id === "quote")!;
    expect(quoteCheck).toMatchObject({ pass: false });
    expect(aapl.sides[0]!.gates.contract.pass).not.toBe(true);
  });

  it("control: the newest quote 5 s before serving, received just now: checked age ≈ 5 s, inside the 10 s check", () => {
    const served = SLOT;
    const ch = chain((c) => ({ ...c, at: iso(served - 5_000) }), { as_of: iso(served), served_at: iso(served) });
    const aapl = logRecord(true, ch, served, served).names[0]!;
    expect(aapl.chain!.checked_age_ms).toBe(5_000);
    expect(aapl.sides[0]!.gates.contract.value.candidates[0]!.checks.find((k) => k.id === "quote")).toMatchObject({ pass: true });
  });
});

// ---- d. one absurd candidate ---------------------------------------------------------------------------------------
describe("d. one absurd candidate does not wipe out the pick", () => {
  it("fixed 2026-11-16 (pre-dry defect fix): the nearest strike's ask is 1e300: it fails, and a good strike further out is still picked", () => {
    // Was KNOWN OPEN: sizeTicket (ticket.ts) throws RangeError on a non-safe-integer price, and the throw was caught by
    // pickContract as "no-chain" for the whole side. contract-pick.ts now fails that strike's premium check only.
    const control = pickContract({ symbol: "AAPL", kind: "call", spot: 100.2, chain: chain(), checkedAgeMs: 1_000, today: DAY });
    expect(control.picked?.strike).toBe(100);
    const p = pickContract({ symbol: "AAPL", kind: "call", spot: 100.2, chain: chain((c) => (c.kind === "call" && c.strike === 100 ? { ask: 1e300 } : {})), checkedAgeMs: 1_000, today: DAY });
    expect(p.why).not.toBe("no-chain");
    expect(p.candidates[0]).toMatchObject({ strike: 100, pass: false });
    expect(p.picked).not.toBeNull();
    expect(p.picked!.strike).not.toBe(100);
  });
});

// ---- e. the parameters against the record ----------------------------------------------------------------------------
describe("e. parameter sync with EXP-0034's config.yaml", () => {
  const CONFIG = fileURLToPath(new URL("../../../research/experiments/EXP-0034-desk-signal-gates/config.yaml", import.meta.url));
  /** The `parameters:` block's top-level keys, read the same way test/signal-params.test.ts reads it. */
  function parametersBlock(text: string): Record<string, string | number> {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^parameters:/.test(l));
    if (start < 0) throw new Error("no parameters block");
    const out: Record<string, string | number> = {};
    for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]!); i++) {
      const m = /^ {2}([a-z_]+):\s*(.*?)\s*(?:#.*)?$/.exec(lines[i]!);
      if (!m) continue;
      const [, key, raw] = m;
      if (raw === ">-") {
        const parts: string[] = [];
        while (i + 1 < lines.length && /^ {4}\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
        out[key!] = parts.join(" ");
      } else if (raw !== "") out[key!] = /^-?\d+(\.\d+)?$/.test(raw!) ? Number(raw) : raw!;
    }
    return out;
  }
  it("contract_quote_stamp_max_age_s in the config equals the code's 60 s", () => {
    // Proves signal-params.ts's contract_quote_stamp_max_age_s matches the record (signal-params.test.ts does not check it).
    const p = parametersBlock(readFileSync(CONFIG, "utf8"));
    expect(p.contract_quote_stamp_max_age_s).toBe(60);
    expect(SIGNAL_PARAMS.contract_quote_stamp_max_age_s).toBe(p.contract_quote_stamp_max_age_s);
  });
});

// ---- f. impossible ages ----------------------------------------------------------------------------------------------
describe("f. the stock bid–ask gate on impossible ages", () => {
  it.fails("KNOWN OPEN: negative quote age passes (owner decision): a quote stamped after the answer's as_of: not available or a fail, never a silent pass", () => {
    // Proves signal.ts:176: Math.max(0, asOf − quoteAt) turns a quote from the future into age flowAgeMs, and it passes.
    const g = gates(gateInput({ flow: withAapl(row(nameBars(), { quote_at: iso(NOW + 30_000) })) }))!;
    expect(g.stock_bid_ask.pass).not.toBe(true);
  });
  it.fails("KNOWN OPEN: negative quote age passes (owner decision): a negative flowAgeMs: not available or a fail, never a silent pass", () => {
    // Proves signal.ts:176/180: a negative checked age is ≤ STALE_MS and is read as fresh.
    const g = gates(gateInput({ flowAgeMs: -30_000 }))!;
    expect(g.stock_bid_ask.pass).not.toBe(true);
  });
});

// ---- g. the lifecycle's window -------------------------------------------------------------------------------------
// Removed: this case called signal.ts slotsLeft directly with the flow's as_of (+125 s). Superseded: the record writer
// (signal-run.ts buildSignalRecord) now passes slot end + CLOSE_GRACE_MS, as the board does; the record-level proof
// (an answer at +125 s inside the slot still reads "confirmed", not "weakening") is in fixes.test.ts.

// ---- h. characterisation (owner decisions): must pass ---------------------------------------------------------------
describe("h. characterisation, owner decisions", () => {
  it("owner decision: a broken rule today and 'done for today' do not gate the word (trade-now.ts:439)", () => {
    // Owner decision. Only rules 7 and 8 ending the day (boardDay's dayLimitUsed, trade-now.ts:439) change the board's
    // state; the record's break_today and done flags never reach signalFor, and doneMask only hides the row's prompt.
    const st = nameState(side("call", "enter_zone"));
    const withFlags = { ...record(st), day: { break_today: true, done: true, day_limit_used: false } } as unknown as SlotRecord;
    expect(signalFor(signalInput(st, { record: withFlags }))!.word).toBe("CALL");
    expect(doneMask(true, { symbol: "AAPL", state: st } as never, new Set())).toBe("done");
    expect(st.state).toBe("enter_zone");
  });

  it("owner decision: a 09:34 break bar reads volume not available (signal.ts:162)", () => {
    // Owner decision. "Before 09:35" is judged on the break bar's start: 09:34-09:36 is not available, never a pass.
    const g = gates(gateInput({ sideState: { brokeAt: OPEN + 3 * SLOT_MS } }))!;
    expect(g.volume).toMatchObject({ pass: null, notYet: false });
    expect(g.volume.why).toMatch(/before 09:35/);
    expect(AS_OF).toBe(iso(NOW));
  });
});
