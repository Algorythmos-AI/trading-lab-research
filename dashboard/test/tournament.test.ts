// The crypto tournament (DEC-0015) as the pages read it, from the crypto snapshot's `sleeves`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { code, type Crypto } from "@/lib/crypto";
import { challengers, challengersLine, sleeveLabel, tournament, tournamentLine } from "@/lib/tournament";

const fixture = (): Crypto => JSON.parse(readFileSync(new URL("./fixtures/crypto.v1.json", import.meta.url), "utf8")) as Crypto;

describe("the crypto tournament", () => {
  it("gives one row per sleeve and never pools them", () => {
    const t = tournament(fixture());
    expect(t.available).toBe(true);
    expect(t.rows.map((r) => [r.name, r.label, r.stage])).toEqual([
      ["trend", "Trend", "failed"],
      ["break", "Breakout", "failed"],
      ["dip", "Dip", "failed"],
      ["ch-29db21a0", "Challenger 29db21a0", "passed"],
    ]);
    // A challenger has no built-in description: its recorded rules say what it does.
    expect(t.rows[3]!.does).toMatch(/^Challenger: break rule on daily bars/);
    expect(t.rows[3]!.equity).toBe(10000);
    const trend = t.rows[0]!;
    expect(trend.trades).toBe(3);
    expect(trend.wins + trend.losses).toBe(3);
    expect(trend.open).toBe(1);
    expect(t.rows[2]!.equity).toBe(10000);
    expect(t.rows[2]!.winRate).toBeNull();
  });

  it("lists open positions with their sleeve, and a trailing stop has no target", () => {
    const t = tournament(fixture());
    expect(t.positions).toHaveLength(1);
    const p = t.positions[0]!;
    expect([p.sleeve, p.pair, p.target]).toEqual(["trend", "XRP/USD", null]);
    expect(p.openPnl).toBeGreaterThan(0);
    expect(p.openR).toBeCloseTo(p.openPnl! / 100, 2);
  });

  it("merges closed trades and signals across sleeves, newest first", () => {
    const t = tournament(fixture());
    expect(t.trades).toHaveLength(5);
    for (let i = 1; i < t.trades.length; i++) expect(t.trades[i - 1]!.exitAt! >= t.trades[i]!.exitAt!).toBe(true);
    expect(new Set(t.trades.map((x) => x.sleeve))).toEqual(new Set(["trend", "break"]));
    expect(t.signals.some((g) => g.entered)).toBe(true);
    expect(t.signals.some((g) => !g.entered && g.why.includes("stop_too_tight"))).toBe(true);
  });

  it("shows what each sleeve said about each pair", () => {
    const t = tournament(fixture());
    expect(t.checks).toHaveLength(8);
    const doge = t.checks.find((c) => c.pair === "DOGE/USD")!;
    expect(doge.by.trend).toEqual({ fire: true, why: [] });
    expect(t.checks.find((c) => c.pair === "BTC/USD")!.by.dip).toEqual({ fire: false, why: ["no_new_high"] });
  });

  it("says in one line what is open and what has closed", () => {
    expect(tournamentLine(tournament(fixture()))).toBe("1 position is open in 1 sleeve; 5 trades have been closed.");
  });

  it("keeps the older page when the host has not published the sleeves yet", () => {
    const t = tournament({ ...fixture(), sleeves: undefined } as Crypto);
    expect(t.available).toBe(false);
    expect(t.rows).toEqual([]);
    expect(tournamentLine(t)).toBe("The tournament has not published yet.");
  });

  it("puts the new codes in plain words", () => {
    expect([code("no_new_high"), code("trend_exit"), code("late_bar"), sleeveLabel("break"), sleeveLabel("other")]).toEqual([
      "no new high",
      "Trend ended",
      "signal found too late",
      "Breakout",
      "other",
    ]);
  });

  it("lists every idea tried, newest first, with the verdict of its backtest", () => {
    const c = challengers(fixture());
    expect(c.available).toBe(true);
    expect(c.learningOn).toBe(true);
    expect(c.rows.map((r) => [r.status, r.slot])).toEqual([
      ["registered", "random"],
      ["live", "neighbour"],
      ["failed", "random"],
    ]);
    const [waiting, live, failed] = c.rows as [typeof c.rows[0], typeof c.rows[0], typeof c.rows[0]];
    expect(waiting.trades).toBeNull();
    expect(waiting.rules).toMatch(/^dip rule on daily bars/);
    expect([live.of, live.meanR, live.ciLow, live.failedOn]).toEqual(["break", 0.212, 0.019, []]);
    expect(failed.failedOn.map(code)).toEqual([
      "not clearly profitable once costs are raised",
      "could be luck, given how many ideas were tried",
      "wins too small against losses",
    ]);
    expect([c.registered, c.live, c.failed, c.maxLive, c.maxRegistered, c.perWeek]).toEqual([3, 1, 1, 6, 60, 2]);
    expect(challengersLine(c)).toBe("3 ideas tried: 1 trading, 1 failed its backtest, 1 waiting for its backtest.");
  });

  it("says so when nothing has been tried, when learning is off, and before the host publishes the section", () => {
    const empty = { ...fixture(), challengers: { learning: "on", list: [], registered: 0 } } as Crypto;
    expect(challengersLine(challengers(empty))).toBe("No idea has been tried yet.");
    const off = { ...fixture(), challengers: { ...fixture().challengers, learning: "off" } } as Crypto;
    expect(challengers(off).learningOn).toBe(false);
    expect(challengersLine(challengers(off))).toMatch(/Learning is switched off\.$/);
    const older = challengers({ ...fixture(), challengers: undefined } as Crypto);
    expect([older.available, older.rows]).toEqual([false, []]);
    expect(challengersLine(older)).toBe("The challengers have not published yet.");
  });
});
