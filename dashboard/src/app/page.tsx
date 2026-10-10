import { CalendarClock, CircleDollarSign, ClipboardList, Gauge, Hand, Milestone, Power, Radar } from "lucide-react";
import Link from "next/link";
import { CopyCommand } from "@/components/client/copy-command";
import { RelativeTime } from "@/components/client/relative-time";
import { Empty } from "@/components/empty";
import { GateRail } from "@/components/gate-rail";
import { HealthBanner } from "@/components/health-banner";
import { NoSnapshot } from "@/components/no-snapshot";
import { Panel } from "@/components/panel";
import { StatusBadge, TONE_TEXT, ToneIcon } from "@/components/status";
import { PnlTiles } from "@/components/today/trading";
import { DigestPanel } from "@/components/v3/digest";
import { duration, newYork, num, shortDate, sydney, txt } from "@/lib/format";
import { computeHealth } from "@/lib/health";
import { humanize, jobKey, jobName, jobTone, severityRank, severityTone, sortJobKeys, stateTone } from "@/lib/labels";
import { requestTime } from "@/lib/now";
import { loadSnapshot } from "@/lib/snapshot";
import { summarize } from "@/lib/summary";
import { scan } from "@/lib/today";
import { outcomeLine, trading } from "@/lib/trading";
import { entries, list, type Snapshot } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CumulativeChart } from "@/components/charts/cumulative-chart";
import { cumulativePoints } from "@/components/v3/perf";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const result = await loadSnapshot();
  const now = requestTime();
  if (result.status !== "ok") {
    return (
      <>
        <HealthBanner health={computeHealth(null, now)} />
        <NoSnapshot status={result.status} />
      </>
    );
  }
  const s = result.snapshot;
  const health = computeHealth(s, now);
  return (
    <>
      <h1 className="sr-only">Overview</h1>
      <HealthBanner health={health} />
      <section aria-label="Summary" className="grid gap-1.5">
        <p className="max-w-[70ch] text-base leading-relaxed font-medium text-balance sm:text-lg">{summarize(s)}</p>
        {s.overview?.headline ? <p className="text-muted-foreground max-w-[80ch] text-sm">{s.overview.headline}</p> : null}
        {s.overview?.subline ? <p className="text-muted-foreground max-w-[80ch] text-sm">{s.overview.subline}</p> : null}
      </section>
      <KillNotice s={s} />
      <PnlStrip s={s} />
      <ScanStrip s={s} />
      <Kpis s={s} />
      <DigestPanel s={s} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <NeedsYouPanel s={s} />
        <JobsPanel s={s} />
      </div>
      <Panel
        title="Gate tracker"
        icon={Milestone}
        means="The fixed steps from research to real money. Each gate must pass before the next one starts; G2 is the paper-trading evidence now being collected."
      >
        {list(s.overview?.gates).length > 0 ? (
          <GateRail gates={list(s.overview?.gates)} g2={s.ops?.paper?.g2} />
        ) : (
          <Empty title="No gate data in this snapshot" />
        )}
      </Panel>
    </>
  );
}

/** Paper B's profit and loss at a glance; the trades and the detail are on the Today page. */
function PnlStrip({ s }: { s: Snapshot }) {
  const v = trading(s);
  if (!v.available) return null;
  const o = outcomeLine(v);
  const curve = list(s.perf?.curve);
  return (
    <Panel
      title="Paper B profit and loss"
      icon={CircleDollarSign}
      means="What the paper strategy's closed trades have made or lost on its US$600 paper ledger, and their running total in R (the result against the amount risked). Paper money only."
      action={
        <StatusBadge tone={o.tone}>
          {v.current || v.session === null ? o.title : `${shortDate(v.session)}: ${o.title}`}
        </StatusBadge>
      }
    >
      <div className="grid gap-3">
        <PnlTiles v={v} />
        {curve.length >= 2 ? <CumulativeChart compact points={cumulativePoints(curve)} /> : null}
        <p className="text-muted-foreground text-xs">
          <Link href="/today" className="underline underline-offset-2">
            See every trade, the open position and why it did or did not trade
          </Link>
        </p>
      </div>
    </Panel>
  );
}

/** The newest pre-market scan in one row of counts: how wide it looked and how far names got. The dry run's
 * view ("as seen"); the reasons and the forward test's own funnel are on the Today page. */
