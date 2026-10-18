"use client";

import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";
import { shortDay } from "@/lib/journal";
import { shortAxis, usdSigned } from "./pnl-curve";

export interface SessionBar {
  /** YYYY-MM-DD, New York. */
  day: string;
  pnl: number;
  trades: number;
  /** The running total across the sessions shown. */
  run: number;
  /** False when the day broke a day rule. */
  kept: boolean;
}

const CONFIG: ChartConfig = {
  win: { label: "Made money", color: "var(--good-fill)" },
  loss: { label: "Lost money", color: "var(--bad-fill)" },
  run: { label: "Running total", color: "var(--info)" },
};

/** One bar per trading day, up for a gain and down for a loss, with the running total across them as a line. */
export function SessionBars({ days }: { days: SessionBar[] }) {
  return (
    <ChartContainer config={CONFIG} className="h-52" aria-label="Result of each recent trading day, with the running total">
      <ComposedChart data={days} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="22%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={18} tickFormatter={shortDay} />
        <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={shortAxis} domain={["auto", "auto"]} />
        <ReferenceLine y={0} strokeWidth={1.5} ifOverflow="extendDomain" />
        <Tooltip
          cursor={{ fill: "var(--muted)", opacity: 0.5 }}
          content={({ active, payload }) => {
            const d = payload?.[0]?.payload as SessionBar | undefined;
            return active && d ? (
              <ChartTooltipBox
                title={shortDay(d.day)}
                rows={[
                  { key: "pnl", name: "Day", value: usdSigned(d.pnl, 2), color: d.pnl >= 0 ? "var(--color-win)" : "var(--color-loss)" },
                  { key: "n", name: "Trades", value: String(d.trades), color: "var(--chart-axis)" },
                  { key: "run", name: "Running", value: usdSigned(d.run, 0), color: "var(--color-run)" },
                  { key: "k", name: "Day rules", value: d.kept ? "Kept" : "Broken", color: d.kept ? "var(--good-fill)" : "var(--warn-fill)" },
                ]}
              />
            ) : null;
          }}
        />
        <Bar dataKey="pnl" radius={[3, 3, 3, 3]} isAnimationActive={false}>
          {days.map((d) => (
            <Cell key={d.day} fill={d.pnl >= 0 ? "var(--color-win)" : "var(--color-loss)"} />
          ))}
        </Bar>
        <Line dataKey="run" type="monotone" stroke="var(--color-run)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ChartContainer>
  );
}
