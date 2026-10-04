"use client";

import { CircleCheck, MoonStar, OctagonX, TriangleAlert, CircleDashed } from "lucide-react";
import { usePathname } from "next/navigation";
import { deskOfPath } from "@/lib/desk";
import { describeAge, freshness, type FreshState } from "@/lib/freshness";
import type { ExpectedWindow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useNow } from "./use-now";

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
  const text = label(f.state, f.ageMin);
  return (
    <span
      role="status"
      aria-live="polite"
      title={asOf ? `Snapshot time ${asOf}` : undefined}
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap", cls)}
    >
      <Icon aria-hidden className="size-3.5" />
      {text}
    </span>
  );
}

export interface DeskFreshness {
  asOf: string | null;
  windows: ExpectedWindow[];
  initial: { state: FreshState; ageMin: number | null };
}

/** The pill of the desk the current page belongs to. Each desk has its own snapshot and its own freshness. */
export function DeskFreshnessPill({ stocks, crypto }: { stocks: DeskFreshness; crypto: DeskFreshness }) {
  const d = deskOfPath(usePathname()) === "crypto" ? crypto : stocks;
  return <FreshnessPill asOf={d.asOf} windows={d.windows} initial={d.initial} />;
}
