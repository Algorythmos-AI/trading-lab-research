import { humanize } from "@/lib/labels";
import { num } from "@/lib/format";
import type { SpecArea } from "@/lib/types";
import { cn } from "@/lib/utils";

export const SPEC_PARTS = [
  { key: "implemented", label: "Implemented", cls: "bg-chart-1" },
  { key: "planned", label: "Planned", cls: "bg-chart-2" },
  { key: "needs_data", label: "Needs data", cls: "bg-chart-3" },
  { key: "n_a", label: "Not applicable", cls: "bg-chart-na" },
] as const;

type PartKey = (typeof SPEC_PARTS)[number]["key"];
const val = (a: SpecArea, k: PartKey) => (typeof a[k] === "number" && Number.isFinite(a[k]) ? (a[k] as number) : 0);

/** One 100% bar per area; segments in a fixed order with 2 px gaps; counts written beside each bar. */
export function SpecBars({ areas }: { areas: SpecArea[] }) {
  return (
    <div className="grid gap-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Legend">
        {SPEC_PARTS.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2.5 rounded-[2px]", p.cls)} />
            {p.label}
          </li>
        ))}
      </ul>
      <ul className="grid gap-2">
        {areas.map((a, i) => {
          const total = SPEC_PARTS.reduce((s, p) => s + val(a, p.key), 0) || 0;
          const label = SPEC_PARTS.filter((p) => val(a, p.key) > 0)
            .map((p) => `${p.label} ${val(a, p.key)}`)
            .join(", ");
          return (
            <li key={`${a.area}-${i}`} className="grid grid-cols-[5.5rem_1fr_3.5rem] items-center gap-2 text-xs sm:grid-cols-[7rem_1fr_4rem]">
              <span className="truncate font-medium">{humanize(a.area)}</span>
              <span className="flex h-2.5 gap-[2px]" role="img" aria-label={`${humanize(a.area)}: ${label || "no requirements"}`}>
                {total > 0 ? (
                  SPEC_PARTS.filter((p) => val(a, p.key) > 0).map((p) => (
                    <span
                      key={p.key}
                      title={`${p.label}: ${val(a, p.key)}`}
                      className={cn("h-full first:rounded-l-[3px] last:rounded-r-[3px]", p.cls)}
                      style={{ flexGrow: val(a, p.key), flexBasis: 0 }}
                    />
                  ))
                ) : (
                  <span className="bg-track h-full flex-1 rounded-[3px]" />
                )}
              </span>
              <span className="text-right tabular-nums">
                {num(a.implemented)}/{num(a.total ?? total)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
