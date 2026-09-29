import { Check, Minus, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { dayIn, duration, NEW_YORK, shortDate, txt } from "@/lib/format";
import { jobKey, jobName, sortJobKeys } from "@/lib/labels";
import type { JobRun } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DataDetails } from "./data-details";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

type CellStatus = "ok" | "failed" | "timeout" | "refused" | "other";
const SEVERITY: Record<CellStatus, number> = { ok: 0, other: 1, refused: 2, timeout: 3, failed: 4 };
const CELL: Record<CellStatus, { cls: string; Icon: LucideIcon; label: string }> = {
  ok: { cls: "bg-good-fill text-white", Icon: Check, label: "OK" },
  failed: { cls: "bg-bad-fill text-white", Icon: X, label: "Failed" },
  timeout: { cls: "bg-warn-fill text-black", Icon: TriangleAlert, label: "Timed out" },
  refused: { cls: "bg-serious-fill text-black", Icon: Minus, label: "Refused" },
  other: { cls: "bg-neutral-fill text-white", Icon: Minus, label: "Other" },
};

const SHORT_NAMES: Record<string, string> = {
  routine: "Routine",
  "paper-b": "Paper B",
  forward: "Forward",
  weekly: "Weekly",
  dashboard: "Dashboard",
};

const toStatus = (s: string | null | undefined): CellStatus => {
  const v = String(s ?? "").toLowerCase();
  return v === "ok" || v === "failed" || v === "timeout" || v === "refused" ? v : "other";
};

/** The `days` ET dates ending at `endYmd`, oldest first. */
function lastDays(endYmd: string, days: number): string[] {
  const [y, m, d] = endYmd.split("-").map(Number);
  const end = Date.UTC(y!, m! - 1, d!);
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** Rows are jobs, columns are trading days (New York date), cells show the worst run of that day. */
export function JobHeatmap({ runs, asOf, extraJobs = [] }: { runs: JobRun[]; asOf: string | null; extraJobs?: string[] }) {
  const endDay = dayIn(asOf, NEW_YORK) ?? runs.map((r) => dayIn(r.started, NEW_YORK)).filter(Boolean).sort().at(-1);
  if (!endDay) return null;
  const days = lastDays(endDay, 14);
  const cells = new Map<string, CellStatus>();
  for (const r of runs) {
    const day = dayIn(r.started, NEW_YORK);
    if (!day) continue;
    const key = `${jobKey(r.job)}|${day}`;
    const st = toStatus(r.status);
    const prev = cells.get(key);
    if (!prev || SEVERITY[st] > SEVERITY[prev]) cells.set(key, st);
  }
  const jobs = sortJobKeys([...runs.map((r) => jobKey(r.job)).filter(Boolean), ...extraJobs]);

  return (
    <div>
      <div
        role="grid"
        aria-label="Job runs per day over the last 14 days"
        className="grid items-center gap-[3px]"
        style={{ gridTemplateColumns: `minmax(4.5rem, 7rem) repeat(${days.length}, minmax(0, 1.75rem))` }}
      >
        <div role="row" className="contents">
          <span role="columnheader" className="text-muted-foreground text-xs">
            Job
          </span>
          {days.map((d, i) => (
            <span
              role="columnheader"
              key={d}
              title={d}
              className={cn("text-center text-[0.6875rem] tabular-nums", weekday(d) % 6 === 0 ? "text-muted-foreground/60" : "text-muted-foreground")}
            >
              {i % 2 === (days.length - 1) % 2 ? Number(d.slice(8, 10)) : ""}
            </span>
          ))}
        </div>
        {jobs.map((job) => (
          <div role="row" key={job} className="contents">
            <span role="rowheader" className="truncate pr-1 text-xs font-medium" title={jobName(job)}>
              {SHORT_NAMES[job] ?? jobName(job)}
            </span>
            {days.map((d) => {
              const st = cells.get(`${job}|${d}`);
              const label = `${jobName(job)}, ${d}: ${st ? CELL[st].label : "no run"}`;
              if (!st) {
                return (
                  <span role="gridcell" key={d} aria-label={label} title={label} className="border-border aspect-square max-h-7 rounded-[3px] border border-dashed" />
                );
              }
              const { cls, Icon } = CELL[st];
              return (
                <span role="gridcell" key={d} aria-label={label} title={label} className={cn("grid aspect-square max-h-7 place-items-center rounded-[3px]", cls)}>
                  <Icon aria-hidden className="size-[60%] max-h-3.5 max-w-3.5" strokeWidth={3} />
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <ul className="text-muted-foreground mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Legend">
        {(["ok", "failed", "timeout", "refused"] as const).map((k) => {
          const { cls, Icon, label } = CELL[k];
          return (
            <li key={k} className="flex items-center gap-1.5">
              <span className={cn("grid size-3.5 place-items-center rounded-[3px]", cls)}>
                <Icon aria-hidden className="size-2.5" strokeWidth={3} />
              </span>
              {label}
            </li>
          );
        })}
        <li className="flex items-center gap-1.5">
          <span className="border-border size-3.5 rounded-[3px] border border-dashed" />
          No run
        </li>
      </ul>
      <DataDetails summary="Show every run">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Day (New York)</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Exit</TableHead>
              <TableHead className="text-right">Took</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...runs].reverse().map((r, i) => (
              <TableRow key={i}>
                <TableCell>{jobName(r.job)}</TableCell>
                <TableCell>{shortDate(dayIn(r.started, NEW_YORK))}</TableCell>
                <TableCell>{CELL[toStatus(r.status)].label === "Other" ? txt(r.status) : CELL[toStatus(r.status)].label}</TableCell>
                <TableCell className="text-right">{txt(r.exit)}</TableCell>
                <TableCell className="text-right">{duration(r.started, r.ended)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataDetails>
    </div>
  );
}