function ScanStrip({ s }: { s: Snapshot }) {
  const v = scan(s);
  const l = v.latest;
  if (!l) return null;
  const top = (v.why?.reasons ?? []).filter((r) => r.count > 0).slice(0, 3);
  const cells: { label: string; value: number | null }[] = [
    { label: "Stocks scanned", value: l.universe },
    { label: "Trading pre-market", value: l.traded },
    { label: "Gapping up", value: l.gapping },
    { label: "Candidates", value: l.candidates },
    { label: "Short list", value: l.shortList },
    { label: "Trade plans", value: l.tickets },
  ];
  return (
    <Panel
      title="Pre-market scan"
      icon={Radar}
      means="The newest small-cap scan in counts: every listed stock, those trading before the open, those gapping up, and how many passed each later step. A dry run: it places no order."
      action={
        <StatusBadge tone={v.failed ? "bad" : v.current ? "good" : "neutral"}>
          {v.failed ? "No data to scan" : v.current ? `Today, ${l.at ?? "latest"} New York` : `${shortDate(v.date)}, not today's`}
        </StatusBadge>
      }
    >
      <div className="grid gap-3">
        <ul className="bg-border grid grid-cols-3 gap-px overflow-hidden rounded-lg border md:grid-cols-6">
          {cells.map((c) => (
            <li key={c.label} className="bg-card grid content-start gap-1 p-3">
              <span className="text-muted-foreground text-xs">{c.label}</span>
              <span className="font-mono text-lg font-semibold tracking-tight">{num(c.value)}</span>
            </li>
          ))}
        </ul>
        {v.failed ? (
          <p className="text-bad text-sm">The scan had no data to scan. That is a data failure, not a quiet morning.</p>
        ) : top.length > 0 ? (
          <p className="text-muted-foreground text-[0.8125rem]">
            Most common reasons a gapping name went no further: {top.map((r) => `${r.label.toLowerCase()} (${num(r.count)})`).join(", ")}.
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {v.feed ? `Data feed: ${v.feed}. ` : ""}
          <Link href="/today" className="underline underline-offset-2">
            See each step, the near misses and the forward test&apos;s own funnel
          </Link>
        </p>
      </div>
    </Panel>
  );
}

function KillNotice({ s }: { s: Snapshot }) {
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

function Kpis({ s }: { s: Snapshot }) {
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

function NeedsYouPanel({ s }: { s: Snapshot }) {
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

function JobsPanel({ s }: { s: Snapshot }) {
  const last = Object.fromEntries(entries(s.jobs?.last));
  const schedule = list(s.ops?.host?.schedule);
  const keys = sortJobKeys([...Object.keys(last), ...schedule.map((e) => jobKey(e.job)).filter(Boolean)]);
  return (
    <Panel
      title="Tonight's jobs"
      icon={CalendarClock}
      means="The nightly jobs on the host: how the last run of each went, and when it is scheduled. Times are shown in Sydney and New York."
    >
      {keys.length === 0 ? (
        <Empty title="No job results yet">Results appear after the first nightly run is published.</Empty>
      ) : (
        <ul className="divide-border grid divide-y">
          {keys.map((key) => {
            const job = last[key];
            const slot = schedule.find((e) => jobKey(e.job) === key);
            return (
              <li key={key} className="grid gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-sm font-medium">{jobName(key)}</span>
                  {job ? (
                    <StatusBadge tone={jobTone(job.status)}>
                      {humanize(job.status)}
                      {typeof job.exit === "number" ? `, exit ${job.exit}` : ""}
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral">No run yet</StatusBadge>
                  )}
                </div>
                {job ? (
                  <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    <dt>Started</dt>
                    <dd className="text-foreground">
                      {sydney(job.started)} Sydney <span className="text-muted-foreground">({newYork(job.started, false)} NY)</span>
                    </dd>
                    <dt>Ended</dt>
                    <dd className="text-foreground">
                      <RelativeTime iso={job.ended} fallback={sydney(job.ended)} />, took {duration(job.started, job.ended)}
                    </dd>
                    {job.detail ? (
                      <>
                        <dt>Detail</dt>
                        <dd className="text-foreground break-words">{job.detail}</dd>
                      </>
                    ) : null}
                  </dl>
                ) : null}
                {slot ? (
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <ClipboardList aria-hidden className="size-3.5" />
                    Scheduled {txt(slot.local)} ({txt(slot.et)}){slot.session === false ? ", no market session" : ""}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
