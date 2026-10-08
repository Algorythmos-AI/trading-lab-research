"use client";

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";

export interface TradeBar {
  i: number;
  r: number;
  /** "Trend · AVAX/USD" */
  what: string;
  /** When it ended, already formatted. */
  when: string;
}

const r = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}R`;
};

const CONFIG: ChartConfig = { win: { label: "Made money", color: "var(--good-fill)" }, loss: { label: "Lost money", color: "var(--bad-fill)" } };

/** One bar per closed trade in the order they ended: its result in R, up for a gain and down for a loss. */
export function TradeBars({ trades, whenLabel = "Ended (UTC)", label = "Result of each closed trade in R, oldest first" }: { trades: TradeBar[]; whenLabel?: string; label?: string }) {
  return (
    <ChartContainer config={CONFIG} className="h-52" aria-label={label}>
      <BarChart data={trades} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="18%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="i" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
        <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={r} domain={[(lo: number) => Math.min(0, lo), (hi: number) => Math.max(0, hi)]} />
        <ReferenceLine y={0} strokeWidth={1.5} />
        <Tooltip
          cursor={{ fill: "var(--muted)", opacity: 0.5 }}
          content={({ active, payload }) => {
            const d = payload?.[0]?.payload as TradeBar | undefined;
            return active && d ? (
              <ChartTooltipBox
                title={d.what}
                rows={[
                  { key: "r", name: d.r >= 0 ? "Gain" : "Loss", value: r(d.r), color: d.r >= 0 ? "var(--color-win)" : "var(--color-loss)" },
                  { key: "when", name: whenLabel, value: d.when },
                ]}
              />
            ) : null;
          }}
        />
        <Bar dataKey="r" radius={2} maxBarSize={28} isAnimationActive={false}>
          {trades.map((d) => (
            <Cell key={d.i} fill={d.r >= 0 ? "var(--color-win)" : "var(--color-loss)"} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
