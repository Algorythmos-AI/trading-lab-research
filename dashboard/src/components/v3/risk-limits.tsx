import { Gauge } from "lucide-react";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pct, shortDate, sydney, txt } from "@/lib/format";
import { list, type Snapshot } from "@/lib/types";
import { limitLabel, limitTone, sectionState } from "@/lib/v3";
import { V3Missing, V3Pending } from "./pending";

/** Every limit in force, read from the code and config that enforce it, with today's usage. */
export function RiskLimitsPanel({ s }: { s: Snapshot }) {
  const risk = s.risk;
  const rows = list(risk?.limits);
  const c = risk?.controls;
  const allowed = c?.entries_allowed;
  return (
    <Panel
      id="limits"
      title="Limits in force"
      icon={Gauge}
      means="Paper B's limits as its code enforces them, and how much of each today has used. Loss limits count against its US$600 virtual paper account; a limit that is used up latches the robot until the owner resets it on the host."
      action={
        allowed === true ? (
          <StatusBadge tone="good">Entries allowed</StatusBadge>
        ) : allowed === false ? (
          <StatusBadge tone="warn">Entries blocked</StatusBadge>
        ) : null
      }
    >
      {sectionState(s, risk) === "v2" ? (
        <V3Pending what="The limits table" />
      ) : sectionState(s, risk) === "missing" ? (
        <V3Missing what="The limits table" />
      ) : rows.length === 0 ? (
        <Empty title="No limits in this snapshot" />
      ) : (
        <div className="grid gap-5">
          {rows.every((r) => r.state === "n/a" || !r.state) ? (
            <p className="text-muted-foreground text-sm">
              No limit has a reading in this snapshot. That is normal when paper B has not traded today (a weekend, a holiday or before the open); the limits still apply when it does.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-3">
            {rows
              .filter((r) => typeof r.used_pct === "number")
              .map((r) => (
                <Meter
                  key={r.id}
                  label={txt(r.label)}
                  value={r.used_pct}
                  max={100}
                  tone={limitTone(r.state, r.id)}
                  valueText={`${txt(r.used)} of ${txt(r.limit)}`}
                />
              ))}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Limit</TableHead>
                <TableHead>Set at</TableHead>
                <TableHead>Today</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="hidden sm:table-cell">Enforced by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{txt(r.label)}</TableCell>
                  <TableCell>{txt(r.limit)}</TableCell>
                  <TableCell>
                    {txt(r.used)}
                    {typeof r.used_pct === "number" ? (
                      <span className="text-muted-foreground"> ({pct(r.used_pct, 0)})</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={limitTone(r.state, r.id)}>{limitLabel(r.state, r.id)}</StatusBadge>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden font-mono text-xs sm:table-cell">
                    {txt(r.source)} {r.source_sha ? `@${r.source_sha}` : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <KeyValues
            items={[
              { label: "Trading day (ET)", value: shortDate(risk?.used_today?.date) },
              { label: "Entries today", value: txt(risk?.used_today?.entries) },
              { label: "Latch resets (all time)", value: txt(c?.latch_resets) },
              { label: "Last reset", value: c?.last_reset ? `${sydney(c.last_reset)} Sydney` : "Never" },
            ]}
          />
        </div>
      )}
    </Panel>
  );
}
