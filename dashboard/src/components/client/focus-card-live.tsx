"use client";

// The live pieces of a focus card, kept small: the state chip in the card's header, the frame that emphasises the side
// the board points at, the live distance in each side's strip, and the alternative chips that light up when the board
// shows one live. Everything they read is the page's one board (trade-now's useBoardRow) and its one live feed
// (ladder-live's useLadderLive), so the card always says what the board says. Read only: nothing here is an order.
import { Ban, CircleCheck, Eye, GitBranch, Hourglass, type LucideIcon, OctagonX, Pause, SkipForward, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/status";
import { altIsLive, type AltChip, type CardSide, stripDistance, stripEmphasis } from "@/lib/focus-card";
import type { NameStateName } from "@/lib/trade-state";
import { cn } from "@/lib/utils";
import { type LadderLiveProps, useLadderLive } from "./ladder-live";
import { boardSide, TestingTag, useBoardRow } from "./trade-now";

// The board's own icons per state (trade-now draws its badge with the same set; it does not export it).
const STATE_ICON: Record<NameStateName, LucideIcon> = {
  no_trade: Ban,
  watch: Eye,
  get_ready: Hourglass,
  enter_zone: CircleCheck,
  plan_off: OctagonX,
  missed: SkipForward,
  paused: Pause,
};

/**
 * The name's live state in the card's header: the board's badge word, tone, icon and side, then its cautions. Nothing
 * when the board has no live row for the name (before the open, an old edition, prices off).
 */
export function FocusStateChip({ symbol }: { symbol: string }) {
  const r = useBoardRow(symbol);
  const s = r?.row.state;
  const v = r?.view;
  if (!r || !s || !v) return null;
  const icon = r.paused ? Pause : v.badge.alt ? GitBranch : STATE_ICON[s.state];
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-focus-state={r.paused ? "paused" : s.state}>
      {/* text-sm (14 px) and its own icon size: the board's badge, at the card's reading size. */}
      <StatusBadge tone={r.paused ? "neutral" : v.badge.tone} icon={icon} className="px-2 py-0.5 text-sm font-semibold [&>svg]:size-4">
        {v.badge.word}
        {v.badge.side && !r.paused ? ` · ${v.badge.side.toUpperCase()}` : ""}
      </StatusBadge>
      {v.testing && !r.paused ? <TestingTag /> : null}
      {!r.paused
        ? s.cautions.map((c) => (
            <StatusBadge key={c.id} tone="warn" icon={TriangleAlert} className="px-2 py-0.5 text-sm [&>svg]:size-4">
              <span title={c.why}>{c.word}</span>
            </StatusBadge>
          ))
        : null}
      {!r.paused && s.moreCautions ? <span className="text-muted-foreground text-sm">+{s.moreCautions} more</span> : null}
    </div>
  );
}

const SIDE_FRAME = {
  call: { edge: "border-l-good-fill", on: "bg-good-soft border-good-fill ring-good-fill" },
  put: { edge: "border-l-bad-fill", on: "bg-bad-soft border-bad-fill ring-bad-fill" },
} as const;

/**
 * One side's decision strip frame. The side the board points at gets a tinted fill, a ring and the words "Board: this
 * side"; the far side a dashed border and muted words (its numbers stay readable). The strip's content is passed in,
 * server-rendered; children read the emphasis through `group-data-[emph=off]/strip:`.
 */
export function SideFrame({ symbol, side, label, children }: { symbol: string; side: CardSide; label: string; children: ReactNode }) {
  const e = stripEmphasis(side, boardSide(useBoardRow(symbol)));
  const f = SIDE_FRAME[side];
  return (
    <section
      aria-label={label}
      data-strip={side}
      data-emph={e}
      className={cn("group/strip relative grid gap-1.5 rounded-md border border-l-4 px-2.5 py-2", f.edge, e === "on" && cn(f.on, "ring-1"), e === "off" && "border-dashed")}
    >
      {children}
      {e === "on" ? <span className="text-foreground text-sm font-semibold">Board: this side</span> : null}
    </section>
  );
}

/** The ladder's live inputs for one name (what useLadderLive reads). */
export type LiveInputs = Pick<LadderLiveProps, "symbol" | "session" | "halfDay" | "premarket" | "close" | "closeDate" | "ceiling" | "floor" | "atr" | "move">;

/**
 * The live distance from the price to this side's trigger: "1.18 away" large, "0.2× move" small under it. Nothing when
 * the ladder's view has no distance, never a stale number. Its space is always reserved, so nothing moves when it
 * appears.
 */
export function LiveDistance({ side, live }: { side: CardSide; live: LiveInputs }) {
  const d = stripDistance(useLadderLive(live), side);
  return (
    <span className="inline-grid justify-items-end text-right" data-live-distance={d ? d.from : "none"}>
      {/* The reserved box: as wide and tall as a typical reading, invisible. */}
      <span aria-hidden className="invisible col-start-1 row-start-1 grid">
        <span className="text-live font-mono tabular-nums">00.00 away</span>
        <span className="text-explain">0.0× move</span>
      </span>
      {d ? (
        <span className="col-start-1 row-start-1 grid">
          <span className={d.near ? "text-live text-foreground font-mono font-semibold tabular-nums" : "text-live text-foreground font-mono tabular-nums"}>{d.away}</span>
          <span className="text-explain text-muted-foreground">
            {d.from === "pre" ? "from pre-market" : null}
            {d.from === "pre" && d.move ? " · " : null}
            {d.move}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The four alternative triggers as compact chips: "Failed break · put 779.40". A chip lights up in the warn tone, with
 * an icon and the word "live", only while the board shows that alternative live. The full sentence is the chip's title
 * (and is listed in the card's fold).
 */
export function AltChips({ symbol, chips }: { symbol: string; chips: AltChip[] }) {
  const r = useBoardRow(symbol);
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Other triggers, under test">
      {chips.map((a) => {
        const lit = altIsLive(r, a.kind, a.side);
        return (
          <li
            key={`${a.kind}-${a.side}`}
            data-alt={a.kind}
            data-alt-side={a.side}
            data-alt-live={lit ? "yes" : undefined}
            title={a.line}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm",
              lit ? "bg-warn-soft border-warn-fill text-warn font-semibold" : "text-muted-foreground",
            )}
          >
            {lit ? <GitBranch aria-hidden className="size-4" /> : <span aria-hidden>{a.side === "call" ? "▲" : "▼"}</span>}
            <span>{a.word}</span>
            <span className="text-foreground font-mono font-semibold tabular-nums">{a.level.toFixed(2)}</span>
            {lit ? <span>· live</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
