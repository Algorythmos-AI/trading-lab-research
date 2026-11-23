// The Radar's pipeline card: where this morning's edition stands, stage by stage, and the cloud routines behind it.
// The live part (the badge, the rail, the last sessions, the funnel) is drawn in the browser from the one summary the
// page read (client/radar-pipeline.tsx); the routines below it are the same on every render.
import { ArrowRight, Cloud, Workflow } from "lucide-react";
import { RadarPipelineLive } from "@/components/client/radar-pipeline";
import { Panel } from "@/components/panel";
import { nyInstant } from "@/lib/options";
import { pipelineDays, type PipelineFile } from "@/lib/radar-pipeline";
import type { SelectBlock } from "@/lib/select-shadow";
import { RADAR_ROUTINES, type RadarRoutine } from "@/lib/radar-pipeline-slots";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** "21:45" in a zone. */
function clock(ms: number, tz: string): string {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  return f.format(new Date(ms));
}

export function RadarSchedulePanel({ file, now, shadow }: { file: PipelineFile | null; now: Date; shadow?: SelectBlock | null }) {
  const day = pipelineDays(now.getTime()).focus;
  return (
    <Panel
      title="Radar pipeline"
      icon={Workflow}
      means="Each stage of the morning's run, from last night's levels to the open: whether it has happened, when, and how far from its time. Read from what the site has stored; a stage nothing was stored for says so. Nothing runs at weekends or on market holidays."
    >
      <RadarPipelineLive file={file} serverNow={now.getTime()} shadow={shadow} />
      <h3 className="text-muted-foreground mt-5 mb-2 text-xs font-medium tracking-wide uppercase">Who does it</h3>
      <ol className="grid gap-2 md:grid-cols-2 xl:grid-cols-4" aria-label="The cloud jobs behind the Radar, in order">
        {RADAR_ROUTINES.map((j, i) => (
          <Job key={j.key} job={j} day={day} last={i === RADAR_ROUTINES.length - 1} />
        ))}
      </ol>
      <p className="text-muted-foreground mt-2 text-xs">
        All four are Claude routines that run in Claude&apos;s cloud, not on the trading host, and only read market data: none can place an order.
      </p>
    </Panel>
  );
}

function Job({ job, day, last }: { job: RadarRoutine; day: string; last: boolean }) {
  const at = job.slot === null ? null : job.slot.zone === "UTC" ? Date.parse(`${day}T00:00:00Z`) + job.slot.minute * 60_000 : nyInstant(day, job.slot.minute);
  return (
    <li className="border-border relative rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2">
        <Cloud aria-hidden className="text-info size-4 shrink-0" />
        <span className="font-semibold">{job.name}</span>
        {at !== null ? (
          <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">
            {clock(at, "Australia/Sydney")} Syd · {clock(at, "America/New_York")} NY
          </span>
        ) : null}
      </div>
      <div className="text-muted-foreground mt-0.5 font-mono text-xs break-all">{job.id}</div>
      <p className="mt-1.5 text-sm">{job.does}</p>
      {last ? null : (
        <ArrowRight aria-hidden className="text-muted-foreground bg-card absolute top-1/2 -right-3 z-10 hidden size-4 -translate-y-1/2 xl:block" />
      )}
    </li>
  );
}
