"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DESK_HOME, DESK_LABEL, DESKS, deskOfPath } from "@/lib/desk";
import { cn } from "@/lib/utils";

/** Stocks | Crypto | HFT. The desk is part of the URL, so a link to a page is a link to its desk. */
export function DeskSwitch() {
  const active = deskOfPath(usePathname());
  return (
    <nav aria-label="Desk" className="bg-muted inline-flex rounded-md p-0.5">
      {DESKS.map((d) => (
        <Link
          key={d}
          href={DESK_HOME[d]}
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
