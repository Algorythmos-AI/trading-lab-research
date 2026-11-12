"use client";

import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Ban,
  ChevronsDown,
  ChevronsUp,
  CircleDashed,
  Clock,
  Focus,
  Minus,
  Moon,
  RefreshCw,
  RotateCw,
  type LucideIcon,
} from "lucide-react";
import { createContext, useContext, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ageSeconds, ageStale, ageText, feedAges, feedLabel } from "@/lib/feed-provenance";
import { newYork, num } from "@/lib/format";
import { liveRead, sessionShare, TRAIL_MS, type LiveRead, type LiveStateName, type OptionsTicker } from "@/lib/options";
import { cn } from "@/lib/utils";
import type { Backoff } from "@/lib/quote-poll";
import { useNow } from "./use-now";
import { POLL_MS, useQuoteFeed, type Feed } from "./use-quotes";

interface Live {
  feed: Feed;
  session: string;
  now: number | null;
  /** Waiting to try again after the feed failed; null while it is healthy. */
  backoff: Backoff | null;
  /** One attempt now while waiting; nothing otherwise. */
  retryNow: () => void;
}

/** Exported for the render tests only; the page reads it through useLive. */
export const LiveContext = createContext<Live>({ feed: { status: "off" }, session: "", now: null, backoff: null, retryNow: () => undefined });

/**
 * One live feed for the whole Options page, so the glance strip, the level maps and the state chips all move on the
 * same 2-second quote. `enabled` false (an old edition) never polls. Read only: it fetches prices, nothing else.
 */
export function LiveQuotes({
  symbols,
  session,
  enabled,
  children,
}: {
  symbols: string;
  session: string;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const { feed, backoff, retryNow } = useQuoteFeed(symbols, enabled);
  const now = useNow(1_000);
  return <LiveContext.Provider value={{ feed, session, now, backoff, retryNow }}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  return useContext(LiveContext);
}

/** A name read off the shared feed: its price, state and staleness, and its trail of recent prices. */
export function useLiveRead(t: OptionsTicker): LiveRead & { trail: { at: number; p: number }[] } {
  const { feed, session, now } = useLive();
  const ok = feed.status === "ok";
  const read = liveRead(t, ok ? feed.quotes[t.symbol] : undefined, session, now, ok ? feed.receivedAt : null);
  return { ...read, trail: ok && read.inSession ? (feed.trails[t.symbol] ?? []) : [] };
}

const STATE_ICON: Record<LiveStateName, LucideIcon> = {
  "TESTING SUPPORT": ArrowDownToLine,
  "TESTING RESISTANCE": ArrowUpToLine,
  "GAP ABOVE": ChevronsUp,
  "GAP BELOW": ChevronsDown,
  "ABOVE PDH": ArrowUp,
  "BELOW PDL": ArrowDown,
  INSIDE: Minus,
  "NO TRADE": Ban,
  "NOT OPEN YET": Clock,
  CLOSED: Moon,
};

const STATE_VARIANT: Record<LiveStateName, "good" | "bad" | "info" | "neutral"> = {
  "TESTING SUPPORT": "good",
  "TESTING RESISTANCE": "bad",
  "GAP ABOVE": "info",
  "GAP BELOW": "info",
  "ABOVE PDH": "info",
  "BELOW PDL": "info",
  INSIDE: "neutral",
  "NO TRADE": "neutral",
  "NOT OPEN YET": "neutral",
  CLOSED: "neutral",
};

/** The chip's own backdrop and ring colours, so they do not depend on the row behind it. */
const chipStyle = (variant: "good" | "bad" | "info" | "neutral" | "warn") =>
  ({ "--chip-bg": `var(--${variant}-chip)`, "--chip-ring": `var(--${variant}-fill)` }) as React.CSSProperties;

/**
 * A live state as colour, icon and word. A test of a major zone pulses a ring around the chip (not when the
 * reader asks for reduced motion, and not on a stale quote); a stale quote turns grey and adds how old it is.
 *
 * The words never fade: an earlier version pulsed and dimmed the chip's opacity, which took its text below the
 * contrast it needs for half of every pulse. The chip also keeps its own backdrop (`chip-solid`), so it reads the
 * same on a highlighted or selected row as on a plain one.
 */
export function StateChip({ read, className }: { read: LiveRead; className?: string }) {
  if (!read.state || !read.inSession) return null;
  const Icon = STATE_ICON[read.state];
  const testing = read.state === "TESTING SUPPORT" || read.state === "TESTING RESISTANCE";
  const variant = read.stale ? "neutral" : STATE_VARIANT[read.state];
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      <Badge variant={variant} style={chipStyle(variant)} className={cn("chip-solid px-1 font-sans text-[0.625rem] max-sm:text-xs", testing && !read.stale && "chip-pulse")}>
        <Icon aria-hidden />
        {read.state}
      </Badge>
      {read.stale ? (
        <Badge variant="warn" style={chipStyle("warn")} className="chip-solid px-1 font-sans text-[0.625rem] max-sm:text-xs">
          <CircleDashed aria-hidden />
          STALE {read.ageS !== null ? `${read.ageS}s` : ""}
        </Badge>
      ) : null}
    </span>
  );
}

