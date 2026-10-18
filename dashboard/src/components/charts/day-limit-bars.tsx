"use client";

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegendList, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";
import { shortDay } from "@/lib/journal";

export interface DayLimitBar {
  day: string;
  pnl: number;
  trades: number;
}

const CONFIG: ChartConfig = {
  gain: { label: "Up on the day", color: "var(--good-fill)" },
  loss: { label: "Down, inside the limit", color: "var(--warn-fill)" },
  over: { label: "Past the day loss limit", color: "var(--bad-fill)" },
};

const money = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n < 0 ? "−" : n > 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};

/** Each recent trading day's closed result as a bar, against the day loss limit drawn as a red line. */
export function DayLimitBars({ days, limit, cap }: { days: DayLimitBar[]; limit: number; cap: number }) {
  const fill = (d: DayLimitBar) => (d.pnl <= -limit ? "var(--color-over)" : d.pnl < 0 ? "var(--color-loss)" : "var(--color-gain)");
  return (
    <div>
      <ChartContainer config={CONFIG} className="h-56" aria-label={`Closed result of each of the last ${days.length} trading days against the −$${limit} day loss limit`}>
        <BarChart data={days} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="18%">
          <CartesianGrid vertical={false} />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(d: string) => shortDay(d)} />
          <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={money} domain={[(lo: number) => Math.min(-limit * 1.2, lo), (hi: number) => Math.max(0, hi)]} />
          <ReferenceLine y={0} strokeWidth={1.5} />
          <ReferenceLine y={-limit} stroke="var(--bad-fill)" strokeDasharray="4 3" strokeWidth={1.5} label={{ value: `−$${limit} limit`, position: "insideBottomLeft", fill: "var(--bad-fill)", fontSize: 11 }} />
          <Tooltip
            cursor={{ fill: "var(--muted)", opacity: 0.5 }}
            content={({ active, payload }) => {
              const d = payload?.[0]?.payload as DayLimitBar | undefined;
              return active && d ? (
                <ChartTooltipBox
                  title={shortDay(d.day)}
                  rows={[
                    { key: "pnl", name: "Closed result", value: money(d.pnl), color: fill(d) },
                    { key: "trades", name: "Trades", value: `${d.trades}${d.trades > cap ? ` (over ${cap})` : ""}` },
                  ]}
                />
              ) : null;
            }}
          />
          <Bar dataKey="pnl" radius={2} maxBarSize={28} isAnimationActive={false}>
            {days.map((d) => (
              <Cell key={d.day} fill={fill(d)} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      <ChartLegendList config={CONFIG} />
    </div>
  );
}
