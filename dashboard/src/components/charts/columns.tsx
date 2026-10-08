import { num } from "@/lib/format";

export interface Column {
  key: string;
  label: string;
  count: number;
  /** Which side of zero the band is on, when that means something. */
  side?: "loss" | "gain" | "flat";
}

const FILL = { loss: "bg-bad-fill", gain: "bg-good-fill", flat: "bg-neutral-fill" } as const;

/** Counts per band as columns, each with its count above and its band below. Server-rendered. */
export function Columns({ columns, label }: { columns: Column[]; label: string }) {
  const top = Math.max(1, ...columns.map((c) => c.count));
  return (
    <div className="grid gap-1" role="group" aria-label={label}>
      <div className="flex h-32 items-end gap-1">
        {columns.map((c) => (
          <div key={c.key} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-0.5">
            <span className="text-muted-foreground text-center font-mono text-[0.6875rem]">{c.count > 0 ? num(c.count) : ""}</span>
            <span className={`rounded-[2px] ${FILL[c.side ?? "flat"]}`} style={{ height: `${(c.count / top) * 82}%`, minHeight: c.count > 0 ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="flex gap-1">
        {columns.map((c) => (
          <span key={c.key} className="text-muted-foreground min-w-0 flex-1 text-center text-[0.625rem] leading-tight sm:text-[0.6875rem]">
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