/** The live chip on a level map's card header; nothing outside the session. */
export function LiveCardChip({ t }: { t: OptionsTicker }) {
  const read = useLiveRead(t);
  if (!read.inSession) return null;
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-sm">{num(read.price, 2)}</span>
      <StateChip read={read} />
    </span>
  );
}

/**
 * Whole seconds until a retry is due, as the page's one-second clock (useNow, floored to the second, so up to a second
 * behind) reads it: rounded down, so the first reading of a 2 s wait is 2, and never below 1 while any of the wait
 * remains. 0 once it is due; null while the attempt is going out, or before the page has a clock.
 */
export function retryInS(b: Backoff, now: number | null): number | null {
  if (b.at === null || now === null) return null;
  const left = b.at - now;
  return left <= 0 ? 0 : Math.max(1, Math.floor(left / 1000));
}

/**
 * A small "is the feed alive" pill: live with the time of the last answer and the feed it named (nothing when it named
 * none), off (and why, when it is the feed setting or the data plan rather than missing keys), or retrying (and in how
 * long).
 */
export function FeedPill() {
  const { feed, backoff, now } = useLive();
  const inS = backoff ? retryInS(backoff, now) : null;
  const retrying = feed.status === "error" || backoff !== null;
  const label =
    backoff !== null
      ? inS
        ? `Retrying in ${inS}s`
        : "Retrying"
      : feed.status === "ok"
        ? `Live ${newYork(feed.asOf, false)}`
        : feed.status === "off"
          ? feed.why === "plan"
            ? "Live off: SIP is not on this data plan"
            : feed.why === "feed"
              ? "Live off: ALPACA_FEED is not iex or sip"
              : "Live off"
          : feed.status === "error"
            ? "Retrying"
            : "Connecting";
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-[0.6875rem] max-sm:text-xs" aria-live="off">
      <span
        className={cn(
          "inline-block size-2 rounded-full",
          retrying ? "bg-warn-fill" : feed.status === "ok" ? "bg-good-fill motion-safe:animate-pulse" : "bg-neutral-fill",
        )}
      />
      {label}
      {backoff === null && feed.status === "ok" ? <FeedName source={feed.source} lead=" · " /> : null}
    </span>
  );
}

/** DEC-0050: SIP is the board's stock feed; IEX is comparison-only, so the board reading it is a warning. */
export const IEX_WARNING = "DEC-0050: the board should read SIP";

/**
 * The feed an answer named, as the pill and the facts line write it (feed-provenance.ts feedLabel): "SIP ·
 * authoritative", or "IEX" in the warning tone with the DEC-0050 note as its title. Nothing when it named none.
 */
export function FeedName({ source, lead = "", trail = "" }: { source: unknown; lead?: string; trail?: string }) {
  const name = feedLabel(source);
  if (!name) return null;
  return (
    <>
      {lead}
      {name === "SIP" ? (
        <span data-feed-name="SIP" className="text-foreground font-medium">
          SIP · authoritative
        </span>
      ) : (
        <span data-feed-name="IEX" title={IEX_WARNING} aria-description={IEX_WARNING} className="text-warn font-medium">
          IEX
        </span>
      )}
      {trail}
    </>
  );
}

/** One age in a slot of fixed width with even digits, so the text around it never moves as it ticks. */
function AgeSlot({ ms, end }: { ms: number | null; end?: "newest" | "oldest" }) {
  return (
    <span
      data-age-slot
      data-age-end={end}
      data-age-s={ms === null ? undefined : ageSeconds(ms)}
      className="inline-block min-w-[6ch] text-right font-mono tabular-nums"
    >
      {ms === null ? "–" : ageText(ms)}
    </span>
  );
}

/** "1 name" / "2 names". */
const names = (n: number) => `${n} name${n === 1 ? "" : "s"}`;

