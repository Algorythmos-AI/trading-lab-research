// The Paper options page under its heading (DEC-0057): the glance, then the options clone, the hand-placed paper
// trades and the research arms. Three sources, each in a frame of its own evidence class, never added together.
// Server-rendered; apart from the page file so a test can render it.
//
// The arithmetic is the Trades page's own (lib/journal.ts) on rows read into the journal's shape (lib/paper.ts), and
// the charts are the ones the Trades page draws. Each group sits behind a pane boundary of its own.
import { Bot, CalendarDays, ChartColumn, ChartLine, ChartNoAxesCombined, Crosshair, FlaskConical, Hand, Inbox, Layers, Lightbulb, ListOrdered, Target, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { DayLimitBars } from "@/components/charts/day-limit-bars";
import { MonthBars } from "@/components/charts/month-bars";
import { PnlCurve } from "@/components/charts/pnl-curve";
import { RollingChart } from "@/components/charts/rolling-chart";
import { TradeBars } from "@/components/charts/trade-bars";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { PaperTable } from "@/components/client/paper-table";
import { Empty } from "@/components/empty";
import { Breakdown, CalendarGrid } from "@/components/journal";
import { ClonePanel } from "@/components/options-clone";
import { ANCHOR_MARGIN, Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import { TradesJumpBar, type JumpLink } from "@/components/trades-jump-bar";
import { Dollars } from "@/components/paper/dollars";
import { EnvFrame } from "@/components/ui/env-chip";
import { Notice } from "@/components/ui/notice";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sparkline } from "@/components/v3/sparkline";
import { newYork, usd } from "@/lib/format";
import {
  applyFilter,
  contractLabel,
  daily,
  DTE_ORDER,
  dteKey,
  filterHref,
  groupBy,
  HOLD_ORDER,
  holdKey,
  HOUR_ORDER,
  hourKey,
  lessons,
  MONTH,
  parseFilter,
  shortDay,
  SIZE_ORDER,
  sizeKey,
  summarize,
  WEEKDAY_ORDER,
  weekdayKey,
  type Filter,
  type Summary,
  type Trade,
} from "@/lib/journal";
import {
  armBooks,
  cloneBook,
  crossCheck,
  execution,
  EXPIRY_ORDER,
  expiryKey,
  glance,
  hypKey,
  manualBook,
  MIN_SAMPLE,
  paperRows,
  paperStale,
  PREMIUM_ORDER,
  premiumKey,
  premiumStats,
  R_UNIT,
  reasonKey,
  reasonLabel,
  rolling,
  ROLLING,
  ropHistogram,
  windowKey,
  windowMarks,
  windowOrder,
  withTrades,
  type Glance,
  type PaperBook,
} from "@/lib/paper";
import type { PaperOptions } from "@/lib/paper-options.types";
import { positionRows, positionsAge, positionsTotal } from "@/lib/positions";
import type { OptionsCloneResult, OptionsLiveResult, PaperOptionsResult } from "@/lib/snapshot";
import { cn } from "@/lib/utils";

type Query = Record<string, string | string[] | undefined>;
type PaperEnv = "paper" | "shadow";

/**
 * The frames this page draws, by their labels (test/env-allowlist.ts lists exactly these, with the clone panel's own
 * "Options clone"). A frame is named once on a page, so the glance cards and the sections carry different names.
 */
export const PAPER_FRAMES = {
  cloneGlance: "Options clone at a glance",
  clone: "Options clone history",
  manualGlance: "Manual option trades at a glance",
  manual: "Manual option trades",
  armsGlance: "Research arms at a glance",
  arms: "Research arms",
} as const;

const GROUPS = {
  clone: { id: "clone-bot", label: "Clone bot", short: "Clone" },
  manual: { id: "my-paper-trades", label: "My paper trades", short: "Mine" },
  arms: { id: "research-arms", label: "Research arms", short: "Arms" },
} as const;

const toneOf = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "neutral" : v > 0 ? "good" : "bad");
const textTone = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "" : v > 0 ? "text-good" : "text-bad");
const share = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
const signedPct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(digits)}%`);
const signedR = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`);
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function PaperBody({ result, clone, live, q, now }: { result: PaperOptionsResult; clone: OptionsCloneResult; live: OptionsLiveResult; q: Query; now: Date }) {
  const filter = parseFilter(q);
  const doc = result.status === "ok" ? result.doc : null;
  const links: JumpLink[] = (["clone", "manual", "arms"] as const).map((k) => ({ href: `#${GROUPS[k].id}`, label: GROUPS[k].label, short: GROUPS[k].short, level: 1 }));
  return (
    <>
      <TradesJumpBar links={links} />
      {result.status === "error" ? (
        <Empty title="Storage could not be read">The dashboard could not read the paper trade history. Reload in a minute.</Empty>
      ) : result.status === "missing" ? (
        <Empty icon={Inbox} title="No paper trade history has been sent yet">
          It fills in once the trading host has sent it, and refreshes every few minutes through the session. Today&apos;s clone session and the open positions below come from their own
          documents and show as soon as they exist.
        </Empty>
      ) : null}
      {doc ? (
        <PaneBoundary name="Paper options at a glance">
          <Top doc={doc} filter={filter} now={now} />
        </PaneBoundary>
      ) : null}
      <Group group="clone" intro="The paper bot that trades one call or put at a time by your rules, with its own paper money. Real orders to a paper account; never your own money.">
        <PaneBoundary name="Options clone (paper)">
          <ClonePanel result={clone} />
        </PaneBoundary>
        {doc ? (
          <PaneBoundary name="Clone history">
            <CloneHistory doc={doc} clone={clone} filter={filter} now={now} />
          </PaneBoundary>
        ) : null}
      </Group>
      <Group group="manual" intro="The option trades you place by hand in the Alpaca paper account: what is open now, and every round trip closed so far.">
        <PaneBoundary name="My paper trades">
          <ManualSection doc={doc} live={live} filter={filter} now={now} />
        </PaneBoundary>
      </Group>
      <Group group="arms" intro="Variations of the clone's rules, run beside it as simulated trades. No order is ever sent for them; each is a hypothesis of its own.">
        <PaneBoundary name="Research arms">
          <ArmsSection doc={doc} filter={filter} now={now} />
        </PaneBoundary>
      </Group>
      {doc ? <Source doc={doc} /> : null}
    </>
  );
}

