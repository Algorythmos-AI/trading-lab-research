import { Activity, CalendarClock, ClipboardCheck, Clock, Database, GitBranch, HardDrive, Workflow } from "lucide-react";
import { RelativeTime } from "@/components/client/relative-time";
import { Empty } from "@/components/empty";
import { JobHeatmap } from "@/components/job-heatmap";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge, ToneIcon } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AuditPanel } from "@/components/v3/audit";
import { SlaPanel } from "@/components/v3/sla";
import { duration, newYork, num, pct, shortDate, shortSha, sydney, txt } from "@/lib/format";
import { humanize, jobKey, jobName, jobTone, sortJobKeys } from "@/lib/labels";
import { loadSnapshot } from "@/lib/snapshot";
import { DISK_FLOOR_GB, DISK_TARGET_GB } from "@/lib/thresholds.gen";
import { entries, list, type LogInfo, type Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Operations" };

export default async function OperationsPage() {
  const result = await loadSnapshot();
  return (
    <>
      <PageHeading
        title="Operations"
        intro="Whether the host and its jobs are healthy: run history, pre-flight checks, disk and memory, clock changes, the deployed code and how fresh each data source is."
      />
      {result.status !== "ok" ? (
        <NoSnapshot status={result.status} />
      ) : (
        <>
          <HeatmapPanel s={result.snapshot} />
          <SlaPanel s={result.snapshot} />
          <div className="grid gap-5 lg:grid-cols-2">
            <LastRunsPanel s={result.snapshot} />
            <PreflightPanel s={result.snapshot} />
            <HostPanel s={result.snapshot} />
            <DeployPanel s={result.snapshot} />
            <DstPanel s={result.snapshot} />
            <LogsPanel s={result.snapshot} />
          </div>
          <SourcesPanel s={result.snapshot} />
          <AuditPanel s={result.snapshot} />
        </>
      )}
    </>
  );
}

function HeatmapPanel({ s }: { s: Snapshot }) {
  const runs = list(s.jobs?.runs);
  return (
    <Panel
      title="Job runs, last 14 days"
      icon={Activity}
      means="One square per job per trading day (New York date). Green ran cleanly; red failed. A dashed square means the job did not run that day, which is normal on weekends."
    >
      {runs.length === 0 ? (
        <Empty title="No run history yet">The heartbeat log has no runs in the last 14 days.</Empty>
      ) : (
        <JobHeatmap runs={runs} asOf={s.as_of} extraJobs={Object.keys(s.jobs?.last ?? {})} />
      )}
    </Panel>
  );
}

function LastRunsPanel({ s }: { s: Snapshot }) {
  const last = Object.fromEntries(entries(s.jobs?.last));
  const keys = sortJobKeys(Object.keys(last));
  return (
    <Panel
      title="Last run of each job"
      icon={Workflow}
      means="The most recent result per job, with its exit code (0 means success) and the code version it ran."
    >
      {keys.length === 0 ? (
        <Empty title="No job results yet" />
      ) : (
        <ul className="divide-border grid divide-y">
          {keys.map((k) => {
            const j = last[k]!;
            return (
              <li key={k} className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm font-medium">{jobName(k)}</span>
                  <StatusBadge tone={jobTone(j.status)}>
                    {humanize(j.status)}
                    {typeof j.exit === "number" ? `, exit ${j.exit}` : ""}
                  </StatusBadge>
                </div>
                <p className="text-muted-foreground text-xs">
                  Started {sydney(j.started)} Sydney ({newYork(j.started, false)} NY), took {duration(j.started, j.ended)}, code{" "}
                  <span className="font-mono">{shortSha(j.sha)}</span>
                </p>
                {j.detail ? <p className="text-xs break-words">{j.detail}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function PreflightPanel({ s }: { s: Snapshot }) {
  const checks = list(s.preflight);
  const failing = checks.filter((c) => c.ok === false).length;
  return (
    <Panel
      title="Pre-flight checks"
      icon={ClipboardCheck}
      means="Safety checks run before live jobs start. A failing check does not stop tonight's run on its own, but it means the host is not in its intended state."
      action={
        checks.length > 0 ? (
          <StatusBadge tone={failing === 0 ? "good" : "warn"}>
            {failing === 0 ? "All passing" : `${failing} failing`}
          </StatusBadge>
        ) : null
      }
    >
      {checks.length === 0 ? (
        <Empty title="No pre-flight results in this snapshot" />
      ) : (
        <ul className="grid gap-2">
          {checks.map((c, i) => (
            <li key={`${c.name}-${i}`} className="flex items-start gap-2 text-sm">
              <ToneIcon
                tone={c.ok === true ? "good" : c.ok === false ? "warn" : "neutral"}
                className="mt-0.5"
                label={c.ok === true ? "Pass" : c.ok === false ? "Fail" : "Unknown"}
              />
              <div className="min-w-0">
                <span className="font-medium">{txt(c.name)}</span>
                {c.detail ? <p className="text-muted-foreground text-xs break-words">{c.detail}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function HostPanel({ s }: { s: Snapshot }) {
  const h = s.ops?.host;
  const free = h?.disk_free_gb;
  const total = h?.disk_total_gb;
  const swap = h?.swap?.used_pct;
  const warn = h?.swap_warn_pct;
  const diskTone = typeof free !== "number" ? "neutral" : free < DISK_FLOOR_GB ? "bad" : free < DISK_TARGET_GB ? "warn" : "good";
  const swapHigh = typeof swap === "number" && typeof warn === "number" && swap >= warn;
  const jobs = list(h?.jobs);
  const wake = list(h?.wake_coverage);
  return (
    <Panel
      title="Host health"
      icon={HardDrive}
      means="The Mac's free disk and memory pressure. Jobs stop if the disk falls below the floor; heavy swap makes nightly runs slow or unreliable."
    >
      <div className="grid gap-4">
        <Meter
          label="Disk free"
          value={free}
          max={typeof total === "number" ? Math.min(total, Math.max(20, DISK_TARGET_GB * 2)) : undefined}
          tone={diskTone}
          threshold={DISK_FLOOR_GB}
          thresholdLabel={`Jobs refuse below ${num(DISK_FLOOR_GB, 0)} GB (marked); keep ${num(DISK_TARGET_GB, 0)} GB free`}
          valueText={`${num(free, 1)} GB`}
        />
        <Meter
          label="Swap used"
          value={swap}
          max={100}
          tone={swapHigh ? "warn" : "good"}
          threshold={warn}
          thresholdLabel={typeof warn === "number" ? `Warning at ${pct(warn, 0)} (marked)` : undefined}
          valueText={`${pct(swap, 1)} (${num(h?.swap?.used_gb, 1)} of ${num(h?.swap?.total_gb, 1)} GB)`}
        />
        {jobs.length > 0 ? (
          <div>
            <h3 className="mb-1 text-sm font-medium">Scheduled agents</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Sydney time</TableHead>
                  <TableHead>Loaded</TableHead>
                  <TableHead className="text-right">Last exit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j, i) => (
                  <TableRow key={`${j.label}-${i}`}>
                    <TableCell>{j.name || jobName(jobKey(j.label))}</TableCell>
                    <TableCell>{txt(j.local_time)}</TableCell>
                    <TableCell>
                      {j.loaded === true ? (
                        <StatusBadge tone="good">{j.running ? "Running" : "Loaded"}</StatusBadge>
                      ) : j.loaded === false ? (
                        <StatusBadge tone="warn">Not loaded</StatusBadge>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right">{txt(j.last_exit)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        {wake.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Wake schedule:{" "}
            {wake.map((w, i) => (
              <span key={i} className="text-foreground">
                {i > 0 ? ", " : ""}
                {txt(w.needed)} {w.covered ? "covered" : "not covered"}
              </span>
            ))}
            .
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

function DeployPanel({ s }: { s: Snapshot }) {
  const d = s.deploy;
  const dep = s.ops?.deployed;
  return (
    <Panel
      title="Deployed version"
      icon={GitBranch}
      means="Which code the nightly jobs run, the tag to roll back to, and whether the live checkout matches the reviewed main branch."
      action={
        d?.smoke_ok === true ? (
          <StatusBadge tone="good">Smoke test passed</StatusBadge>
        ) : d?.smoke_ok === false ? (
          <StatusBadge tone="bad">Smoke test failed</StatusBadge>
        ) : null
      }
    >
      <KeyValues
        items={[
          { label: "Deployed commit", value: shortSha(d?.to), mono: true },
          { label: "Rollback tag", value: txt(d?.rollback_tag), mono: true },
          { label: "Deployed at", value: txt(d?.at), mono: true },
          { label: "Live branch", value: txt(dep?.branch), mono: true },
          { label: "Live head", value: shortSha(dep?.head), mono: true },
          { label: "Main", value: shortSha(dep?.main), mono: true },
          { label: "Behind main", value: num(dep?.behind) },
          { label: "Ahead of main", value: num(dep?.ahead) },
          { label: "Changed files", value: `${num(dep?.modified)} modified, ${num(dep?.untracked)} untracked` },
        ]}
      />
    </Panel>
  );
}

function DstPanel({ s }: { s: Snapshot }) {
  const changes = list(s.dst);
  return (
    <Panel
      title="Clock changes"
      icon={Clock}
      means="Upcoming daylight-saving switches. Sessions follow New York time, so Sydney job times shift by an hour at each change."
    >
      {changes.length === 0 ? (
        <Empty title="No clock change in the look-ahead window" />
      ) : (
        <ul className="grid gap-2.5">
          {changes.map((c, i) => (
            <li key={`${c.zone}-${i}`} className="flex items-start gap-3 text-sm">
              <CalendarClock aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">
                  {txt(c.zone)}: {shortDate(c.local_date)}
                  {typeof c.days_away === "number" ? (
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      in {c.days_away} day{c.days_away === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </p>
                <p className="text-muted-foreground text-xs">
                  {txt(c.from_offset)} to {txt(c.to_offset)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function LogsPanel({ s }: { s: Snapshot }) {
  const logs: [string, LogInfo | null | undefined][] = [
    ["Pre-market routine", s.ops?.routine?.log],
    ["Paper B", s.ops?.paper?.log],
    ["Forward test", s.ops?.forward?.log],
  ];
  return (
    <Panel
      title="Job logs"
      icon={Database}
      means="Error counts in the latest log of each job. The last error line is shown so a failure can be recognised without logging in to the host."
    >
      <ul className="divide-border grid divide-y">
        {logs.map(([name, log]) => (
          <li key={name} className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm font-medium">{name}</span>
              {log?.exists === false ? (
                <StatusBadge tone="neutral">No log</StatusBadge>
              ) : typeof log?.errors_count === "number" ? (
                <StatusBadge tone={log.errors_count > 0 ? "warn" : "good"}>
                  {log.errors_count} error{log.errors_count === 1 ? "" : "s"}
                </StatusBadge>
              ) : null}
            </div>
            <p className="text-muted-foreground text-xs">
              <span className="font-mono">{txt(log?.file)}</span>, written{" "}
              <RelativeTime iso={log?.modified} fallback={sydney(log?.modified)} />
            </p>
            {log?.last_error ? <p className="bg-muted rounded px-2 py-1 font-mono text-xs break-all">{log.last_error}</p> : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function SourcesPanel({ s }: { s: Snapshot }) {
  const c = s.collector;
  const sources = entries(c?.sources);
  return (
    <Panel
      title="Data sources"
      icon={Database}
      means="Each section of this dashboard is collected from one source on the host. A stale or failed source means that section may be out of date."
      action={
        typeof c?.fresh_sources === "number" && typeof c?.total_sources === "number" ? (
          <StatusBadge tone={c.fresh_sources === c.total_sources ? "good" : "warn"}>
            {c.fresh_sources} of {c.total_sources} fresh
          </StatusBadge>
        ) : null
      }
    >
      <p className="text-muted-foreground mb-3 text-xs">
        Collector exit {txt(c?.exit_code)}, took {num(c?.duration_s, 0)} s, code <span className="font-mono">{shortSha(c?.sha)}</span> on{" "}
        <span className="font-mono">{txt(c?.branch)}</span>
        {c?.dirty ? " with uncommitted changes" : ""}.
      </p>
      {sources.length === 0 ? (
        <Empty title="No source details in this snapshot" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Collected</TableHead>
              <TableHead className="text-right">Took</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map(([name, src]) => (
              <TableRow key={name}>
                <TableCell className="font-medium">{humanize(name)}</TableCell>
                <TableCell>
                  {src.ok === false ? (
                    <StatusBadge tone="bad">Failed</StatusBadge>
                  ) : src.stale ? (
                    <StatusBadge tone="warn">Stale</StatusBadge>
                  ) : src.ok ? (
                    <StatusBadge tone="good">Fresh</StatusBadge>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>{sydney(src.as_of)}</TableCell>
                <TableCell className="text-right">{typeof src.ms === "number" ? `${num(src.ms / 1000, 1)} s` : "—"}</TableCell>
                <TableCell className="max-w-64 truncate" title={src.error ?? undefined}>
                  {txt(src.error)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