/**
 * What the live prices are and how old: the feed the last answer named ("IEX" or "SIP"; nothing when it named none),
 * that the page asks for them every 2 s rather than being sent each trade, and two ages on the board's (server) clock
 * (feed-provenance.ts). The last trades as a spread across `symbols`, newest to oldest, so a busy name cannot make a
 * quiet one look fresh (one value for one name, or when both ends read the same); names with no trade today are left
 * out of it and counted beside it. And when the page last got an answer: a price re-fetched a second ago can be a
 * minute-old trade, so the two are drawn apart. The spread turns to a warning colour when its oldest end passes the
 * board's trade limit, the answer when it passes the feed limit. Nothing while the feed has not answered or is off.
 * Not a live region: the ages tick every second and are never announced; a reader finds them in place. Each piece
 * keeps to one line and the ages to fixed slots (the second end keeps its room while hidden), so the line wraps the
 * same way whatever they read and nothing under it moves.
 */
export function FeedFacts({ symbols, where }: { symbols?: readonly string[]; where: "board" | "glance" }) {
  const { feed, now, session } = useLive();
  if (feed.status !== "ok") return null;
  const ages = feedAges(feed, symbols ?? null, now, session || null);
  const { newestMs, oldestMs, traded, noTrade } = ages.trade;
  const tradeStale = oldestMs !== null && ageStale("trade", oldestMs);
  const oneEnd = traded <= 1 || (newestMs !== null && oldestMs !== null && ageText(newestMs) === ageText(oldestMs));
  return (
    <p
      data-feed-facts={where}
      aria-live="off"
      className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.6875rem] max-sm:text-xs"
    >
      <span data-feed-source className="whitespace-nowrap">
        <FeedName source={feed.source} trail=" · " />
        fetched every {POLL_MS / 1000} s, not streamed
      </span>
      {traded > 0 ? (
        <span
          data-feed-age="trade"
          data-trade-stale={tradeStale ? "true" : "false"}
          className={cn("text-foreground flex items-center gap-1 whitespace-nowrap font-medium", tradeStale && "text-warn")}
        >
          <Activity aria-hidden className="size-3 shrink-0" />
          {traded > 1 ? "last trades" : "last trade"} <AgeSlot ms={newestMs} end="newest" />{" "}
          {traded > 1 ? (
            <span data-age-range={oneEnd ? "one" : "two"} aria-hidden={oneEnd || undefined} className={cn("flex items-center gap-1", oneEnd && "invisible")}>
              to <AgeSlot ms={oldestMs} end="oldest" />
            </span>
          ) : null}{" "}
          ago
        </span>
      ) : null}
      {noTrade > 0 ? (
        <span data-feed-no-trade={noTrade} className="text-warn whitespace-nowrap font-medium">
          {traded > 0 ? `${names(noTrade)} with no trade today` : "no trade today"}
        </span>
      ) : null}
      <span data-feed-age="checked" className={cn("flex items-center gap-1 whitespace-nowrap", ages.checkedMs !== null && ageStale("checked", ages.checkedMs) && "text-warn")}>
        <RefreshCw aria-hidden className="size-3 shrink-0" />
        checked <AgeSlot ms={ages.checkedMs} /> ago
      </span>
    </p>
  );
}

/** What the retry line announces: once when it appears, and again only when the reason changes, never each second. */
export function retrySpoken(b: Backoff | null): string {
  if (!b) return "";
  return b.limited ? "Live prices busy. Trying again in about 30 seconds." : "Live prices did not answer. Trying again shortly.";
}

/**
 * One quiet line while the live prices are being tried again after failing: why, in how many seconds, and a button
 * that tries once now (keeping the count of failures, so the waits after it still grow). After a rate limit the button
 * is off and the line says the wait stands. Laid over the board's header row (`absolute inset-0`, the row is
 * `relative`), so nothing on the board moves when it comes or goes. Its live region is always there and changes only
 * with retrySpoken, so a reader hears it once, not every second. Nothing drawn while the prices answer.
 */
