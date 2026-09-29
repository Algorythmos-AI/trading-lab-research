import type { LucideIcon } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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
    <Card className={className} id={id} aria-labelledby={id ? `${id}-title` : undefined}>
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
