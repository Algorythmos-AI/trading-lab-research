import type { Tone } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { TONE_FILL } from "./status";

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/**
 * A horizontal meter: filled share of `max`, an optional threshold tick (a target or a floor),
 * and the value written out so the bar is never the only carrier of the number.
 */
export function Meter({
  label,
  value,
  max,
  valueText,
  tone = "info",
  threshold,
  thresholdLabel,
  className,
}: {
  label: React.ReactNode;
  value: number | null | undefined;
  max: number | null | undefined;
  valueText: React.ReactNode;
  tone?: Tone;
  threshold?: number | null;
  thresholdLabel?: string;
  className?: string;
}) {
  const ok = typeof value === "number" && typeof max === "number" && Number.isFinite(value) && max > 0;
  const share = ok ? clamp(value / max) : 0;
  const tick =
    typeof threshold === "number" && typeof max === "number" && max > 0 ? clamp(threshold / max) : null;
  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-[0.8125rem]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{valueText}</span>
      </div>
      <div
        role="meter"
        aria-label={typeof label === "string" ? label : undefined}
        aria-valuemin={0}
        aria-valuemax={ok ? max : undefined}
        aria-valuenow={ok ? value : undefined}
        className="bg-track relative h-2 overflow-visible rounded-full"
      >
        <div className={cn("h-full rounded-full", TONE_FILL[tone])} style={{ width: `${share * 100}%` }} />
        {tick !== null ? (
          <span
            aria-hidden
            title={thresholdLabel}
            className="bg-foreground absolute -top-1 -bottom-1 w-0.5 rounded-full"
            style={{ left: `calc(${tick * 100}% - 1px)` }}
          />
        ) : null}
      </div>
      {thresholdLabel && tick !== null ? <p className="text-muted-foreground text-xs">{thresholdLabel}</p> : null}
    </div>
  );
}
