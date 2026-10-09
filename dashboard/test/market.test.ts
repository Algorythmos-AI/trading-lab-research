// The market monitor's readings, and its panels rendered from a snapshot without a browser.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CorrelationPanel, ExposurePanel, OpportunityPanel, RDistributionPanel, RegimePanel } from "@/components/crypto/market";
import type { Crypto } from "@/lib/crypto";
import { coinOf, coinRows, correlationGrid, exposureMap, priceDigits, regimeOf, shade, sleeveResults, trendOf } from "@/lib/market";

const fixture = (): Crypto => JSON.parse(readFileSync(new URL("./fixtures/crypto.v1.json", import.meta.url), "utf8")) as Crypto;
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (panel: (p: { s: Crypto }) => unknown, s: Crypto) => text(renderToString(createElement(panel as never, { s })));
const bare = (): Crypto => {
  const s = fixture();
  delete s.monitor;
  delete s.exposure;
  for (const x of s.sleeves ?? []) if (x) delete x.r_bands;
  return s;
};

describe("the coins, strongest first", () => {
  it("keeps the host's order and places, and reads each coin's figures", () => {
    const rows = coinRows(fixture());
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const sorted = [...rows].sort((a, b) => (b.ret30 as number) - (a.ret30 as number));
    expect(rows.map((r) => r.pair)).toEqual(sorted.map((r) => r.pair));
    expect(rows[0]).toMatchObject({ pair: "ADA/USD", coin: "ADA", stale: false, aboveEma20: true, aboveEma50: true });
  });

  it("says what each registered rule made of a coin and which books hold it", () => {
    const rows = coinRows(fixture());
    const doge = rows.find((r) => r.pair === "DOGE/USD");
    expect(doge?.rules.map((x) => [x.label, x.fires, x.unmet])).toEqual([["Trend", true, 0], ["Breakout", true, 0], ["Dip", true, 0]]);
    const btc = rows.find((r) => r.pair === "BTC/USD");
    expect(btc?.rules.every((x) => !x.fires && x.unmet === 1)).toBe(true);
    expect(rows.find((r) => r.pair === "XRP/USD")?.heldBy).toEqual(["Trend"]);
    expect(btc?.heldBy).toEqual([]);
  });

  it("is empty, not broken, on a snapshot from a host that does not publish the monitor", () => {
    expect(coinRows(bare())).toEqual([]);
    expect(coinRows({} as Crypto)).toEqual([]);
  });

  it("names a trend from the two averages", () => {
    expect(trendOf({ aboveEma20: true, aboveEma50: true })).toEqual({ label: "Above both", tone: "good" });
    expect(trendOf({ aboveEma20: false, aboveEma50: false }).label).toBe("Below both");
    expect(trendOf({ aboveEma20: false, aboveEma50: true }).label).toBe("Pulling back");
    expect(trendOf({ aboveEma20: true, aboveEma50: false }).label).toBe("Recovering");
    expect(trendOf({ aboveEma20: null, aboveEma50: true }).label).toBe("Too few bars");
  });

  it("gives a cheap coin enough decimals", () => {
    expect([118000, 172.5, 0.19, null].map(priceDigits)).toEqual([0, 2, 4, 2]);
    expect([coinOf("BTC/USD"), coinOf(null), coinOf("")]).toEqual(["BTC", "—", "—"]);
  });
});

describe("the market state", () => {
  it("reads the published regime", () => {
    const r = regimeOf(fixture());
    expect(r).toMatchObject({ available: true, code: "up", label: "Rising", tone: "good", pairs: 8, aboveEma50: 6, breadth: 0.75, rising: 6, stale: false });
    expect(r.btcVsSma50Pct).toBeCloseTo(0.5193, 4);
  });

  it("does not invent a state from an unknown code or a missing block", () => {
    const s = fixture();
    (s.monitor as NonNullable<Crypto["monitor"]>).regime = { code: "bullish" };
    expect(regimeOf(s)).toMatchObject({ available: true, code: null, label: "Not enough bars", tone: "neutral", pairs: 0 });
    expect(regimeOf(bare())).toMatchObject({ available: false, code: null, btcClose: null });
  });
});

describe("the correlation square", () => {
  it("is square and symmetric with ones on the diagonal", () => {
    const g = correlationGrid(fixture());
    expect(g?.coins).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      expect(g?.cells[i]?.[i]).toBe(1);
      for (let j = 0; j < 8; j++) expect(g?.cells[i]?.[j]).toBe(g?.cells[j]?.[i]);
    }
    expect(g?.mean).toBeCloseTo(0.331, 3);
    expect(g?.tightest?.value).toBe(g?.high);
    expect(g?.loosest?.value).toBe(g?.low);
  });

  it("refuses a square that is not one, and clamps a value out of range", () => {
    const s = fixture();
    const c = (s.monitor as NonNullable<Crypto["monitor"]>).correlation as NonNullable<NonNullable<Crypto["monitor"]>["correlation"]>;
    c.rows = [{ pair: "BTC/USD", with: [1, 7] }, { pair: "ETH/USD", with: [7, 1] }];
    c.pairs = ["BTC/USD", "ETH/USD"];
    expect(correlationGrid(s)?.cells).toEqual([[1, 1], [1, 1]]);
    c.rows = [{ pair: "BTC/USD", with: [1] }, { pair: "ETH/USD", with: [0.5, 1] }];
    expect(correlationGrid(s)).toBeNull();
    expect(correlationGrid(bare())).toBeNull();
  });

  it("shades by distance from zero", () => {
    expect(shade(0.8)).toEqual({ side: "with", strength: 0.8 });
    expect(shade(-0.25)).toEqual({ side: "against", strength: 0.25 });
    expect([shade(null), shade(0), shade(Number.NaN)].map((x) => x.side)).toEqual(["none", "none", "none"]);
  });
});

