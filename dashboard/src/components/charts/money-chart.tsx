"use client";

import { CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegendList, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";
import { shortDay, type MoneyPoint } from "@/lib/journal";

const CONFIG: ChartConfig = {
  putIn: { label: "Put in", color: "var(--chart-3)" },
  takenOut: { label: "Taken out", color: "var(--chart-2)" },
  value: { label: "Account value", color: "var(--chart-1)" },
};

/** What was put into and taken out of the account over time (a step at each transfer) against what it was worth. */
export function MoneyChart({ points, symbol }: { points: MoneyPoint[]; symbol: string }) {
  const money = (v: unknown, digits = 0) => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return "—";
    return `${n < 0 ? "−" : ""}${symbol}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  };
  const axis = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return "";
    const a = Math.abs(n);
    return `${n < 0 ? "−" : ""}${symbol}${a >= 1000 ? `${(a / 1000).toFixed(a >= 10_000 ? 0 : 1)}k` : Math.round(a)}`;
  };
  // Time runs to scale, so years with few transfers do not look as short as a busy week.
  const data = points.map((p) => ({ ...p, t: Date.parse(`${p.date}T12:00:00Z`) }));
  const tick = (t: number) => shortDay(new Date(t).toISOString().slice(0, 10));
  return (
    <div>
      <ChartContainer config={CONFIG} className="h-56 sm:h-64" aria-label="Money put into the account and money taken out, against the account's value, by day">
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} tickMargin={8} minTickGap={48} tickFormatter={tick} />
          <YAxis tickLine={false} axisLine={false} width={60} tickFormatter={axis} domain={[0, "auto"]} />
          <Tooltip
            cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
            content={({ active, payload }) => {
              const d = payload?.[0]?.payload as (MoneyPoint & { t: number }) | undefined;
              return active && d ? (
                <ChartTooltipBox
                  title={shortDay(d.date)}
                  rows={[
                    { key: "putIn", name: "Put in", value: money(d.putIn), color: "var(--color-putIn)" },
                    { key: "takenOut", name: "Taken out", value: money(d.takenOut), color: "var(--color-takenOut)" },
                    { key: "netIn", name: "Put in, less taken out", value: money(d.netIn) },
                    { key: "value", name: "Account value", value: d.value === null ? "not recorded" : money(d.value), color: "var(--color-value)" },
                  ]}
                />
              ) : null;
            }}
          />
          <Line dataKey="putIn" type="stepAfter" stroke="var(--color-putIn)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} isAnimationActive={false} />
          <Line dataKey="takenOut" type="stepAfter" stroke="var(--color-takenOut)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} isAnimationActive={false} />
          <Line dataKey="value" type="linear" stroke="var(--color-value)" strokeWidth={2} dot={{ r: 2 }} connectNulls activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} isAnimationActive={false} />
        </ComposedChart>
      </ChartContainer>
      <ChartLegendList config={CONFIG} />
    </div>
  );
}
