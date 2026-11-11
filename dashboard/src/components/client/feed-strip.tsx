"use client";

// The Options page's feed health strip: one chip per feed the morning's trading reads (the options edition, the
// pre-open refresh, the live prices, the session bars, the trade journal and the server check), each with its state
// and its age. The server-known feeds are drawn from the stamps the page's server render read (feed-watch-run.ts
// loadPageFeeds) by the same evaluator the alerts use (feed-watch.ts), and redrawn here as the clock moves on; the
// prices and the bars come from the page's own polls (live-layer.tsx, the board's bars). Nothing here polls.
//
// Every chip has the same fixed size whatever it says, so a state change never moves the board below it.
import { TONE_ICON, TONE_TEXT } from "@/components/status";
import { BARS_STALE_MS } from "@/lib/bars-feed";
import { useState } from "react";
import { chipAge, evaluateStamped, type FeedStateName, journalShown, polledState, shadowWindow, STATE_WORD, type StampedInputs } from "@/lib/feed-watch";
import type { Tone } from "@/lib/labels";
import { STALE_MS } from "@/lib/options";
import { cn } from "@/lib/utils";
import { useEvalStatus } from "./desk-shadow";
import { useLive } from "./live-layer";
import { useBoard } from "./trade-now";
import { usePerfNow } from "./use-now";

const TONE: Record<FeedStateName, Tone> = {
  on_time: "good",
  waiting: "info",
  late: "warn",
  failed: "bad",
  not_expected: "neutral",
  unknown: "warn",
};

const CHIP_TONE: Record<Tone, string> = {
  good: "border-good-fill/50 bg-good-soft",
  warn: "border-warn-fill/70 bg-warn-soft",
  bad: "border-bad-fill/70 bg-bad-soft",
  info: "border-info-fill/50 bg-info-soft",
  neutral: "border-border bg-card",
};

export interface Chip {
  id: string;
  name: string;
  short: string;
  state: FeedStateName;
  age: string;
  /** Its schedule is assumed (the calendar has run out, or the routine's time is not verified). */
  assumed: boolean;
}

/** Seconds as a chip's age: "now", "12s", then minutes and up as chipAge says them. */
const secondsAge = (s: number | null) => (s === null ? "—" : s < 1 ? "now" : s < 60 ? `${s}s` : chipAge(Math.floor(s / 60)));

/**
 * The six chips at `now` (server clock) and `browserNow`: pure, so a test can draw every state. The server check reads
 * the page's own status poll when it has one (newer than the server render's read).
 */
export function stripChips(a: {
  stamps: StampedInputs;
  now: number;
  browserNow: number | null;
  prices: Parameters<typeof polledState>[0];
  bars: Parameters<typeof polledState>[0];
  evalStatus: { eval: "off" | "log"; last: number | null } | null;
}): Chip[] {
  const shadow: StampedInputs["shadow"] = a.evalStatus
    ? {
        status: "ok",
        value: {
          on: a.evalStatus.eval === "log",
          switched_at: a.stamps.shadow?.status === "ok" ? a.stamps.shadow.value.switched_at : null,
          last_slot_end: a.evalStatus.last,
        },
      }
    : a.stamps.shadow;
  const views = new Map(evaluateStamped({ ...a.stamps, shadow }, a.now).map((v) => [v.id, v]));
  const server = (id: string): Chip => {
    const v = views.get(id)!;
    // The journal shows the board's own day check (journalShown), so the strip and the day check agree.
    const state = id === "journal" ? journalShown(v, a.stamps.stamps.journal, a.now) : v.state;
    return { id, name: v.name, short: v.short, state, age: chipAge(v.age_min), assumed: v.assumed };
  };
  const assumed = shadowWindow(a.now)?.assumed ?? false;
  const prices = polledState(a.prices, a.browserNow, a.now, STALE_MS, "failed");
  const bars = polledState(a.bars, a.browserNow, a.now, BARS_STALE_MS, "not_expected");
  return [
    server("options-edition"),
    server("pre-open"),
    { id: "prices", name: "Live prices", short: "Prices", state: prices.state, age: secondsAge(prices.age_s), assumed },
    { id: "bars", name: "Session bars", short: "Bars", state: bars.state, age: secondsAge(bars.age_s), assumed },
    server("journal"),
    server("shadow"),
  ];
}

