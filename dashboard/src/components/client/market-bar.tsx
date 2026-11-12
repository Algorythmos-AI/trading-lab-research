"use client";

// The market bar (B2): at the top of the Options page, in one glance, what SPY and QQQ are doing. A headline chip
// (MARKET UP, MARKET DOWN, MIXED, RANGE, or NOT AVAILABLE with the reason) and one tile per index: the price, its
// direction, where it sits against session VWAP, relative volume and the spread. Colour always comes with an arrow and a
// word, never alone.
//
// Facts only: no advice, no side, no prediction. The readings are display definitions marked "Testing" (lib/context.ts)
// and change no board state, rule or level. Every reading is worked out in lib/context.ts from the /api/flow answer;
// how old that answer is comes from lib/flow-request.ts. No colour is ever shown on a stale, partial or missing answer.
//
// Every state draws the same rows (the headline, its line, two tiles of four lines, the footer), so the bar never
// changes height as it loads or as the market's state changes.
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { type Direction, type IndexReading, type MarketWord, spreadWords, volumeWords } from "@/lib/context";
import { marketView, type MarketView } from "@/lib/market-view";
import { TestingTag } from "./trade-now";
import { useFlow } from "./use-flow";

type Tone = "good" | "bad" | "warn" | "neutral" | "muted";

const CHIP: Record<Tone, string> = {
  good: "bg-good-soft border-good-fill text-good",
  bad: "bg-bad-soft border-bad-fill text-bad",
  warn: "bg-warn-soft border-warn-fill text-warn",
  neutral: "bg-neutral-soft border-neutral-fill text-foreground",
  muted: "bg-muted/60 border-border text-muted-foreground",
};
const TEXT: Record<Tone, string> = { good: "text-good", bad: "text-bad", warn: "text-warn", neutral: "text-foreground", muted: "text-muted-foreground" };
const BAR: Record<Tone, string> = { good: "border-l-good-fill", bad: "border-l-bad-fill", warn: "border-l-warn-fill", neutral: "border-l-neutral-fill", muted: "border-l-border" };

const HEAD: Record<MarketWord, { glyph: string; word: string; tone: Tone }> = {
  up: { glyph: "▲", word: "MARKET UP", tone: "good" },
  down: { glyph: "▼", word: "MARKET DOWN", tone: "bad" },
  mixed: { glyph: "◆", word: "MIXED", tone: "warn" },
  range: { glyph: "▬", word: "RANGE", tone: "neutral" },
};
const DIR: Record<Direction, { glyph: string; word: string; tone: Tone }> = {
  up: { glyph: "▲", word: "UP", tone: "good" },
  down: { glyph: "▼", word: "DOWN", tone: "bad" },
  range: { glyph: "▬", word: "RANGE", tone: "neutral" },
};
const SIDE = { above: { glyph: "▲", tone: "good" }, below: { glyph: "▼", tone: "bad" }, at: { glyph: "▬", tone: "neutral" } } as const;

/** Both clocks, re-read every second: the monotonic one rounded up and the wall one rounded up, so an age reads old, never young. */
function useClocks(): { perf: number; wall: number } | null {
  const snap = useSyncExternalStore(
    (onChange) => {
      const id = window.setInterval(onChange, 1_000);
      return () => window.clearInterval(id);
    },
    () => `${Math.ceil(performance.now() / 1_000) * 1_000}|${Math.ceil(Date.now() / 1_000) * 1_000}`,
    () => null,
  );
  if (snap === null) return null;
  const [perf, wall] = snap.split("|").map(Number);
  return { perf: perf!, wall: wall! };
}

function Headline({ state, line }: { state: MarketView["state"]; line: string }) {
  const h = state === "none" || state === "loading" ? null : HEAD[state];
  const tone: Tone = h?.tone ?? "muted";
  return (
    // On a phone the bar is kept short (about 100 px), so the desk's own pane bar below it stays on the first screen:
    // the chip, the sentence and the Testing tag share one row, each tile is three tight lines, and the footer's times
    // are for screen readers only (a reading is never coloured unless it is under 20 s old, so they add nothing there).
    <div className="grid content-center gap-1 max-md:flex max-md:min-w-0 max-md:items-center max-md:gap-2">
      <p data-market-head className={cn("text-decision inline-flex w-fit shrink-0 items-center gap-2 rounded-md border border-l-[6px] px-2.5 py-0.5 font-semibold whitespace-nowrap max-md:gap-1.5 max-md:border-l-4 max-md:px-2 max-md:py-0 max-md:text-base", CHIP[tone])}>
        {h ? (
          <span aria-hidden className="text-[0.85em] leading-none">
            {h.glyph}
          </span>
        ) : null}
        {h ? h.word : state === "loading" ? "CHECKING" : "NOT AVAILABLE"}
      </p>
      <p data-market-line className="text-explain text-muted-foreground truncate max-md:min-w-0 max-md:flex-1 max-md:text-xs">
        {line}
      </p>
      <span className="shrink-0 md:hidden">
        <TestingTag />
      </span>
    </div>
  );
}

