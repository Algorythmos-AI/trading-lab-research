import { cn } from "@/lib/utils";

export interface ForestRow {
  key: string;
  label: React.ReactNode;
  sub?: React.ReactNode;
  value: number | null;
  low: number | null;
  high: number | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * One estimate per row with its range, against a zero line. A range that crosses zero is drawn in grey:
 * the difference may be luck. Server-rendered; the numbers are written beside every row.
 */
export function Forest({
  rows,
  format,
  label,
  empty = "No range",
}: {
  rows: ForestRow[];
  format: (v: number | null) => string;
  label: string;
  empty?: string;
}) {
  const all = rows.flatMap((r) => [r.value, r.low, r.high]).filter(isNum);
  const reach = Math.max(0.0001, ...all.map((v) => Math.abs(v))) * 1.12;
  const at = (v: number) => `${((v + reach) / (2 * reach)) * 100}%`;
  return (
    <figure className="grid gap-2" role="group" aria-label={label}>
      <div className="grid gap-2.5">
        {rows.map((r) => {
          const ranged = isNum(r.low) && isNum(r.high);
          const tone = !ranged ? "neutral" : r.low! > 0 ? "good" : r.high! < 0 ? "bad" : "neutral";
          const fill = tone === "good" ? "bg-good-fill" : tone === "bad" ? "bg-bad-fill" : "bg-neutral-fill";
          return (
            <div key={r.key} className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_7.5rem]">
              <div className="min-w-0">
                <p className="truncate text-[0.8125rem] font-medium">{r.label}</p>
                {r.sub ? <p className="text-muted-foreground truncate text-xs">{r.sub}</p> : null}
              </div>
              <div className="bg-track/60 relative h-6 rounded-sm" aria-hidden>
                <span className="bg-chart-axis absolute inset-y-0 w-px" style={{ left: "50%" }} />
                {ranged ? (
                  <span
                    className={cn("absolute top-1/2 h-1 -translate-y-1/2 rounded-full opacity-60", fill)}
                    style={{ left: at(r.low!), width: `calc(${at(r.high!)} - ${at(r.low!)})` }}
                  />
                ) : null}
                {isNum(r.value) ? (
                  <span
                    className={cn("border-card absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2", fill)}
                    style={{ left: at(r.value) }}
                  />
                ) : null}
              </div>
              <p className="font-mono text-xs leading-tight whitespace-nowrap sm:text-right">
                {isNum(r.value) ? (
                  <>
                    <span className="text-foreground font-medium">{format(r.value)}</span>
                    {ranged ? <span className="text-muted-foreground sm:block"> {format(r.low)} to {format(r.high)}</span> : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">{empty}</span>
                )}
              </p>
            </div>
          );
        })}
      </div>
      <div className="text-muted-foreground grid font-mono text-[0.6875rem] sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_7.5rem] sm:gap-x-3" aria-hidden>
        <span className="hidden sm:block" />
        <span className="flex justify-between">
          <span>{format(-reach)}</span>
          <span>0</span>
          <span>{format(reach)}</span>
        </span>
      </div>
    </figure>
  );
}
