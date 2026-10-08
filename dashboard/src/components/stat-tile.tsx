import type { LucideIcon } from "lucide-react";
import type { Tone } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { TONE_TEXT } from "./status";

const EDGE: Record<Tone, string> = {
  good: "before:bg-good-fill",
  warn: "before:bg-warn-fill",
  bad: "before:bg-bad-fill",
  info: "before:bg-info-fill",
  neutral: "before:bg-neutral-fill",
};

/** One headline number: what it is, the number, and a line saying how to read it. */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  icon: Icon,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "tile bg-card relative min-w-0 overflow-hidden rounded-lg border py-3 pr-3.5 pl-4",
        "before:absolute before:inset-y-0 before:left-0 before:w-0.5",
        EDGE[tone],
        className,
      )}
    >
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {Icon ? <Icon aria-hidden className={cn("size-3.5 shrink-0", TONE_TEXT[tone])} /> : null}
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1 font-mono text-[1.0625rem] leading-tight font-semibold tracking-tight break-words sm:text-xl">{value}</p>
      {hint ? <p className="text-muted-foreground mt-1 text-xs leading-snug">{hint}</p> : null}
    </div>
  );
}

export function StatTiles({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>{children}</div>;
}
