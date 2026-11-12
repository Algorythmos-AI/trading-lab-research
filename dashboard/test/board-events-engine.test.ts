// The board's event line is display only (DEC-0042, note of 2026-11-12): the desk's engine never reads it. Two
// proofs. The engine's import closure (the files the engine label hashes) does not hold the line's files. And the
// engine's output for the fixture day is identical whether the calendar lists nothing on that day or a Fed decision,
// a CPI release and an earnings report for every focus name: the engine is loaded twice, once on each calendar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusOptions } from "@/lib/fixture-variants";
import { SCRIPT_ANSWER_LAG_MS, SCRIPT_STEPS, scriptBars, scriptQuote, stepInstant } from "@/lib/fixture-script";
import type { LiveQuote, Options } from "@/lib/options";
import realCalendar from "@/lib/market-calendar.json";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12, a Monday on EDT
const NAMES = E.focus!.items.map((i) => i.symbol);
const QUOTED = [...NAMES, "SMH"];

/** The calendar with events on the fixture's day: a CPI release and a Fed decision inside the session, and every
 * focus name reporting (before the open, during the session and after the close), plus the next morning. */
const busy = structuredClone(realCalendar);
busy.macro.push({ date: S, time_et: "10:00", code: "cpi", quality: "exact" }, { date: S, time_et: "10:30", code: "fomc_decision", quality: "exact" });
busy.earnings.push(
  ...NAMES.map((symbol, i) => ({ date: S, symbol, when: ["bmo", "during", "amc"][i % 3]!, quality: "confirmed" })),
  ...NAMES.map((symbol) => ({ date: "2026-10-13", symbol, when: "bmo", quality: "expected" })),
);

/** The engine's whole output for the fixture day, from a fresh load of its modules on the given calendar. */
async function engineOutput(calendar: unknown): Promise<string> {
  vi.resetModules();
  vi.doMock("@/lib/market-calendar.json", () => ({ default: calendar }));
  const tradeNow = await import("@/lib/trade-now");
  const deskEval = await import("@/lib/desk-eval");
  const { SERVER_SETTLE_MS } = await import("@/lib/trade-state");
  const { boardEvents } = await import("@/lib/board-events");
  const out: unknown[] = [];
  // The calendar really is the one loaded: the line itself sees the busy day, and only on the busy calendar.
  out.push({ line: boardEvents({ session: S, now: stepInstant(S, 0), names: NAMES }).map((e) => e.kind) });
  SCRIPT_STEPS.forEach((_, step) => {
    const quotes: Record<string, LiveQuote> = {};
    for (const s of QUOTED) quotes[s] = scriptQuote(s, S, step)! as LiveQuote;
    const at = stepInstant(S, step) + SCRIPT_ANSWER_LAG_MS;
    const input = {
      session: S,
      halfDay: false,
      items: E.focus!.items,
      tickers: E.tickers,
      quotes,
      trails: {},
      serverBars: Object.fromEntries(NAMES.map((n) => [n, scriptBars(n, S, step)])),
      serverFetchedAt: Object.fromEntries(NAMES.map((n) => [n, stepInstant(S, step) + SERVER_SETTLE_MS])),
      now: at + 1_000,
      receivedAt: at,
      dayLimitUsed: false,
      wonToday: false,
    };
    out.push({ step, mode: tradeNow.boardMode(S, false, "ok", input.now), rows: tradeNow.boardRows(input, true) });
  });
  // The server's evaluation for every settled slot of the script's morning.
  const last = SCRIPT_STEPS.length - 1;
  const lastAt = stepInstant(S, last);
  for (const end of deskEval.expectedSlots(S).filter((x) => x + SERVER_SETTLE_MS <= lastAt)) {
    const runAt = end + SERVER_SETTLE_MS + 1_000;
    out.push(
      deskEval.evaluateSlot({
        slot: { day: S, end },
        edition: E,
        journal: null,
        done: false,
        bars: Object.fromEntries(NAMES.map((n) => [n, scriptBars(n, S, last)])),
        fetchedAt: Object.fromEntries(NAMES.map((n) => [n, runAt])),
        snapshots: Object.fromEntries(QUOTED.map((s) => [s, scriptQuote(s, S, last)! as LiveQuote])),
      }),
    );
  }
  return JSON.stringify(out);
}

afterEach(() => {
  vi.doUnmock("@/lib/market-calendar.json");
  vi.resetModules();
});

describe("the event line is outside the engine", () => {
  it("no file of the line is in the import closure the engine label hashes", async () => {
    // @ts-expect-error: a plain .mjs script, no types
    const gen = (await import("../scripts/gen-engine.mjs")) as { engineFiles(): string[] };
    const files = gen.engineFiles().map((f) => f.replace(/\\/g, "/"));
    expect(files.some((f) => f.endsWith("/src/lib/desk-eval.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/src/lib/market-calendar.json"))).toBe(true);
    for (const mine of ["/src/lib/board-events.ts", "/src/components/board-events.tsx", "/src/components/client/trade-now.tsx"]) {
      expect(files.some((f) => f.endsWith(mine)), mine).toBe(false);
    }
  });

  it("the engine's output for the fixture day is identical with and without events on that day", async () => {
    const quiet = await engineOutput(realCalendar);
    const loud = await engineOutput(busy);
    const [lineQuiet, ...engineQuiet] = JSON.parse(quiet) as unknown[];
    const [lineLoud, ...engineLoud] = JSON.parse(loud) as unknown[];
    expect(lineQuiet).toEqual({ line: [] });
    const perName = NAMES.flatMap((_, i) => [["earnings_before_open", "earnings_during", "earnings_after_close"][i % 3], "earnings_next_open"]);
    expect(lineLoud).toEqual({ line: ["release", "release", ...perName] });
    // The engine reached real states on this morning, and not one byte of them moved.
    expect(JSON.stringify(engineQuiet)).toContain('"state":"enter_zone"');
    expect(JSON.stringify(engineLoud)).toBe(JSON.stringify(engineQuiet));
  });
});
