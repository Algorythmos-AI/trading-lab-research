// "Today's focus": the few names worth watching this session, one card each, built to be read at a glance. Each card
// says every number a decision needs once, large and outside any fold: the price ladder (the levels to scale, the
// no-trade box, the live price with its source and time), then one decision strip per side (trigger, entry, stop and
// first target, and the live distance to the trigger), the board's live state and its cautions in the header. Only the
// explanations fold: how a trigger confirms, the other triggers' sentences, the runner plan, and the lines to draw on
// the chart in the owner's fixed colour code.
// Picked after the close from the board; an optional pre-market line says where each name sits before the open.
// Server-rendered; the live pieces are small client components (client/focus-card-live.tsx). Advisory and read only.
import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, ChevronRight, MoveHorizontal, Target } from "lucide-react";
import { newYork } from "@/lib/format";
import { TestingTag } from "@/components/client/trade-now";
import { AltChips, FocusStateChip, LiveDistance, type LiveInputs, SideFrame } from "@/components/client/focus-card-live";
import { ladderInputs, LevelLadder } from "@/components/level-ladder";
import { CHART_CODE, LINE } from "@/lib/chart-code";
import { altChips, ruleChips } from "@/lib/focus-card";
import { chartLevels, expiryNote, focusPlan, GLOSSARY, levelWords, type ChartLine, type SidePlan } from "@/lib/focus-plan";
import { CONFIRM_BAR_MINUTES, PREMIUM_STOP } from "@/lib/trade-rules";
import { isHalfDay, type Options, type OptionsTicker } from "@/lib/options";
import { runnerLine } from "@/lib/trade-now";
import { cn } from "@/lib/utils";

type Focus = NonNullable<Options["focus"]>;
type Item = Focus["items"][number];
type Pre = NonNullable<Focus["premarket"]>["items"][number];

// The size tokens (globals.css text-price, text-live, text-explain) are not known to tailwind-merge, which would take
// them for colours and drop a colour beside them: so they are never passed through `cn` with a colour.

const BIAS = {
  breakout: { word: "Breakout watch", icon: ArrowUpFromLine, text: "text-good", edge: "border-t-good-fill" },
  support: { word: "Hold support", icon: ArrowDownToLine, text: "text-info", edge: "border-t-info-fill" },
  range: { word: "Range: wait", icon: MoveHorizontal, text: "text-warn", edge: "border-t-warn-fill" },
} as const;

const WHERE: Record<NonNullable<Pre["where"]>, string> = {
  above_resistance: "Above resistance pre-market",
  near_resistance: "Near resistance pre-market",
  between: "Between the levels pre-market",
  near_support: "Near support pre-market",
  below_support: "Below support pre-market",
};

const px = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(2));
const stopPct = Math.round(PREMIUM_STOP * 100);

const SIDE = {
  call: {
    word: "CALL",
    glyph: "▲",
    title: "CALL if it breaks up",
    text: "text-good",
    over: "above",
    back: "below",
    retest: "a dip holds it",
  },
  put: {
    word: "PUT",
    glyph: "▼",
    title: "PUT if it breaks down",
    text: "text-bad",
    over: "below",
    back: "above",
    retest: "a bounce fails under it",
  },
} as const;

// ---- the decision strip -------------------------------------------------------------------------------------------
// The far side's small words go muted; its prices keep the foreground colour, so they stay at 7:1.
const SMALL = "text-explain text-muted-foreground";
const MUTE_OFF = "group-data-[emph=off]/strip:text-muted-foreground";

/** One number of the strip: the small label over the price, the price large in the mono font. */
function Cell({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="grid min-w-0 content-start" data-cell={label.toLowerCase()}>
      <dt className={SMALL}>{label}</dt>
      <dd className="text-price text-foreground font-mono tabular-nums">{value}</dd>
      {note ? <dd className={SMALL}>{note}</dd> : null}
    </div>
  );
}

/**
 * One side in a line that reads in two seconds: "▼ PUT 343.10", the live distance to it, then entry, stop and first
 * target. The prices are static, from the plan; the distance is the only live part. The side the board points at is
 * emphasised by its frame (SideFrame); colour is never the only cue (the glyph and the word say the side).
 */
