// The Gap Hunter page's body. Server-rendered; reads the stocks snapshot through lib/gap-hunter.ts and the robot's
// own block (the newer of the snapshot's copy and its live document) through lib/gap-hunter-now.ts.
//
// Since DEC-0078 the page shows the day's symbols and the open position (PRIVATE, behind the owner's login, in the
// paper frame). No record's prose, setup name or journal free text is shown. What the host does not publish yet is
// said to be missing, in the panel it belongs to. Nothing here is filled in.
import { BellRing, CalendarClock, Filter, Inbox, ScrollText, Signpost, Target } from "lucide-react";
import { Funnel } from "@/components/charts/funnel";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { duration, newYork, num, rMult, shortDate, sydney } from "@/lib/format";
import {
  firing,
  gapHunterBlock,
  morningFunnel,
  records,
  reliability,
  runWords,
  sessionJob,
  sessionRuns,
  standing,
  type FunnelStep,
  type GapHunterBlock,
  type RecordState,
} from "@/lib/gap-hunter";
import { humanize, jobTone } from "@/lib/labels";
import { GAP_HUNTER } from "@/lib/robots";
import type { Snapshot } from "@/lib/types";
import { cn } from "@/lib/utils";
import { clockAt, pickSource, readLive } from "@/lib/gap-hunter-now";
import type { GapHunterLiveResult } from "@/lib/snapshot";
import { ClosedPanel, DayPanel, HowItWorks, NowHero, OrdersPanel, PickPanel, PositionPanel, SafetyPanel, TimelinePanel } from "./live-panels";

/** A snapshot older than this is called stale on the page (two missed hourly publishes and a margin). */
const STALE_HOURS = 3;
const NOT_SENT = "Not sent yet";

const yesNo = (v: boolean | null) => (v === true ? "Yes" : v === false ? "No" : NOT_SENT);
const countText = (v: number | null) => (v === null ? NOT_SENT : num(v));

export function GapHunterBody({ s, now, live = null }: { s: Snapshot | null; now: Date; live?: GapHunterLiveResult | null }) {
  const block = gapHunterBlock(s);
  const src = pickSource(s, live);
  const l = readLive(src.raw);
  const clock = clockAt(now);
  return (
    <div className="grid gap-5">
      <NowHero live={l} src={src} clock={clock} now={now} />
      <Glance s={s} now={now} />
      <DayPanel live={l} clock={clock} />
      <div className="grid gap-5 lg:grid-cols-2">
        <PositionPanel live={l} />
        <PickPanel live={l} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <TimelinePanel live={l} />
        <SafetyPanel live={l} />
      </div>
      <OrdersPanel live={l} />
      <ClosedPanel live={l} />
      <StandingPanel s={s} block={block} />
      <FunnelPanel s={s} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ResultsPanel block={block} />
        <SessionsPanel s={s} />
      </div>
      <AlertsPanel s={s} />
      <HowItWorks />
    </div>
  );
}

// ---------------------------------------------------------------- at a glance

function recordTone(r: RecordState): "info" | "neutral" {
  return r.status ? "info" : "neutral";
}

function Glance({ s, now }: { s: Snapshot | null; now: Date }) {
  const st = standing(s);
  const r = records(s);
  const job = sessionJob(s);
  const alerts = firing(s);
  const t = s?.as_of ? Date.parse(s.as_of) : NaN;
  const ageHours = Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 3_600_000) : null;
  const stale = ageHours !== null && ageHours > STALE_HOURS;
  return (
    <section aria-label="Gap Hunter at a glance" className="bg-card flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 shadow-sm" data-gap-hunter-state={st.word}>
      <StatusBadge tone={st.tone}>{st.word}</StatusBadge>
      <StatusBadge tone={recordTone(r.decision)}>
        Rule {r.decision.id} · {r.decision.status ?? "not in the registry yet"}
      </StatusBadge>
      {/* With no session reported, the state badge already says so. */}
      {runWords(job) === st.word ? null : <StatusBadge tone={job ? jobTone(job.status) : "neutral"}>{runWords(job)}</StatusBadge>}
      <StatusBadge tone={alerts.length === 0 ? "good" : alerts.some((a) => a.red) ? "bad" : "warn"}>{alerts.length === 0 ? "No alerts" : `${alerts.length} alert${alerts.length === 1 ? "" : "s"}`}</StatusBadge>
      <span className={cn("ml-auto text-xs", stale ? "text-warn font-medium" : "text-muted-foreground")}>
        {s?.as_of ? `Status snapshot ${newYork(s.as_of)} New York${stale ? ` · stale (${Math.round(ageHours ?? 0)} h old)` : ""}` : "No host data"}
      </span>
    </section>
  );
}

