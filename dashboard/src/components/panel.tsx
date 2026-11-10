import type { LucideIcon } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * How far an anchored section stops below the top of the window, so a link to it does not land under what sticks
 * there: on a phone the Trades page's jump bar; from sm up the site header (taller while its first row wraps, below
 * lg) and that bar under it. See `trades-jump-bar.tsx` for the heights.
 */
export const ANCHOR_MARGIN = "scroll-mt-20 sm:scroll-mt-44 lg:scroll-mt-40";

/**
 * A titled card. `means` is the one-line plain-English "what this means" for a non-engineer.
 */
export function Panel({
  title,
  means,
  icon: Icon,
  action,
  children,
  className,
  contentClassName,
  id,
}: {
  title: React.ReactNode;
  means: React.ReactNode;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  id?: string;
}) {
  return (
    <Card className={cn(id ? ANCHOR_MARGIN : undefined, className)} id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <CardHeader>
        <CardTitle id={id ? `${id}-title` : undefined} className="flex items-center gap-2">
          {Icon ? <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" /> : null}
          {title}
        </CardTitle>
        <CardDescription>{means}</CardDescription>
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className={cn(contentClassName)}>{children}</CardContent>
    </Card>
  );
}
