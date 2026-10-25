// "Today's focus": the few names worth watching this session, each with a ceiling and a floor, and a call plan and a
// put plan in plain words (trigger, entry, stop, targets) with the level codes written out.
// Picked after the close from the board; an optional pre-market line says where each name sits before the open.
// Server-rendered and compact, so it can sit above the desk without pushing it off a laptop screen.
import type { ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, MoveHorizontal, Target } from "lucide-react";
import { sydney, weekDate } from "@/lib/format";
import { sessionView, type JournalDoc } from "@/lib/journal";
import { focusPlan, GLOSSARY, levelWords, noEntryTimes, type SidePlan } from "@/lib/focus-plan";
import {
  CONFIRM_BAR_MINUTES,
  dayCheck,
  DAY_LOSS_LIMIT,
  MAX_PREMIUM,
  MAX_TRADES_PER_DAY,
  PREMIUM_STOP,
  RISK_PER_TRADE,
  TIME_STOP_MINUTES,
} from "@/lib/trade-rules";
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

/** "212.85 (last week's low)": a price with its level codes written out. */
function Level({ price, name }: { price: number | null | undefined; name?: string | null }) {
  const words = levelWords(name);
  return (
    <>
      <span className="font-mono font-semibold">{px(price)}</span>
      {words ? <span className="text-muted-foreground"> ({words})</span> : null}
    </>
  );
}

