import { freshness } from "@/lib/freshness";
import type { SnapshotResult } from "@/lib/snapshot";
import { list } from "@/lib/types";
import { Clocks } from "./client/clocks";
import { FreshnessPill } from "./client/freshness-pill";
import { NavTabs } from "./client/nav-tabs";
import { ThemeToggle } from "./client/theme-toggle";

function Mark() {
  // Seven gate nodes on a rail: the project's K0 -> G5 path, as the product mark.
  return (
    <svg viewBox="0 0 28 28" className="size-7 shrink-0" aria-hidden>
      <rect x="0.5" y="0.5" width="27" height="27" rx="5" className="fill-primary/10 stroke-primary/40" />
      <path d="M5 14h18" className="stroke-primary" strokeWidth="1.5" />
      {[5, 11, 17, 23].map((x, i) => (
        <circle key={x} cx={x} cy="14" r="2.4" className={i < 2 ? "fill-primary" : "fill-card stroke-primary"} strokeWidth="1.5" />
      ))}
    </svg>
  );
}

export function SiteHeader({ result, now }: { result: SnapshotResult; now: number }) {
  const snap = result.status === "ok" ? result.snapshot : null;
  const windows = list(snap?.expected_windows);
  const f = freshness(snap?.as_of ?? null, windows, now);
  return (
    <header className="bg-card/80 supports-[backdrop-filter]:bg-card/70 z-30 border-b backdrop-blur sm:sticky sm:top-0">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pt-3 sm:gap-x-4 sm:px-6">
        <div className="mr-auto flex min-w-0 items-center gap-2.5">
          <Mark />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold">Trading Lab</p>
            <p className="text-muted-foreground hidden truncate text-xs sm:block">Paper research status, read-only</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <FreshnessPill
            asOf={snap?.as_of ?? null}
            windows={windows}
            initial={{ state: f.state, ageMin: f.ageMin }}
          />
          <ThemeToggle />
        </div>
        <div className="w-full sm:order-none sm:w-auto">
          <Clocks />
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-2 sm:px-4">
        <NavTabs />
      </div>
    </header>
  );
}
