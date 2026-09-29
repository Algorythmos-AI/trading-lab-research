"use client";

import * as React from "react";
import { ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";

/** Series config: keys must be CSS-identifier safe (they become `--color-<key>`). */
export type ChartConfig = Record<string, { label: React.ReactNode; color: string }>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

export function useChart() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error("useChart must be used within <ChartContainer />");
  return ctx;
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const vars = Object.entries(config)
    .filter(([key]) => /^[A-Za-z][\w-]*$/.test(key))
    .map(([key, c]) => `  --color-${key}: ${c.color};`)
    .join("\n");
  if (!vars) return null;
  return <style dangerouslySetInnerHTML={{ __html: `[data-chart="${id}"] {\n${vars}\n}` }} />;
}

export function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof ResponsiveContainer>["children"];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/[^A-Za-z0-9-]/g, "")}`;
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "text-muted-foreground flex w-full justify-center text-xs",
          "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-chart-grid",
          "[&_.recharts-reference-line_line]:stroke-chart-axis [&_.recharts-surface]:outline-hidden [&_.recharts-wrapper]:outline-hidden",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 200 }}>
          {children}
        </ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export interface TooltipRow {
  key: string;
  name: React.ReactNode;
  value: React.ReactNode;
  color?: string;
}

/** The tooltip body: a title and one row per series. Values stay in ink; the swatch carries identity. */
export function ChartTooltipBox({ title, rows }: { title: React.ReactNode; rows: TooltipRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="bg-popover text-popover-foreground grid min-w-[9rem] gap-1.5 rounded-md border px-2.5 py-2 text-xs shadow-lg">
      <div className="font-medium">{title}</div>
      <div className="grid gap-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            {r.color ? <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: r.color }} /> : null}
            <span className="text-muted-foreground flex-1 truncate">{r.name}</span>
            <span className="text-foreground font-medium tabular-nums">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Legend rendered in HTML under the plot (always present for two or more series). */
export function ChartLegendList({ config, className }: { config: ChartConfig; className?: string }) {
  const items = Object.entries(config);
  if (items.length < 2) return null;
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-1.5 pt-3 text-xs", className)}>
      {items.map(([key, c]) => (
        <li key={key} className="text-foreground flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-3.5 rounded-full" style={{ background: c.color }} />
          {c.label}
        </li>
      ))}
    </ul>
  );
}
