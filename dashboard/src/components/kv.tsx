import { cn } from "@/lib/utils";

export interface KvItem {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
}

/** Compact label/value grid; two columns on phones, more on wide cards. */
export function KeyValues({ items, className }: { items: KvItem[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3", className)}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-muted-foreground text-xs">{it.label}</dt>
          <dd className={cn("mt-0.5 text-sm font-medium break-words", it.mono && "font-mono text-[0.8125rem]")}>
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
