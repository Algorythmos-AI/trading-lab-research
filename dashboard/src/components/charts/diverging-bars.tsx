import { cn } from "@/lib/utils";

export interface DivergingRow {
  key: string;
  label: React.ReactNode;
  value: number | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Signed values as bars from a centre line, on one shared scale. `better` says which side is the good one,
 * or "none" when a sign is a direction rather than a verdict. Server-rendered; every bar has its number.
 */
export function DivergingBars({
  rows,
  format,
  label,
  better = "none",
}: {
  rows: DivergingRow[];
  format: (v: number) => string;
  label: string;
  better?: "positive" | "negative" | "none";
}) {
  const reach = Math.max(0.0001, ...rows.map((r) => (isNum(r.value) ? Math.abs(r.value) : 0)));
  const fillOf = (v: number) => {
    if (better === "none") return v >= 0 ? "bg-chart-1" : "bg-chart-2";
    const good = better === "positive" ? v > 0 : v < 0;
    return v === 0 ? "bg-neutral-fill" : good ? "bg-good-fill" : "bg-bad-fill";
  };
  return (
    <div className="grid gap-1.5" role="group" aria-label={label}>
      {rows.map((r) => {
        const share = isNum(r.value) ? (Math.abs(r.value) / reach) * 50 : 0;
        return (
          <div key={r.key} className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_4.5rem] items-center gap-x-3 text-[0.8125rem]">
            <span className="min-w-0 leading-snug">{r.label}</span>
            <span className="bg-track/60 relative h-4 rounded-sm" aria-hidden>
              <span className="bg-chart-axis absolute inset-y-0 left-1/2 w-px" />
              {isNum(r.value) && share > 0 ? (
                <span
                  className={cn("absolute inset-y-0.5 rounded-[2px]", fillOf(r.value))}
                  style={r.value >= 0 ? { left: "50%", width: `${share}%` } : { right: "50%", width: `${share}%` }}
                />
              ) : null}
            </span>
            <span className="text-right font-mono text-xs">{isNum(r.value) ? format(r.value) : "—"}</span>
          </div>
        );
      })}
    </div>
  );
}
