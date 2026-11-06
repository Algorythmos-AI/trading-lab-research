"use client";

// The live layer of a price ladder: the price dot, a thin "now" line and, under the ladder, the price with its source
// and the distance to each trigger. It reads the page's one live feed (live-layer's useLive) on the board's own clock
// and with the board's own rules (level-ladder's ladderLiveState: boardMode, FEED_STALE_MS, TRADE_STALE_MS, a quote
// only when it is the session day's), so the dot says what the board says: filled and live only while the board would
// use the price; before the open a hollow diamond (pre-market, or the edition's close with its date); after the close
// the day's last trade; nothing when prices are off or paused.
//
// The static ladder (components/level-ladder.tsx) is passed in as children; this layer draws over it in the same
// viewBox. The side the board highlights keeps full opacity; the other side's marks are dimmed by CSS (data-highlight).
// An alternative the board shows live lights its marker in the warn tone by CSS (data-live-alt), and dims nothing: its
// numbers are its own, not either side's plan.
// Read only: it shows prices, nothing else. The only motion is the dot moving, and not for a reader who asks for
// reduced motion.
import type { ReactNode } from "react";
import { type LadderFrame, type LadderLiveView, ladderLiveState } from "@/lib/level-ladder";
import { cn } from "@/lib/utils";
import { useLive } from "./live-layer";
import { boardAlt, boardSide, useBoardRow } from "./trade-now";

export interface LadderLiveProps {
  symbol: string;
  session: string;
  /** The edition's half day (options.ts isHalfDay), the board's one source. */
  halfDay: boolean;
  premarket: number | null;
  close: number | null;
  /** The day the edition's close is from (its built_from), for the "close Fri 9 Oct" label. */
  closeDate: string | null;
  ceiling: number | null;
  floor: number | null;
  atr: number | null;
  move: number | null;
  frame: LadderFrame;
  domain: { lo: number; hi: number };
  /** The side the board highlights: its marks keep full opacity, the other side's are dimmed. */
  highlight?: "call" | "put";
  /** The y of each label already in the left gutter (the alternative triggers), so the dot's tag steps around them. */
  busy?: readonly number[];
  /** The static ladder SVG. */
  children: ReactNode;
}

/** The dot's view from the page's live feed and the browser's clock (all the rules are in ladderLiveState). */
export function useLadderLive(
  p: Pick<LadderLiveProps, "symbol" | "session" | "halfDay" | "premarket" | "close" | "closeDate" | "ceiling" | "floor" | "atr" | "move">,
): LadderLiveView {
  const { feed, now } = useLive();
  return ladderLiveState({ ...p, feed, browserNow: now });
}

/**
 * Where the dot's tag goes in the left gutter: at the dot's own height when free, else the nearest free step above or
 * below it, inside the frame. Pure.
 */
export function tagY(y: number, busy: readonly number[], gap: number, top: number, bottom: number): number {
  const free = (v: number) => v >= top && v <= bottom && busy.every((b) => Math.abs(b - v) >= gap);
  for (let k = 0; k <= 12; k++)
    for (const v of k === 0 ? [y] : [y - k * (gap / 2), y + k * (gap / 2)]) if (free(v)) return v;
  return Math.min(bottom, Math.max(top, y));
}

/**
 * The dot, the "now" line and the dot's tag, in the ladder's viewBox units. The tag sits in the left gutter beside the
 * dot (stepping around the gutter's markers), so it never covers the box or a level. Pure: the view is passed in.
 */
