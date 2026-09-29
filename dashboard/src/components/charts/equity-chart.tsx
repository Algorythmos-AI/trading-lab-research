"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";

export interface EquityPoint {
  date: string;
  equity: number | null;
}

const fmt = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
};

const shortDay = (ymd: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))),
  );
};

/** Virtual paper equity by day, with the starting balance as the reference line. */
export function EquityChart({ points, start }: { points: EquityPoint[]; start: number | null }) {
  const config: ChartConfig = { equity: { label: "Virtual equity", color: "var(--chart-1)" } };
  return (
    <ChartContainer config={config} className="h-44" aria-label="Virtual paper equity by day">
      <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={shortDay} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={fmt} domain={["auto", "auto"]} />
        {start !== null ? <ReferenceLine y={start} strokeWidth={1} /> : null}
        <Tooltip
          cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <ChartTooltipBox
                title={shortDay(String(label ?? ""))}
                rows={[{ key: "equity", name: "Virtual equity", value: fmt(payload[0]?.value), color: "var(--color-equity)" }]}
              />
            ) : null
          }
        />
        <Line
          dataKey="equity"
          type="linear"
          stroke="var(--color-equity)"
          strokeWidth={2}
          dot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--color-equity)" }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