function DecisionStrip({ symbol, plan, live }: { symbol: string; plan: SidePlan; live: LiveInputs }) {
  const s = SIDE[plan.side];
  return (
    <SideFrame symbol={symbol} side={plan.side} label={`${s.word === "CALL" ? "Call" : "Put"} side`}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="grid">
          <span className={`text-explain font-bold tracking-wide ${s.text} ${MUTE_OFF}`}>
            <span aria-hidden>{s.glyph}</span> {s.word} {s.over}
          </span>
          <span className={`text-price font-mono tabular-nums ${s.text}`} data-cell="trigger">
            {px(plan.level)}
          </span>
        </p>
        <LiveDistance side={plan.side} live={live} />
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1">
        {plan.entry != null ? <Cell label="In ≈" value={px(plan.entry)} /> : null}
        {plan.stop != null ? (
          <Cell label="Stop" value={px(plan.stop)} note={`or −${stopPct}%`} />
        ) : (
          <div className="grid min-w-0 content-start" data-cell="stop">
            <dt className={SMALL}>Stop</dt>
            <dd className="text-explain text-foreground">
              {CONFIRM_BAR_MINUTES}-min close back {s.back} {px(plan.level)}, or −{stopPct}%
            </dd>
          </div>
        )}
        {plan.target1 != null ? <Cell label="T1" value={px(plan.target1)} /> : null}
      </dl>
    </SideFrame>
  );
}

// ---- the "How" fold: the old numbered steps, now explanation only --------------------------------------------------
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

/** One numbered step of a side's plan: the number, the step's name, then the price first and its words after. */
function Step({ n, label, price, children }: { n: number; label: string; price?: ReactNode; children?: ReactNode }) {
  return (
    <li data-step={label.toLowerCase()} className="grid grid-cols-[1.25rem_4.5rem_1fr] items-baseline gap-x-1.5">
      <span aria-hidden className="text-muted-foreground bg-muted flex size-5 items-center justify-center rounded-full font-mono text-sm font-semibold">
        {n}
      </span>
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0">
        {price}
        {price && children ? " " : null}
        {children ? <span className="text-muted-foreground">{children}</span> : null}
      </span>
    </li>
  );
}

const Price = ({ v }: { v: number | null | undefined }) => <span className="text-foreground font-mono font-semibold">{px(v)}</span>;

/** One side's steps in order: trigger (how it confirms), enter, stop (with the option stop), targets (with T2). */
function HowSide({ plan }: { plan: SidePlan }) {
  const s = SIDE[plan.side];
  let n = 0;
  return (
    <div className="grid gap-1" data-how-side={plan.side}>
      <p className={`font-semibold ${s.text}`}>
        <span aria-hidden>{s.glyph}</span> {s.title}
      </p>
      <ol aria-label={`${plan.side === "call" ? "Call" : "Put"} plan, in order`} className="grid gap-1">
        <Step n={++n} label="Trigger" price={<Price v={plan.level} />}>
          A {CONFIRM_BAR_MINUTES}-min candle closes {s.over} it, then {s.retest}
        </Step>
        {plan.entry != null ? (
          <Step n={++n} label="Enter" price={<Price v={plan.entry} />}>
            Limit price about here
          </Step>
        ) : null}
        <Step n={++n} label="Stop" price={plan.stop != null ? <Price v={plan.stop} /> : null}>
          {plan.stop != null
            ? `A ${CONFIRM_BAR_MINUTES}-min close ${s.back} it, or −${stopPct}% on the option`
            : `A ${CONFIRM_BAR_MINUTES}-min close back ${s.back} the level, or −${stopPct}% on the option`}
        </Step>
        {plan.target1 != null || plan.target2 ? (
          <Step
            n={++n}
            label="Targets"
            price={
              <>
                {plan.target1 != null ? <Price v={plan.target1} /> : null}
                {plan.target1 != null && plan.target2 ? ", then " : null}
                {plan.target2 ? <Level price={plan.target2.price} name={plan.target2.name} /> : null}
              </>
            }
          />
        ) : null}
      </ol>
    </div>
  );
}

/** A fold under the strips, operable by keyboard (a native details). The summary is 14 px, never smaller. */
function Fold({ title, tag, children, ...rest }: { title: string; tag?: ReactNode; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <details className="group/fold text-explain" {...rest}>
      <summary className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1.5 select-none">
        <ChevronRight aria-hidden className="size-4 transition-transform group-open/fold:rotate-90 motion-reduce:transition-none" />
        {title}
        {tag}
      </summary>
      <div className="mt-1.5 grid gap-2 pl-5">{children}</div>
    </details>
  );
}

// ---- the lines to draw on the chart (folded) ----------------------------------------------------------------------
// Yellow fails 3:1 on a white card, so its ball carries a darker ring.
const PREMARKET = {
  ball: "bg-warn-fill ring-2 ring-warn ring-inset",
  swatch: "border-t-2 border-dotted border-warn",
};
const BOX = "border-neutral bg-neutral-soft rounded-sm border";

