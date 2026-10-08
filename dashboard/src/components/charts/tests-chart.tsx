"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegendList, ChartTooltipBox, type ChartConfig } from "@/components/ui/chart";

export interface TestPoint {
  test: number;
  spread: number | null;
  lower: number | null;
}

const r = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(3)}R`;
};

const CONFIG: ChartConfig = {
  spread: { label: "Liked minus disliked", color: "var(--chart-1)" },
  lower: { label: "Worst case allowed by luck", color: "var(--chart-2)" },
};

/** Each test the model has faced, on the full row of tests it is allowed. It passes when the lower line is above zero. */
export function TestsChart({ points }: { points: TestPoint[] }) {
  return (
    <div>
      <ChartContainer config={CONFIG} className="h-52" aria-label="Result of each test: liked minus disliked, and its lower bound">
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="test" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => `Test ${v}`} interval={0} />
          <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={r} domain={["auto", "auto"]} />
          <ReferenceLine y={0} strokeWidth={1.5} strokeDasharray="4 3" />
          <Tooltip
            cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <ChartTooltipBox
                  title={`Test ${String(label ?? "")}`}
                  rows={payload.map((p) => ({
                    key: String(p.dataKey),
                    name: CONFIG[String(p.dataKey)]?.label ?? String(p.dataKey),
                    value: r(p.value),
                    color: `var(--color-${String(p.dataKey)})`,
                  }))}
                />
              ) : null
            }
          />
          <Line
            dataKey="spread"
            type="linear"
            stroke="var(--color-spread)"
            strokeWidth={2}
            dot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--color-spread)" }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }}
            isAnimationActive={false}
          />
          <Line
            dataKey="lower"
            type="linear"
            stroke="var(--color-lower)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--color-lower)" }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
      <ChartLegendList config={CONFIG} />
    </div>
  );
}
