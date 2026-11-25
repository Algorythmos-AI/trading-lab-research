"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DESK_HOME, deskOfPath, type DeskName } from "@/lib/desk";
import { deskNote } from "@/lib/desk-state";
import { GAP_HUNTER } from "@/lib/robots";
import { cn } from "@/lib/utils";

export const NAV = [
  { href: "/", label: "Overview" },
  { href: "/today", label: "Today" },
  { href: "/radar", label: "Radar" },
  { href: "/options", label: "Options" },
  { href: "/paper", label: "Paper" },
  { href: GAP_HUNTER.href, label: GAP_HUNTER.name },
  { href: "/trades", label: "Trades" },
  { href: "/calendar", label: "Calendar" },
  { href: "/strategies", label: "Strategies" },
  { href: "/research", label: "Research" },
  { href: "/research/records", label: "Records" },
  { href: "/operations", label: "Operations" },
  { href: "/risk", label: "Risk" },
  { href: "/engineering", label: "Engineering" },
] as const;

/** The crypto desk is closed (DEC-0036, src/lib/desks.json): one page at /crypto and no sections. */
export const CRYPTO_NAV: readonly { href: string; label: string }[] = [];

/** The HFT desk's sections (ADR 0006). One for now; the desk lives in another repository and adds pages as it grows. */
export const HFT_NAV = [{ href: "/hft", label: "Overview" }] as const;

const DESK_NAV: Record<DeskName, readonly { href: string; label: string }[]> = { stocks: NAV, crypto: CRYPTO_NAV, hft: HFT_NAV };

/** The one section a path belongs to: the home page exactly, otherwise the longest section the path is under. */
export function activeHref(nav: readonly { href: string }[], pathname: string, home: string): string | null {
  let best: string | null = null;
  for (const { href } of nav) {
    const hit = href === home ? pathname === href : pathname.startsWith(href);
    if (hit && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

export function NavTabs() {
  const pathname = usePathname();
  const desk = deskOfPath(pathname);
  const nav = DESK_NAV[desk];
  const listRef = useRef<HTMLUListElement>(null);
  const rowRef = useRef<HTMLElement>(null);
  // Which ends of a row too wide for the screen hide tabs: each fades out, so a cut-off row reads as one that scrolls.
  const [hidden, setHidden] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setHidden((h) => (h.left === left && h.right === right ? h : { left, right }));
  }, []);
  useEffect(() => {
    // On a phone the tab row scrolls sideways; keep the current section in view.
    listRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
    measure();
  }, [pathname, measure]);
  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  // A closed desk has one page and no sections: no empty landmark either.
  if (nav.length === 0 || (desk !== "stocks" && deskNote(desk).state === "closed")) return null;
  return (
    <nav
      ref={rowRef}
      aria-label="Sections"
      onScroll={measure}
      data-hidden-left={hidden.left || undefined}
      data-hidden-right={hidden.right || undefined}
      className={cn(
        "-mb-px overflow-x-auto [scrollbar-width:none]",
        hidden.left && hidden.right
          ? "[mask-image:linear-gradient(to_right,transparent,black_2rem,black_calc(100%-2rem),transparent)]"
          : hidden.right
            ? "[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]"
            : hidden.left
              ? "[mask-image:linear-gradient(to_right,transparent,black_2rem)]"
              : undefined,
      )}
    >
      <ul ref={listRef} className="flex min-w-max gap-1">
        {nav.map((item) => {
          // A desk's first page matches exactly; every other section also covers the pages under it, and where two
          // sections cover a page (Research and its Records) the longer one is the page's.
          const active = item.href === activeHref(nav, pathname, DESK_HOME[desk]);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center border-b-2 px-2.5 text-sm transition-colors max-sm:h-11",
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
