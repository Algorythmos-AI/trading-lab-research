"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { DESK_HOME, deskOfPath, type DeskName } from "@/lib/desk";
import { deskNote } from "@/lib/desk-state";
import { cn } from "@/lib/utils";

export const NAV = [
  { href: "/", label: "Overview" },
  { href: "/today", label: "Today" },
  { href: "/radar", label: "Radar" },
  { href: "/options", label: "Options" },
  { href: "/trades", label: "Trades" },
  { href: "/strategies", label: "Strategies" },
  { href: "/research", label: "Research" },
  { href: "/operations", label: "Operations" },
  { href: "/risk", label: "Risk" },
  { href: "/engineering", label: "Engineering" },
] as const;

/** The crypto desk is closed (DEC-0036, src/lib/desks.json): one page at /crypto and no sections. */
export const CRYPTO_NAV: readonly { href: string; label: string }[] = [];

/** The HFT desk's sections (ADR 0006). One for now; the desk lives in another repository and adds pages as it grows. */
export const HFT_NAV = [{ href: "/hft", label: "Overview" }] as const;

const DESK_NAV: Record<DeskName, readonly { href: string; label: string }[]> = { stocks: NAV, crypto: CRYPTO_NAV, hft: HFT_NAV };

export function NavTabs() {
  const pathname = usePathname();
  const desk = deskOfPath(pathname);
  const nav = DESK_NAV[desk];
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    // On a phone the tab row scrolls sideways; keep the current section in view.
    listRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);
  // A closed desk has one page and no sections: no empty landmark either.
  if (nav.length === 0 || (desk !== "stocks" && deskNote(desk).state === "closed")) return null;
  return (
    <nav aria-label="Sections" className="-mb-px overflow-x-auto [scrollbar-width:none]">
      <ul ref={listRef} className="flex min-w-max gap-1">
        {nav.map((item) => {
          // A desk's first page matches exactly; every other section also covers the pages under it.
          const active = item.href === DESK_HOME[desk] ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center border-b-2 px-2.5 text-sm transition-colors",
                  active
                    ? "border-primary text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
