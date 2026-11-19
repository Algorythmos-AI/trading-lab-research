import { Check, Circle, CircleDot, CircleHelp, Hourglass, Pause, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type RailState = "done" | "current" | "failed" | "paused" | "todo" | "late" | "waiting" | "unknown";
export interface RailStep {
  key: string;
  label: string;
  state: RailState;
  /** The state in words, when the caller's own words fit better than the default ("Running" for a step under way). */
  words?: string;
  /** A short line under the state: a time. */
  detail?: string;
}

const LOOK: Record<RailState, { node: string; Icon: LucideIcon; words: string; text: string }> = {
  done: { node: "bg-good-fill border-good-fill text-white", Icon: Check, words: "Done", text: "text-good" },
  current: { node: "bg-card border-info text-info rail-now", Icon: CircleDot, words: "Now", text: "text-info" },
  failed: { node: "bg-bad-fill border-bad-fill text-white", Icon: X, words: "No", text: "text-bad" },
  paused: { node: "bg-warn-fill border-warn-fill text-black", Icon: Pause, words: "Paused", text: "text-warn" },
  todo: { node: "bg-card border-border text-muted-foreground", Icon: Circle, words: "Not yet", text: "text-muted-foreground" },
  late: { node: "bg-warn-fill border-warn-fill text-black", Icon: TriangleAlert, words: "Late", text: "text-warn" },
  waiting: { node: "bg-card border-info text-info", Icon: Hourglass, words: "Waiting", text: "text-info" },
  unknown: { node: "bg-card border-border border-dashed text-muted-foreground", Icon: CircleHelp, words: "No record", text: "text-muted-foreground" },
};

/**
 * Steps in order as one track. Each node carries an icon and its state in words, so colour is never alone.
 * `nowBefore`: the index of the step the clock has not reached yet; a small mark sits on the track before it.
 */
export function StepRail({ steps, label, nowBefore }: { steps: RailStep[]; label: string; nowBefore?: number | null }) {
  return (
    <ol className="flex items-start" aria-label={label}>
      {steps.map((s, i) => {
        const look = LOOK[s.state];
        const reached = i > 0 && steps[i - 1]?.state === "done";
        return (
          <li key={s.key} data-rail-state={s.state} className="relative flex min-w-0 flex-1 flex-col items-center gap-1 text-center">
            {i > 0 ? (
              <span aria-hidden className={cn("absolute top-3.5 right-1/2 h-0.5 w-full -translate-y-1/2", reached ? "bg-good-fill" : "bg-border")} />
            ) : null}
            {nowBefore === i ? (
              <span data-rail-now-mark className="bg-info ring-card absolute top-3.5 left-0 z-20 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2">
                <span className="sr-only">Now is before this step.</span>
              </span>
            ) : null}
            <span className={cn("relative z-10 grid size-7 place-items-center rounded-full border-2", look.node)}>
              <look.Icon aria-hidden className="size-3.5" strokeWidth={3} />
            </span>
            <span className="px-0.5 text-xs leading-tight font-medium">{s.label}</span>
            <span className={cn("text-[0.6875rem] leading-none max-sm:text-xs", look.text)}>{s.words ?? look.words}</span>
            {s.detail ? <span className="text-muted-foreground font-mono text-[0.6875rem] leading-none tabular-nums max-sm:text-xs">{s.detail}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
