import { freshness } from "@/lib/freshness";
import type { CryptoResult, HftResult, SnapshotResult } from "@/lib/snapshot";
import { list } from "@/lib/types";
import { Clocks } from "./client/clocks";
import { DeskSwitch } from "./client/desk-switch";
import { DeskFreshnessPill } from "./client/freshness-pill";
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

export function SiteHeader({ result, crypto, hft, now }: { result: SnapshotResult; crypto: CryptoResult; hft: HftResult; now: number }) {
  const snap = result.status === "ok" ? result.snapshot : null;
  const windows = list(snap?.expected_windows);
  const f = freshness(snap?.as_of ?? null, windows, now);
  const csnap = crypto.status === "ok" ? crypto.snapshot : null;
  const cwindows = list(csnap?.expected_windows);
  const cf = freshness(csnap?.as_of ?? null, cwindows, now);
  const hsnap = hft.status === "ok" ? hft.snapshot : null;
  const hwindows = list(hsnap?.expected_windows);
  const hf = freshness(hsnap?.as_of ?? null, hwindows, now);
  return (
    // On a phone the header is two rows: the logo, the desk switch, the feed pill and the theme button on one row
    // that never wraps; then the section tabs, with the clocks as one chip pinned over the tab row's right end (the
    // tab row stops short of it). From sm up nothing here changes.
    <header className="bg-card/80 supports-[backdrop-filter]:bg-card/70 z-30 border-b backdrop-blur max-sm:relative sm:sticky sm:top-0">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pt-3 max-sm:flex-nowrap max-sm:gap-x-2 max-sm:pt-1 sm:gap-x-4 sm:px-6">
        {/* On a phone the name gives way so the desk switch shares its row: the header is one row shorter. */}
        <div className="flex min-w-0 items-center gap-2.5 sm:mr-auto">
          <Mark />
          <div className="min-w-0 leading-tight max-sm:sr-only">
            <p className="truncate text-sm font-semibold">Trading Lab</p>
            <p className="text-muted-foreground hidden truncate text-xs sm:block">Paper research status, read-only</p>
          </div>
        </div>
        <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2 max-sm:contents">
          <DeskSwitch />
          <DeskFreshnessPill
            desks={{
              stocks: { asOf: snap?.as_of ?? null, windows, initial: { state: f.state, ageMin: f.ageMin } },
              crypto: { asOf: csnap?.as_of ?? null, windows: cwindows, initial: { state: cf.state, ageMin: cf.ageMin } },
              hft: { asOf: hsnap?.as_of ?? null, windows: hwindows, initial: { state: hf.state, ageMin: hf.ageMin } },
            }}
          />
          <ThemeToggle className="max-sm:ml-auto max-sm:size-11" />
        </div>
        <div className="w-full max-sm:absolute max-sm:right-4 max-sm:bottom-0 max-sm:flex max-sm:h-11 max-sm:w-auto max-sm:items-center sm:order-none sm:w-auto">
          <Clocks />
        </div>
      </div>
      {/* On a phone the tab row ends where the clock chip starts (10 rem, the widest chip: NY and Sydney over each
          other, then "After-hours"). */}
      <div className="mx-auto max-w-6xl px-2 max-sm:mr-40 max-sm:min-h-11 sm:px-4">
        <NavTabs />
      </div>
    </header>
  );
}
