// The Trades page's four groups and the bar that jumps between them. Server-rendered: plain links, no script.
import { ANCHOR_MARGIN } from "@/components/panel";
import { cn } from "@/lib/utils";

/** The page's groups, in order. Each id is rendered by `TradesGroup`; the bar links to them by these ids. */
export const TRADES_GROUPS = {
  today: { id: "today-group", label: "Today" },
  record: { id: "record", label: "The record", short: "Record" },
  history: { id: "history", label: "History" },
  clone: { id: "clone-group", label: "Options clone (paper)", short: "Clone" }, // options-clone.tsx CLONE_TITLE
} as const;

/** Panels worth a link of their own, by the id their panel already carries (journal.tsx). */
export const TRADES_QUICK = {
  lossSize: { id: "loss-size", label: "Loss size" },
  trades: { id: "trades", label: "Every trade" },
  money: { id: "money", label: "Money" },
} as const;

export interface JumpLink {
  href: `#${string}`;
  label: string;
  /** A shorter label for a phone ("Record"), so the bar's first four links fit 390 px; the full one is read out. */
  short?: string;
  /** 1 for a group, 2 for a panel inside one. */
  level: 1 | 2;
}

/**
 * The bar's links, only to what the page draws: no journal, only the clone; a view with no trades in it has no loss
 * size panel and no list of trades; no money record, no money panel and, with no calendar either, no History group.
 */
export function jumpLinks({ journal, record = false, money = false }: { journal: boolean; record?: boolean; money?: boolean }): JumpLink[] {
  const g = (k: keyof typeof TRADES_GROUPS): JumpLink => {
    const group: { id: string; label: string; short?: string } = TRADES_GROUPS[k];
    return { href: `#${group.id}`, label: group.label, level: 1, ...(group.short ? { short: group.short } : {}) };
  };
  const q = (k: keyof typeof TRADES_QUICK): JumpLink => ({ href: `#${TRADES_QUICK[k].id}`, label: TRADES_QUICK[k].label, level: 2 });
  if (!journal) return [g("clone")];
  return [
    g("today"),
    g("record"),
    ...(record || money ? [g("history")] : []),
    g("clone"),
    ...(record ? [q("lossSize"), q("trades")] : []),
    ...(money ? [q("money")] : []),
  ];
}

/**
 * Where the bar sticks. On a phone the site header scrolls away, so the bar sits at the very top. From sm up it sits
 * under the sticky header: 12px of padding, the 32px first row, the 40px section tabs and a 1px border make 85px at
 * lg and up; below lg the header's clocks wrap onto a second row (20px and a 6px gap), so it is about 111px there.
 * The bar itself is about 64px tall on a phone and 52px from sm up; `ANCHOR_MARGIN` in panel.tsx clears both.
 * The header is z-30; the bar stays under it.
 */
const STICK = "sticky top-0 z-20 sm:top-[7rem] lg:top-[5.375rem]";

/** The jump bar: one row of plain links that scrolls sideways inside itself when it is wider than the screen. */
export function TradesJumpBar({ links }: { links: JumpLink[] }) {
  return (
    <nav aria-label="On this page" className={cn(STICK, "bg-background -mx-4 border-b px-4 py-2 sm:-mx-6 sm:px-6")}>
      <div className="overflow-x-auto [scrollbar-width:thin]">
        <div className="bg-muted inline-flex w-max items-center rounded-md p-0.5">
          {links.map((l, i) => (
            <span key={l.href} className="contents">
              {/* A thin rule where the groups end and the panel links start. */}
              {l.level === 2 && links[i - 1]?.level === 1 ? <span aria-hidden className="bg-border mx-1 h-5 w-px" /> : null}
              <a
                href={l.href}
                className="text-muted-foreground hover:text-foreground focus-visible:outline-ring inline-flex h-11 items-center rounded px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 sm:h-8 sm:px-2.5 sm:text-xs"
              >
                {l.short ? (
                  <>
                    <span aria-hidden className="sm:hidden">
                      {l.short}
                    </span>
                    <span className="max-sm:sr-only">{l.label}</span>
                  </>
                ) : (
                  l.label
                )}
              </a>
            </span>
          ))}
        </div>
      </div>
    </nav>
  );
}

/**
 * One group of the page: a heading with a one-line intro (the pattern of the wiki's `WikiPart`), then its panels.
 * `hideHeading` keeps the heading for a screen reader only, for a group whose one panel carries the same title (the
 * clone): one visible heading, not the same words twice in a row.
 */
export function TradesGroup({ group, intro, hideHeading = false, children }: { group: keyof typeof TRADES_GROUPS; intro: React.ReactNode; hideHeading?: boolean; children: React.ReactNode }) {
  const { id, label } = TRADES_GROUPS[group];
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn(ANCHOR_MARGIN, "grid min-w-0 gap-5")}>
      <div className="border-foreground/80 grid gap-1 border-t-2 pt-4">
        <h2 id={`${id}-title`} data-group-heading={hideHeading ? "hidden" : undefined} className={cn("text-xl font-semibold tracking-tight", hideHeading && "sr-only")}>
          {label}
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm">{intro}</p>
      </div>
      {children}
    </section>
  );
}
