// The Radar's update card: when each edition is built and lands, in Sydney and New York time, and whether the newest
// edition is the one the schedule says should be out. Server-rendered from the page clock; never says "on time" for
// an edition the schedule has passed.
import { ArrowRight, CalendarClock, Cloud } from "lucide-react";
import { Panel } from "@/components/panel";
import { duration, weekDate } from "@/lib/format";
import { RADAR_JOBS, nyAt, radarSchedule, radarScheduleStatus, type RadarJob, type ScheduleStep } from "@/lib/radar-schedule";
import { cn } from "@/lib/utils";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** "Mon 21:45" in a zone. */
function dayTime(iso: string, tz: string): string {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  return f.format(new Date(iso)).replace(",", "");
}
const SYD = "Australia/Sydney";
const NY = "America/New_York";

export function RadarSchedulePanel({ latest, now }: { latest: string; now: Date }) {
  const nowMs = now.getTime();
  const status = radarScheduleStatus(latest, nowMs);
  const steps = radarSchedule(status.day);
  const next = weekDate(status.day);
  const line =
    status.state === "current"
      ? {
          tone: "info" as const,
          word: "Up to date",
          text: `${weekDate(latest)} is the newest edition. Next: ${next}, about ${dayTime(status.expected, SYD)} Sydney (${dayTime(status.expected, NY)} New York), in ${duration(now.toISOString(), status.expected)}.`,
        }
      : status.state === "building"
        ? {
            tone: "warn" as const,
            word: "Building",
            text: `${next}'s edition is being built. It usually lands about ${dayTime(status.expected, SYD)} Sydney; it counts as late after ${dayTime(status.lateAfter, SYD)} Sydney.`,
          }
        : {
            tone: "bad" as const,
            word: "Late",
            text: `${next}'s edition was due by ${dayTime(status.lateAfter, SYD)} Sydney (${dayTime(status.lateAfter, NY)} New York) and has not published, or the market is shut for a holiday.`,
          };
  return (
    <Panel
      title="When Radar updates"
      icon={CalendarClock}
      means="A scheduled task in the cloud builds one edition each weekday before the New York open. Nothing runs at weekends. The times move by an hour when either city changes its clocks; these are worked out for the next edition."
    >
      <div className="flex flex-wrap items-center gap-2" role="status" aria-label={`Radar schedule: ${line.word}`}>
        <span
          className={cn(
            "rounded-lg border px-3 py-1.5 text-base font-semibold",
            line.tone === "info" && "bg-info-soft text-info border-info/40",
            line.tone === "warn" && "bg-warn-soft text-warn border-warn/40",
            line.tone === "bad" && "bg-bad-soft text-bad border-bad/40",
          )}
        >
          {line.word}
        </span>
        <span className="text-sm">{line.text}</span>
      </div>
      <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label={`The schedule for ${next}`}>
        {steps.map((s) => (
          <Step key={s.key} step={s} />
        ))}
      </ol>
      <h3 className="text-muted-foreground mt-5 mb-2 text-xs font-medium tracking-wide uppercase">Who does it</h3>
      <ol className="grid gap-2 md:grid-cols-3" aria-label="The cloud jobs behind the Radar, in order">
        {RADAR_JOBS.map((j, i) => (
          <Job key={j.key} job={j} day={status.day} last={i === RADAR_JOBS.length - 1} />
        ))}
      </ol>
      <p className="text-muted-foreground mt-2 text-xs">
        All three run in Claude&apos;s cloud, not on the trading host, and only read market data: none can place an order.
      </p>
    </Panel>
  );
}

function Step({ step }: { step: ScheduleStep }) {
  const key = step.key === "lands";
  return (
    <li className={cn("rounded-lg border px-3 py-2", key ? "border-primary/50 bg-primary/5" : "border-border")}>
      <div className={cn("text-xs", key ? "text-primary font-medium" : "text-muted-foreground")}>{step.label}</div>
      <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
        {step.approx ? <span className="text-muted-foreground mr-1 text-sm font-normal">≈</span> : null}
        {dayTime(step.at, SYD)}
      </div>
      <div className="text-muted-foreground font-mono text-xs tabular-nums">
        Sydney · {dayTime(step.at, NY)} NY
      </div>
    </li>
  );
}

function Job({ job, day, last }: { job: RadarJob; day: string; last: boolean }) {
  const at =
    job.slot.zone === "UTC"
      ? new Date(Date.parse(`${day}T00:00:00Z`) + job.slot.minute * 60_000).toISOString()
      : new Date(nyAt(day, job.slot.minute)).toISOString();
  return (
    <li className="border-border relative rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Cloud aria-hidden className="text-info size-4 shrink-0" />
        <span className="font-semibold">{job.name}</span>
        <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">
          {dayTime(at, SYD)} Syd · {dayTime(at, NY).slice(4)} NY
        </span>
      </div>
      <div className="text-muted-foreground mt-0.5 text-xs">
        {job.kind}
        {job.id ? <span className="font-mono"> · {job.id}</span> : null}
      </div>
      <p className="mt-1.5 text-sm">{job.does}</p>
      {last ? null : (
        <ArrowRight aria-hidden className="text-muted-foreground bg-card absolute top-1/2 -right-3 z-10 hidden size-4 -translate-y-1/2 md:block" />
      )}
    </li>
  );
}