function Step({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.25rem_1fr] gap-x-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const SIDE = {
  call: { title: "CALL if it breaks up", text: "text-good", edge: "border-l-good-fill", over: "above", back: "below", retest: "a dip holds it" },
  put: { title: "PUT if it breaks down", text: "text-bad", edge: "border-l-bad-fill", over: "below", back: "above", retest: "a bounce fails under it" },
} as const;

function SideBlock({ plan }: { plan: SidePlan }) {
  const s = SIDE[plan.side];
  const stopPct = Math.round(PREMIUM_STOP * 100);
  return (
    <div className={cn("rounded border border-l-4 px-2 py-1.5", s.edge)}>
      <p className={cn("mb-1 text-xs font-semibold", s.text)}>{s.title}</p>
      <dl className="grid gap-0.5 text-xs leading-snug">
        <Step label="Trigger">
          A {CONFIRM_BAR_MINUTES}-min candle closes {s.over} <span className="font-mono font-semibold">{px(plan.level)}</span>, then {s.retest}
        </Step>
        {plan.entry != null ? (
          <Step label="Enter">
            Limit order about <span className="font-mono font-semibold">{px(plan.entry)}</span>
          </Step>
        ) : null}
        <Step label="Stop">
          {plan.stop != null ? (
            <>
              A {CONFIRM_BAR_MINUTES}-min close {s.back} <span className="font-mono font-semibold">{px(plan.stop)}</span>, or −{stopPct}% on the option
            </>
          ) : (
            <>
              A {CONFIRM_BAR_MINUTES}-min close back {s.back} the level, or −{stopPct}% on the option
            </>
          )}
        </Step>
        {plan.target1 != null || plan.target2 ? (
          <Step label="Targets">
            {plan.target1 != null ? <span className="font-mono font-semibold">{px(plan.target1)}</span> : null}
            {plan.target1 != null && plan.target2 ? ", then " : null}
            {plan.target2 ? <Level price={plan.target2.price} name={plan.target2.name} /> : null}
          </Step>
        ) : null}
      </dl>
    </div>
  );
}

function FocusCard({ item, pre }: { item: Item; pre: Pre | undefined }) {
  const b = BIAS[item.bias];
  const plan = focusPlan(item);
  return (
    <li className={cn("bg-card grid w-[88%] shrink-0 snap-start content-start gap-2 rounded-lg border border-t-4 px-3 py-2.5 sm:w-auto", b.edge)}>
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
      {plan.call && plan.put ? (
        <p className="text-xs leading-snug">
          Ceiling <Level price={plan.call.level} name={plan.call.levelName} />, floor <Level price={plan.put.level} name={plan.put.levelName} />. No trade
          while it stays between them.
        </p>
      ) : null}
      {pre ? (
        <p className="bg-muted/60 rounded px-2 py-1 text-xs">
          <span className="font-semibold">{pre.where ? WHERE[pre.where] : "Pre-market"}</span>
          {pre.price != null ? ` · ${px(pre.price)}` : ""}
          {pre.gap_pct != null ? ` (${pre.gap_pct >= 0 ? "+" : ""}${pre.gap_pct.toFixed(1)}%)` : ""}
          {pre.note ? <span className="text-muted-foreground block">{pre.note}</span> : null}
        </p>
      ) : null}
      {plan.call ? <SideBlock plan={plan.call} /> : null}
      {plan.put ? <SideBlock plan={plan.put} /> : null}
    </li>
  );
}

/** The rules that hold for every name, said once under the cards, with the no-entry times in Sydney for this session. */
function Always({ session }: { session: string }) {
  const t = noEntryTimes(session);
  const premium = (MAX_PREMIUM / 100).toFixed(2);
  return (
    <div className="text-muted-foreground grid gap-1 text-xs">
      <p>
        <span className="text-foreground font-semibold">Skip</span> a name while it chops between its ceiling and floor
        {t ? `, and take no entries before ${t.firstEntry} or between ${t.lunchFrom} and ${t.lunchTo} Sydney` : ""}.{" "}
        <span className="text-foreground font-semibold">Size:</span> an option under ${premium}, so the −{Math.round(PREMIUM_STOP * 100)}% stop loses at most $
        {RISK_PER_TRADE}. Out after {TIME_STOP_MINUTES} minutes if it isn&apos;t working. {MAX_TRADES_PER_DAY} trades a day max. Research only.
      </p>
      <details>
        <summary className="cursor-pointer select-none underline-offset-2 hover:underline">What do the codes mean?</summary>
        <dl className="mt-1 grid gap-0.5">
          {GLOSSARY.map((g) => (
            <div key={g.code} className="flex flex-wrap gap-x-2">
              <dt className="text-foreground font-mono font-semibold">{g.code}</dt>
              <dd>{g.words}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
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
          Today&apos;s focus
        </h2>
        <p className="text-muted-foreground text-xs">
          {f.premarket ? `Pre-market check ${sydney(f.premarket.as_of)} Sydney. ` : f.picked_at ? `Picked ${sydney(f.picked_at)} Sydney. ` : ""}
          Enter only on a break then retest.
        </p>
      </div>
      {/* On a phone the cards sit side by side and swipe, so the desk stays near the top of the screen. */}
      <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 xl:grid-cols-4">
        {items.map((i) => (
          <FocusCard key={i.symbol} item={i} pre={pre.get(i.symbol)} />
        ))}
      </ul>
      <Always session={e.session} />
    </section>
  );
}

/** The edition with only its focus names, in focus rank order; the whole edition when it has no focus block. */
export function focusOnly(e: Options): Options {
  const ranks = new Map((e.focus?.items ?? []).map((i) => [i.symbol, i.rank]));
  const tickers = e.tickers.filter((t) => ranks.has(t.symbol)).sort((a, b) => ranks.get(a.symbol)! - ranks.get(b.symbol)!);
  return tickers.length ? { ...e, tickers } : e;
}

const DAY = {
  clear: { word: "Clear to trade", tone: "bg-good-soft border-good-fill/40", text: "text-good" },
  careful: { word: "Careful", tone: "bg-warn-soft border-warn-fill/50", text: "text-warn" },
  stop: { word: "Stop for today", tone: "bg-bad-soft border-bad-fill/50", text: "text-bad" },
  unknown: { word: "Journal not current", tone: "bg-warn-soft border-warn-fill/50", text: "text-warn" },
} as const;

/** One line at the top: the session, today's trade count and the day's loss against the limits. */
export function DayBar({ doc, now, session }: { doc: JournalDoc | null; now: Date; session: string }) {
  const c = dayCheck(doc ? sessionView(doc, now) : null, { asOf: doc?.as_of ?? null, now });
  const s = DAY[c.status];
  const loss = Math.max(0, -c.net);
  return (
    <div role="status" className={cn("flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border px-3.5 py-2 text-sm", s.tone)}>
      <span className={cn("font-semibold", s.text)}>{c.isToday || !c.current ? s.word : "New day"}</span>
      <span className="text-muted-foreground">Session {weekDate(session)}</span>
      <span>
        Trades{" "}
        <span className="font-mono font-semibold">
          {c.used} of {MAX_TRADES_PER_DAY}
        </span>
      </span>
      <span>
        Day loss{" "}
        <span className="font-mono font-semibold">
          ${loss.toFixed(0)} of ${DAY_LOSS_LIMIT}
        </span>
      </span>
      <span className="text-muted-foreground text-xs">{c.line}</span>
    </div>
  );
}
