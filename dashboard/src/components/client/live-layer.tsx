"use client";

import {
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
  type LucideIcon,
} from "lucide-react";
import { createContext, useContext, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { newYork, num } from "@/lib/format";
import { liveRead, sessionShare, TRAIL_MS, type LiveRead, type LiveStateName, type OptionsTicker } from "@/lib/options";
import { cn } from "@/lib/utils";
import { useNow } from "./use-now";
import { useQuotes, type Feed } from "./use-quotes";

interface Live {
  feed: Feed;
  session: string;
  now: number | null;
}

const LiveContext = createContext<Live>({ feed: { status: "off" }, session: "", now: null });

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
  const feed = useQuotes(symbols, enabled);
  const now = useNow(1_000);
  return <LiveContext.Provider value={{ feed, session, now }}>{children}</LiveContext.Provider>;
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
      <Badge variant={variant} style={chipStyle(variant)} className={cn("chip-solid px-1 font-sans text-[0.625rem]", testing && !read.stale && "chip-pulse")}>
        <Icon aria-hidden />
        {read.state}
      </Badge>
      {read.stale ? (
        <Badge variant="warn" style={chipStyle("warn")} className="chip-solid px-1 font-sans text-[0.625rem]">
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

/** A small "is the feed alive" pill: live with the time of the last answer, off, or retrying. */
export function FeedPill() {
  const { feed } = useLive();
  const label =
    feed.status === "ok"
      ? `Live ${newYork(feed.asOf, false)}`
      : feed.status === "off"
        ? "Live off"
        : feed.status === "error"
          ? "Retrying"
          : "Connecting";
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-[0.6875rem]" aria-live="off">
      <span
        className={cn(
          "inline-block size-2 rounded-full",
          feed.status === "ok" ? "bg-good-fill motion-safe:animate-pulse" : feed.status === "error" ? "bg-warn-fill" : "bg-neutral-fill",
        )}
      />
      {label}
    </span>
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