function Tile({ symbol, reading }: { symbol: string; reading: IndexReading | null }) {
  const d = reading?.direction ? DIR[reading.direction] : null;
  // Values only when they are current: a stale answer shows dashes, never yesterday's numbers in today's place.
  const show = reading !== null && reading.why !== "stale";
  const r = show ? reading : null;
  const side = d && r?.side ? SIDE[r.side] : null;
  const vwapLine = r && r.vwap !== null ? `${r.side === null ? "VWAP" : r.side === "at" ? "at VWAP" : `${r.side} VWAP`} ${r.vwap.toFixed(2)}` : "VWAP –";
  const crossed = r?.spread.bps === null && (r.spread.why === "crossed" || r.spread.why === "locked");
  return (
    <div data-index-tile={symbol} data-direction={reading?.direction ?? "none"} className={cn("bg-card min-w-0 rounded-md border border-l-4 px-2.5 py-2 max-md:grid max-md:grid-cols-[auto_1fr_auto] max-md:items-baseline max-md:gap-x-2 max-md:px-2 max-md:py-0.5", BAR[d?.tone ?? "muted"])}>
      <p className="flex items-baseline justify-between gap-2 max-md:contents md:justify-start md:gap-4">
        <span className="font-mono font-semibold">{symbol}</span>
        <span data-index-direction className={cn("text-sm font-semibold whitespace-nowrap max-md:order-3 max-md:text-xs", TEXT[d?.tone ?? "muted"])}>
          {d ? (
            <>
              <span aria-hidden>{d.glyph} </span>
              {d.word}
            </>
          ) : (
            "no reading"
          )}
        </span>
      </p>
      <p data-index-price className={cn("text-price font-mono leading-tight tabular-nums max-md:order-2 max-md:text-base max-md:font-semibold", !d && "text-muted-foreground")}>
        {r?.price != null ? r.price.toFixed(2) : "–"}
      </p>
      <p data-index-vwap className={cn("truncate text-sm max-md:order-4 max-md:col-span-3 max-md:text-xs max-md:leading-4", !side && "text-muted-foreground")}>
        {side ? (
          <span aria-hidden className={TEXT[side.tone]}>
            {side.glyph}{" "}
          </span>
        ) : null}
        {vwapLine}
      </p>
      <p data-index-volume className="text-muted-foreground truncate text-sm max-md:order-4 max-md:col-span-3 max-md:text-xs max-md:leading-4">
        {r ? volumeWords(r.volume) : "volume –"}
      </p>
      <p data-index-spread={r ? (r.spread.bps === null ? r.spread.why : "ok") : "none"} className={cn("truncate text-sm max-md:order-4 max-md:col-span-3 max-md:text-xs max-md:leading-4", crossed ? "text-bad font-semibold" : "text-muted-foreground max-md:hidden")}>
        {r ? spreadWords(r.spread) : "bid–ask –"}
      </p>
    </div>
  );
}

/** The market bar, fed by /api/flow every 5 s. */
export function MarketBar() {
  const { feed, shownPerf } = useFlow();
  const clocks = useClocks();
  const v = marketView(feed, shownPerf, clocks);
  return (
    <section aria-labelledby="market-bar-heading" data-market-bar data-market-read={v.state} className="bg-card grid gap-2 rounded-lg border p-3 max-md:-mb-2 max-md:gap-1 max-md:px-2 max-md:py-1.5">
      <h2 id="market-bar-heading" className="sr-only">
        Market: SPY and QQQ
      </h2>
      <div className="grid gap-2 md:grid-cols-[minmax(15rem,auto)_1fr_1fr] md:items-stretch md:gap-3">
        <Headline state={v.state} line={v.line} />
        <div className="grid grid-cols-2 gap-2 md:contents">
          {v.tiles.map((t) => (
            <Tile key={t.symbol} symbol={t.symbol} reading={t.reading} />
          ))}
        </div>
      </div>
      {/* The same words in every state, with dashes until there is an answer, so the line never changes its length much. */}
      <p data-market-footer className="text-muted-foreground flex flex-wrap items-center gap-y-1 text-xs max-md:sr-only">
        <span>SIP · as of {v.footer.asOf ?? "--:--:--"} New York</span>
        <span className="whitespace-pre">{" · "}</span>
        <span data-age-slot>checked {v.footer.checked ?? "–"}</span>
        <span className="whitespace-pre">{" · "}</span>
        <TestingTag />
      </p>
    </section>
  );
}
