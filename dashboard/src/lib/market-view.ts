// What the market bar (components/client/market-bar.tsx) shows for a /api/flow feed at a pair of clocks: the headline
// state and its line, the two index readings and the footer's times. Pure and browser-safe, so every state can be
// tested without a browser. Facts only: the readings come from context.ts, the answer's age from flow-request.ts.
import { ageWords, direction, indexInput, type IndexReading, INDEXES, marketRead, type MarketWord, whyWords } from "./context";
import { slotClockFromAsOf } from "./flow";
import { type FlowFeed, judgeFlow } from "./flow-request";

const nyTime = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(ms));

export interface MarketView {
  state: MarketWord | "none" | "loading";
  line: string;
  tiles: { symbol: string; reading: IndexReading | null }[];
  footer: { asOf: string | null; checked: string | null };
}

const emptyTiles = () => INDEXES.map((symbol) => ({ symbol, reading: null }));

/** The bar's view of the feed at these clocks; `shownPerf` is when the tab was last shown (monotonic). */
export function marketView(feed: FlowFeed, shownPerf: number, clocks: { perf: number; wall: number } | null): MarketView {
  const blank = { asOf: null, checked: null };
  if (feed.status === "loading" || clocks === null) return { state: "loading", line: "Reading SPY and QQQ", tiles: emptyTiles(), footer: blank };
  if (feed.status === "off") return { state: "none", line: feed.plan ? "data plan" : "live data is off", tiles: emptyTiles(), footer: blank };
  if (feed.status === "error") return { state: "none", line: feed.limited ? "the data provider asked to slow down" : "prices could not be read", tiles: emptyTiles(), footer: blank };
  const { held } = feed;
  const judged = judgeFlow(held, clocks.perf, clocks.wall, shownPerf);
  const readings = INDEXES.map((s) => direction(indexInput(held.body, s, judged.ageMs)));
  const [spy, qqq] = readings as [IndexReading, IndexReading];
  const read = marketRead(spy, qqq);
  const footer = { asOf: Number.isFinite(held.asOf) ? nyTime(held.asOf) : null, checked: judged.checkedMs < 10_000 ? "just now" : `${ageWords(judged.checkedMs)} ago` };
  const tiles = readings.map((r) => ({ symbol: r.symbol, reading: r }));
  // The device's clock against the server's: no age can be trusted, and the page says why rather than an age.
  if (!judged.fresh && judged.why === "device-clock") return { state: "none", line: "this device's clock is off", tiles, footer };
  if (read.read !== null) {
    const line =
      read.read === "up"
        ? "Both above VWAP, 10-minute closes rising"
        : read.read === "down"
          ? "Both below VWAP, 10-minute closes falling"
          : read.read === "range"
            ? "Neither is trending with VWAP"
            : `SPY ${spy.direction} · QQQ ${qqq.direction}`;
    return { state: read.read, line, tiles, footer };
  }
  const clock = slotClockFromAsOf(held.body.as_of);
  // A stale answer is said once, with its own age; a stale trade or quote inside a fresh answer, with that price's age.
  const staleAge = (symbol: string) => (judged.fresh ? (readings.find((r) => r.symbol === symbol)?.ageMs ?? null) : judged.ageMs);
  const words = read.why.map((w) => ({ symbol: w.symbol, text: whyWords(w.why, clock, w.why === "stale" ? staleAge(w.symbol) : null) }));
  const line = words.length === 2 && words[0]!.text === words[1]!.text ? words[0]!.text : words.map((w) => `${w.symbol}: ${w.text}`).join(" · ");
  return { state: "none", line, tiles, footer };
}

