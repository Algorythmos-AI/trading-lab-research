import { CircleDashed, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** A designed empty state: says what is missing and what will fill it. */
export function Empty({
  title,
  children,
  icon: Icon = CircleDashed,
  className,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div className={cn("bg-muted/40 flex items-start gap-3 rounded-md border border-dashed px-3 py-3", className)}>
      <Icon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        {children ? <div className="text-muted-foreground text-[0.8125rem]">{children}</div> : null}
      </div>
    </div>
  );
}
