"use client";

// The live layer of a price ladder: the price dot, a thin "now" line and, under the ladder, the price with its source
// and the distance to each trigger. It reads the page's one live feed (live-layer's useLive, read with options.ts liveRead on the board's clock) and the
// board's mode (trade-now's boardMode), so the dot says the same as the board: live only while the feed is live and
// fresh, hollow when stale, a hollow diamond before the open, nothing when prices are off or paused.
//
// The static ladder (components/level-ladder.tsx) is passed in as children; this layer draws over it in the same
// viewBox. The side the board highlights keeps full opacity; the other side's marks are dimmed by CSS (data-highlight).
// Read only: it shows prices, nothing else. The only motion is the dot moving, and not for a reader who asks for
// reduced motion.
import type { ReactNode } from "react";
import { newYork } from "@/lib/format";
import { closeMinute, liveRead, nyClock, type OptionsTicker } from "@/lib/options";
import { boardMode } from "@/lib/trade-now";
import { FEED_STALE_MS, serverNow, TRADE_STALE_MS } from "@/lib/trade-state";
import { type LadderFrame, type LadderLiveView, ladderLiveView } from "@/lib/level-ladder";
import { cn } from "@/lib/utils";
import { useLive } from "./live-layer";

export interface LadderLiveProps {
  ticker: OptionsTicker;
  session: string;
  halfDay: boolean;
  premarket: number | null;
  close: number | null;
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

/** The dot's view from the live feed and the board's clock. */
export function useLadderLive(p: Pick<LadderLiveProps, "ticker" | "session" | "halfDay" | "premarket" | "close" | "ceiling" | "floor" | "atr" | "move">): LadderLiveView {
  const { feed, now: browserNow } = useLive();
  const ok = feed.status === "ok";
  // The board's clock, as the Trade now board keeps it: the feed's (server) time once it has answered, the
  // browser's before; and the answer's own (server) time, so both ages are read on one clock.
  const now = browserNow === null ? null : serverNow(ok ? feed.asOf : null, ok ? feed.receivedAt : null, browserNow).getTime();
  const answeredAt = ok && Number.isFinite(Date.parse(feed.asOf)) ? Date.parse(feed.asOf) : null;
  const mode = now === null ? "loading" : boardMode(p.session, p.halfDay, feed.status, now).kind;
  const q = ok ? feed.quotes[p.ticker.symbol] : undefined;
  const read = liveRead(p.ticker, q, p.session, now, answeredAt);
  // As the board's "prices paused" row: no quote, the feed silent, or the last trade too old.
  const paused = now === null || answeredAt === null || !q || now - answeredAt > FEED_STALE_MS || !(now - Date.parse(q.at) <= TRADE_STALE_MS);
  const clock = now === null ? null : nyClock(new Date(now).toISOString());
  const afterClose = clock !== null && clock.day === p.session && clock.minutes >= closeMinute(p.halfDay);
  return ladderLiveView({
    mode,
    paused: (mode === "live" || mode === "opening") && paused,
    read,
    liveAt: read.q ? newYork(read.q.at, false) : null,
    premarket: p.premarket,
    close: p.close,
    afterClose,
    lastPrice: afterClose && q && q.day === p.session ? q.price : null,
    ceiling: p.ceiling,
    floor: p.floor,
    atr: p.atr,
    move: p.move,
  });
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
      <title>{`${dot.label}${dot.kind === "live" || dot.kind === "stale" ? ` · ${dot.price.toFixed(2)}` : ""}${off ? `, ${off} the scale` : ""}`}</title>
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
          <span className={cn("font-mono text-[20px] font-medium tabular-nums sm:text-[24px]", dot.kind === "stale" && "text-muted-foreground")}>{dot.price.toFixed(2)}</span>
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

/** The static ladder with the live dot over it, and the note under it (not on the mini). */
export function LadderLive(props: LadderLiveProps) {
  const view = useLadderLive(props);
  const { frame, domain, highlight, busy, children } = props;
  return (
    <div className="grid gap-2">
      <div className="group/ladder relative" data-highlight={highlight ?? "none"} style={frame.size === "mini" ? { maxWidth: frame.width } : undefined}>
        {children}
        <svg aria-hidden viewBox={`0 0 ${frame.width} ${frame.height}`} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          <LadderMark view={view} frame={frame} domain={domain} busy={busy} />
        </svg>
      </div>
      {frame.size === "mini" ? null : <LadderNote view={view} />}
    </div>
  );
}
