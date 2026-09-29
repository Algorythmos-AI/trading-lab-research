import { ShieldCheck, Siren, TriangleAlert } from "lucide-react";
import type { Health } from "@/lib/health";
import type { Tone } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { TONE_FILL, TONE_TEXT, ToneIcon } from "./status";

const LEVEL: Record<Health["level"], { tone: Tone; title: string; Icon: typeof Siren; means: string }> = {
  green: {
    tone: "good",
    title: "All clear",
    Icon: ShieldCheck,
    means: "Nothing needs attention right now.",
  },
  amber: {
    tone: "warn",
    title: "Needs a look",
    Icon: TriangleAlert,
    means: "Nothing is at risk right now, but the items below should be checked today.",
  },
  red: {
    tone: "bad",
    title: "Action needed",
    Icon: Siren,
    means: "Something may be wrong with a paper position or the jobs have stopped. Act on the items below now.",
  },
};

export function HealthBanner({ health }: { health: Health }) {
  const cfg = LEVEL[health.level];
  return (
    <section aria-labelledby="health-title" className="bg-card flex overflow-hidden rounded-lg border">
      <div aria-hidden className={cn("w-1.5 shrink-0", TONE_FILL[cfg.tone])} />
      <div className="min-w-0 flex-1 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <cfg.Icon aria-hidden className={cn("size-5", TONE_TEXT[cfg.tone])} />
          <h2 id="health-title" className="text-lg font-semibold tracking-tight">
            {cfg.title}
          </h2>
          <span className={cn("text-sm font-medium", TONE_TEXT[cfg.tone])}>
            Status {health.level === "green" ? "green" : health.level === "amber" ? "amber" : "red"}
          </span>
        </div>
        <p className="text-muted-foreground mt-1 text-[0.8125rem]">{cfg.means}</p>
        {health.reasons.length > 0 ? (
          <ul className="mt-3 grid gap-1.5">
            {health.reasons.map((r) => (
              <li key={r.code} className="flex items-start gap-2 text-sm">
                <ToneIcon tone={r.level === "red" ? "bad" : "warn"} className="mt-0.5" label={r.level === "red" ? "Urgent" : "Check"} />
                <span className="min-w-0">{r.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
