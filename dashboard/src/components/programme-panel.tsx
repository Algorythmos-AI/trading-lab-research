// The programme on one panel: each desk, its state, what decides it against its line, and the record that holds it.
import { Compass } from "lucide-react";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import type { ProgrammeRow } from "@/lib/programme";

export function ProgrammePanel({ rows }: { rows: ProgrammeRow[] }) {
  return (
    <Panel
      id="programme"
      title="The programme"
      icon={Compass}
      means="Every desk, what decides it and where it stands, read from the published records. Paper money only; nothing here is an order."
    >
      <ul className="grid gap-3" data-programme>
        {rows.map((r) => (
          <li key={r.desk} className="grid gap-1 border-t pt-3 first:border-t-0 first:pt-0 sm:grid-cols-[12rem_1fr] sm:gap-4">
            <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-start">
              <span className="font-medium">{r.desk}</span>
              <StatusBadge tone={r.tone}>{r.state}</StatusBadge>
            </div>
            <div className="grid gap-0.5 text-sm">
              {r.lines.map((l) => (
                <p key={l}>{l}</p>
              ))}
              <p className="text-muted-foreground text-xs">Record: {r.record}</p>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