export function FeedRetry() {
  const { backoff, now, retryNow } = useLive();
  const spoken = retrySpoken(backoff);
  const inS = backoff ? retryInS(backoff, now) : null;
  const going = backoff?.at === null;
  return (
    <>
      <p data-feed-retry-spoken role="status" aria-live="polite" className="sr-only">
        {spoken}
      </p>
      {backoff ? (
        <div
          data-feed-retry={going ? "now" : backoff.limited ? "limited" : "waiting"}
          className="bg-card text-warn absolute inset-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] font-medium max-sm:flex-nowrap max-sm:text-xs"
        >
          <RotateCw aria-hidden className={cn("size-3 shrink-0", going && "motion-safe:animate-spin")} />
          {/* The count is for the eye; the live region above says it once in words. */}
          {/* On a phone the words wrap beside the button rather than above it, so the line stays inside the row. */}
          <span aria-hidden className="min-w-0 max-sm:flex-1">
            {backoff.limited ? "Live prices busy" : "Live prices did not answer"}: {going || !inS ? "trying again now" : `trying again in ${inS}s`}
          </span>
          {/* 44 px to touch: on a phone's width, and on any screen whose main pointer is a finger (a tablet). */}
          <button
            type="button"
            onClick={retryNow}
            disabled={going || backoff.limited}
            className="text-foreground hover:bg-accent shrink-0 rounded border px-2 py-0.5 font-medium disabled:opacity-50 max-sm:min-h-11 max-sm:px-3 pointer-coarse:min-h-11 pointer-coarse:px-3"
          >
            Retry now
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * The live price on a level map: a dot that walks across the gap between the last candle and the one-day line as
 * the session goes by, a faint trail of the last few minutes behind it, and a thin line across the chart at the
 * price. Hollow when the quote is stale. Drawn in the map's own viewBox units; nothing outside the session.
 */
export function LiveMapMark({
  t,
  lo,
  hi,
  top,
  bottom,
  xFrom,
  xTo,
  lineFrom,
  lineTo,
}: {
  t: OptionsTicker;
  lo: number;
  hi: number;
  top: number;
  bottom: number;
  xFrom: number;
  xTo: number;
  lineFrom: number;
  lineTo: number;
}) {
  const read = useLiveRead(t);
  if (!read.inSession || read.price === null || !read.q || hi <= lo) return null;
  const y = (p: number) => top + ((hi - Math.max(lo, Math.min(hi, p))) / (hi - lo)) * (bottom - top);
  const x = (iso: string | number) => {
    const share = sessionShare(t, typeof iso === "number" ? new Date(iso).toISOString() : iso);
    return xFrom + (share ?? 0) * (xTo - xFrom);
  };
  const cx = x(read.q.at);
  const cy = y(read.price);
  const trail = read.trail.filter((pt) => pt.at >= Date.parse(read.q!.at) - TRAIL_MS);
  const off = read.price > hi ? "above" : read.price < lo ? "below" : null;
  return (
    <g data-testid={`${t.symbol}-live-mark`}>
      <title>{`Live ${num(read.price, 2)} at ${newYork(read.q.at, false)} New York${read.stale ? `, stale (${read.ageS}s old)` : ""}${off ? `, ${off} the chart` : ""}`}</title>
      <line x1={lineFrom} x2={lineTo} y1={cy} y2={cy} stroke="var(--warn-fill)" strokeOpacity={0.8} strokeWidth={1.2} />
      {trail.length > 1 ? (
        <polyline
          points={trail.map((pt) => `${x(pt.at)},${y(pt.p)}`).join(" ")}
          fill="none"
          stroke="var(--foreground)"
          strokeOpacity={0.35}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      ) : null}
      <circle
        cx={cx}
        cy={cy}
        r={5}
        fill={read.stale ? "var(--card)" : "var(--warn-fill)"}
        stroke={read.stale ? "var(--warn-fill)" : "var(--card)"}
        strokeWidth={2}
        strokeDasharray={read.stale ? "2 2" : undefined}
      />
      <text x={xTo + 4} y={cy + 4} fontSize={10.5} fontWeight={600} style={{ fill: "var(--warn)" }} className="font-mono">
        {off === "above" ? "now ↑" : off === "below" ? "now ↓" : "now"}
      </text>
    </g>
  );
}

const FOCUS_KEY = "options-focus";
const FOCUS_EVENT = "options-focus";

function readFocus(): boolean {
  try {
    return window.localStorage.getItem(FOCUS_KEY) === "on";
  } catch {
    return false;
  }
}
// Storage can be blocked (private mode); the choice then lasts for this page only.
let focusFallback = false;
const focusNow = () => readFocus() || focusFallback;
function subscribeFocus(onChange: () => void) {
  window.addEventListener(FOCUS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(FOCUS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
function setFocus(on: boolean) {
  focusFallback = on;
  try {
    window.localStorage.setItem(FOCUS_KEY, on ? "on" : "off");
  } catch {
    // kept in focusFallback
  }
  window.dispatchEvent(new Event(FOCUS_EVENT));
}
const useFocus = () => useSyncExternalStore(subscribeFocus, focusNow, () => false);

/**
 * Focus mode for the Options page: one button hides every explanation, table fold and research panel, leaving the
 * glance strip, the level maps and the chips. Remembered in this browser only.
 */
export function FocusScope({ children }: { children: React.ReactNode }) {
  const on = useFocus();
  return (
    <div data-focus={on ? "on" : "off"} className="group/focus grid gap-5">
      {children}
    </div>
  );
}

export function FocusButton() {
  const on = useFocus();
  return (
    <Button variant={on ? "secondary" : "outline"} size="sm" onClick={() => setFocus(!on)} aria-pressed={on}>
      <Focus aria-hidden />
      {on ? "Show everything" : "Focus mode"}
    </Button>
  );
}
