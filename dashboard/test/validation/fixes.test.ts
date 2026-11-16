// The fixes to the DEC-0051 dry-run pipeline (signal-run.ts, desk-run.ts) that the audit's tests do not pin on their
// own: a DEC-0044 put that lands late with a read-back, a signal put that lands late holding another writer's bytes,
// the slot on every desk-signal line, the log record from another slot's flow, the lifecycle counted at the slot, and
// the record-level reasons for reads that failed. Frozen hashes are mocked to the code's own (as logic-suspects does)
// so a CALL can be reached.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreconditionFailed } from "@/lib/blob";
import type { DeskLogRecord, LoggedSlot } from "@/lib/desk-run";
import type { NameStats } from "@/lib/flow";
import type { ServerFlow } from "@/lib/flow-route";
import type { Options } from "@/lib/options";
import { SLOT_MS } from "@/lib/flow";
import { type FlowInput, lifecycle } from "@/lib/signal";
import { type LogSignalRecord, signalLogPath } from "@/lib/signal-record";
import { buildSignalRecord, FLOW_OTHER_SLOT, HISTORY_UNREAD, runSignalStep, STAMPS_UNREAD } from "@/lib/signal-run";
import { deskRun, E, RUN_AT, S, signalDeps, signalOf, SLOT, storeWith } from "./harness-pipeline";
import { BROKE_AT, chain, DAY, edition, flow, iso, NOW, nameBars, nameState, OPEN, record, row, side, SLOT as SCENE_SLOT, withAapl } from "./harness-scene";

vi.mock("@/lib/signal-freeze", async () => {
  const p = await import("@/lib/signal-params");
  const g = await import("@/lib/signal-version.gen");
  return { FROZEN_PARAMS_HASH: p.paramsHash(), FROZEN_CODE_HASH: g.SIGNAL_CODE_HASH };
});
const events = vi.hoisted(() => [] as { evt: string; fields: Record<string, unknown> }[]);
vi.mock("@/lib/log", () => ({
  logEvent: (evt: string, fields: Record<string, unknown> = {}) => {
    events.push({ evt, fields });
  },
}));

const FAKE = { toFake: ["Date", "setTimeout", "clearTimeout"] as ("Date" | "setTimeout" | "clearTimeout")[] };
const drive = async <T,>(p: Promise<T>, ms = 10_000): Promise<T> => {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
};
beforeEach(() => {
  events.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a DEC-0044 put that lands after its limit", () => {
  const late = (store: Map<string, string>, body?: string) => async (p: string, b: string) => {
    if (store.has(p)) throw new PreconditionFailed();
    store.set(p, body ?? b);
    await new Promise((r) => setTimeout(r, 2_000));
  };

  it("read back with this run's bytes: logged late, handed over, and the signal step writes the slot", async () => {
    const store = storeWith("dry");
    vi.useFakeTimers(FAKE);
    const r = await drive(deskRun(store, RUN_AT, E, { write: late(store), read: async (p) => store.get(p) ?? null }));
    expect(r.outcome).toBe("logged");
    expect(r.logged).not.toBeNull();
    expect(events.some((e) => e.evt === "desk-eval" && e.fields.outcome === "logged-late")).toBe(true);
    vi.useRealTimers();
    expect(await runSignalStep(r.logged, signalDeps(store).deps)).toBe("written");
    expect(signalOf(store)!.dec0044.key).toBe(`desk/log/${S}/1030.json`);
  });

  it("read back with another writer's bytes: already-logged, nothing handed over", async () => {
    const store = storeWith("dry");
    vi.useFakeTimers(FAKE);
    const r = await drive(deskRun(store, RUN_AT, E, { write: late(store, "{}"), read: async (p) => store.get(p) ?? null }));
    expect(r).toEqual({ logged: null, outcome: "already-logged" });
  });

  it("not there after it: write-failed, and a desk-signal line names the slot", async () => {
    const store = storeWith("dry");
    const r = await deskRun(store, RUN_AT, E, { write: () => Promise.reject(new Error("store 503")), read: async () => null });
    expect(r).toEqual({ logged: null, outcome: "write-failed" });
    expect(events).toContainEqual({ evt: "desk-signal", fields: { outcome: "no-handover", slot: "1030", why: "dec0044-write-failed" } });
  });
});

