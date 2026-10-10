import { Flag, Map as MapIcon, Milestone, Rocket, ScrollText } from "lucide-react";
import { Empty } from "@/components/empty";
import { Meter } from "@/components/meter";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { LAB_PLATFORM_TOC, LabPlatform } from "@/components/wiki/lab-platform";
import { WikiLayout, WikiSection, type TocGroup } from "@/components/wiki/kit";
import { ArchitectureSection, GatesSection, GlanceSection, NightSection, OrdersSection, RunbooksSection, STOCKS_TOC } from "@/components/wiki/stocks";
import { num, shortDate, sydney, txt } from "@/lib/format";
import { humanize, severityTone } from "@/lib/labels";
import { requestTime } from "@/lib/now";
import { loadSnapshot } from "@/lib/snapshot";
import { entries, list, type Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Engineering" };

const TOC: TocGroup[] = [STOCKS_TOC, LAB_PLATFORM_TOC];

export default async function EngineeringPage() {
  const result = await loadSnapshot();
  const s = result.status === "ok" ? result.snapshot : null;
  const now = requestTime();
  return (
    <>
      <PageHeading
        title="Engineering"
        intro="How the stocks desk is built: the machine, a trading night, how orders stay safe, the research gates, and the lab platform it shares with the crypto desk. Pictures lead; the dots on them are live."
      />
      {result.status !== "ok" ? <NoSnapshot status={result.status} /> : null}
      <WikiLayout toc={TOC}>
        {s ? (
          <>
            <GlanceSection s={s} />
            <ArchitectureSection s={s} />
            <NightSection s={s} now={now} />
            <OrdersSection s={s} />
            <GatesSection s={s} />
          </>
        ) : null}
        {s ? (
          <WikiSection
            id="plans"
            eyebrow="Stocks desk"
            title="Plans and history"
            lede="Planned engineering work, in order, with the milestones it rolls up to, the tagged releases and the dates that shaped the lab."
          >
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <RoadmapPanel s={s} />
              <MilestonesPanel s={s} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <ReleasesPanel s={s} />
              <TimelinePanel s={s} />
            </div>
          </WikiSection>
        ) : null}
        <RunbooksSection />
        <LabPlatform s={s} />
      </WikiLayout>
    </>
  );
}

function MilestonesPanel({ s }: { s: Snapshot }) {
  const ms = list(s.platform?.milestones);
  const total = s.platform?.items_total;
  const done = s.platform?.items_done;
  return (
    <Panel
      title="Milestones"
      icon={Milestone}
      means={`Groups of planned engineering work in ${s.platform?.backlog_repo ?? "the backlog"} and how many of their issues are closed. P0 marks the must-fix items.`}
    >
      <div className="grid gap-4">
        <Meter label="All tracked issues" value={done} max={total} valueText={`${num(done)} of ${num(total)} done`} />
        {ms.length === 0 ? (
          <Empty title="No milestones in this snapshot" />
        ) : (
          <ul className="grid gap-3">
            {ms.map((m, i) => {
              const open = m.open ?? 0;
              const closed = m.closed ?? 0;
              return (
                <li key={`${m.key}-${i}`} className="grid gap-1">
                  <Meter
                    label={
                      <span className="text-foreground">
                        {txt(m.title)}
                        {typeof m.p0_open === "number" && m.p0_open > 0 ? (
                          <span className="text-bad ml-1.5 text-xs font-medium">{m.p0_open} P0 open</span>
                        ) : null}
                      </span>
                    }
                    value={closed}
                    max={open + closed}
                    tone={m.state === "closed" ? "good" : "info"}
                    valueText={`${num(closed)}/${num(open + closed)}`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function RoadmapPanel({ s }: { s: Snapshot }) {
  const items = list(s.platform?.roadmap).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  return (
    <Panel
      title="Roadmap"
      icon={MapIcon}
      means="What is planned next, in order. P0 items unblock the research; lower priorities improve safety and operations."
    >
      {items.length === 0 ? (
        <Empty title="No roadmap items in this snapshot" />
      ) : (
        <ol className="divide-border grid divide-y">
          {items.map((r, i) => (
            <li key={`${r.rank}-${i}`} className="grid grid-cols-[2rem_1fr] gap-x-2 gap-y-1 py-2.5 first:pt-0 last:pb-0">
              <span className="text-muted-foreground pt-0.5 text-xs tabular-nums">{num(r.rank)}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-start gap-2">
                  <span className="min-w-0 flex-1 text-sm font-medium">{txt(r.title)}</span>
                  {r.priority ? (
                    <StatusBadge tone={severityTone(r.priority === "P0" ? "high" : r.priority === "P1" ? "medium" : "low")} icon={Flag}>
                      {r.priority}
                    </StatusBadge>
                  ) : null}
                </div>
                {r.why ? <p className="text-muted-foreground mt-0.5 text-xs">{r.why}</p> : null}
                {r.owner ? <p className="text-muted-foreground mt-0.5 text-xs">Owner: {r.owner}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function ReleasesPanel({ s }: { s: Snapshot }) {
  const releases = list(s.platform?.releases);
  return (
    <Panel title="Releases" icon={Rocket} means="Tagged versions of the lab's software, newest first.">
      {releases.length === 0 ? (
        <Empty title="No releases yet" />
      ) : (
        <ul className="grid gap-2.5">
          {releases.map((r, i) => (
            <li key={`${r.tagName}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-mono text-xs font-semibold">{txt(r.tagName)}</span>
              <span className="min-w-0 flex-1">{txt(r.name)}</span>
              {r.isLatest ? <StatusBadge tone="info">Latest</StatusBadge> : null}
              <span className="text-muted-foreground w-full text-xs">{sydney(r.publishedAt)} Sydney</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function TimelinePanel({ s }: { s: Snapshot }) {
  const events = list(s.history?.timeline);
  const legacy = s.history?.legacy;
  const outcomes = entries(legacy?.by_outcome);
  return (
    <Panel
      title="Project timeline"
      icon={ScrollText}
      means="Milestone dates in the lab's history, including the retired first pipeline, which never placed an order."
    >
      {events.length === 0 ? (
        <Empty title="No timeline in this snapshot" />
      ) : (
        <ol className="border-border grid gap-2.5 border-l pl-4">
          {events.map((e, i) => (
            <li key={`${e.date}-${i}`} className="relative text-sm">
              <span aria-hidden className="bg-border absolute top-1.5 -left-[1.3rem] size-2 rounded-full" />
              <span className="text-muted-foreground mr-2 text-xs">{shortDate(e.date)}</span>
              {txt(e.event)}
            </li>
          ))}
        </ol>
      )}
      {legacy ? (
        <p className="text-muted-foreground mt-4 text-xs">
          Legacy pipeline: {num(legacy.total)} runs from {shortDate(legacy.first)} to {shortDate(legacy.last)}, {num(legacy.orders_placed)}{" "}
          orders placed
          {outcomes.length > 0 ? ` (${outcomes.map(([k, v]) => `${humanize(k).toLowerCase()} ${v}`).join(", ")})` : ""}.
        </p>
      ) : null}
    </Panel>
  );
}
