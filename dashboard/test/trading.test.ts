// Paper B's trades and profit and loss as the pages read them, from the snapshot's `today` section.
import { describe, expect, it } from "vitest";
import { summarize } from "@/lib/summary";
import { outcomeLine, reasonLabel, tradeSentence, trading } from "@/lib/trading";
import type { Snapshot } from "@/lib/types";
import { fixtureV3 as fixture } from "./helpers";

type Today = NonNullable<Snapshot["today"]>;
const withToday = (over: Partial<Today>, extra: Partial<Snapshot> = {}): Snapshot =>
  ({ ...fixture(), ...extra, today: { ...(fixture().today as Today), ...over } }) as Snapshot;

describe("Paper B's trades and profit and loss", () => {
  it("reads the four periods, the statistics and the trades newest first", () => {
    const v = trading(fixture());
    expect(v.available).toBe(true);
    expect(v.periods.map((p) => p.label)).toEqual(["Today", "This week", "This month", "All time"]);
    expect(v.periods[3]!.trades).toBe(v.stats.trades);
    expect(v.stats.wins + v.stats.losses).toBeLessThanOrEqual(v.stats.trades);
    expect(v.trades.length).toBeGreaterThan(1);
    expect(v.trades[0]!.session >= v.trades[1]!.session).toBe(true);
    expect(v.trades[0]!.entryAt).toMatch(/^2026-/);
  });

  it("prices the open position from the broker's paper account", () => {
    const s = withToday(
      { position: { symbol: "QQQM", state: "in_position", qty: 2, entry: 250, entry_at: "2026-10-02T14:31:00+00:00", trigger: 250, stop: 249, target: 252 } },
      { ops: { ...fixture().ops, account: { ...fixture().ops?.account, positions: [{ symbol: "QQQM", qty: 2, market_value: 503, unrealized_pl: 3 }] } } } as Partial<Snapshot>,
    );
    const p = trading(s).position!;
    expect(p.mark).toBe(251.5);
    expect(p.openPnl).toBe(3);
    expect(p.openR).toBe(1.5);
  });

  it("shows a waiting order without a price or a result", () => {
    const p = trading(withToday({ position: { symbol: "QQQM", state: "entry_working", qty: 2, entry: null, entry_at: null, trigger: 250, stop: 249, target: 252 } })).position!;
    expect([p.state, p.mark, p.openPnl]).toEqual(["entry_working", null, null]);
  });

  it("answers why there was no trade in plain words", () => {
    const line = (outcome: string | null, ended = true, position: Today["position"] = null) =>
      outcomeLine(trading(withToday({ outcome, ended, position }))).title;
    expect(line("traded")).toBe("It traded");
    expect(line("no_signal")).toBe("No trade: no signal");
    expect(line("blocked:kill_file")).toBe("No trade: blocked (kill switch on)");
    expect(line("signal_not_acted")).toBe("No trade: a signal fired and was not acted on");
    expect(line(null, false)).toBe("Session in progress");
    expect(outcomeLine(trading(withToday({ outcome: "signal_not_acted" }))).tone).toBe("bad");
    expect(line("no_inputs")).toBe("No trade: the signal could not be checked");
    expect(outcomeLine(trading(withToday({ outcome: "no_inputs" }))).tone).toBe("bad");
    expect(line("a_kind_from_a_newer_host")).toBe("No trade");
  });

  it("never calls an older session today", () => {
    const s = withToday({ outcome: "no_signal", ended: true, session: "2026-10-01" }, { market: { ...fixture().market, trading_day_et: "2026-10-02" } } as Partial<Snapshot>);
    expect(trading(s).current).toBe(false);
    expect(tradeSentence(s)).toBeNull();
  });

  it("adds a status sentence to the summary, without money", () => {
    const day = fixture().today!.session!;
    const s = withToday({ outcome: "no_signal", ended: true, position: null }, { market: { ...fixture().market, trading_day_et: day } } as Partial<Snapshot>);
    expect(tradeSentence(s)).toBe("Paper B had no signal today.");
    expect(summarize(s)).toContain("Paper B had no signal today.");
    expect(summarize(s)).not.toMatch(/US\$/);
  });

  it("keeps the older page when the host has not published the section yet", () => {
    const v = trading({ ...fixture(), today: undefined } as Snapshot);
    expect(v.available).toBe(false);
    expect(v.trades).toEqual([]);
    expect(outcomeLine(v).title).toBe("No session recorded yet");
  });

  it("shows the runner's own ledger figures until the ledger file exists", () => {
    const base = fixture();
    const s = { ...base, today: { ...base.today, pnl: { ...base.today!.pnl, equity: null, start: null, return_pct: null } }, ops: { ...base.ops, paper: { ...base.ops?.paper, virtual: { equity: 606, start: 600 } } } } as Snapshot;
    const v = trading(s);
    expect([v.equity, v.start]).toEqual([606, 600]);
    expect(v.returnPct).toBeCloseTo(1, 6);
  });

  it("names how a trade ended", () => {
    expect(reasonLabel("eod_flatten")).toBe("Closed before the bell");
    expect(reasonLabel("something_new")).toBe("something new");
    expect(reasonLabel(null)).toBe("—");
  });
});
