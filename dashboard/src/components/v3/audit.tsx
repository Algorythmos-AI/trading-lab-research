import { BellRing, ListChecks } from "lucide-react";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sydney, txt } from "@/lib/format";
import { humanize } from "@/lib/labels";
import { list, type Snapshot } from "@/lib/types";
import { AUDIT_LABEL, auditTone, hasV3, sectionState } from "@/lib/v3";
import { V3Missing, V3Pending } from "./pending";

/** One time-ordered record of deploys, overrides, latch resets, refusals and alerts. */
export function AuditPanel({ s }: { s: Snapshot }) {
  const a = s.audit;
  const events = list(a?.events).slice().reverse();
  return (
    <Panel
      id="audit"
      title="Audit trail"
      icon={ListChecks}
      means="Who or what changed the system, newest first: deploys, kill switch, latch resets, refused or failed jobs, and alerts. The owner's own notes stay on the Mac."
      action={
        !hasV3(s) ? null : a?.chain_ok === true ? (
          <StatusBadge tone="good">Log intact</StatusBadge>
        ) : a?.chain_ok === false ? (
          <StatusBadge tone="bad">Log altered at #{txt(a.chain_bad_seq)}</StatusBadge>
        ) : null
      }
    >
      {sectionState(s, a) === "v2" ? (
        <V3Pending what="The audit trail" />
      ) : sectionState(s, a) === "missing" ? (
        <V3Missing what="The audit trail" />
      ) : events.length === 0 ? (
        <Empty title="Nothing recorded yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When (Sydney)</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.slice(0, 50).map((e, i) => (
              <TableRow key={`${e.at}-${i}`}>
                <TableCell className="whitespace-nowrap">{sydney(e.at)}</TableCell>
                <TableCell>
                  <StatusBadge tone={auditTone(e.kind)}>{AUDIT_LABEL[e.kind ?? ""] ?? humanize(e.kind)}</StatusBadge>
                </TableCell>
                <TableCell className="text-muted-foreground">{txt(e.detail)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

/** Every alert that fired or resolved, newest first (what reached the owner's phone). */
export function AlertHistoryPanel({ s }: { s: Snapshot }) {
  const rows = list(s.alerts?.history).slice().reverse();
  return (
    <Panel
      id="alert-history"
      title="Alert history"
      icon={BellRing}
      means="Alerts as they started and cleared. Repeats while an alert keeps firing are not sent again, so each row is one message."
    >
      {sectionState(s, s.alerts?.history) === "v2" ? (
        <V3Pending what="The alert history" />
      ) : sectionState(s, s.alerts?.history) === "missing" ? (
        <V3Missing what="The alert history" />
      ) : rows.length === 0 ? (
        <Empty title="No alerts recorded yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When (Sydney)</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Alert</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, 50).map((r, i) => (
              <TableRow key={`${r.at}-${i}`}>
                <TableCell className="whitespace-nowrap">{sydney(r.at)}</TableCell>
                <TableCell>
                  <StatusBadge tone={r.event === "fired" ? "bad" : "good"}>
                    {r.event === "fired" ? "Fired" : "Resolved"}
                  </StatusBadge>
                </TableCell>
                <TableCell>{txt(r.title)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
