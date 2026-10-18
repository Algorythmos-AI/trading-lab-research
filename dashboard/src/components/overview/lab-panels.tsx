// The paper lab's own panels: the nightly summary, its key numbers, the gates and the decisions waiting on the
// owner. They lived on the Overview until it became the owner's trading home page; now Research and
// Operations show them.
import { Gauge, Hand, Milestone, Power } from "lucide-react";
import { CopyCommand } from "@/components/client/copy-command";
import { Empty } from "@/components/empty";
import { GateRail } from "@/components/gate-rail";
import { Panel } from "@/components/panel";
import { StatusBadge, TONE_TEXT, ToneIcon } from "@/components/status";
import { sydney, txt } from "@/lib/format";
import { humanize, severityRank, severityTone, stateTone } from "@/lib/labels";
import { summarize } from "@/lib/summary";
import { list, type Snapshot } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The nightly run in one sentence, with the lab's headline and subline. */
export function LabSummary({ s }: { s: Snapshot }) {
  return (
    <section aria-label="Summary" className="grid gap-1.5">
      <p className="max-w-[70ch] text-base leading-relaxed font-medium text-balance sm:text-lg">{summarize(s)}</p>
      {s.overview?.headline ? <p className="text-muted-foreground max-w-[80ch] text-sm">{s.overview.headline}</p> : null}
      {s.overview?.subline ? <p className="text-muted-foreground max-w-[80ch] text-sm">{s.overview.subline}</p> : null}
    </section>
  );
}

export function GatePanel({ s }: { s: Snapshot }) {
  return (
    <Panel
      title="Gate tracker"
      icon={Milestone}
      means="The fixed steps from research to real money. Each gate must pass before the next one starts; G2 is the paper-trading evidence now being collected."
    >
      {list(s.overview?.gates).length > 0 ? <GateRail gates={list(s.overview?.gates)} g2={s.ops?.paper?.g2} /> : <Empty title="No gate data in this snapshot" />}
    </Panel>
  );
}

export function KillNotice({ s }: { s: Snapshot }) {
  if (s.kill?.on !== true) return null;
  return (
    <section aria-label="Kill switch" className="bg-warn-soft border-warn/35 flex items-start gap-3 rounded-lg border px-4 py-3">
      <Power aria-hidden className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT.warn)} />
      <div className="min-w-0 text-sm">
        <p className="font-medium">Kill switch is on: paper B will not open new trades.</p>
        <p className="text-muted-foreground mt-0.5 text-[0.8125rem]">
          {s.kill.reason ? `${s.kill.reason} ` : ""}
          Since {sydney(s.kill.since)} Sydney. Exits are still managed. Removing the switch is done on the host, not here.
        </p>
      </div>
    </section>
  );
}

export function Kpis({ s }: { s: Snapshot }) {
  const kpis = list(s.overview?.kpis);
  if (kpis.length === 0) return null;
  return (
    <section aria-labelledby="kpi-title" className="grid gap-2">
      <h2 id="kpi-title" className="flex items-center gap-2 text-sm font-semibold">
        <Gauge aria-hidden className="text-muted-foreground size-4" />
        Key numbers
      </h2>
      <p className="text-muted-foreground -mt-1 text-[0.8125rem]">
        The headline figures the lab is judged on. The icon beside each one says whether it is fine, worth watching, or a problem.
      </p>
      <ul className="bg-border grid grid-cols-2 gap-px overflow-hidden rounded-lg border md:grid-cols-4">
        {kpis.map((k, i) => {
          const tone = stateTone(k.state);
          return (
            <li key={k.id ?? i} className="bg-card grid content-start gap-1 p-3 sm:p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground truncate text-xs">{txt(k.label)}</span>
                <ToneIcon tone={tone} label={humanize(k.state)} className="size-3.5" />
              </div>
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-xl font-semibold tracking-tight sm:text-2xl">{txt(k.value)}</span>
                {k.unit ? <span className="text-muted-foreground text-xs">{k.unit}</span> : null}
              </div>
              {k.detail ? <p className="text-muted-foreground line-clamp-2 text-xs">{k.detail}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function NeedsYouPanel({ s }: { s: Snapshot }) {
  const items = list(s.overview?.needs_you).sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || (a.rank ?? 99) - (b.rank ?? 99),
  );
  return (
    <Panel
      title="Needs you"
      icon={Hand}
      means="Decisions or actions only the owner can take, most urgent first. Where a command is shown, it is run on the host."
    >
      {items.length === 0 ? (
        <Empty title="Nothing needs you">The lab is not waiting on any decision from you.</Empty>
      ) : (
        <ol className="divide-border grid divide-y">
          {items.map((n, i) => (
            <li key={n.id ?? i} className="grid gap-1.5 py-3 first:pt-0 last:pb-0">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-sm font-medium">{txt(n.title)}</span>
                <StatusBadge tone={severityTone(n.severity)}>{humanize(n.severity)}</StatusBadge>
              </div>
              {n.why ? <p className="text-muted-foreground text-[0.8125rem]">{n.why}</p> : null}
              <p className="text-xs">
                {n.blocks ? <span>Blocks: {n.blocks}. </span> : null}
                {n.when ? <span>When: {n.when}. </span> : null}
                {n.manual ? <span className="text-muted-foreground">Manual step.</span> : null}
              </p>
              {n.command ? <CopyCommand command={n.command} /> : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
