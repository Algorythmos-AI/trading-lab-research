// The status rail's buttons share one shape and one set of colours, so the five controls line up and a colour means
// the same thing on each: green works, amber needs you, red failed, blue is for your attention, grey is at rest.
import type { Tone } from "@/lib/labels";
import { cn } from "@/lib/utils";

/** The shared shape: 32 px tall from sm up, a 44 px square target on a phone. */
export const RAIL_BUTTON =
  "relative inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 text-sm font-medium whitespace-nowrap transition-colors max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center max-sm:px-2 disabled:opacity-60";

/** Each tone's colours; "neutral" is the plain outline of a button at rest. */
export const RAIL_TONE: Record<Tone, string> = {
  neutral: "text-muted-foreground hover:text-foreground",
  good: "border-good-fill/60 bg-good-soft text-good",
  warn: "border-warn-fill/70 bg-warn-soft text-warn",
  bad: "border-bad-fill/60 bg-bad-soft text-bad",
  info: "border-info-fill/60 bg-info-soft text-info",
};

/** A rail button's classes in a tone. */
export const railButton = (tone: Tone, ...more: (string | false | null | undefined)[]) => cn(RAIL_BUTTON, RAIL_TONE[tone], ...more);