// ---------------------------------------------------------------- where it stands

function StandingPanel({ s, block }: { s: Snapshot | null; block: GapHunterBlock | null }) {
  const st = standing(s);
  const r = records(s);
  const job = sessionJob(s);
  const rel = reliability(s);
  const record = (x: RecordState) => (
    <>
      <span className="font-mono">{x.id}</span> · {x.status ?? "not in this snapshot's registry"}
      {x.date ? <span className="text-muted-foreground"> · {shortDate(x.date)}</span> : null}
    </>
  );
  return (
    <Panel
      title="Where it stands"
      icon={Signpost}
      means="Gap Hunter scans the whole market before the open, narrows it to the day's best names and trades what comes out. Paper money only: its own Alpaca paper account, never your Webull account."
      action={<StatusBadge tone={st.tone}>{st.word}</StatusBadge>}
    >
      <div className="grid gap-4">
        <p className="text-sm">{st.detail}</p>
        <KeyValues
          items={[
            { label: "Money", value: "Paper only" },
            { label: "Rule", value: record(r.decision) },
            { label: "Hypothesis", value: record(r.hypothesis) },
            { label: "A rule is switched on", value: yesNo(block?.enabled ?? null) },
            { label: "Its kill switch", value: block?.kill === true ? "On" : block?.kill === false ? "Off" : NOT_SENT },
            { label: "Last session", value: job ? `${humanize(job.status)}${job.started ? ` · ${newYork(job.started)} NY` : ""}` : "None reported yet" },
            {
              label: "Sessions run as planned, last two weeks",
              value: rel ? `${num(rel.ok)} of ${num(rel.expected)}${rel.refused ? ` · ${num(rel.refused)} refused` : ""}${rel.failed ? ` · ${num(rel.failed)} failed` : ""}${rel.missed ? ` · ${num(rel.missed)} missed` : ""}` : "Not counted yet",
            },
          ]}
        />
        {block ? null : (
          <p className="text-muted-foreground max-w-prose text-xs">
            The host sends this site the session&apos;s runs, its alerts and the research registry. It does not yet send whether a rule is switched on, the robot&apos;s own kill switch, its
            selection or its trades: those read &ldquo;{NOT_SENT.toLowerCase()}&rdquo; until it does.
          </p>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- the morning funnel

function stepRows(steps: FunnelStep[], inner = false) {
  return steps.flatMap((x) => (typeof x.value === "number" ? [{ key: x.key, label: x.label, count: x.value, inner }] : []));
}

function FunnelPanel({ s }: { s: Snapshot | null }) {
  const f = morningFunnel(s);
  const pick = f.selection.find((x) => x.key === "primary");
  const rows = [...stepRows(f.market), ...stepRows(f.selection, f.market.length > 0)];
  return (
    <Panel
      title="Morning funnel"
      icon={Filter}
      means="The whole market narrowed to the day's names, in counts: every listed stock, those trading before the open, those gapping up, the ones that pass every filter, tier 1, tier 2 and whether there was a first pick."
      action={f.session ? <span className="text-muted-foreground text-xs">Session {shortDate(f.session)}</span> : undefined}
    >
      {f.source === "none" || rows.length === 0 ? (
        <Empty icon={Inbox} title="No morning funnel has been sent yet">
          It shows here, in counts, once the host publishes a pre-market scan.
        </Empty>
      ) : (
        <div className="grid gap-4" data-funnel-source={f.source}>
          {!f.current ? <p className="text-warn text-xs font-medium">These counts are from {shortDate(f.session)}, the latest session sent. Today&apos;s are not in yet.</p> : null}
          <Funnel rows={rows} label="The morning funnel, in counts" />
          {pick ? (
            <p className="text-sm">
              First pick: <span className="font-medium">{pick.value === true ? "Yes" : pick.value === false ? "No" : NOT_SENT}</span>
            </p>
          ) : null}
          {f.source === "scan" ? (
            <p className="text-muted-foreground max-w-prose text-xs" data-funnel-note="">
              {f.selection.length > 0
                ? `These are the pre-market scan's counts under the filter it runs today. Gap Hunter's own selection rule (${GAP_HUNTER.decision}) is not counted on the host yet; its counts replace the last four here once it is.`
                : `The scan's own counts. Gap Hunter's selection from it (${GAP_HUNTER.decision}) is not sent yet.`}
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- trades and results

function ResultsPanel({ block }: { block: GapHunterBlock | null }) {
  const sent = block !== null && [block.trades, block.sessions, block.open, block.totalR].some((v) => v !== null);
  return (
    <Panel title="Trades and results" icon={Target} means="What Gap Hunter has done with paper money: sessions armed, positions open, trades closed and the result in R (the amount risked on a trade).">
      {!sent ? (
        <Empty icon={Inbox} title="Trades and results are not sent yet">
          The host does not publish Gap Hunter&apos;s trades to this site yet. Nothing is shown rather than a guess.
        </Empty>
      ) : (
        <KeyValues
          items={[
            { label: "Sessions armed", value: countText(block.sessions) },
            { label: "Last session", value: block.lastSession ? shortDate(block.lastSession) : NOT_SENT },
            { label: "Open positions", value: countText(block.open) },
            { label: "Closed trades", value: countText(block.trades) },
            { label: "Total R", value: block.totalR === null ? NOT_SENT : rMult(block.totalR, 2) },
            { label: "Average R per trade", value: block.meanR === null ? NOT_SENT : rMult(block.meanR) },
          ]}
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- the session job

function SessionsPanel({ s }: { s: Snapshot | null }) {
  const runs = sessionRuns(s);
  return (
    <Panel title="Session runs" icon={CalendarClock} means="Each run of Gap Hunter's session on the host, newest first. A session that runs has not necessarily traded. Times are New York, with Sydney beside them.">
      {runs.length === 0 ? (
        <Empty icon={Inbox} title="No session run in this snapshot">
          The host starts the session at 08:30 New York on trading days. Its runs list here once it reports one.
        </Empty>
      ) : (
        <Table label="Gap Hunter session runs">
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Took</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.started}>
                <TableCell className="whitespace-normal">
                  {newYork(r.started)} NY
                  <span className="text-muted-foreground block text-xs">{sydney(r.started, false)} Sydney</span>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.ended ? duration(r.started, r.ended) : "—"}</TableCell>
                <TableCell>
                  <StatusBadge tone={jobTone(r.status)}>
                    {humanize(r.status)}
                    {r.exit !== null && r.exit !== 0 ? ` (exit ${r.exit})` : ""}
                  </StatusBadge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- alerts

function AlertsPanel({ s }: { s: Snapshot | null }) {
  const alerts = firing(s);
  return (
    <Panel
      title="Alerts"
      icon={alerts.length === 0 ? ScrollText : BellRing}
      means="Gap Hunter's own alerts that have not cleared. Urgent ones are about a position or the account and turn the whole dashboard red; the rest need a look."
      action={<StatusBadge tone={alerts.length === 0 ? "good" : alerts.some((a) => a.red) ? "bad" : "warn"}>{alerts.length === 0 ? "None" : `${alerts.length} firing`}</StatusBadge>}
    >
      {alerts.length === 0 ? (
        <Empty icon={BellRing} title="No Gap Hunter alert is firing" />
      ) : (
        <ul className="divide-border grid divide-y">
          {alerts.map((a) => (
            <li key={a.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
              <StatusBadge tone={a.red ? "bad" : "warn"}>{a.red ? "Urgent" : "Check"}</StatusBadge>
              <span className="text-sm font-medium">{a.title}</span>
              <span className="text-muted-foreground ml-auto text-xs">{a.since ? `Since ${sydney(a.since)} Sydney` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