export function LadderMark({ view, frame, domain, busy = [] }: { view: LadderLiveView; frame: LadderFrame; domain: { lo: number; hi: number }; busy?: readonly number[] }) {
  const dot = view.dot;
  if (!dot || !(domain.hi > domain.lo)) return null;
  const top = frame.pad;
  const bottom = frame.height - frame.pad;
  const off = dot.price > domain.hi ? "above" : dot.price < domain.lo ? "below" : null;
  const clamped = Math.min(domain.hi, Math.max(domain.lo, dot.price));
  const y = top + ((domain.hi - clamped) / (domain.hi - domain.lo)) * (bottom - top);
  const live = dot.kind === "live";
  const diamond = dot.kind === "pre" || dot.kind === "close";
  const mini = frame.size === "mini";
  // At least 6 px, in the warn text tone: amber on dark, a dark amber on light (both at least 3:1 on the card).
  const r = mini ? 6 : 7;
  const label = `${dot.label}${off === "above" ? " ↑" : off === "below" ? " ↓" : ""}`;
  const ty = tagY(y, busy, frame.small + 4, top, bottom);
  return (
    <g data-testid="ladder-dot" data-dot={dot.kind}>
      <title>{`${dot.label}${dot.kind === "live" || dot.kind === "last" ? ` · ${dot.price.toFixed(2)}` : ""}${off ? `, ${off} the scale` : ""}`}</title>
      {/* The only motion: the dot and its line move to the new price (none for reduced motion). */}
      <g className="transition-transform duration-700 ease-out motion-reduce:transition-none" style={{ transform: `translateY(${y}px)` }}>
        <line x1={frame.lineFrom} x2={frame.lineTo} y1={0} y2={0} stroke="var(--warn)" strokeOpacity={live ? 0.9 : 0.7} strokeWidth={1.5} strokeDasharray={live ? undefined : "3 3"} />
        {diamond ? (
          <rect x={frame.dotX - r} y={-r} width={r * 2} height={r * 2} transform={`rotate(45 ${frame.dotX} 0)`} fill="var(--card)" stroke="var(--warn)" strokeWidth={2.5} />
        ) : (
          <circle
            cx={frame.dotX}
            cy={0}
            r={r}
            fill={live ? "var(--warn)" : "var(--card)"}
            stroke={live ? "var(--card)" : "var(--warn)"}
            strokeWidth={live ? 2 : 2.5}
            strokeDasharray={live ? undefined : "3 2"}
          />
        )}
      </g>
      {mini ? null : (
        <g>
          {ty !== y ? <line x1={frame.markerX + 2} y1={ty} x2={frame.dotX - r - 2} y2={y} stroke="var(--warn)" strokeWidth={1} /> : null}
          <text x={frame.markerX} y={ty} textAnchor="end" dominantBaseline="central" fontSize={frame.small} fontWeight={700} className="tabular-nums" style={{ fill: "var(--warn)" }}>
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

const TO = { ceiling: "Ceiling", floor: "Floor" } as const;

/**
 * Under the ladder: the price and its source, then one line per trigger at one size, the nearer first and bold, the
 * far one muted ("Ceiling 779.40 · 0.52 away · 0.1× move"). Pure: the view is passed in.
 */
export function LadderNote({ view }: { view: LadderLiveView }) {
  const dot = view.dot;
  return (
    <div data-testid="ladder-note" className="grid gap-1" aria-live="off">
      {dot ? (
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn("font-mono text-[20px] font-medium tabular-nums sm:text-[24px]", dot.kind !== "live" && "text-muted-foreground")}>{dot.price.toFixed(2)}</span>
          <span className="text-muted-foreground text-sm">
            {dot.label}
            {view.from === "pre" ? " · distances from pre" : ""}
          </span>
        </p>
      ) : null}
      {view.caption ? <p className="text-muted-foreground text-sm">{view.caption}</p> : null}
      {view.distances.length ? (
        <ul className="grid gap-0.5" data-testid="ladder-distances">
          {view.distances.map((d) => (
            <li key={d.to} data-near={d.near ? "yes" : undefined} className={cn("text-[15px] tabular-nums sm:text-[20px]", d.near ? "font-bold" : "text-muted-foreground font-medium")}>
              {TO[d.to]} {d.level.toFixed(2)} · {d.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The sentence a screen reader hears for what the board draws on the ladder: the highlighted side, or the live
 * alternative. The static list (level-ladder's LadderList) says nothing about it, since the board can change it.
 */
export function ladderBoardLine(highlight: "call" | "put" | null, alt: { kind: string; side: "call" | "put" } | null): string {
  if (highlight) return `The ${highlight} side is highlighted; the ${highlight === "call" ? "put" : "call"} side is dimmed.`;
  if (alt) return `The ${alt.kind === "failed_break" ? "failed break" : "sweep"} ${alt.side} is live now on the board; no side is dimmed.`;
  return "No side is highlighted.";
}

/** The value of data-live-alt the static ladder's markers are lit by (level-ladder's LIT): "fail-put", "sweep-call". */
export function liveAltKey(alt: { kind: "failed_break" | "sweep_reclaim"; side: "call" | "put" }): string {
  return `${alt.kind === "failed_break" ? "fail" : "sweep"}-${alt.side}`;
}

/** The static ladder with the live dot over it, and the note under it (not on the mini). */
export function LadderLive(props: LadderLiveProps) {
  const view = useLadderLive(props);
  // The side the page's board points at (an entry or a get-ready), unless the caller fixed one; and its live alternative.
  const r = useBoardRow(props.symbol);
  const fromBoard = boardSide(r);
  const alt = boardAlt(r);
  const { frame, domain, busy, children } = props;
  const highlight = props.highlight ?? fromBoard ?? undefined;
  return (
    <div className="grid gap-2">
      <p className="sr-only" data-testid="ladder-board-line">
        {ladderBoardLine(highlight ?? null, props.highlight ? null : alt)}
      </p>
      <div
        className="group/ladder relative"
        data-highlight={highlight ?? "none"}
        data-live-alt={!props.highlight && alt ? liveAltKey(alt) : undefined}
        style={frame.size === "mini" ? { maxWidth: frame.width } : undefined}
      >
        {children}
        <svg aria-hidden viewBox={`0 0 ${frame.width} ${frame.height}`} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          <LadderMark view={view} frame={frame} domain={domain} busy={busy} />
        </svg>
      </div>
      {frame.size === "mini" ? (
        // The mini draws no words beside its dot: one line for a screen reader instead.
        <p className="sr-only" data-testid="ladder-mini-note">
          {props.symbol}: {view.dot ? `${view.dot.label}${view.dot.kind === "live" || view.dot.kind === "last" ? `, ${view.dot.price.toFixed(2)}` : ""}` : (view.caption ?? "no price")}
        </p>
      ) : (
        <LadderNote view={view} />
      )}
    </div>
  );
}
