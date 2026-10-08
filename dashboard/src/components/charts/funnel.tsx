import { num } from "@/lib/format";

export interface FunnelRow {
  key: string;
  label: React.ReactNode;
  count: number;
  /** A step inside the one above it (drawn indented). */
  inner?: boolean;
  fill?: string;
}

/** Counts as bars on the scale of the first row, so each step reads as a share of everything recorded. */
export function Funnel({ rows, label }: { rows: FunnelRow[]; label: string }) {
  const top = Math.max(1, rows[0]?.count ?? 0, ...rows.map((r) => r.count));
  return (
    <div className="grid gap-1.5" role="group" aria-label={label}>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_3.5rem] items-center gap-x-3 text-[0.8125rem]">
          <span className={r.inner ? "text-muted-foreground min-w-0 pl-3" : "min-w-0"}>{r.label}</span>
          <span className="bg-track/60 relative h-4 rounded-sm" aria-hidden>
            <span className={`absolute inset-y-0.5 left-0 rounded-[2px] ${r.fill ?? "bg-chart-1"}`} style={{ width: `${(r.count / top) * 100}%` }} />
          </span>
          <span className="text-right font-mono text-xs">{num(r.count)}</span>
        </div>
      ))}
    </div>
  );
}
