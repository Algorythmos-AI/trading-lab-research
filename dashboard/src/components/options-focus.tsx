// "Today's focus": the few names worth watching this session, each with one level to break and one level to hold.
// Picked after the close from the board; an optional pre-market line says where each name sits before the open.
// Server-rendered and compact, so it can sit above the desk without pushing it off a laptop screen.
import { ArrowDownToLine, ArrowUpFromLine, MoveHorizontal, Target } from "lucide-react";
import { sydney } from "@/lib/format";
import type { Options } from "@/lib/options";
import { cn } from "@/lib/utils";

type Focus = NonNullable<Options["focus"]>;
type Item = Focus["items"][number];
type Pre = NonNullable<Focus["premarket"]>["items"][number];

const BIAS = {
  breakout: {
    word: "Breakout watch",
    icon: ArrowUpFromLine,
    text: "text-good",
    edge: "border-t-good-fill",
  },
  support: {
    word: "Hold support",
    icon: ArrowDownToLine,
    text: "text-info",
    edge: "border-t-info-fill",
  },
  range: {
    word: "Range: wait",
    icon: MoveHorizontal,
    text: "text-warn",
    edge: "border-t-warn-fill",
  },
} as const;

const WHERE: Record<NonNullable<Pre["where"]>, string> = {
  above_resistance: "Above resistance pre-market",
  near_resistance: "Near resistance pre-market",
  between: "Between the levels pre-market",
  near_support: "Near support pre-market",
  below_support: "Below support pre-market",
};

const px = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(2));

function Row({ label, value, name, className }: { label: string; value: number | null | undefined; name?: string | null; className?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono font-semibold", className)}>
        {px(value)}
        {name ? <span className="text-muted-foreground ml-1 font-sans font-normal">{name}</span> : null}
      </span>
    </div>
  );
}

function FocusCard({ item, pre }: { item: Item; pre: Pre | undefined }) {
  const b = BIAS[item.bias];
  return (
    <li className={cn("bg-card grid content-start gap-2 rounded-lg border border-t-4 px-3 py-2.5", b.edge)}>
      <div className="flex items-baseline justify-between gap-2">
        <a href={`/options?s=${item.symbol}`} className="text-base font-bold tracking-tight hover:underline">
          <span className="text-muted-foreground mr-1 text-xs font-normal">#{item.rank}</span>
          {item.symbol}
        </a>
        <span className={cn("flex items-center gap-1 text-xs font-semibold", b.text)}>
          <b.icon aria-hidden className="size-3.5" />
          {b.word}
        </span>
      </div>
      <div className="grid gap-1">
        <Row label="Break and hold above" value={item.breakout_above ?? item.resistance?.price} name={item.resistance?.name} className="text-good" />
        <Row label="Hold support at" value={item.hold_above ?? item.support?.price} name={item.support?.name} className="text-info" />
        {item.target_up ? <Row label="Next up" value={item.target_up.price} name={item.target_up.name} /> : null}
        {item.target_down ? <Row label="Next down" value={item.target_down.price} name={item.target_down.name} /> : null}
        <Row label="Close · ATR" value={item.close} name={item.atr != null ? `± ${item.atr.toFixed(2)}` : null} />
      </div>
      {item.why ? <p className="text-muted-foreground text-xs leading-snug">{item.why}</p> : null}
      {pre ? (
        <p className="bg-muted/60 rounded px-2 py-1 text-xs">
          <span className="font-semibold">{pre.where ? WHERE[pre.where] : "Pre-market"}</span>
          {pre.price != null ? ` · ${px(pre.price)}` : ""}
          {pre.gap_pct != null ? ` (${pre.gap_pct >= 0 ? "+" : ""}${pre.gap_pct.toFixed(1)}%)` : ""}
          {pre.note ? <span className="text-muted-foreground block">{pre.note}</span> : null}
        </p>
      ) : null}
    </li>
  );
}

export function FocusStrip({ e }: { e: Options }) {
  const f = e.focus;
  if (!f || f.items.length === 0) return null;
  const pre = new Map((f.premarket?.items ?? []).map((p) => [p.symbol, p]));
  const items = [...f.items].sort((a, b) => a.rank - b.rank);
  return (
    <section aria-labelledby="focus-title" className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="focus-title" className="flex items-center gap-2 text-sm font-semibold">
          <Target aria-hidden className="text-muted-foreground size-4" />
          Today&apos;s focus: {items.length} names, nothing else
        </h2>
        <p className="text-muted-foreground text-xs">
          {f.premarket ? `Pre-market check ${sydney(f.premarket.as_of)} Sydney. ` : f.picked_at ? `Picked ${sydney(f.picked_at)} Sydney. ` : ""}
          Enter only on a break then retest. $50 max risk, 5 trades a day max. Research only.
        </p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((i) => (
          <FocusCard key={i.symbol} item={i} pre={pre.get(i.symbol)} />
        ))}
      </ul>
    </section>
  );
}
