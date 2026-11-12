"use client";

import { Archive, CircleCheck, MoonStar, OctagonX, TriangleAlert, CircleDashed } from "lucide-react";
import { usePathname } from "next/navigation";
import { deskOfPath, type DeskName } from "@/lib/desk";
import { deskNote } from "@/lib/desk-state";
import { describeAge, freshness, type FreshState, shortAge } from "@/lib/freshness";
import type { ExpectedWindow } from "@/lib/types";
import { pricePill, type PricePillState, type PriceStatus } from "@/lib/price-pill";
import { cn } from "@/lib/utils";
import { usePriceStatus } from "./price-status";
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

// The header is one row on a laptop (the browser tests hold it), so every wording here stays about as short as the
// longest it replaced; the tooltip carries the longer explanation.
function label(state: FreshState, ageMin: number | null): string {
  switch (state) {
    case "fresh":
      return `Lab host (VM) · ${describeAge(ageMin ?? 0)}`;
    case "late":
      return `Lab host (VM) late · ${shortAge(ageMin ?? 0)}`;
    case "stopped":
      return `Lab host (VM) stopped · ${shortAge(ageMin ?? 0)}`;
    case "asleep":
      return "Lab host (VM) · resting";
    default:
      return "Lab host (VM): no data yet";
  }
}

/** The tooltip: what the pill measures, and for a resting host that the quiet is expected. */
function hostTitle(state: FreshState, asOf: string | null): string {
  const what = "Status of the lab host, the cloud VM that runs the lab's jobs, published every few minutes. Not a price.";
  const rest = state === "asleep" ? " Between sessions now, which is expected." : "";
  return `${what}${rest}${asOf ? ` Last published ${asOf}.` : ""}`;
}

/** The phone's word for the pill, or null where the full words are short enough already. */
export function pillWord(state: FreshState, ageMin: number | null): string | null {
  switch (state) {
    case "fresh":
      return `Host ${shortAge(ageMin ?? 0)}`;
    case "late":
      return `Host late ${shortAge(ageMin ?? 0)}`;
    case "stopped":
      return `Host stopped ${shortAge(ageMin ?? 0)}`;
    case "asleep":
      return "Host resting";
    default:
      return "Host: no data";
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

/**
 * Header freshness pill: the age of the lab's status snapshot (job health, paper accounts, research), which the host
 * publishes every few minutes. It is not a price: it says "Lab host (VM)", the machine that runs the lab's jobs, so it is not read as the board's freshness.
 * The server passes its own reading; the browser keeps it current.
 */
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
      title={hostTitle(f.state, asOf)}
      className={cn(PILL, cls)}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <Words full={label(f.state, f.ageMin)} short={pillWord(f.state, f.ageMin)} />
    </span>
  );
}

const PRICE_STYLE: Record<PricePillState, { cls: string; Icon: typeof CircleCheck }> = {
  live: STYLE.fresh,
  paused: STYLE.stopped,
  connecting: STYLE.unknown,
  off: STYLE.late,
  closed: STYLE.asleep,
};

/** On a page that polls live prices: how fresh they are, in the lab pill's place (price-pill.ts). */
function PricePillView({ status }: { status: PriceStatus }) {
  const nowMs = useNow(1_000);
  // Before the browser's clock is known nothing is claimed: the pill only says it is connecting.
  const pill = nowMs === null ? null : pricePill(status, nowMs);
  const { cls, Icon } = PRICE_STYLE[pill?.state ?? "connecting"];
  return (
    <span role="status" title={pill?.title} className={cn(PILL, cls)}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <Words full={pill?.full ?? "Prices connecting"} short={pill?.short ?? "Connecting"} />
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
  const price = usePriceStatus();
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
  if (desk === "stocks" && price) return <PricePillView status={price} />;
  const d = desks[desk];
  return <FreshnessPill asOf={d.asOf} windows={d.windows} initial={d.initial} />;
}
