"use client";

import { Bar, BarChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegendList, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";

export interface KeptSkippedPoint {
  name: string;
  kept: number | null;
  skipped: number | null;
}

const r = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(3)}R`;
};

const CONFIG: ChartConfig = {
  kept: { label: "Signals it would keep", color: "var(--chart-1)" },
  skipped: { label: "Signals it would skip", color: "var(--chart-2)" },
};

/** Average result of the signals each model would keep beside the ones it would skip. A useful model's kept bar is higher. */
export function KeptSkippedChart({ points }: { points: KeptSkippedPoint[] }) {
  return (
    <div>
      <ChartContainer config={CONFIG} className="h-52" aria-label="Average result of kept and skipped signals, per model">
        <BarChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={4} barCategoryGap="28%">
          <CartesianGrid vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} interval={0} />
          <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={r} domain={[(lo: number) => Math.min(0, lo), (hi: number) => Math.max(0, hi)]} />
          <ReferenceLine y={0} strokeWidth={1.5} />
          <Tooltip
            cursor={{ fill: "var(--muted)", opacity: 0.5 }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <ChartTooltipBox
                  title={String(label ?? "")}
                  rows={payload.map((p) => ({
                    key: String(p.dataKey),
                    name: CONFIG[String(p.dataKey)]?.label ?? String(p.dataKey),
                    value: r(p.value),
                    color: `var(--color-${String(p.dataKey)})`,
                  }))}
                />
              ) : null
            }
          />
          <Bar dataKey="kept" fill="var(--color-kept)" radius={2} maxBarSize={36} isAnimationActive={false} />
          <Bar dataKey="skipped" fill="var(--color-skipped)" radius={2} maxBarSize={36} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
      <ChartLegendList config={CONFIG} />
    </div>
  );
}
