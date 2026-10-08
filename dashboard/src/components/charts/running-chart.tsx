"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegendList, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";

export interface RunningPoint {
  n: number;
  kept: number;
  skipped: number;
}

const r = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}R`;
};

const CONFIG: ChartConfig = {
  kept: { label: "Signals the model liked", color: "var(--chart-3)" },
  skipped: { label: "Signals it disliked", color: "var(--chart-2)" },
};

/** Running total result of liked and of disliked signals as they finish. A useful model's liked line pulls away upward. */
export function RunningChart({ points }: { points: RunningPoint[] }) {
  return (
    <div>
      <ChartContainer config={CONFIG} className="h-52" aria-label="Running total result of liked and disliked signals">
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="n" type="number" domain={[1, "dataMax"]} allowDecimals={false} tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} />
          <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={r} domain={[(lo: number) => Math.min(0, lo), (hi: number) => Math.max(0, hi)]} />
          <ReferenceLine y={0} strokeWidth={1.5} />
          <Tooltip
            cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <ChartTooltipBox
                  title={`After ${String(label ?? "")} finished signals`}
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
          <Line dataKey="kept" type="stepAfter" stroke="var(--color-kept)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          <Line dataKey="skipped" type="stepAfter" stroke="var(--color-skipped)" strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
      <ChartLegendList config={CONFIG} />
    </div>
  );
}
