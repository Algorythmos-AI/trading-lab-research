"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { deskOfPath } from "@/lib/desk";
import { cn } from "@/lib/utils";

export const NAV = [
  { href: "/", label: "Overview" },
  { href: "/today", label: "Today" },
  { href: "/strategies", label: "Strategies" },
  { href: "/research", label: "Research" },
  { href: "/operations", label: "Operations" },
  { href: "/risk", label: "Risk" },
  { href: "/engineering", label: "Engineering" },
] as const;

/** The crypto desk's sections (ADR 0005). Engineering is one page for the whole lab. */
export const CRYPTO_NAV = [
  { href: "/crypto", label: "Overview" },
  { href: "/crypto/strategy", label: "Strategy" },
  { href: "/crypto/research", label: "Research" },
  { href: "/crypto/operations", label: "Operations" },
  { href: "/crypto/risk", label: "Risk" },
  { href: "/engineering", label: "Engineering" },
] as const;

export function NavTabs() {
  const pathname = usePathname();
  const nav = deskOfPath(pathname) === "crypto" ? CRYPTO_NAV : NAV;
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    // On a phone the tab row scrolls sideways; keep the current section in view.
    listRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);
  return (
    <nav aria-label="Sections" className="-mb-px overflow-x-auto [scrollbar-width:none]">
      <ul ref={listRef} className="flex min-w-max gap-1">
        {nav.map((item) => {
          const active = item.href === "/" || item.href === "/crypto" ? pathname === item.href : pathname.startsWith(item.href);
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
