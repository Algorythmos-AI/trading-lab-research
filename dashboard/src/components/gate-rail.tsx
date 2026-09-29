import { Check, Circle, CircleDot, X } from "lucide-react";
import { humanize, stateTone, type Tone } from "@/lib/labels";
import { num } from "@/lib/format";
import type { Gate, Paper } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Meter } from "./meter";
import { StatusBadge } from "./status";

function nodeStyle(tone: Tone) {
  switch (tone) {
    case "good":
      return { cls: "bg-good-fill border-good-fill text-white", Icon: Check };
    case "bad":
      return { cls: "bg-bad-fill border-bad-fill text-white", Icon: X };
    case "info":
      return { cls: "bg-card border-info text-info", Icon: CircleDot };
    default:
      return { cls: "bg-card border-border text-muted-foreground", Icon: Circle };
  }
}

/** K0 -> G5 as one track: where the project is on the road from research to live money. */
export function GateRail({ gates, g2 }: { gates: Gate[]; g2: Paper["g2"] }) {
  return (
    <div className="grid gap-5">
      <ol className="flex items-start" aria-label="Gates in order">
        {gates.map((g, i) => {
          const tone = stateTone(g.status);
          const { cls, Icon } = nodeStyle(tone);
          const prevDone = i > 0 && stateTone(gates[i - 1]?.status) === "good";
          return (
            <li key={g.id ?? i} className="relative flex flex-1 flex-col items-center gap-1.5">
              {i > 0 ? (
                <span
                  aria-hidden
                  className={cn("absolute top-3.5 right-1/2 h-0.5 w-full -translate-y-1/2", prevDone ? "bg-good-fill" : "bg-border")}
                />
              ) : null}
              <span className={cn("relative z-10 grid size-7 place-items-center rounded-full border-2", cls)}>
                <Icon aria-hidden className="size-3.5" strokeWidth={3} />
              </span>
              <span className="font-mono text-xs font-medium">{g.id ?? "—"}</span>
              <span className="sr-only">{humanize(g.status)}</span>
            </li>
          );
        })}
      </ol>
      <ul className="divide-border grid divide-y">
        {gates.map((g, i) => {
          const tone = stateTone(g.status);
          const isG2 = g.id === "G2";
          return (
            <li key={g.id ?? i} className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-xs font-semibold">{g.id}</span>
                <span className="text-sm font-medium">{g.name ?? "—"}</span>
                <StatusBadge tone={tone} className="ml-auto">
                  {humanize(g.status)}
                </StatusBadge>
              </div>
              {g.criteria ? <p className="text-muted-foreground text-xs">{g.criteria}</p> : null}
              {g.evidence || g.next || g.progress ? (
                <p className="text-xs">
                  {g.evidence ? <span>Evidence: {g.evidence}. </span> : null}
                  {g.progress ? <span>Progress: {g.progress}. </span> : null}
                  {g.next ? <span>Next: {g.next}.</span> : null}
                </p>
              ) : null}
              {isG2 && g2 ? (
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <Meter
                    label="Paper trades"
                    value={g2.trades}
                    max={g2.trades_needed}
                    valueText={`${num(g2.trades)} of ${num(g2.trades_needed)}`}
                  />
                  <Meter
                    label="Armed sessions"
                    value={g2.sessions}
                    max={g2.sessions_needed}
                    valueText={`${num(g2.sessions)} of ${num(g2.sessions_needed)}`}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