function Swatch({ className }: { className: string }) {
  return <span aria-hidden className={cn("inline-block w-6 shrink-0", className)} />;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function lineWhat(l: ChartLine): { head: string; words: string } {
  const words = levelWords(l.codes.join("/"));
  if (l.kind === "ceiling" || l.kind === "floor") return { head: CHART_CODE[l.kind].what, words: [words, ...l.targets].filter(Boolean).join(" · ") };
  if (l.kind === "target") return { head: l.targets.map(cap).join(", "), words };
  return { head: l.kind === "week" ? "Week" : "Month", words: [words, ...l.targets].filter(Boolean).join(" · ") };
}

/** The lines to draw on the chart, highest first like the chart's price axis, with the no-trade box between the triggers. */
function ChartLines({ symbol, lines }: { symbol: string; lines: ChartLine[] }) {
  if (!lines.length) return null;
  const ceiling = lines.find((l) => l.kind === "ceiling");
  const floor = lines.find((l) => l.kind === "floor");
  const id = `lines-${symbol}`;
  return (
    <div className="grid gap-1.5" data-testid="chart-lines">
      <p id={id} className="sr-only">
        {symbol}: lines to draw, highest first
      </p>
      <ul aria-labelledby={id} className="grid gap-1.5">
        {lines.map((l) => {
          const w = lineWhat(l);
          const c = CHART_CODE[l.kind];
          const strong = l.kind === "ceiling" || l.kind === "floor";
          return (
            <Fragment key={`${l.kind}-${l.price}`}>
              <li className="grid grid-cols-[1.75rem_4.75rem_1fr] items-center gap-x-2">
                <span aria-hidden className={cn("size-7 rounded-full", LINE[l.kind].ball)} />
                <span className={cn("font-mono text-lg leading-none tabular-nums", strong ? "font-bold" : "font-semibold")}>{l.price.toFixed(2)}</span>
                <span className="min-w-0 leading-tight">
                  <span className="font-semibold">{w.head}</span>
                  {w.words ? <span className="text-muted-foreground"> {w.words}</span> : null}
                  <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5">
                    <Swatch className={LINE[l.kind].swatch} />
                    {c.colour}, {c.line}
                  </span>
                </span>
              </li>
              {l === ceiling && floor ? (
                <li className="grid grid-cols-[1.75rem_1fr] items-center gap-x-2">
                  <span aria-hidden className={cn("h-5 w-7", BOX)} />
                  <span className="leading-tight">
                    <span className="font-semibold">Grey box</span>{" "}
                    <span className="font-mono">
                      {floor.price.toFixed(2)} to {ceiling.price.toFixed(2)}
                    </span>
                    <span className="text-muted-foreground">: no trade while it stays inside</span>
                  </span>
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ul>
    </div>
  );
}

// ---- the card -----------------------------------------------------------------------------------------------------
/** The pre-market price and where it sits, in one short line; the longer note folds. */
function PremarketLine({ pre }: { pre: Pre }) {
  return (
    <div className="bg-muted/60 text-explain grid gap-0.5 rounded px-2 py-1" data-premarket>
      <p>
        <span className="font-semibold">{pre.where ? WHERE[pre.where] : "Pre-market"}</span>
        {pre.price != null ? (
          <>
            {" · "}
            <span className="font-mono font-semibold tabular-nums">{px(pre.price)}</span>
          </>
        ) : null}
        {pre.gap_pct != null ? ` (${pre.gap_pct >= 0 ? "+" : ""}${pre.gap_pct.toFixed(1)}%)` : ""}
      </p>
      {pre.note ? (
        <details>
          <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer select-none">Pre-market note</summary>
          <p className="text-muted-foreground mt-0.5">{pre.note}</p>
        </details>
      ) : null}
    </div>
  );
}

function FocusCard({
  item,
  pre,
  ticker,
  session,
  halfDay,
  closeDate,
}: {
  item: Item;
  pre: Pre | undefined;
  ticker: OptionsTicker | undefined;
  session: string;
  halfDay: boolean;
  closeDate: string | null;
}) {
  const b = BIAS[item.bias];
  const plan = focusPlan(item);
  const expiry = expiryNote(item.symbol, session);
  const premarket = pre?.price ?? null;
  const i = ladderInputs(item, ticker, premarket);
  const live: LiveInputs = {
    symbol: item.symbol,
    session,
    halfDay,
    premarket: i.pre,
    close: i.close,
    closeDate,
    ceiling: plan.call?.level ?? null,
    floor: plan.put?.level ?? null,
    atr: i.atr,
    move: i.move,
  };
  const alts = altChips(item);
  const runners = (["call", "put"] as const).flatMap((k) => {
    const line = runnerLine(plan[k], halfDay);
    return line ? [{ side: k, line }] : [];
  });
  return (
    <li
      id={`focus-card-${item.symbol}`}
      tabIndex={-1}
      className={cn(
        "bg-card relative grid w-[92%] shrink-0 snap-start content-start gap-3 rounded-lg border border-t-4 px-2.5 py-2.5 focus:ring-ring focus:ring-2 focus:outline-none sm:w-auto sm:px-3",
        b.edge,
      )}
    >
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <a href={`/options?s=${item.symbol}`} className="text-xl font-bold tracking-tight hover:underline">
            <span className="text-muted-foreground mr-1.5 text-sm font-normal">#{item.rank}</span>
            {item.symbol}
          </a>
          <span className={cn("flex items-center gap-1 text-sm font-semibold", b.text)}>
            <b.icon aria-hidden className="size-4" />
            {b.word}
          </span>
        </div>
        <FocusStateChip symbol={item.symbol} />
      </div>
      {pre ? <PremarketLine pre={pre} /> : null}
      {expiry ? (
        <p className="text-warn text-explain font-medium" data-expiry>
          {expiry}
        </p>
      ) : null}
      <LevelLadder item={item} ticker={ticker} session={session} halfDay={halfDay} closeDate={closeDate} premarket={premarket} />
      {plan.call || plan.put ? (
        <div className="grid gap-2" data-strips>
          {plan.call ? <DecisionStrip symbol={item.symbol} plan={plan.call} live={live} /> : null}
          {plan.put ? <DecisionStrip symbol={item.symbol} plan={plan.put} live={live} /> : null}
        </div>
      ) : null}
      <div className="grid gap-1.5">
        <Fold title="How each side works" data-how="">
          {plan.call ? <HowSide plan={plan.call} /> : null}
          {plan.put ? <HowSide plan={plan.put} /> : null}
        </Fold>
        {alts.length ? (
          <div className="grid gap-1.5" data-alts>
            <p className="text-explain text-muted-foreground flex items-center gap-1.5">
              Other triggers <TestingTag />
            </p>
            <AltChips symbol={item.symbol} chips={alts} />
            <Fold title="What the other triggers mean">
              <ul className="grid gap-1">
                {alts.map((a) => (
                  <li key={`${a.kind}-${a.side}`} data-alt-line={`${a.kind}-${a.side}`}>
                    {a.line}
                  </li>
                ))}
              </ul>
            </Fold>
          </div>
        ) : null}
        {runners.length ? (
          <Fold title="Runner plan" tag={<TestingTag />} data-runner="">
            {runners.map((r) => (
              <p key={r.side} data-step="runner" data-runner-side={r.side}>
                <span className={`font-semibold ${SIDE[r.side].text}`}>
                  <span aria-hidden>{SIDE[r.side].glyph}</span> {SIDE[r.side].word}:
                </span>{" "}
                {r.line}
              </p>
            ))}
          </Fold>
        ) : null}
        <Fold title="Draw on chart">
          <ChartLines symbol={item.symbol} lines={chartLevels(item, ticker?.levels)} />
        </Fold>
      </div>
    </li>
  );
}

// ---- under the cards: placed by the page --------------------------------------------------------------------------
/**
 * The rules that hold for every name, as large chips with this session's New York times: "No entries before 09:35",
 * "No entries 11:30–13:00" (none on a half day), "Option under $2.00", "Out after 5 min", "Max 5 a day".
 */
export function RulesStrip({ session, halfDay }: { session: string; halfDay: boolean }) {
  const chips = ruleChips(session, halfDay);
  return (
    <section aria-label="Rules for every name, New York times" className="grid gap-1.5" data-testid="rules-strip">
      <ul className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <li key={c.key} data-rule={c.key} className="bg-card flex flex-wrap items-baseline gap-x-1.5 rounded-md border px-3 py-1.5">
            <span className="text-foreground text-base font-semibold">{c.text}</span>
            {c.note ? <span className={SMALL}>{c.note}</span> : null}
          </li>
        ))}
      </ul>
      <p className={SMALL}>
        Times are New York. Skip a name while it chops inside its grey box. Research only: nothing here places an order.
      </p>
    </section>
  );
}

/** The colour code once under the cards: the same on every name, every day. */
function ChartKey() {
  const rows: { ball: string; swatch: string | null; text: string }[] = [
    ...(["ceiling", "floor", "week", "month", "target"] as const).map((k) => ({
      ball: LINE[k].ball,
      swatch: LINE[k].swatch,
      text: `${CHART_CODE[k].what}: ${CHART_CODE[k].colour.toLowerCase()}, ${CHART_CODE[k].line}`,
    })),
    {
      ball: BOX,
      swatch: null,
      text: "Between ceiling and floor: grey box (rectangle tool), no trade inside",
    },
    {
      ball: PREMARKET.ball,
      swatch: PREMARKET.swatch,
      text: "Pre-market high / low: yellow, dotted. Not in today's data: mark them from the chart, delete after the first 30 minutes",
    },
  ];
  return (
    <div className="grid gap-1" data-testid="chart-key">
      <p className="text-foreground font-semibold">Chart colour code</p>
      <ul className="grid gap-x-5 gap-y-1 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((r) => (
          <li key={r.text} className="flex items-center gap-2">
            <span aria-hidden className={cn("size-3.5 shrink-0", r.ball.includes("rounded-sm") ? r.ball : cn("rounded-full", r.ball))} />
            {r.swatch ? <Swatch className={r.swatch} /> : null}
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
      <p>
        Don&apos;t draw the 20 / 50 / 200-day averages: turn them on as indicators so they update themselves. PMH / PML
        are last month&apos;s high / low, not pre-market.
      </p>
    </div>
  );
}

/** How to draw the cards' lines: the colour code, and what the level codes mean. */
export function DrawingGuide() {
  return (
    <section aria-label="Drawing guide" className="text-muted-foreground text-explain grid gap-2" data-drawing-guide>
      <ChartKey />
      <details>
        <summary className="hover:text-foreground w-fit cursor-pointer select-none underline-offset-2 hover:underline">What do the codes mean?</summary>
        <dl className="mt-1 grid gap-0.5">
          {GLOSSARY.map((g) => (
            <div key={g.code} className="flex flex-wrap gap-x-2">
              <dt className="text-foreground font-mono font-semibold">{g.code}</dt>
              <dd>{g.words}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

export function FocusStrip({ e }: { e: Options }) {
  const f = e.focus;
  if (!f || f.items.length === 0) return null;
  const pre = new Map((f.premarket?.items ?? []).map((p) => [p.symbol, p]));
  const tickers = new Map(e.tickers.map((t) => [t.symbol, t]));
  const items = [...f.items].sort((a, b) => a.rank - b.rank);
  const halfDay = isHalfDay(e);
  return (
    <section aria-labelledby="focus-title" className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-3">
          <h2 id="focus-title" className="flex items-center gap-2 text-base font-semibold">
            <Target aria-hidden className="text-muted-foreground size-4" />
            Today&apos;s focus
          </h2>
          {/* How past cards did, reachable at all times: the review itself shows here only outside market hours. */}
          <Link
            href="/options/record"
            data-testid="card-record-link"
            className="text-muted-foreground hover:text-foreground text-explain inline-flex items-center underline-offset-4 hover:underline"
          >
            Card record
            <ChevronRight aria-hidden className="size-3.5" />
          </Link>
        </div>
        <p className="text-muted-foreground text-explain">
          {f.premarket
            ? `Pre-market check ${newYork(f.premarket.as_of)} New York. `
            : f.picked_at
              ? `Picked ${newYork(f.picked_at)} New York. `
              : ""}
          Enter only on a break then retest.
        </p>
      </div>
      {/* On a phone the cards sit side by side and swipe. From sm one card per row, two from xl: the ladder is drawn
          530 px wide and its labels shrink below 14 px in a narrower card. */}
      {/* relative: the strip (and each card) is the containing block of the ladders' screen-reader text (sr-only is
          absolutely positioned), so the strip clips it; without it the third card's hidden labels sat 300 px past a
          phone's right edge and the page scrolled sideways. */}
      <ul className="relative -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-1 sm:overflow-visible sm:px-0 sm:pb-0 xl:grid-cols-2">
        {items.map((i) => (
          <FocusCard
            key={i.symbol}
            item={i}
            pre={pre.get(i.symbol)}
            ticker={tickers.get(i.symbol)}
            session={e.session}
            halfDay={halfDay}
            closeDate={e.built_from ?? null}
          />
        ))}
      </ul>
    </section>
  );
}

/** The edition with only its focus names, in focus rank order; the whole edition when it has no focus block. */
export function focusOnly(e: Options): Options {
  const ranks = new Map((e.focus?.items ?? []).map((i) => [i.symbol, i.rank]));
  const tickers = e.tickers
    .filter((t) => ranks.has(t.symbol))
    .sort((a, b) => ranks.get(a.symbol)! - ranks.get(b.symbol)!);
  return tickers.length ? { ...e, tickers } : e;
}
