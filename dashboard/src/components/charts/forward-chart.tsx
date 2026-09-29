"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";

export interface ForwardPointRow {
  session: string;
  cum_r: number;
  n: number | null;
}

const fmtR = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Number(Math.abs(n).toFixed(2))}R`;
};

const shortDay = (ymd: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))),
  );
};

/**
 * One strategy's cumulative R by session. Small multiples share `domain`, so heights compare across
 * strategies without a legend or a ninth colour.
 */
export function ForwardMini({
  name,
  points,
  ticks,
}: {
  name: string;
  points: ForwardPointRow[];
  /** Shared y ticks (always including 0); the first and last set the domain. */
  ticks: number[];
}) {
  const domain: [number, number] = [ticks[0] ?? -1, ticks.at(-1) ?? 1];
  const config: ChartConfig = { cum: { label: name, color: "var(--chart-1)" } };
  return (
    <ChartContainer config={config} className="h-36" aria-label={`${name}: cumulative R by session`}>
      <LineChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="session" tickLine={false} axisLine={false} tickMargin={6} tickFormatter={shortDay} minTickGap={16} />
        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={fmtR} domain={domain} ticks={ticks} interval={0} />
        <ReferenceLine y={0} strokeWidth={1} />
        <Tooltip
          cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
          content={({ active, payload, label }) => {
            const row = payload?.[0]?.payload as ForwardPointRow | undefined;
            return active && row ? (
              <ChartTooltipBox
                title={shortDay(String(label ?? ""))}
                rows={[
                  { key: "cum", name: "Cumulative", value: fmtR(row.cum_r), color: "var(--color-cum)" },
                  { key: "n", name: "Trades that session", value: row.n ?? "—" },
                ]}
              />
            ) : null;
          }}
        />
        <Line
          dataKey="cum_r"
          type="linear"
          stroke="var(--color-cum)"
          strokeWidth={2}
          dot={{ r: 3.5, strokeWidth: 2, stroke: "var(--card)", fill: "var(--color-cum)" }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
