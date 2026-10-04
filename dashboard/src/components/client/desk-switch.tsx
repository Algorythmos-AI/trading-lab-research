"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DESK_LABEL, deskOfPath, type DeskName } from "@/lib/desk";
import { cn } from "@/lib/utils";

const HOME: Record<DeskName, string> = { stocks: "/", crypto: "/crypto" };

/** Stocks | Crypto. The desk is part of the URL, so a link to a page is a link to its desk. */
export function DeskSwitch() {
  const active = deskOfPath(usePathname());
  return (
    <nav aria-label="Desk" className="bg-muted inline-flex rounded-md p-0.5">
      {(Object.keys(HOME) as DeskName[]).map((d) => (
        <Link
          key={d}
          href={HOME[d]}
          aria-current={d === active ? "true" : undefined}
          className={cn(
            "rounded px-2.5 py-1 text-xs font-medium transition-colors",
            d === active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {DESK_LABEL[d]}
        </Link>
      ))}
    </nav>
  );
}
