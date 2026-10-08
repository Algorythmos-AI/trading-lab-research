"use client";

import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegendList, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";

export interface CumulativePoint {
  i: number;
  /** The trade's day, already formatted. */
  day: string;
  cum: number | null;
  /** How far below the earlier high the total stands (zero or below). */
  dd: number | null;
}

const r = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}R`;
};

const CONFIG: ChartConfig = {
  cum: { label: "Running total", color: "var(--chart-1)" },
  dd: { label: "Below the earlier high", color: "var(--chart-8)" },
};

/** The running total of closed trades in R, trade by trade, with the fall from the earlier high shaded beneath. */
export function CumulativeChart({ points, compact = false }: { points: CumulativePoint[]; compact?: boolean }) {
  return (
    <div>
      <ChartContainer config={CONFIG} className={compact ? "h-44" : "h-60"} aria-label="Running total of closed trades in R, with the fall from the earlier high">
        <ComposedChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="i" type="number" domain={[1, "dataMax"]} allowDecimals={false} tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} />
          <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={r} domain={[(lo: number) => Math.min(0, lo), (hi: number) => Math.max(0, hi)]} />
          <ReferenceLine y={0} strokeWidth={1.5} />
          <Tooltip
            cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
            content={({ active, payload }) => {
              const d = payload?.[0]?.payload as CumulativePoint | undefined;
              return active && d ? (
                <ChartTooltipBox
                  title={`Trade ${d.i} · ${d.day}`}
                  rows={[
                    { key: "cum", name: CONFIG.cum!.label, value: r(d.cum), color: "var(--color-cum)" },
                    { key: "dd", name: CONFIG.dd!.label, value: r(d.dd), color: "var(--color-dd)" },
                  ]}
                />
              ) : null;
            }}
          />
          <Area dataKey="dd" type="stepAfter" stroke="var(--color-dd)" strokeWidth={1} fill="var(--color-dd)" fillOpacity={0.18} isAnimationActive={false} />
          <Line
            dataKey="cum"
            type="linear"
            stroke="var(--color-cum)"
            strokeWidth={2}
            dot={points.length <= 40 ? { r: 3, strokeWidth: 2, stroke: "var(--card)", fill: "var(--color-cum)" } : false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ChartContainer>
      <ChartLegendList config={CONFIG} />
    </div>
  );
}
