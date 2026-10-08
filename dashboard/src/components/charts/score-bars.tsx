import { num } from "@/lib/format";

export interface ScoreBand {
  lo: number;
  hi: number;
  kept: number;
  halved: number;
  skipped: number;
}

const PARTS = [
  { key: "kept", label: "Liked: taken in full", fill: "bg-chart-3" },
  { key: "halved", label: "Borderline: halved", fill: "bg-chart-4" },
  { key: "skipped", label: "Disliked: skipped", fill: "bg-chart-2" },
] as const;

/**
 * How many signals fell in each score band, stacked by what the model would do with them once it acts.
 * The two lines are the model's cut-offs. Server-rendered; the count is written over every column.
 */
export function ScoreBars({ bins, cutoff, halfBelow, label }: { bins: ScoreBand[]; cutoff: number | null; halfBelow: number | null; label: string }) {
  const top = Math.max(1, ...bins.map((b) => b.kept + b.halved + b.skipped));
  const lo = bins[0]?.lo ?? 0;
  const hi = bins[bins.length - 1]?.hi ?? 1;
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo || 1)) * 100))}%`;
  const marks = [
    { v: cutoff, text: "skip below" },
    { v: halfBelow, text: "halve below" },
  ].filter((m): m is { v: number; text: string } => typeof m.v === "number" && m.v >= lo && m.v <= hi);
  return (
    <figure className="grid gap-2" role="group" aria-label={label}>
      <div className="relative">
        <div className="flex h-36 items-end gap-1">
          {bins.map((b) => {
            const total = b.kept + b.halved + b.skipped;
            return (
              <div key={b.lo} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-0.5">
                <span className="text-muted-foreground text-center font-mono text-[0.6875rem]">{total > 0 ? num(total) : ""}</span>
                <div className="flex flex-col-reverse overflow-hidden rounded-[2px]" style={{ height: `${(total / top) * 82}%` }}>
                  {PARTS.map((p) => (b[p.key] > 0 ? <span key={p.key} className={p.fill} style={{ flexGrow: b[p.key] }} /> : null))}
                </div>
              </div>
            );
          })}
        </div>
        {marks.map((m) => (
          <span key={m.text} aria-hidden className="border-foreground/60 absolute inset-y-0 border-l border-dashed" style={{ left: at(m.v) }} />
        ))}
      </div>
      <div className="text-muted-foreground flex justify-between font-mono text-[0.6875rem]" aria-hidden>
        <span>{lo.toFixed(2)}</span>
        <span>score</span>
        <span>{hi.toFixed(2)}</span>
      </div>
      <figcaption className="grid gap-1.5">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {PARTS.map((p) => (
            <li key={p.key} className="flex items-center gap-1.5">
              <span aria-hidden className={`size-2.5 rounded-[2px] ${p.fill}`} />
              {p.label}
            </li>
          ))}
        </ul>
        {marks.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Dashed lines: {marks.map((m) => `${m.text} ${m.v.toFixed(2)}`).join(", ")}.
          </p>
        ) : null}
      </figcaption>
    </figure>
  );
}
