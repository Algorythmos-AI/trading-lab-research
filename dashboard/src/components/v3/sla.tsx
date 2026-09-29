import { Activity } from "lucide-react";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { TONE_FILL } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pct, shortDate } from "@/lib/format";
import { jobName } from "@/lib/labels";
import { list, type SlaStatus, type Snapshot } from "@/lib/types";
import { cn } from "@/lib/utils";
import { hasV3, SLA_GLYPH, SLA_LABEL, SLA_TONE, slaStatus } from "@/lib/v3";
import { V3Pending } from "./pending";

const LEGEND: SlaStatus[] = ["ok", "refused", "partial", "failed", "missed", "none"];

/** Did each scheduled job run, day by day (ET), over the last two weeks. */
export function SlaPanel({ s }: { s: Snapshot }) {
  const sla = s.sla;
  const days = list(sla?.days);
  const cells = list(sla?.cells);
  const summary = list(sla?.summary);
  const at = new Map(cells.map((c) => [`${c.job}|${c.date}`, c]));
  return (
    <Panel
      id="sla"
      title="Job reliability, 14 days"
      icon={Activity}
      means="One square per job per US trading day. 'Missed' means the job was due and left no record; 'Refused' means its safety checks stopped it on purpose. Today stays blank while a job may still run."
    >
      {!hasV3(s) ? (
        <V3Pending what="The reliability matrix" />
      ) : summary.length === 0 ? (
        <Empty title="No job records yet" />
      ) : (
        <div className="grid gap-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                {days.map((d) => (
                  <TableHead key={d} className="px-0.5 text-center text-[0.6875rem] font-normal">
                    <span className="sr-only">{shortDate(d)}</span>
                    <span aria-hidden>{d.slice(8, 10)}</span>
                  </TableHead>
                ))}
                <TableHead className="text-right">OK</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.map((row) => (
                <TableRow key={row.job}>
                  <TableCell className="font-medium whitespace-nowrap">{jobName(row.job)}</TableCell>
                  {days.map((d) => {
                    const c = at.get(`${row.job}|${d}`);
                    const st = slaStatus(c?.status);
                    const tone = SLA_TONE[st];
                    const title = `${jobName(row.job)}, ${shortDate(d)}: ${SLA_LABEL[st]}${c?.runs ? ` (${c.runs} run${c.runs === 1 ? "" : "s"})` : ""}`;
                    return (
                      <TableCell key={d} className="px-0.5 py-1 text-center">
                        <span
                          title={title}
                          aria-label={title}
                          role="img"
                          className={cn(
                            "inline-flex size-5 items-center justify-center rounded-sm text-[0.6875rem] font-semibold",
                            st === "none" || st === "n/a"
                              ? "bg-muted text-muted-foreground"
                              : cn(TONE_FILL[tone], tone === "warn" ? "text-black" : "text-white"),
                          )}
                        >
                          {SLA_GLYPH[st]}
                        </span>
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right tabular-nums">{pct(row.ok_pct, 0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
            {LEGEND.map((st) => (
              <li key={st} className="flex items-center gap-1.5">
                <span aria-hidden className="font-semibold">{SLA_GLYPH[st]}</span>
                {SLA_LABEL[st]}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
