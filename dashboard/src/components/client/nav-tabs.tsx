"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export const NAV = [
  { href: "/", label: "Overview" },
  { href: "/strategies", label: "Strategies" },
  { href: "/research", label: "Research" },
  { href: "/operations", label: "Operations" },
  { href: "/risk", label: "Risk" },
  { href: "/engineering", label: "Engineering" },
] as const;

export function NavTabs() {
  const pathname = usePathname();
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    // On a phone the tab row scrolls sideways; keep the current section in view.
    listRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);
  return (
    <nav aria-label="Sections" className="-mb-px overflow-x-auto [scrollbar-width:none]">
      <ul ref={listRef} className="flex min-w-max gap-1">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
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
