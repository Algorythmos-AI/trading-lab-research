"use client";

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";
import { shortMonth } from "@/lib/journal";
import { shortAxis, usdSigned } from "./pnl-curve";

export interface MonthBar {
  /** YYYY-MM. */
  month: string;
  pnl: number;
  trades: number;
  winRate: number;
}

const CONFIG: ChartConfig = { win: { label: "Made money", color: "var(--good-fill)" }, loss: { label: "Lost money", color: "var(--bad-fill)" } };

const monthLabel = shortMonth;

/** One bar per month with a closed trade: its result in dollars, up for a gain and down for a loss. */
export function MonthBars({ months }: { months: MonthBar[] }) {
  return (
    <ChartContainer config={CONFIG} className="h-56" aria-label="Result of each month in dollars">
      <BarChart data={months} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="22%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} minTickGap={8} tickFormatter={monthLabel} />
        <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={shortAxis} domain={["auto", "auto"]} />
        <ReferenceLine y={0} strokeWidth={1.5} ifOverflow="extendDomain" />
        <Tooltip
          cursor={{ fill: "var(--muted)", opacity: 0.5 }}
          content={({ active, payload }) => {
            const d = payload?.[0]?.payload as MonthBar | undefined;
            return active && d ? (
              <ChartTooltipBox
                title={monthLabel(d.month)}
                rows={[
                  { key: "pnl", name: "Result", value: usdSigned(d.pnl, 2), color: d.pnl >= 0 ? "var(--color-win)" : "var(--color-loss)" },
                  { key: "n", name: "Trades", value: String(d.trades), color: "var(--chart-axis)" },
                  { key: "w", name: "Won", value: `${Math.round(d.winRate * 100)}%`, color: "var(--chart-axis)" },
                ]}
              />
            ) : null;
          }}
        />
        <Bar dataKey="pnl" radius={[3, 3, 3, 3]} isAnimationActive={false}>
          {months.map((m) => (
            <Cell key={m.month} fill={m.pnl >= 0 ? "var(--color-win)" : "var(--color-loss)"} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
