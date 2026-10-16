"use client";

import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegendList, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";

export interface PnlPoint {
  /** YYYY-MM-DD in New York. */
  day: string;
  pnl: number;
  cum: number;
  dd: number;
  trades: number;
}

export const usdSigned = (v: unknown, digits = 0) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}$${s}`;
};

const shortAxis = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "";
  const a = Math.abs(n);
  const s = a >= 1000 ? `${(a / 1000).toFixed(a >= 10_000 ? 0 : 1)}k` : `${Math.round(a)}`;
  return `${n < 0 ? "−" : ""}$${s}`;
};

const dayLabel = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });

const CONFIG: ChartConfig = {
  cum: { label: "Running total", color: "var(--chart-1)" },
  dd: { label: "Below the earlier high", color: "var(--chart-8)" },
};

/** The running total of closed trades in dollars, day by day, with the fall from its earlier high shaded beneath. */
export function PnlCurve({ points }: { points: PnlPoint[] }) {
  const data = points.map((p, i) => ({ ...p, i }));
  return (
    <div>
      <ChartContainer config={CONFIG} className="h-64 sm:h-72" aria-label="Running total of closed trades in dollars, by day, with the fall from the earlier high">
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="pnl-cum-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-cum)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--color-cum)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="i" type="number" domain={[0, "dataMax"]} tickLine={false} axisLine={false} tickMargin={8} minTickGap={48} tickFormatter={(i: number) => (data[i] ? dayLabel(data[i]!.day) : "")} />
          <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={shortAxis} domain={[(lo: number) => Math.min(0, lo), (hi: number) => Math.max(0, hi)]} />
          <ReferenceLine y={0} strokeWidth={1.5} />
          <Tooltip
            cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
            content={({ active, payload }) => {
              const d = payload?.[0]?.payload as (PnlPoint & { i: number }) | undefined;
              return active && d ? (
                <ChartTooltipBox
                  title={`${dayLabel(d.day)} · ${d.trades} trade${d.trades === 1 ? "" : "s"}`}
                  rows={[
                    { key: "day", name: "That day", value: usdSigned(d.pnl, 2), color: d.pnl >= 0 ? "var(--good-fill)" : "var(--bad-fill)" },
                    { key: "cum", name: "Running total", value: usdSigned(d.cum, 2), color: "var(--color-cum)" },
                    { key: "dd", name: "Below the high", value: usdSigned(d.dd, 2), color: "var(--color-dd)" },
                  ]}
                />
              ) : null;
            }}
          />
          <Area dataKey="dd" type="stepAfter" stroke="var(--color-dd)" strokeWidth={1} fill="var(--color-dd)" fillOpacity={0.16} isAnimationActive={false} />
          <Area dataKey="cum" type="linear" stroke="none" fill="url(#pnl-cum-fill)" isAnimationActive={false} />
          <Line dataKey="cum" type="linear" stroke="var(--color-cum)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} isAnimationActive={false} />
        </ComposedChart>
      </ChartContainer>
      <ChartLegendList config={CONFIG} />
    </div>
  );
}
