"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegendList, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";

export interface LineSeries {
  /** CSS-identifier safe: it names the colour variable. */
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
  points: { t: number; v: number }[];
}

const pct = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
};
const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
const stamp = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** Several books on one time axis, each as a change in percent from its own start. Times are UTC. */
export function LinesChart({ series, label }: { series: LineSeries[]; label: string }) {
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]));
  const sparse = series.every((s) => s.points.length <= 24);
  return (
    <div>
      <ChartContainer config={config} className="h-64 sm:h-72" aria-label={label}>
        <LineChart margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            allowDuplicatedCategory={false}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={40}
            tickFormatter={(t: number) => day.format(new Date(t))}
          />
          <YAxis dataKey="v" tickLine={false} axisLine={false} width={64} tickFormatter={pct} domain={[(lo: number) => Math.min(0, lo), (hi: number) => Math.max(0, hi)]} />
          <ReferenceLine y={0} strokeWidth={1.5} />
          <Tooltip
            cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
            content={({ active, payload, label: at }) =>
              active && payload?.length ? (
                <ChartTooltipBox
                  title={`${stamp.format(new Date(Number(at)))} UTC`}
                  rows={payload.map((p) => ({
                    key: String(p.name),
                    name: config[String(p.name)]?.label ?? String(p.name),
                    value: pct(p.value),
                    color: `var(--color-${String(p.name)})`,
                  }))}
                />
              ) : null
            }
          />
          {series.map((s) => (
            <Line
              key={s.key}
              name={s.key}
              data={s.points}
              dataKey="v"
              type="linear"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              strokeDasharray={s.dashed ? "5 4" : undefined}
              dot={sparse ? { r: 3, strokeWidth: 2, stroke: "var(--card)", fill: `var(--color-${s.key})` } : false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
      <ChartLegendList config={config} />
    </div>
  );
}
