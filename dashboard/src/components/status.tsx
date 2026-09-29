import { CircleCheck, CircleMinus, Info, OctagonX, TriangleAlert, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/lib/labels";
import { cn } from "@/lib/utils";

export const TONE_ICON: Record<Tone, LucideIcon> = {
  good: CircleCheck,
  warn: TriangleAlert,
  bad: OctagonX,
  info: Info,
  neutral: CircleMinus,
};

export const TONE_TEXT: Record<Tone, string> = {
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  info: "text-info",
  neutral: "text-neutral",
};

export const TONE_FILL: Record<Tone, string> = {
  good: "bg-good-fill",
  warn: "bg-warn-fill",
  bad: "bg-bad-fill",
  info: "bg-info-fill",
  neutral: "bg-neutral-fill",
};

/** A status is always icon + words, never colour alone. */
export function StatusBadge({
  tone,
  children,
  className,
  icon,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
  icon?: LucideIcon;
}) {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <Badge variant={tone} className={className}>
      <Icon aria-hidden />
      {children}
    </Badge>
  );
}

export function ToneIcon({ tone, className, label }: { tone: Tone; className?: string; label?: string }) {
  const Icon = TONE_ICON[tone];
  return <Icon className={cn("size-4 shrink-0", TONE_TEXT[tone], className)} aria-label={label} aria-hidden={label ? undefined : true} />;
}
