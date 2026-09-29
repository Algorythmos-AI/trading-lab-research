import { Gauge } from "lucide-react";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pct, shortDate, sydney, txt } from "@/lib/format";
import { list, type Snapshot } from "@/lib/types";
import { hasV3, LIMIT_LABEL, limitTone } from "@/lib/v3";
import { V3Pending } from "./pending";

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
      means="Each limit as the code enforces it, and how much of it today has used. Loss limits count against the US$600 virtual account; a limit that is used up latches the runner until the owner resets it."
      action={
        allowed === true ? (
          <StatusBadge tone="good">Entries allowed</StatusBadge>
        ) : allowed === false ? (
          <StatusBadge tone="warn">Entries blocked</StatusBadge>
        ) : null
      }
    >
      {!hasV3(s) ? (
        <V3Pending what="The limits table" />
      ) : rows.length === 0 ? (
        <Empty title="No limits in this snapshot" />
      ) : (
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-3">
            {rows
              .filter((r) => typeof r.used_pct === "number")
              .map((r) => (
                <Meter
                  key={r.id}
                  label={txt(r.label)}
                  value={r.used_pct}
                  max={100}
                  tone={limitTone(r.state)}
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
                    <StatusBadge tone={limitTone(r.state)}>{r.state ? LIMIT_LABEL[r.state] : "Unknown"}</StatusBadge>
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
