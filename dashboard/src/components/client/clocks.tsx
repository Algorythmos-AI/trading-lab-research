"use client";

import { useNow } from "./use-now";

const time = (tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const SYD = time("Australia/Sydney");
const NY = time("America/New_York");
const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** US equity market phase from the New York wall clock. Exchange holidays are not known here. */
export function marketPhase(now: Date): string {
  const parts = Object.fromEntries(NY_PARTS.formatToParts(now).map((p) => [p.type, p.value]));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return "Weekend";
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (mins < 4 * 60) return "Overnight";
  if (mins < 9 * 60 + 30) return "Pre-market";
  if (mins < 16 * 60) return "Market open";
  if (mins < 20 * 60) return "After-hours";
  return "Overnight";
}

export function Clocks() {
  const nowMs = useNow(1000);
  const now = nowMs === null ? null : new Date(nowMs);
  return (
    <div className="flex items-center gap-3 text-xs" aria-label="Local clocks">
      <span className="flex items-baseline gap-1.5">
        <span className="text-muted-foreground">Sydney</span>
        <time className="font-mono text-[0.8125rem] font-medium">{now ? SYD.format(now) : "--:--"}</time>
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-muted-foreground">New York</span>
        <time className="font-mono text-[0.8125rem] font-medium">{now ? NY.format(now) : "--:--"}</time>
      </span>
      <span
        className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 whitespace-nowrap"
        title="From the New York clock; exchange holidays are not shown"
      >
        {now ? marketPhase(now) : "Market"}
      </span>
    </div>
  );
}
