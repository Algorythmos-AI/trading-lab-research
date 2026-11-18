"use client";

import { CartesianGrid, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegendList, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";
import { shortDay } from "@/lib/journal";
import { shortAxis, usdSigned } from "./pnl-curve";

export interface RollingChartPoint {
  /** The trade the window ends on, counted from 1. */
  n: number;
  /** YYYY-MM-DD in New York. */
  day: string;
  /** 0..1. */
  winRate: number;
  /** Dollars per trade. */
  expectancy: number;
}

const CONFIG: ChartConfig = {
  expectancy: { label: "Average per trade (left)", color: "var(--chart-1)" },
  win: { label: "Share that won (right)", color: "var(--chart-3)" },
};

const share = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—";
};

/**
 * The record over a moving window of the last `span` trades: the average result per trade in dollars (left axis) and
 * the share that won (right axis, dashed). A line that climbs is a record getting better; the zero and 50% lines are
 * drawn so neither has to be read off the axis.
 */
export function RollingChart({ points, span }: { points: RollingChartPoint[]; span: number }) {
  return (
    <div>
      <ChartContainer config={CONFIG} className="h-56 sm:h-64" aria-label={`Average result per trade and share that won over the last ${span} trades, trade by trade`}>
        <ComposedChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="n" type="number" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} tickFormatter={(n: number) => `#${n}`} />
          <YAxis yAxisId="usd" tickLine={false} axisLine={false} width={52} tickFormatter={shortAxis} domain={[(lo: number) => Math.min(0, lo), (hi: number) => Math.max(0, hi)]} />
          <YAxis yAxisId="win" orientation="right" tickLine={false} axisLine={false} width={40} tickFormatter={share} domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} />
          <ReferenceLine yAxisId="usd" y={0} strokeWidth={1.5} />
          <ReferenceLine yAxisId="win" y={0.5} stroke="var(--chart-axis)" strokeDasharray="2 4" />
          <Tooltip
            cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
            content={({ active, payload }) => {
              const d = payload?.[0]?.payload as RollingChartPoint | undefined;
              return active && d ? (
                <ChartTooltipBox
                  title={`Trades ${Math.max(1, d.n - span + 1)}–${d.n} · to ${shortDay(d.day)}`}
                  rows={[
                    { key: "expectancy", name: "Average per trade", value: usdSigned(d.expectancy, 2), color: "var(--color-expectancy)" },
                    { key: "win", name: "Share that won", value: share(d.winRate), color: "var(--color-win)" },
                  ]}
                />
              ) : null;
            }}
          />
          <Line yAxisId="usd" dataKey="expectancy" type="linear" stroke="var(--color-expectancy)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} isAnimationActive={false} />
          <Line yAxisId="win" dataKey="winRate" type="linear" stroke="var(--color-win)" strokeWidth={1.75} strokeDasharray="5 3" dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
        </ComposedChart>
      </ChartContainer>
      <ChartLegendList config={CONFIG} />
    </div>
  );
}
