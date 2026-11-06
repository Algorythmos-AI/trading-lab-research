"use client";

// The fourfold glance: the four focus names side by side (two by two on a phone), each its small ladder with the price
// dot, the name and the board's state chip, in the same word and colour as the board. Tapping one brings its focus card
// into view. The ladders are the page's own (server-drawn LadderMini), passed in as children; the chip is read from the
// board, never worked out here. Read only.
import { CircleCheck, Ban, Eye, GitBranch, Hourglass, OctagonX, Pause, SkipForward, type LucideIcon } from "lucide-react";
import { StatusBadge } from "@/components/status";
import type { NameStateName } from "@/lib/trade-state";
import { cn } from "@/lib/utils";
import { openFocusCard, useBoardRow } from "./trade-now";

const STATE_ICON: Record<NameStateName, LucideIcon> = {
  no_trade: Ban,
  watch: Eye,
  get_ready: Hourglass,
  enter_zone: CircleCheck,
  plan_off: OctagonX,
  missed: SkipForward,
  paused: Pause,
};

/** A name's state chip as the board draws it; nothing outside the live mode, where the board has no state. */
export function BoardChip({ symbol, className }: { symbol: string; className?: string }) {
  const r = useBoardRow(symbol);
  if (!r || !r.view || !r.row.state) return null;
  const paused = r.paused || r.row.state.state === "paused";
  const v = r.view;
  const icon = paused ? Pause : v.badge.alt ? GitBranch : STATE_ICON[r.row.state.state];
  return (
    // The chip may wrap: "FAILED BREAK · PUT" is wider than a phone's glance tile (about 150 px), and a badge that
    // cannot shrink pushes the tile sideways or is clipped. The side wraps as one piece, never split from its dot.
    <span data-chip-state={paused ? "paused" : r.row.state.state} className="max-w-full min-w-0">
      <StatusBadge
        tone={paused ? "neutral" : v.badge.tone}
        icon={icon}
        className={cn("max-w-full shrink flex-wrap justify-start gap-x-1 gap-y-0 text-left font-sans text-sm whitespace-normal", className)}
      >
        <span>{paused ? "PRICES PAUSED" : v.badge.word}</span>
        {/* the space keeps the words apart in the text a reader or a test reads; the gap draws it */}
        {v.badge.side && !paused ? <>{" "}<span className="whitespace-nowrap">· {v.badge.side.toUpperCase()}</span></> : null}
      </StatusBadge>
    </span>
  );
}

/** One tile of the glance: a button that opens the name's focus card. */
export function GlanceTile({ symbol, children }: { symbol: string; children: React.ReactNode }) {
  const r = useBoardRow(symbol);
  const state = r?.row.state ? (r.paused ? "paused" : r.row.state.state) : "plan";
  return (
    <li data-glance={symbol} data-glance-state={state} className="min-w-0">
      <button
        type="button"
        onClick={() => openFocusCard(symbol)}
        className="bg-card hover:bg-muted/50 grid h-full w-full min-w-0 content-start gap-1.5 rounded-lg border p-2 text-left sm:p-3"
      >
        <span className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="font-mono text-base font-bold sm:text-lg">{symbol}</span>
          <BoardChip symbol={symbol} />
        </span>
        {children}
        <span className="sr-only">. Show the {symbol} focus card</span>
      </button>
    </li>
  );
}

/** The row of four. */
export function FocusGlance({ children }: { children: React.ReactNode }) {
  return (
    <section aria-label="The four focus names at a glance" data-focus-glance>
      <ul className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">{children}</ul>
    </section>
  );
}