describe("what the books hold", () => {
  it("adds up: the coins make the holdings, and the books make the equity", () => {
    const e = exposureMap(fixture());
    expect(e.available).toBe(true);
    expect(e.coins.map((c) => [c.coin, c.books, Math.round(c.sharePct)])).toEqual([["XRP", ["Trend"], 100]]);
    expect(e.coins.reduce((a, c) => a + c.notional, 0)).toBeCloseTo(e.gross as number, 6);
    expect(e.books.reduce((a, b) => a + (b.equity as number), 0)).toBeCloseTo(e.equity as number, 6);
    expect(e.books.reduce((a, b) => a + b.notional, 0)).toBeCloseTo(e.gross as number, 6);
    expect(e.riskPct).toBeCloseTo(((e.risk as number) / (e.equity as number)) * 100, 9);
    expect(e.books.map((b) => b.label).slice(0, 3)).toEqual(["Trend", "Breakout", "Dip"]);
  });

  it("is unavailable, with nothing in it, when the host does not publish it", () => {
    expect(exposureMap(bare())).toMatchObject({ available: false, coins: [], books: [], equity: null, riskPct: null });
  });
});

describe("results in R", () => {
  it("counts every closed trade once and works out the break-even win rate", () => {
    const all = sleeveResults(fixture());
    expect(all.map((x) => [x.label, x.trades])).toEqual([["Trend", 3], ["Breakout", 2]]);
    const trend = all[0] as (typeof all)[number];
    expect(trend.bands).toHaveLength(12);
    expect(trend.bands[0]).toMatchObject({ label: "under −2", side: "loss" });
    expect(trend.bands.at(-1)).toMatchObject({ label: "4+", side: "gain" });
    expect(trend.bands.filter((b) => b.side === "loss").map((b) => b.label)).toEqual(["under −2", "−2", "−1.5", "−1", "−0.5"]);
    expect(trend.breakevenWinRate).toBeCloseTo(1 / (1 + (trend.payoff as number)), 9);
  });

  it("leaves out a sleeve with no trades, and a host that publishes no bands", () => {
    expect(sleeveResults(fixture()).some((x) => x.name === "dip")).toBe(false);
    expect(sleeveResults(bare())).toEqual([]);
  });
});

describe("the market panels", () => {
  it("show the market state with its six readings", () => {
    const out = render(RegimePanel, fixture());
    expect(out).toContain("Market state");
    expect(out).toContain("Rising");
    expect(out).toContain("+0.52%");
    expect(out).toContain("6 of 8");
    expect(out).toContain("Average correlation 0.33");
  });

  it("show every coin with what the rules made of it, in plain words", () => {
    const out = render(OpportunityPanel, fixture());
    expect(out).toContain("Coins, strongest first");
    expect(out).toContain("1 coin with a rule firing");
    expect(out).toContain("Trend: fires");
    expect(out).toContain("Breakout: 1 unmet");
    for (const coin of ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LINK", "AVAX"]) expect(out).toContain(coin);
    expect(out).not.toMatch(/no_new_high|\/USD/);
  });

  it("show the correlation square and the books' holdings", () => {
    const corr = render(CorrelationPanel, fixture());
    expect(corr).toContain("Average between two coins 0.33");
    expect(corr).toMatch(/Moved together most [A-Z]+ and [A-Z]+ 0\.\d\d/);
    const held = render(ExposurePanel, fixture());
    expect(held).toContain("1 coin held");
    expect(held).toContain("XRP Trend");
    expect(held).toContain("100% of holdings");
  });

  it("show each sleeve's results in R", () => {
    const out = render(RDistributionPanel, fixture());
    expect(out).toContain("Trend · 3 closed trades");
    expect(out).toContain("Breakout · 2 closed trades");
    expect(out).toContain("breaks even at");
  });

  it("say so plainly on an older snapshot, and never print a broken number", () => {
    const old = bare();
    expect(render(RegimePanel, old)).toContain("has not published the market monitor yet");
    expect(render(OpportunityPanel, old)).toContain("No coin has a stored bar yet");
    expect(render(CorrelationPanel, old)).toContain("Not enough bars yet");
    expect(render(ExposurePanel, old)).toContain("has not published the books' holdings yet");
    expect(render(RDistributionPanel, old)).toContain("No sleeve has closed a trade yet");
    for (const s of [fixture(), old]) {
      for (const p of [RegimePanel, OpportunityPanel, CorrelationPanel, ExposurePanel, RDistributionPanel]) expect(render(p, s)).not.toMatch(/NaN|undefined|Infinity|null/);
    }
  });
});