export function FeedChips({ chips }: { chips: readonly Chip[] }) {
  return (
    <ul aria-label="Feed health" data-feed-strip className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
      {chips.map((c) => {
        const tone = TONE[c.state];
        const Icon = TONE_ICON[tone];
        return (
          <li
            key={c.id}
            data-feed-chip={c.id}
            data-feed-state={c.state}
            data-feed-assumed={c.assumed ? "true" : undefined}
            title={c.assumed ? "Assumed schedule" : undefined}
            aria-label={`${c.name}: ${STATE_WORD[c.state]}, ${c.age === "—" ? "age not known" : c.age === "now" ? "just now" : `${c.age} old`}${c.assumed ? ", assumed schedule" : ""}`}
            className={cn("grid h-12 min-w-0 content-center gap-0.5 rounded-md border px-2", CHIP_TONE[tone])}
          >
            <span className="text-muted-foreground truncate text-[0.6875rem] leading-tight font-medium max-sm:text-xs">{c.short}</span>
            <span className="flex min-w-0 items-center gap-1 text-xs leading-tight font-semibold">
              <Icon aria-hidden className={cn("size-3.5 shrink-0", TONE_TEXT[tone])} />
              <span className="truncate">{STATE_WORD[c.state]}</span>
              {/* A fixed box pinned right, its text set from the left: an age that ticks from "now" to "1s" or "10s"
                  moves no text on the page (a right-set text would start somewhere else each second). */}
              <span className="text-muted-foreground ml-auto w-[4ch] shrink-0 text-left font-mono font-normal tabular-nums">{c.age}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The strip's clock (ms): the server's render time plus the monotonic time since hydration; the render time alone
 * while either monotonic reading is missing. */
export function stripNow(serverNow: number, perf0: number | null, perf: number | null): number {
  return perf0 === null || perf === null ? serverNow : serverNow + Math.max(0, perf - perf0);
}

/**
 * The strip on the Options page, inside its live feed and board. `serverNow` is the server render's clock (ms).
 * `evalOn`: the server check's switch as the render read it. Off, and with no record read for it (outside the session
 * at render), the server check is "not due" for the whole of the page's life: the page asks nothing about it.
 */
export function FeedStrip({ stamps, serverNow, evalOn }: { stamps: StampedInputs; serverNow: number; evalOn: boolean }) {
  const { feed, now: browserNow, backoff } = useLive();
  const board = useBoard();
  const status = useEvalStatus();
  // The strip's clock is the server render's, moved on by the browser's monotonic clock since hydration: never the
  // device's wall clock, which may be wrong. Until the monotonic clock is read, the server render's state stands.
  const [perf0] = useState(() => (typeof performance === "undefined" ? null : performance.now()));
  const perf = usePerfNow(15_000);
  const now = stripNow(serverNow, perf0, perf);
  const shadow: StampedInputs["shadow"] = stamps.shadow ?? (evalOn ? null : { status: "ok", value: { on: false, switched_at: null, last_slot_end: null } });
  // The prices are failing while the retry line is up (backoff) or the board has paused on them.
  const failing = backoff !== null || board?.paused === true;
  const prices = feed.status === "ok" ? { status: "ok" as const, receivedAt: feed.receivedAt, failing } : { status: feed.status, receivedAt: null, failing };
  const chips = stripChips({
    stamps: { ...stamps, shadow },
    now,
    browserNow,
    prices,
    bars: board?.barsRead ?? { status: "off", receivedAt: null },
    evalStatus: status,
  });
  return <FeedChips chips={chips} />;
}
