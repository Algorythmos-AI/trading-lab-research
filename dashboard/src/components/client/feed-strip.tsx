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
import { useSyncExternalStore } from "react";
import { chipAge, evaluateStamped, type FeedStateName, journalShown, polledState, shadowWindow, STATE_WORD, type StampedInputs } from "@/lib/feed-watch";
import type { Tone } from "@/lib/labels";
import { STALE_MS } from "@/lib/options";
import { cn } from "@/lib/utils";
import { useEvalStatus } from "./desk-shadow";
import { useLive } from "./live-layer";
import { useBoard } from "./trade-now";
import { useNow, usePerfNow } from "./use-now";

/** A chip's state: the feed watch's, or "checking" while the strip's own clock cannot be trusted (stripClock). */
export type ChipState = FeedStateName | "checking";

const TONE: Record<ChipState, Tone> = {
  checking: "info",
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

const WORD: Record<ChipState, string> = { ...STATE_WORD, checking: "Checking" };

export interface Chip {
  id: string;
  name: string;
  short: string;
  state: ChipState;
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
            aria-label={`${c.name}: ${WORD[c.state]}, ${c.age === "—" ? "age not known" : c.age === "now" ? "just now" : `${c.age} old`}${c.assumed ? ", assumed schedule" : ""}`}
            className={cn("grid h-12 min-w-0 content-center gap-0.5 rounded-md border px-2", CHIP_TONE[tone])}
          >
            <span className="text-muted-foreground truncate text-[0.6875rem] leading-tight font-medium max-sm:text-xs">{c.short}</span>
            <span className="flex min-w-0 items-center gap-1 text-xs leading-tight font-semibold">
              <Icon aria-hidden className={cn("size-3.5 shrink-0", TONE_TEXT[tone])} />
              <span className="truncate">{WORD[c.state]}</span>
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

/** Where the strip's clock was last set: a server time, and the monotonic and wall clocks at the moment it arrived. */
export interface Anchor {
  server: number;
  perf: number;
  wall: number;
}

/** Past this long without a new server time (the layout refreshes every 60 s while visible), the clock is stale. */
export const ANCHOR_MAX_AGE_MS = 3 * 60_000;
/** The wall clock and the monotonic clock may drift apart by this much before the clock is stale (sleep, a clock change). */
export const ANCHOR_DRIFT_MS = 30_000;

/**
 * The strip's clock: the server time of the latest render (`anchor.server`, re-anchored each time a refresh brings a
 * new one) plus the monotonic time since it arrived, never the device's wall clock. Before any anchor (the server
 * render, hydration) it is the server render's own time. Stale when no new server time has come for
 * ANCHOR_MAX_AGE_MS (a refresh failed, offline) or when the wall clock and the monotonic clock disagree about the time
 * since the anchor by more than ANCHOR_DRIFT_MS (the machine slept and the monotonic clock stood still, or the device's
 * clock was changed): then the server-derived chips are shown as "checking" until a new server time arrives.
 */
export function stripClock(anchor: Anchor | null, serverNow: number, perf: number | null, wall: number | null): { now: number; stale: boolean } {
  if (!anchor || perf === null) return { now: anchor?.server ?? serverNow, stale: false };
  const byPerf = Math.max(0, perf - anchor.perf);
  const drift = wall === null ? 0 : Math.abs(wall - anchor.wall - (perf - anchor.perf));
  return { now: anchor.server + byPerf, stale: byPerf > ANCHOR_MAX_AGE_MS || drift > ANCHOR_DRIFT_MS };
}

// The anchor for the page's one strip: kept until a different server time is rendered, so the same server time always
// gives the same anchor (a stable snapshot for useSyncExternalStore).
let anchorCache: Anchor | null = null;
function anchorFor(serverNow: number): Anchor {
  if (anchorCache?.server !== serverNow) anchorCache = { server: serverNow, perf: performance.now(), wall: Date.now() };
  return anchorCache;
}
const noSubscribe = () => () => undefined;

/** The chips with a stale clock: nothing that depends on the time is presented as current, and nothing as on time. */
export function withStaleClock(chips: readonly Chip[]): Chip[] {
  const polled = new Set(["prices", "bars"]);
  return chips.map((c) =>
    polled.has(c.id) ? (c.state === "on_time" || c.state === "not_expected" ? { ...c, state: "checking" } : c) : { ...c, state: "checking" },
  );
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
  // The anchor moves with every new server time (the layout's refresh every minute brings one), the moment the render
  // carrying it reads the store below, rather than by remounting the strip on a key: a remount would drop the chips to
  // the server render's state for a frame (a flash) and gains nothing. The server render and hydration have no anchor
  // and show the server's own state.
  const anchor = useSyncExternalStore(noSubscribe, () => anchorFor(serverNow), () => null);
  const perf = usePerfNow(5_000);
  const wall = useNow(5_000);
  const clock = stripClock(anchor, serverNow, perf, wall);
  const now = clock.now;
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
  // A stale clock: the layout's own refresh (on every return to the tab, and each minute while visible) brings the
  // next server time; nothing more is polled here.
  return <FeedChips chips={clock.stale ? withStaleClock(chips) : chips} />;
}