describe("a signal put that lands after its limit", () => {
  it("our exact bytes read back after the write timed out: written, logged as landed late", async () => {
    const store = storeWith("dry");
    const { logged } = await deskRun(store);
    vi.useFakeTimers(FAKE);
    const { deps } = signalDeps(store, {
      write: async (p, b) => {
        store.set(p, b);
        await new Promise((r) => setTimeout(r, 1_500));
      },
    });
    expect(await drive(runSignalStep(logged, deps))).toBe("written");
    expect(signalOf(store)!.mode).toBe("dry");
    expect(events.find((e) => e.evt === "desk-signal" && e.fields.outcome === "written")?.fields).toMatchObject({ slot: "1030", landed: "late" });
  });

  it("holding another writer's bytes: exists, never written", async () => {
    const store = storeWith("dry");
    const { logged } = await deskRun(store);
    vi.useFakeTimers(FAKE);
    const { deps } = signalDeps(store, {
      write: async (p) => {
        store.set(p, "raced");
        await new Promise((r) => setTimeout(r, 1_500));
      },
    });
    expect(await drive(runSignalStep(logged, deps))).toBe("exists");
    expect(store.get(signalLogPath(S, SLOT))).toBe("raced");
    expect(events.find((e) => e.evt === "desk-signal" && e.fields.outcome === "exists")?.fields).toMatchObject({ slot: "1030", landed: "late" });
  });
});

describe("the step's log lines", () => {
  it("every desk-signal line carries the slot, and a switched-off step logs off", async () => {
    for (const mode of ["off", "dry"]) {
      events.length = 0;
      const store = storeWith(mode);
      const { logged } = await deskRun(store);
      await runSignalStep(logged, signalDeps(store).deps);
      const lines = events.filter((e) => e.evt.startsWith("desk-signal"));
      expect(lines.length, mode).toBeGreaterThan(0);
      expect(lines.every((e) => e.fields.slot === "1030"), mode).toBe(true);
      if (mode === "off") expect(lines).toContainEqual({ evt: "desk-signal", fields: { outcome: "off", slot: "1030" } });
    }
  });
});

// ---- the log record's scene: a clean AAPL call break on 2026-11-12, as logic-suspects builds it ---------------------
function serverFlowOf(asOf = flow().as_of, f = flow()): ServerFlow {
  // The quotes one second before the answer, as a live answer's are.
  const at = iso(Date.parse(asOf) - 1_000);
  const names: ServerFlow["names"] = Object.fromEntries(Object.entries(f.names).map(([k, r]) => [k, { ...r, trade_at: at, quote_at: at, bid_size: 5, ask_size: 5, day_volume: null }]));
  return {
    as_of: asOf,
    feed: "sip",
    baseline: { v: 2, for_session: DAY, built_at: iso(OPEN - 3_600_000), feed: "sip", sessions: Array.from({ length: 20 }, (_, i) => `s${i}`), built_for: Object.keys(f.names), names: f.baseline!.names as Record<string, NameStats> },
    names,
    missing: [],
  };
}
function loggedSlot(brokeAt = BROKE_AT): LoggedSlot {
  const st = nameState(side("call", "enter_zone", { brokeAt }));
  const rec = { ...record(st), reason: null, evaluated_at: iso(SCENE_SLOT + 5_000) } as unknown as DeskLogRecord;
  return { path: `desk/log/${DAY}/1030.json`, body: JSON.stringify(rec), record: rec, slot: { day: DAY, end: SCENE_SLOT }, edition: edition() as unknown as Options, states: [st] };
}
// A failed read gives only what runSignalStep then holds: no stamp (not usable), or a history that is not usable.
const build = (mode: "dry" | "log", asOf?: string, extra: { stampsFailed?: boolean; failed?: boolean; brokeAt?: number; flow?: FlowInput } = {}) =>
  buildSignalRecord({
    mode,
    switch: mode,
    logged: loggedSlot(extra.brokeAt),
    evaluatedAt: NOW + 500,
    stamp: extra.stampsFailed ? { stamp: null, usable: false } : { stamp: { key: "k", feed: "sip", answered: "ok", at: iso(SCENE_SLOT + 4_000) }, usable: true },
    flow: serverFlowOf(asOf, extra.flow),
    flowWhy: null,
    chains: { AAPL: { chain: chain(), receivedAt: NOW + 500 } },
    history: extra.failed ? { breaks: [], from: null, usable: false, failed: true } : { breaks: [], from: null, usable: true },
    ...(extra.stampsFailed ? { stampsFailed: true } : {}),
  });
