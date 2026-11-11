"use client";

import { Archive, CircleCheck, MoonStar, OctagonX, TriangleAlert, CircleDashed } from "lucide-react";
import { usePathname } from "next/navigation";
import { deskOfPath, type DeskName } from "@/lib/desk";
import { deskNote } from "@/lib/desk-state";
import { describeAge, freshness, type FreshState, shortAge } from "@/lib/freshness";
import type { ExpectedWindow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useNow } from "./use-now";

/**
 * On a phone the pill shares the header's first row, which never wraps: there it shows a short word that fits
 * (pillWord) and the full words are read out instead. Never an ellipsis.
 */
const PILL = "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap max-sm:min-w-0";

const STYLE: Record<FreshState, { cls: string; Icon: typeof CircleCheck }> = {
  fresh: { cls: "bg-good-soft text-good border-good/30", Icon: CircleCheck },
  late: { cls: "bg-warn-soft text-warn border-warn/35", Icon: TriangleAlert },
  stopped: { cls: "bg-bad-soft text-bad border-bad/30", Icon: OctagonX },
  asleep: { cls: "bg-neutral-soft text-neutral border-neutral/25", Icon: MoonStar },
  unknown: { cls: "bg-neutral-soft text-neutral border-neutral/25", Icon: CircleDashed },
};

function label(state: FreshState, ageMin: number | null): string {
  switch (state) {
    case "fresh":
      return `Updated ${describeAge(ageMin ?? 0)}`;
    case "late":
      return `Late: ${describeAge(ageMin ?? 0)}`;
    case "stopped":
      return `Stopped: ${describeAge(ageMin ?? 0)}`;
    case "asleep":
      return "Between sessions (expected)";
    default:
      return "No data yet";
  }
}

/** The phone's word for the pill, or null where the full words are short enough already. */
export function pillWord(state: FreshState, ageMin: number | null): string | null {
  switch (state) {
    case "fresh":
      return `Updated ${shortAge(ageMin ?? 0)}`;
    case "late":
      return `Late ${shortAge(ageMin ?? 0)}`;
    case "stopped":
      return `Stopped ${shortAge(ageMin ?? 0)}`;
    case "asleep":
      return "Between";
    default:
      return null;
  }
}

/** The full words, then the phone's short word in their place below sm (the full words still read out there). */
function Words({ full, short }: { full: string; short: string | null }) {
  if (short === null) return <>{full}</>;
  return (
    <>
      <span className="max-sm:sr-only">{full}</span>
      <span aria-hidden className="sm:hidden">
        {short}
      </span>
    </>
  );
}

/** Header freshness pill. The server passes its own reading; the browser keeps it current. */
export function FreshnessPill({
  asOf,
  windows,
  initial,
}: {
  asOf: string | null;
  windows: ExpectedWindow[];
  initial: { state: FreshState; ageMin: number | null };
}) {
  const nowMs = useNow(15_000);
  const f = nowMs === null ? initial : freshness(asOf, windows, nowMs);
  const { cls, Icon } = STYLE[f.state];
  return (
    <span
      role="status"
      aria-live="polite"
      title={asOf ? `Snapshot time ${asOf}` : undefined}
      className={cn(PILL, cls)}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <Words full={label(f.state, f.ageMin)} short={pillWord(f.state, f.ageMin)} />
    </span>
  );
}

export interface DeskFreshness {
  asOf: string | null;
  windows: ExpectedWindow[];
  initial: { state: FreshState; ageMin: number | null };
}

/**
 * The pill of the desk the current page belongs to. Each desk has its own snapshot and its own freshness. A desk
 * the lab has closed (src/lib/desks.json) publishes nothing by decision, so its pill says that instead of an age.
 */
export function DeskFreshnessPill({ desks }: { desks: Record<DeskName, DeskFreshness> }) {
  const desk = deskOfPath(usePathname());
  if (desk !== "stocks" && deskNote(desk).state === "closed") {
    return (
      <span
        role="status"
        className={cn(PILL, STYLE.unknown.cls)}
      >
        <Archive aria-hidden className="size-3.5 shrink-0" />
        Desk closed
      </span>
    );
  }
  const d = desks[desk];
  return <FreshnessPill asOf={d.asOf} windows={d.windows} initial={d.initial} />;
}