function Group({ group, intro, children }: { group: keyof typeof GROUPS; intro: React.ReactNode; children: React.ReactNode }) {
  const { id, label } = GROUPS[group];
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn(ANCHOR_MARGIN, "grid min-w-0 gap-5")}>
      <div className="border-foreground/80 grid gap-1 border-t-2 pt-4">
        <h2 id={`${id}-title`} className="text-xl font-semibold tracking-tight">
          {label}
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm">{intro}</p>
      </div>
      {children}
    </section>
  );
}

// ── The glance and the filters ───────────────────────────────────────────────────────────────────────────────────

function Chip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? "true" : undefined}
      scroll={false}
      className={cn(
        "inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors max-sm:h-11 max-sm:px-3.5 max-sm:text-sm",
        on ? "bg-foreground text-background border-foreground font-medium" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

const PERIODS: { key: Filter["period"]; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "ytd", label: "This year" },
  { key: "90d", label: "90 days" },
  { key: "30d", label: "30 days" },
];
const KINDS = [
  { key: "call", label: "Calls" },
  { key: "put", label: "Puts" },
] as const;

function Filters({ filter, symbols }: { filter: Filter; symbols: string[] }) {
  const href = (f: Filter) => filterHref(f, "/paper");
  return (
    <div className="grid gap-2" data-paper-filters="">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <Chip key={p.key} href={href({ ...filter, period: p.key })} on={filter.period === p.key}>
            {p.label}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="What was traded">
        <Chip href={href({ ...filter, kind: null })} on={filter.kind === null}>
          Calls and puts
        </Chip>
        {KINDS.map((k) => (
          <Chip key={k.key} href={href({ ...filter, kind: k.key })} on={filter.kind === k.key}>
            {k.label}
          </Chip>
        ))}
        <span className="bg-border mx-1 w-px self-stretch" aria-hidden />
        <Chip href={href({ ...filter, symbol: null })} on={filter.symbol === null}>
          All tickers
        </Chip>
        {symbols.map((s) => (
          <Chip key={s} href={href({ ...filter, symbol: s })} on={filter.symbol === s}>
            {s}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function GlanceCard({ label, title, href, icon: Icon, g, empty }: { label: string; title: string; href: string; icon: typeof Bot; g: Glance | null; empty: string }) {
  return (
    <EnvFrame env="paper" label={label} className="grid content-start gap-2">
      <a href={href} className="hover:text-foreground focus-visible:outline-ring flex items-center gap-1.5 text-sm font-medium focus-visible:outline-2">
        <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        {title}
      </a>
      {g && g.trades > 0 ? (
        <>
          <p className={cn("font-mono text-2xl leading-none font-semibold tracking-tight sm:text-3xl", textTone(g.net))} data-glance-net="">
            <Dollars env="paper" value={g.net} signed />
          </p>
          <p className="text-muted-foreground text-xs">
            {count(g.trades, "closed trade")} · {share(g.winRate)} won
            {g.last ? ` · last ${shortDay(g.last)}` : ""}
          </p>
          <p className="text-xs">
            <span className="text-muted-foreground">Today </span>
            {g.today === null ? <span className="text-muted-foreground">no closed trades</span> : <Dollars env="paper" value={g.today} signed className={cn("font-mono font-medium", textTone(g.today))} />}
          </p>
          <Sparkline values={g.curve} label={`${title}: running total, day by day`} className={cn("h-10 w-full", textTone(g.net))} height={40} />
        </>
      ) : (
        <p className="text-muted-foreground text-xs">{empty}</p>
      )}
    </EnvFrame>
  );
}

/** The three sources at a glance, then the period, kind and ticker they and the rest of the page follow. */
function Top({ doc, filter, now }: { doc: PaperOptions; filter: Filter; now: Date }) {
  const clone = cloneBook(doc);
  const manual = manualBook(doc);
  const arms = armBooks(doc);
  const all = [...clone.trades, ...(manual?.trades ?? []), ...(arms ?? []).flatMap((a) => a.trades)];
  // The tickers worth a chip: the ten most traded across the three sources, plus the one in the address.
  const symbols = groupBy(all, (t) => t.symbol)
    .sort((a, b) => b.trades - a.trades)
    .slice(0, 10)
    .map((g) => g.key);
  if (filter.symbol && !symbols.includes(filter.symbol)) symbols.push(filter.symbol);
  const cut = (trades: readonly Trade[]) => applyFilter(trades, filter, now);
  return (
    <div className="grid gap-4">
      {paperStale(doc, now) ? (
        <Notice tone="warn" size="sm" role="status">
          This history was last sent on {newYork(doc.as_of)} New York time. Trades closed since then are not in it yet.
        </Notice>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3" data-paper-glance="">
        <GlanceCard label={PAPER_FRAMES.cloneGlance} title="Clone bot" href={`#${GROUPS.clone.id}`} icon={Bot} g={glance(cut(clone.trades), now)} empty="No closed clone trades in this view." />
        <GlanceCard
          label={PAPER_FRAMES.manualGlance}
          title="My paper trades"
          href={`#${GROUPS.manual.id}`}
          icon={Hand}
          g={manual ? glance(cut(manual.trades), now) : null}
          empty={manual ? "No closed hand-placed trades in this view." : "The hand-placed history is not being sent yet."}
        />
        <EnvFrame env="shadow" label={PAPER_FRAMES.armsGlance} className="grid content-start gap-2">
          <a href={`#${GROUPS.arms.id}`} className="hover:text-foreground focus-visible:outline-ring flex items-center gap-1.5 text-sm font-medium focus-visible:outline-2">
            <FlaskConical aria-hidden className="text-muted-foreground size-4 shrink-0" />
            Research arms
          </a>
          {arms && arms.some((a) => cut(a.trades).length > 0) ? (
            <ul className="grid gap-1 text-xs">
              {arms.map((a) => {
                const g = glance(cut(a.trades), now);
                return (
                  <li key={a.hyp} className="flex items-baseline justify-between gap-3">
                    <span className="text-muted-foreground">
                      {a.hyp} · {g.trades}
                    </span>
                    {g.trades > 0 ? <Dollars env="shadow" value={g.net} signed className={cn("font-mono font-medium", textTone(g.net))} /> : <span className="text-muted-foreground">—</span>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs">{arms ? "No simulated trades in this view." : "The arms' simulated trades are not being sent yet."}</p>
          )}
          <p className="text-muted-foreground text-[0.6875rem] leading-snug max-sm:text-xs">Simulated, one contract each; each arm is its own trial and they are not added up.</p>
        </EnvFrame>
      </div>
      <Filters filter={filter} symbols={symbols.sort()} />
      <p className="text-muted-foreground max-w-prose text-xs">Three separate books. They are never added together: the clone and your own trades use different paper money, and the arms are simulated.</p>
    </div>
  );
}

// ── Panels shared by the books ───────────────────────────────────────────────────────────────────────────────────

function Tiles({ env, s, extra }: { env: PaperEnv; s: Summary; extra?: React.ReactNode }) {
  return (
    <StatTiles className="lg:grid-cols-4">
      <StatTile label="Net result" icon={Wallet} tone={toneOf(s.net)} value={<Dollars env={env} value={s.net} signed />} hint={`${count(s.trades, "closed trade")}${s.first && s.last ? ` · ${shortDay(s.first)} to ${shortDay(s.last)}` : ""}`} />
      <StatTile label="Won" icon={Target} tone={s.winRate === null ? "neutral" : s.winRate >= 0.5 ? "good" : "warn"} value={share(s.winRate)} hint={`${s.wins.toLocaleString("en-US")} won · ${s.losses.toLocaleString("en-US")} lost`} />
      <StatTile
        label="Profit factor"
        icon={ChartColumn}
        tone={s.profitFactor === null ? "neutral" : s.profitFactor >= 1 ? "good" : "bad"}
        value={s.profitFactor === null ? "—" : s.profitFactor.toFixed(2)}
        hint="Dollars won for each dollar lost. Above 1 makes money."
      />
      <StatTile label="Per trade" icon={Layers} tone={toneOf(s.expectancy)} value={<Dollars env={env} value={s.expectancy} signed />} hint="The average result of one trade" />
      <StatTile label="Average win" icon={TrendingUp} tone="good" value={<Dollars env={env} value={s.avgWin} />} hint={s.best ? `Best ${usd(s.best.pnl)} · ${contractLabel(s.best)}` : undefined} />
      <StatTile
        label="Average loss"
        icon={TrendingDown}
        tone="bad"
        value={<Dollars env={env} value={s.avgLoss} />}
        hint={s.payoff === null ? undefined : `A win is ${s.payoff.toFixed(2)}× a loss${s.worst ? ` · worst ${usd(s.worst.pnl)}` : ""}`}
      />
      <StatTile label="Deepest fall" icon={ChartLine} tone={s.maxDrawdown < 0 ? "bad" : "neutral"} value={<Dollars env={env} value={s.maxDrawdown} />} hint={`From a high, by day · ${s.lossStreak} losses in a row at most`} />
      {extra ?? (
        <StatTile
          label="Green days"
          icon={CalendarDays}
          tone={s.days && s.greenDays / s.days >= 0.5 ? "good" : "warn"}
          value={`${s.greenDays} of ${s.days}`}
          hint={s.worstDay ? `Worst day ${shortDay(s.worstDay.day)}: ${usd(s.worstDay.pnl)}` : undefined}
        />
      )}
    </StatTiles>
  );
}

/** The result of each band of results on the premium: how many trades fell in it, as a bar, and the dollars they made. */
function Histogram({ book }: { book: PaperBook }) {
  const bands = ropHistogram(book);
  const most = Math.max(1, ...bands.map((b) => b.trades));
  return (
    <ol className="grid gap-1.5" aria-label="Trades by result on the premium paid">
      {bands.map((b) => (
        <li key={b.key} className="grid grid-cols-[7.5rem_minmax(0,1fr)_5.5rem] items-center gap-x-3 text-[0.8125rem]">
          <span className="leading-snug">{b.label}</span>
          <span className="bg-track/60 relative h-4 rounded-sm" aria-hidden>
            {b.trades > 0 ? <span className={cn("absolute inset-y-0.5 left-0 rounded-[2px]", b.loss ? "bg-bad-fill" : "bg-good-fill")} style={{ width: `${(b.trades / most) * 100}%` }} /> : null}
          </span>
          <span className="text-right font-mono text-xs">
            {b.trades} <span className={cn("ml-1", textTone(b.pnl))}>{b.trades ? usd(b.pnl) : ""}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function tradeBars(book: PaperBook) {
  return book.trades.flatMap((t, i) => {
    const rop = book.meta.get(t.id)?.rop;
    return typeof rop === "number" ? [{ i: i + 1, r: rop / R_UNIT, what: contractLabel(t), when: newYork(t.closed_at) }] : [];
  });
}

// ── The options clone ────────────────────────────────────────────────────────────────────────────────────────────

function CloneHistory({ doc, clone, filter, now }: { doc: PaperOptions; clone: OptionsCloneResult; filter: Filter; now: Date }) {
  const whole = cloneBook(doc);
  const book = withTrades(whole, applyFilter(whole.trades, filter, now));
  const env = "paper" as const;
  const fee = typeof doc.clone?.fee_per_contract === "number" ? doc.clone.fee_per_contract : null;
  const feeWords = fee === null ? "After the clone's modelled fees." : `After the clone's modelled fee of ${usd(fee)} a contract each way; the paper account itself charges none.`;
  const check = crossCheck(whole.trades, clone.status === "ok" ? clone.doc.setups.find((s) => s.hyp === "all") : null);
  const notes = (
    <>
      {check.status === "differ" ? (
        <Notice tone="warn" size="sm" role="status">
          This page adds the clone&apos;s {check.trades} trades up to {usd(check.page)}; the clone&apos;s own document says {usd(check.clone)}. One of the two is out of step: treat the totals here with
          care until they agree.
        </Notice>
      ) : null}
      {whole.truncated > 0 ? <p className="text-warn text-xs font-medium">{count(whole.truncated, "older trade")} are left out: the host sends the newest only.</p> : null}
      {whole.skipped > 0 ? (
        <p data-paper-skipped={whole.skipped} className="text-warn text-xs font-medium">
          {count(whole.skipped, "row")} could not be read and {whole.skipped === 1 ? "is" : "are"} left out.
        </p>
      ) : null}
      {whole.uncounted.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {count(whole.uncounted.length, "trade")} the clone could not settle {whole.uncounted.length === 1 ? "is" : "are"} in no figure here: {whole.uncounted.map((u) => u.id).join(", ")}.
        </p>
      ) : null}
    </>
  );
  if (book.trades.length === 0) {
    return (
      <EnvFrame env="paper" label={PAPER_FRAMES.clone} className="grid gap-4">
        {notes}
        <Empty title={whole.trades.length === 0 ? "The clone has closed no trades yet" : "No clone trades in this view"}>{whole.trades.length === 0 ? "Its first closed trade shows here within a few minutes." : "Pick another period, ticker or kind above."}</Empty>
      </EnvFrame>
    );
  }
  const s = summarize(book.trades);
  const days = daily(book.trades);
  const order = windowOrder(doc);
  const prem = premiumStats(book);
  const ex = execution(book);
  const roll = rolling(book.trades);
  const limit = clone.status === "ok" && clone.doc.day_pnl.limit_usd > 0 ? clone.doc.day_pnl.limit_usd : null;
  const cap = clone.status === "ok" ? clone.doc.entries.max : 0;
  const months = groupBy(book.trades, MONTH)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((g) => ({ month: g.key, pnl: g.pnl, trades: g.trades, winRate: g.winRate }));
  const bySymbol = groupBy(book.trades, (t) => t.symbol).sort((a, b) => b.pnl - a.pnl);
  const reasons = groupBy(book.trades, reasonKey(book))
    .map((g) => ({ ...g, label: reasonLabel(g.key === "none" ? null : g.key) }))
    .sort((a, b) => b.trades - a.trades);
  return (
    <EnvFrame env="paper" label={PAPER_FRAMES.clone} className="grid gap-5">
      {notes}
      <Tiles
        env={env}
        s={s}
        extra={
          <StatTile
            label="On the premium"
            icon={Crosshair}
            tone={toneOf(prem.mean)}
            value={signedPct(prem.mean)}
            hint={prem.mean === null ? `Shown from ${MIN_SAMPLE} trades` : `${signedR(prem.meanR)} a trade (one R is the −${Math.round(R_UNIT * 100)}% stop) · middle trade ${signedPct(prem.median)}`}
          />
        }
      />
      <p className="text-muted-foreground max-w-prose text-xs">
        {feeWords} One contract a trade. {s.greenDays} of {s.days} trading days were green.
      </p>
      <Panel
        id="clone-curve"
        title="Running total"
        icon={ChartLine}
        means="Every closed clone trade added up, day by day. The shaded band is how far the total stood below its best so far; a dashed line marks the day a rule changed."
      >
        <PnlCurve points={days.map((d) => ({ day: d.day, pnl: d.pnl, cum: d.cum, dd: d.dd, trades: d.trades }))} marks={windowMarks(days, order)} />
      </Panel>
      <div className="grid gap-5 lg:grid-cols-2">
        {limit !== null ? (
          <Panel id="clone-days" title="Day by day, against the loss limit" icon={ChartColumn} means="Each of the last 30 trading days against today's day loss limit, the line. Amber is a losing day inside it; red is a day at or past it. The limit has changed over time, so an old red day may not have latched.">
            <DayLimitBars days={days.slice(-30).map((d) => ({ day: d.day, pnl: d.pnl, trades: d.trades }))} limit={limit} cap={cap} />
          </Panel>
        ) : null}
        <Panel id="clone-months" title="Month by month" icon={ChartColumn} means="What each month made or lost. Months with no trades are left out." className={limit === null ? "lg:col-span-2" : undefined}>
          <MonthBars months={months} />
        </Panel>
      </div>
      <Panel id="clone-calendar" title="Trading calendar" icon={CalendarDays} means="The latest months with trades, Monday to Friday. Green made money that day, red lost it; the stronger the colour, the bigger the day.">
        <CalendarGrid days={days} />
      </Panel>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel id="clone-each" title="Trade by trade" icon={ChartNoAxesCombined} means={`Each closed trade in the order they ended, in R: one R is the premium stop, ${Math.round(R_UNIT * 100)}% of what was paid. A bar at −1R is a clean stop; one far below it slipped.`}>
          <TradeBars trades={tradeBars(book)} whenLabel="Closed (New York)" label="Result of each closed clone trade in R, oldest first" />
        </Panel>
        <Panel id="clone-spread" title="How the results are spread" icon={Layers} means="Trades by their result on the premium paid. The count is the bar; the dollars beside it are what that band made or lost in all.">
          <Histogram book={book} />
        </Panel>
      </div>
      <Panel id="clone-rolling" title="Is it getting better or worse?" icon={TrendingUp} means={`The last ${ROLLING} trades at each point: the average result per trade and the share that won. It moves one trade at a time, so a change of rules shows as a bend.`}>
        {roll.length >= 2 ? <RollingChart points={roll} span={ROLLING} /> : <Empty title={`Drawn from ${ROLLING + 1} trades`}>This view has {book.trades.length}.</Empty>}
      </Panel>
      <Panel id="clone-breakdown" title="Where it was made and lost" icon={Layers} means="The same trades cut nine ways. Each bar is the dollars made or lost; the small numbers are how many trades and the share that won.">
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
          <Breakdown title="By ticker" rows={bySymbol} />
          <Breakdown title="Calls and puts" rows={groupBy(book.trades, (t) => t.kind, KINDS)} />
          <Breakdown title="How it ended" rows={reasons} />
          <Breakdown title="By hypothesis" rows={groupBy(book.trades, hypKey(book)).sort((a, b) => a.key.localeCompare(b.key))} note="The registered idea each trade counts toward" />
          <Breakdown title="By rule window" rows={groupBy(book.trades, windowKey(book), order)} note="Each change of the clone's rules starts a new window" />
          <Breakdown title="Time of entry (New York)" rows={groupBy(book.trades, hourKey, HOUR_ORDER)} />
          <Breakdown title="Day of the week" rows={groupBy(book.trades, weekdayKey, WEEKDAY_ORDER)} />
          <Breakdown title="How long it was held" rows={groupBy(book.trades, holdKey, HOLD_ORDER)} />
          <Breakdown title="Expiry" rows={groupBy(book.trades, expiryKey, EXPIRY_ORDER)} />
          <Breakdown title="Premium paid" rows={groupBy(book.trades, premiumKey, PREMIUM_ORDER)} />
        </div>
      </Panel>
      <Panel id="clone-fills" title="Fills and exits" icon={Crosshair} means="How the entries filled against the quote, and how much of each trade's best moment the exit kept. Each figure needs eight trades with the numbers behind it.">
        <StatTiles className="lg:grid-cols-4">
          <StatTile
            label="Fill against the ask"
            tone={ex.slipMedianPct === null ? "neutral" : ex.slipMedianPct <= 0.5 ? "good" : "warn"}
            value={ex.slipMedianPct === null ? "—" : `${ex.slipMedianPct > 0 ? "+" : ex.slipMedianPct < 0 ? "−" : ""}${Math.abs(ex.slipMedianPct).toFixed(2)}%`}
            hint={`The middle entry, against the ask when it was sent · ${count(ex.n, "entry", "entries")}${ex.quoteAgeMedianS === null ? "" : ` · quote ${ex.quoteAgeMedianS.toFixed(1)} s old`}`}
          />
          <StatTile label="At the ask or better" tone={ex.atOrBetter === null ? "neutral" : ex.atOrBetter >= 0.5 ? "good" : "warn"} value={share(ex.atOrBetter)} hint="Entries that paid no more than the quoted ask" />
          <StatTile label="Best and worst moment" tone="info" value={`${signedPct(ex.bestMean, 0)} / ${signedPct(ex.worstMean, 0)}`} hint={`The average highest and lowest bid while held, on the premium · ${count(ex.held, "trade")}`} />
          <StatTile
            label="Kept of the best gain"
            tone={ex.keptMedian === null ? "neutral" : ex.keptMedian >= 0.5 ? "good" : "warn"}
            value={share(ex.keptMedian)}
            hint={`The middle trade that was ahead at some point${ex.gaveBack > 0 ? ` · ${count(ex.gaveBack, "trade")} up a full R closed at a loss` : ""}`}
          />
        </StatTiles>
      </Panel>
      <Panel id="clone-all-trades" title="Every clone trade" icon={ListOrdered} means="Each closed trade, newest first. Click a heading to sort; times are New York. The result is after the modelled fees; “on premium” is the result over what was paid, with the same in R beside it.">
        <PaperTable rows={paperRows(book)} env={env} label="Every clone trade" detail />
      </Panel>
    </EnvFrame>
  );
}

// ── The hand-placed paper account ────────────────────────────────────────────────────────────────────────────────

function OpenPositions({ live, now }: { live: OptionsLiveResult; now: Date }) {
  if (live.status !== "ok") {
    return <p className="text-muted-foreground text-xs">{live.status === "missing" ? "Open positions have not been sent yet." : "Open positions could not be read; the next update will try again."}</p>;
  }
  // As on the Options desk: positions the host stopped sending are greyed with a warning, then not shown at all.
  const close = Date.parse(live.doc.market?.next_close ?? "");
  const open = live.doc.market?.is_open === true && (!Number.isFinite(close) || now.getTime() < close);
  const age = positionsAge(live.doc.as_of, now.getTime(), open);
  if (age.state === "gone") return <p className="text-muted-foreground text-xs">Open positions were last sent on {newYork(live.doc.as_of)} New York time, too long ago to show. Check the paper account itself.</p>;
  const rows = positionRows(live.doc, new Set(), now.getTime());
  const total = positionsTotal(rows);
  if (rows.length === 0) return <p className="text-muted-foreground text-xs">No open option positions in the paper account, as of {newYork(live.doc.as_of, false)} New York time.</p>;
  return (
    <div className={cn("grid gap-2", age.state === "old" && "opacity-70")} data-positions={age.state}>
      {age.state === "old" ? (
        <Notice role="status">
          These are {Math.round(age.minutes ?? 0)} minutes old: the host has stopped sending them. Check the paper account before relying on them.
        </Notice>
      ) : null}
      <Table label="Open paper option positions">
        <TableHeader>
          <TableRow>
            <TableHead>Contract</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Paid</TableHead>
            <TableHead className="text-right">Mark</TableHead>
            <TableHead className="text-right">Open result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.contract}>
              <TableCell>
                {contractLabel(r)}
                {r.expired ? <span className="text-muted-foreground ml-1.5 text-xs">expired</span> : r.days !== null ? <span className="text-muted-foreground ml-1.5 text-xs">{r.days === 0 ? "expires today" : `${r.days} d`}</span> : null}
              </TableCell>
              <TableCell className="text-right font-mono">{r.qty}</TableCell>
              <TableCell className="text-right font-mono">{r.avgPrice === null ? "—" : r.avgPrice.toFixed(2)}</TableCell>
              <TableCell className="text-right font-mono">{r.price === null ? "—" : r.price.toFixed(2)}</TableCell>
              <TableCell className={cn("text-right font-mono font-semibold", textTone(r.unrealized))}>
                <Dollars env="paper" value={r.unrealized} signed />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-muted-foreground text-xs">
        {total !== null ? (
          <>
            Open result in all <Dollars env="paper" value={total} signed className={cn("font-mono font-medium", textTone(total))} /> ·{" "}
          </>
        ) : null}
        as of {newYork(live.doc.as_of, false)} New York time. Not closed, so in no total below.
      </p>
    </div>
  );
}

/** Why fills in the account are missing from this section: the clone bot made them, and they are in its own section. */
export function cloneFillsLeftOut(n: number): string {
  return `${count(n, "fill")} in this account ${n === 1 ? "was" : "were"} the clone bot's own, from when it traded here: ${n === 1 ? "it is" : "they are"} left out, and counted in its section above.`;
}

function ManualSection({ doc, live, filter, now }: { doc: PaperOptions | null; live: OptionsLiveResult; filter: Filter; now: Date }) {
  const env = "paper" as const;
  const whole = doc ? manualBook(doc) : null;
  const book = whole ? withTrades(whole, applyFilter(whole.trades, filter, now)) : null;
  const gaps = doc?.manual?.gaps?.length ?? 0;
  const excluded = doc?.manual?.excluded_clone_fills ?? 0;
  const s = book && book.trades.length > 0 ? summarize(book.trades) : null;
  const days = book ? daily(book.trades) : [];
  const found = book ? lessons(book.trades) : [];
  return (
    <EnvFrame env="paper" label={PAPER_FRAMES.manual} className="grid gap-5">
      <Panel id="manual-open" title="Open now" icon={Hand} means="What the paper account holds right now, at the broker's mark. It refreshes every five minutes through the session.">
        <OpenPositions live={live} now={now} />
      </Panel>
      {!whole || !book ? (
        <Empty icon={Inbox} title="Your closed paper trades are not being sent yet">
          The trading host reads the paper account&apos;s filled orders and matches them into round trips. Until it does, only what is open shows here.
        </Empty>
      ) : !s ? (
        <Empty title={whole.trades.length === 0 ? "No closed hand-placed trades yet" : "No hand-placed trades in this view"}>
          {whole.trades.length === 0 ? "A round trip shows here within a few minutes of its close." : "Pick another period, ticker or kind above."}
          {whole.trades.length === 0 && excluded > 0 ? ` ${cloneFillsLeftOut(excluded)}` : ""}
        </Empty>
      ) : (
        <>
          {whole.skipped > 0 ? (
            <p data-paper-skipped={whole.skipped} className="text-warn text-xs font-medium">
              {count(whole.skipped, "row")} could not be read and {whole.skipped === 1 ? "is" : "are"} left out.
            </p>
          ) : null}
          <Tiles env={env} s={s} />
          <p className="text-muted-foreground max-w-prose text-xs">
            Before fees: the paper account charges none. Filled orders are matched first in, first out, so one round trip can be several rows; a contract left to expire closes at zero.
            {gaps > 0 ? ` ${count(gaps, "position")} left by exercise or assignment, not a sale: no result is booked for ${gaps === 1 ? "it" : "them"}.` : ""}
            {excluded > 0 ? ` ${cloneFillsLeftOut(excluded)}` : ""}
          </p>
          <Panel id="manual-curve" title="Running total" icon={ChartLine} means="Every closed hand-placed trade added up, day by day. The shaded band is how far the total stood below its best so far.">
            <PnlCurve points={days.map((d) => ({ day: d.day, pnl: d.pnl, cum: d.cum, dd: d.dd, trades: d.trades }))} />
          </Panel>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel id="manual-each" title="Trade by trade" icon={ChartNoAxesCombined} means={`Each closed trade in the order they ended, in R: one R is ${Math.round(R_UNIT * 100)}% of the premium paid, your own stop. A bar far below −1R ran past it.`}>
              <TradeBars trades={tradeBars(book)} whenLabel="Closed (New York)" label="Result of each closed hand-placed trade in R, oldest first" />
            </Panel>
            <Panel id="manual-spread" title="How the results are spread" icon={Layers} means="Trades by their result on the premium paid. The count is the bar; the dollars beside it are what that band made or lost in all.">
              <Histogram book={book} />
            </Panel>
          </div>
          <Panel id="manual-calendar" title="Trading calendar" icon={CalendarDays} means="The latest months with trades, Monday to Friday. Green made money that day, red lost it; the stronger the colour, the bigger the day.">
            <CalendarGrid days={days} />
          </Panel>
          {found.length > 0 ? (
            <Panel id="manual-lessons" title="What the record says" icon={Lightbulb} means="Patterns measured from these trades, each comparing like with like. They describe what happened; they predict nothing.">
              <ul className="grid gap-3 md:grid-cols-2">
                {found.map((l) => (
                  <li key={l.id} className={cn("bg-card relative grid content-start gap-1.5 overflow-hidden rounded-lg border py-3 pr-3.5 pl-4", "before:absolute before:inset-y-0 before:left-0 before:w-1", LESSON_EDGE[l.tone])}>
                    <p className="text-sm leading-snug font-semibold">{l.title}</p>
                    <p className="text-muted-foreground text-[0.8125rem] leading-snug">{l.finding}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          <Panel id="manual-breakdown" title="Where it was made and lost" icon={Layers} means="The same trades cut six ways. Each bar is the dollars made or lost; the small numbers are how many trades and the share that won.">
            <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
              <Breakdown title="By ticker" rows={groupBy(book.trades, (t) => t.symbol).sort((a, b) => b.pnl - a.pnl)} />
              <Breakdown title="Calls and puts" rows={groupBy(book.trades, (t) => t.kind, KINDS)} />
              <Breakdown title="Time of entry (New York)" rows={groupBy(book.trades, hourKey, HOUR_ORDER)} />
              <Breakdown title="How long it was held" rows={groupBy(book.trades, holdKey, HOLD_ORDER)} />
              <Breakdown title="Time to expiry when opened" rows={groupBy(book.trades, dteKey, DTE_ORDER)} />
              <Breakdown title="Position size" rows={groupBy(book.trades, sizeKey, SIZE_ORDER)} note="Contracts per matched piece" />
            </div>
          </Panel>
          <Panel id="manual-trades" title="Every hand-placed trade" icon={ListOrdered} means="Each closed round trip, newest first. Click a heading to sort; times are New York. “On premium” is the result over what was paid, with the same in R beside it.">
            <PaperTable rows={paperRows(book)} env={env} label="Every hand-placed paper trade" />
          </Panel>
        </>
      )}
    </EnvFrame>
  );
}

const LESSON_EDGE = { good: "before:bg-good-fill", bad: "before:bg-bad-fill", warn: "before:bg-warn-fill", info: "before:bg-info-fill" } as const;

// ── The research arms ────────────────────────────────────────────────────────────────────────────────────────────

function ArmsSection({ doc, filter, now }: { doc: PaperOptions | null; filter: Filter; now: Date }) {
  const env = "shadow" as const;
  const arms = doc ? armBooks(doc) : null;
  if (!arms || arms.length === 0) {
    return (
      <EnvFrame env="shadow" label={PAPER_FRAMES.arms}>
        <Empty icon={Inbox} title={arms ? "No research arm has a simulated trade yet" : "The arms' simulated trades are not being sent yet"}>
          Each arm runs beside the clone and books a simulated fill where its own rule would have traded.
        </Empty>
      </EnvFrame>
    );
  }
  const books = arms.map((a) => ({ hyp: a.hyp, whole: a, book: withTrades(a, applyFilter(a.trades, filter, now)) }));
  return (
    <EnvFrame env="shadow" label={PAPER_FRAMES.arms} className="grid gap-5">
      <Panel id="arms-table" title="Arm by arm" icon={FlaskConical} means="One row for each arm: its simulated trades, the share that won, the result for one contract a trade and the average on the premium. Each is its own trial; the rows are not added up.">
        <Table label="Research arms, one row each">
          <TableHeader>
            <TableRow>
              <TableHead>Hypothesis</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">Won</TableHead>
              <TableHead className="text-right">Result</TableHead>
              <TableHead className="text-right">Per trade</TableHead>
              <TableHead className="text-right">On premium</TableHead>
              <TableHead className="w-40">Running total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {books.map(({ hyp, book }) => {
              const s = summarize(book.trades);
              const prem = premiumStats(book);
              const curve = [0, ...daily(book.trades).map((d) => d.cum)];
              return (
                <TableRow key={hyp} data-arm={hyp}>
                  <TableCell className="font-medium">{hyp}</TableCell>
                  <TableCell className="text-right font-mono">{s.trades}</TableCell>
                  <TableCell className="text-right font-mono">{s.trades >= MIN_SAMPLE ? share(s.winRate) : "—"}</TableCell>
                  <TableCell className={cn("text-right font-mono font-semibold", textTone(s.net))}>{s.trades ? <Dollars env={env} value={s.net} signed /> : "—"}</TableCell>
                  <TableCell className={cn("text-right font-mono", textTone(s.expectancy))}>{s.trades >= MIN_SAMPLE ? <Dollars env={env} value={s.expectancy} signed /> : "—"}</TableCell>
                  <TableCell className={cn("text-right font-mono", textTone(prem.mean))}>{signedPct(prem.mean)}</TableCell>
                  <TableCell className={textTone(s.net)}>{curve.length > 2 ? <Sparkline values={curve} label={`${hyp}: running total of its simulated trades`} className="h-7 w-36" height={28} /> : <span className="text-muted-foreground text-xs">—</span>}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <p className="text-muted-foreground mt-3 max-w-prose text-xs">A rate or an average is shown from {MIN_SAMPLE} trades. Simulated fills at the quoted prices, after the same modelled fees as the clone; a real fill could differ.</p>
      </Panel>
      {books
        .filter(({ book }) => book.trades.length > 0)
        .map(({ hyp, book }) => (
          <details key={hyp} className="bg-card rounded-lg border px-4 py-3" data-arm-trades={hyp}>
            <summary className="hover:text-foreground cursor-pointer text-sm font-medium max-sm:min-h-11 max-sm:content-center">
              {hyp}: {count(book.trades.length, "simulated trade")}
            </summary>
            <div className="mt-3">
              <PaperTable rows={paperRows(book)} env={env} label={`Simulated trades of ${hyp}`} />
            </div>
          </details>
        ))}
    </EnvFrame>
  );
}

/** Where the history came from: the page's footnote. */
function Source({ doc }: { doc: PaperOptions }) {
  return (
    <p className="text-muted-foreground max-w-prose text-xs">
      Built on the trading host on {newYork(doc.as_of)} New York time from its own records: the clone&apos;s journal, the paper account&apos;s filled orders and the arms&apos; simulated book. Results are in US
      dollars and days are New York trading days. A record only: nothing here can trade. The focus cards&apos; modelled option results are a different thing and are on{" "}
      <Link href="/options/record" className="hover:text-foreground underline underline-offset-2">
        Card record
      </Link>
      .
    </p>
  );
}