const logRecord = (asOf?: string, extra: Parameters<typeof build>[2] = {}) => build("log", asOf, extra) as LogSignalRecord;

describe("the log record", () => {
  it("control: the scene's call side reads CALL, confirmed, with nothing unusable", () => {
    const r = logRecord();
    expect(r.unusable).toEqual([]);
    expect(r.names[0]!.sides[0]).toMatchObject({ word: "CALL", scoring: "a", lifecycle: "confirmed" });
    expect(r.breaks).toEqual([{ symbol: "AAPL", side: "call", broke_at: iso(BROKE_AT), confirmed_at: iso(SCENE_SLOT), occ: r.names[0]!.sides[0]!.gates.contract.value.picked, volume_failed_at: null }]);
  });

  it("a flow answer from another slot: the record and every side say so, the word is NO TRADE and nothing is confirmed", () => {
    const r = logRecord(iso(SCENE_SLOT + 185_000));
    expect(r.unusable).toEqual([FLOW_OTHER_SLOT]);
    const s = r.names[0]!.sides[0]!;
    expect(s.unusable).toContain(FLOW_OTHER_SLOT);
    expect(s).toMatchObject({ word: "NO TRADE", scoring: "not_usable" });
    expect(r.breaks.every((b) => b.confirmed_at === null)).toBe(true);
  });

  it("the lifecycle counts the retest window at the slot (slot end + CLOSE_GRACE_MS), not at the flow's as_of", () => {
    // A break one bar earlier (bar 26), so three slots are left at the slot and two at the bar after it. An answer at
    // slot end + 125 s is still this slot's (settled slot unchanged, nothing flagged), but its forming bar is the next
    // one: read there, the lifecycle would be "weakening"; read at the slot, as the board reads it, "confirmed".
    const brokeAt = BROKE_AT - SLOT_MS;
    const f = withAapl(row(nameBars((k) => (k === 26 ? { v: 2_000 } : k === 27 ? { v: 1_000 } : {}))));
    expect(lifecycle({ session: DAY, symbol: "AAPL", side: "call", brokeAt, rowState: "enter_zone", word: "CALL", slotEnd: SCENE_SLOT, evaluatedAt: SCENE_SLOT + 125_000 }, [])).toBe("weakening");
    for (const off of [90_000, 125_000, 170_000]) {
      const r = logRecord(iso(SCENE_SLOT + off), { brokeAt, flow: f });
      expect(r.unusable, String(off)).toEqual([]);
      expect(r.names[0]!.sides[0], String(off)).toMatchObject({ word: "CALL", lifecycle: "confirmed" });
    }
  });

  it("stamps that could not be read, and earlier records that could not be listed, are named on a log record", () => {
    const st = logRecord(undefined, { stampsFailed: true });
    expect(st.unusable).toEqual([STAMPS_UNREAD]);
    expect(st.names[0]!.sides[0]!.word).toBe("NO TRADE");
    const h = logRecord(undefined, { failed: true });
    expect(h.unusable).toEqual([HISTORY_UNREAD]);
    expect(h.history_usable).toBe(false);
    expect(h.names[0]!.sides[0]!.word).toBe("NO TRADE");
  });

  it("a dry record does not carry them: its gates read neither the stamps nor the carried breaks", () => {
    expect(build("dry", undefined, { stampsFailed: true, failed: true }).unusable).toEqual([]);
  });
});
