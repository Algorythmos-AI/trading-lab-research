// The Trades page's panels. Server-rendered; the charts and the table are the only client parts.
import { CalendarDays, ChartColumn, ChartLine, Clock, Inbox, Layers, Lightbulb, ListOrdered, Target, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { DivergingBars } from "@/components/charts/diverging-bars";
import { MonthBars } from "@/components/charts/month-bars";
import { PnlCurve } from "@/components/charts/pnl-curve";
import { JournalTable, type JournalRow } from "@/components/client/journal-table";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import {
  calendar,
  contractLabel,
  DTE_ORDER,
  dteKey,
  filterHref,
  fmtMinutes,
  groupBy,
  HOLD_ORDER,
  holdKey,
  holdMinutes,
  HOUR_ORDER,
  hourKey,
  KIND_ORDER,
  MONTH,
  shortDay,
  SIZE_ORDER,
  sizeKey,
  WEEKDAY_ORDER,
  weekdayKey,
  type DayRow,
  type Filter,
  type GroupRow,
  type Lesson,
  type Summary,
  type Trade,
} from "@/lib/journal";
import type { JournalResult } from "@/lib/snapshot";
import { cn } from "@/lib/utils";

const usd = (v: number | null | undefined, digits = 0) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}$${s}`;
};
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
const toneOf = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "neutral" : v > 0 ? "good" : "bad");

export function NoJournal({ status }: { status: Exclude<JournalResult["status"], "ok"> }) {
  if (status === "error") return <Empty title="Storage could not be read">The dashboard could not read the trade journal. Reload in a minute.</Empty>;
  return (
    <Empty icon={Inbox} title="No trades have been sent yet">
      The journal fills in when the broker&apos;s history is first read, and refreshes after every session.
    </Empty>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────────────────────────────────────────

function Chip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? "true" : undefined}
      scroll={false}
      className={cn(
        "inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors",
        on ? "bg-foreground text-background border-foreground font-medium" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

/** Period, kind and ticker chips. Each is a link, so a filtered view can be bookmarked. */
export function JournalFilters({ filter, years, symbols }: { filter: Filter; years: string[]; symbols: string[] }) {
  const periods: { key: Filter["period"]; label: string }[] = [
    { key: "all", label: "All time" },
    ...years.map((y) => ({ key: y as Filter["period"], label: y })),
    { key: "ytd", label: "This year" },
    { key: "90d", label: "90 days" },
    { key: "30d", label: "30 days" },
  ];
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Period">
        {periods.map((p) => (
          <Chip key={p.key} href={filterHref({ ...filter, period: p.key })} on={filter.period === p.key}>
            {p.label}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="What was traded">
        <Chip href={filterHref({ ...filter, kind: null })} on={filter.kind === null}>
          Everything
        </Chip>
        {KIND_ORDER.map((k) => (
          <Chip key={k.key} href={filterHref({ ...filter, kind: k.key })} on={filter.kind === k.key}>
            {k.label}
          </Chip>
        ))}
        <span className="bg-border mx-1 w-px self-stretch" aria-hidden />
        <Chip href={filterHref({ ...filter, symbol: null })} on={filter.symbol === null}>
          All tickers
        </Chip>
        {symbols.map((s) => (
          <Chip key={s} href={filterHref({ ...filter, symbol: s })} on={filter.symbol === s}>
            {s}
          </Chip>
        ))}
      </div>
    </div>
  );
}

// ── Headline ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function JournalTiles({ s }: { s: Summary }) {
  return (
    <StatTiles className="lg:grid-cols-4">
      <StatTile label="Net result" icon={Wallet} tone={toneOf(s.net)} value={usd(s.net)} hint={`${s.trades.toLocaleString("en-US")} closed trades, before fees`} />
      <StatTile
        label="Won"
        icon={Target}
        tone={s.winRate === null ? "neutral" : s.winRate >= 0.5 ? "good" : "warn"}
        value={pct(s.winRate)}
        hint={`${s.wins.toLocaleString("en-US")} won · ${s.losses.toLocaleString("en-US")} lost`}
      />
      <StatTile
        label="Profit factor"
        icon={ChartColumn}
        tone={s.profitFactor === null ? "neutral" : s.profitFactor >= 1 ? "good" : "bad"}
        value={s.profitFactor === null ? "—" : s.profitFactor.toFixed(2)}
        hint="Dollars won for each dollar lost. Above 1 makes money."
      />
      <StatTile label="Per trade" icon={Layers} tone={toneOf(s.expectancy)} value={usd(s.expectancy, 2)} hint="The average result of one trade" />
      <StatTile label="Average win" icon={TrendingUp} tone="good" value={usd(s.avgWin, 2)} hint={s.best ? `Best: ${usd(s.best.pnl)} · ${contractLabel(s.best)}` : undefined} />
      <StatTile
        label="Average loss"
        icon={TrendingDown}
        tone="bad"
        value={usd(s.avgLoss, 2)}
        hint={s.payoff === null ? undefined : `A win is ${s.payoff.toFixed(2)}× a loss · worst ${usd(s.worst?.pnl)}`}
      />
      <StatTile label="Deepest fall" icon={ChartLine} tone={s.maxDrawdown < 0 ? "bad" : "neutral"} value={usd(s.maxDrawdown)} hint={`From a high, by day · ${s.lossStreak} losses in a row at most`} />
      <StatTile
        label="Green days"
        icon={CalendarDays}
        tone={s.days && s.greenDays / s.days >= 0.5 ? "good" : "warn"}
        value={`${s.greenDays} of ${s.days}`}
        hint={s.worstDay ? `Worst day ${shortDay(s.worstDay.day)}: ${usd(s.worstDay.pnl)}` : undefined}
      />
    </StatTiles>
  );
}

// ── Curve and months ─────────────────────────────────────────────────────────────────────────────────────────────

export function CurvePanel({ days }: { days: DayRow[] }) {
  return (
    <Panel id="curve" title="Running total" icon={ChartLine} means="Every closed trade added up, day by day. The shaded band underneath is how far the total stood below its best.">
      <PnlCurve points={days.map((d) => ({ day: d.day, pnl: d.pnl, cum: d.cum, dd: d.dd, trades: d.trades }))} />
    </Panel>
  );
}

export function MonthsPanel({ trades }: { trades: Trade[] }) {
  const months = groupBy(trades, MONTH)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((g) => ({ month: g.key, pnl: g.pnl, trades: g.trades, winRate: g.winRate }));
  return (
    <Panel id="months" title="Month by month" icon={ChartColumn} means="What each month made or lost. Months with no trades are left out.">
      <MonthBars months={months} />
    </Panel>
  );
}

// ── Calendar ─────────────────────────────────────────────────────────────────────────────────────────────────────

function heat(pnl: number | null, reach: number): string {
  if (pnl === null) return "bg-muted/40";
  if (pnl === 0) return "bg-neutral-soft";
  const s = Math.min(1, Math.abs(pnl) / reach);
  const step = s > 0.66 ? 3 : s > 0.33 ? 2 : 1;
  return pnl > 0 ? ["", "bg-good-fill/30", "bg-good-fill/60", "bg-good-fill"][step]! : ["", "bg-bad-fill/30", "bg-bad-fill/60", "bg-bad-fill"][step]!;
}

export function CalendarPanel({ days }: { days: DayRow[] }) {
  const months = calendar(days, 6);
  const reach = Math.max(1, ...days.slice(-130).map((d) => Math.abs(d.pnl)));
  return (
    <Panel id="calendar" title="Trading calendar" icon={CalendarDays} means="The last six months with trades, Monday to Friday. Green made money that day, red lost it; the stronger the colour, the bigger the day.">
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {months.map((m) => (
          <div key={m.month} className="grid gap-1.5">
            <p className="flex items-baseline justify-between text-sm">
              <span className="font-medium">{new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" })}</span>
              <span className={cn("font-mono text-xs", m.pnl > 0 ? "text-good" : m.pnl < 0 ? "text-bad" : "text-muted-foreground")}>{usd(m.pnl)}</span>
            </p>
            <div className="text-muted-foreground grid grid-cols-5 gap-1 text-center text-[0.625rem]">
              {["M", "T", "W", "T", "F"].map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </div>
            {m.weeks.map((w, i) => (
              <div key={i} className="grid grid-cols-5 gap-1">
                {w.map((c, j) =>
                  c ? (
                    <span
                      key={j}
                      title={c.pnl === null ? `${shortDay(c.day)}: no trades` : `${shortDay(c.day)}: ${usd(c.pnl, 2)} · ${c.trades} trade${c.trades === 1 ? "" : "s"}`}
                      className={cn("relative flex h-8 items-end justify-end rounded-[3px] px-1 pb-0.5 text-[0.5625rem]", heat(c.pnl, reach), c.pnl !== null && Math.abs(c.pnl) / reach > 0.66 ? "text-white" : "text-muted-foreground")}
                    >
                      {Number(c.day.slice(8))}
                    </span>
                  ) : (
                    <span key={j} />
                  ),
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── Lessons ──────────────────────────────────────────────────────────────────────────────────────────────────────

const LESSON_EDGE = { good: "before:bg-good-fill", bad: "before:bg-bad-fill", warn: "before:bg-warn-fill", info: "before:bg-info-fill" } as const;
const LESSON_TAG = { good: "Keep doing", bad: "Costing you", warn: "Watch", info: "Worth knowing" } as const;
const LESSON_TAG_TONE = { good: "text-good", bad: "text-bad", warn: "text-warn", info: "text-info" } as const;

export function LessonsPanel({ lessons }: { lessons: Lesson[] }) {
  return (
    <Panel id="lessons" title="What the record says" icon={Lightbulb} means="Patterns measured from these trades, each comparing like with like. They describe what happened; they do not predict anything.">
      {lessons.length === 0 ? (
        <Empty title="Not enough trades in this view">Pick a wider period to see patterns.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {lessons.map((l) => (
            <div key={l.id} className={cn("bg-card relative grid gap-2 overflow-hidden rounded-lg border py-3 pr-3.5 pl-4", "before:absolute before:inset-y-0 before:left-0 before:w-1", LESSON_EDGE[l.tone])}>
              <p className={cn("text-[0.6875rem] font-medium tracking-wide uppercase", LESSON_TAG_TONE[l.tone])}>{LESSON_TAG[l.tone]}</p>
              <p className="text-sm leading-snug font-semibold">{l.title}</p>
              <p className="text-muted-foreground text-[0.8125rem] leading-snug">{l.finding}</p>
              {l.compare ? (
                <DivergingBars
                  label={`${l.compare.a.label} against ${l.compare.b.label}, average result per trade`}
                  better="positive"
                  format={(v) => usd(v, 0)}
                  rows={[
                    { key: "a", label: l.compare.a.label, value: l.compare.a.avg },
                    { key: "b", label: l.compare.b.label, value: l.compare.b.avg },
                  ]}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Breakdowns ───────────────────────────────────────────────────────────────────────────────────────────────────

function Breakdown({ title, rows, note }: { title: string; rows: GroupRow[]; note?: string }) {
  const shown = rows.filter((r) => r.trades > 0);
  return (
    <div className="grid content-start gap-2">
      <p className="text-sm font-medium">{title}</p>
      {note ? <p className="text-muted-foreground -mt-1 text-xs">{note}</p> : null}
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-xs">No trades.</p>
      ) : (
        <DivergingBars
          label={`${title}: result in dollars`}
          better="positive"
          format={(v) => usd(v)}
          rows={shown.map((r) => ({
            key: r.key,
            label: (
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate">{r.label}</span>
                <span className="text-muted-foreground shrink-0 font-mono text-[0.6875rem]">
                  {r.trades} · {pct(r.winRate)}
                </span>
              </span>
            ),
            value: r.pnl,
          }))}
        />
      )}
    </div>
  );
}

export function BreakdownPanel({ trades }: { trades: Trade[] }) {
  const bySymbol = groupBy(trades, (t) => t.symbol);
  const worst = bySymbol.slice(0, 6);
  const best = bySymbol.slice(-6).reverse().filter((r) => !worst.some((w) => w.key === r.key));
  const symbols = [...best, ...worst.reverse()].sort((a, b) => b.pnl - a.pnl);
  return (
    <Panel id="breakdown" title="Where it was made and lost" icon={Layers} means="The same trades cut six ways. Each bar is the dollars made or lost; the small numbers are how many trades and the share that won.">
      <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
        <Breakdown title="By ticker" rows={symbols} note="The best and the worst" />
        <Breakdown title="Calls, puts and shares" rows={groupBy(trades, (t) => t.kind, KIND_ORDER)} />
        <Breakdown title="Time of entry (New York)" rows={groupBy(trades, hourKey, HOUR_ORDER)} />
        <Breakdown title="Day of the week" rows={groupBy(trades, weekdayKey, WEEKDAY_ORDER)} />
        <Breakdown title="How long it was held" rows={groupBy(trades, holdKey, HOLD_ORDER)} />
        <Breakdown title="Time to expiry when opened" rows={groupBy(trades, dteKey, DTE_ORDER)} note="Options only" />
        <Breakdown title="Position size" rows={groupBy(trades, sizeKey, SIZE_ORDER)} note="Contracts per trade, options only" />
      </div>
    </Panel>
  );
}

// ── Trades ───────────────────────────────────────────────────────────────────────────────────────────────────────

const whenFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "America/New_York", day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function toRows(trades: Trade[]): JournalRow[] {
  return trades.map((t) => ({
    id: t.id,
    when: whenFmt.format(new Date(t.closed_at)).replace(",", " ·"),
    at: Date.parse(t.closed_at),
    symbol: t.symbol,
    what: contractLabel(t),
    kind: t.kind,
    qty: t.qty,
    entry: t.entry,
    exit: t.exit,
    pnl: t.pnl,
    held: t.close === "expired" ? "to expiry" : fmtMinutes(holdMinutes(t)),
    holdMin: holdMinutes(t),
    expired: t.close === "expired",
  }));
}

export function TradesPanel({ trades }: { trades: Trade[] }) {
  return (
    <Panel id="trades" title="Every trade" icon={ListOrdered} means="Each closed trade, matched first in, first out from the broker's filled orders. Results are before fees.">
      <JournalTable rows={toRows(trades)} />
    </Panel>
  );
}

export function DayList({ days }: { days: DayRow[] }) {
  const sorted = [...days].sort((a, b) => a.pnl - b.pnl);
  const worst = sorted.slice(0, 5);
  const best = sorted.slice(-5).reverse();
  const row = (d: DayRow) => (
    <li key={d.day} className="flex items-baseline justify-between gap-3 text-[0.8125rem]">
      <span>
        {shortDay(d.day)} <span className="text-muted-foreground text-xs">· {d.trades} trades</span>
      </span>
      <span className={cn("font-mono text-xs font-semibold", d.pnl > 0 ? "text-good" : "text-bad")}>{usd(d.pnl, 2)}</span>
    </li>
  );
  return (
    <Panel id="days" title="Best and worst days" icon={Clock} means="The five biggest days each way. Open the calendar above to see when they fell.">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <p className="text-good text-xs font-medium">Best</p>
          <ul className="grid gap-1">{best.filter((d) => d.pnl > 0).map(row)}</ul>
        </div>
        <div className="grid content-start gap-1.5">
          <p className="text-bad text-xs font-medium">Worst</p>
          <ul className="grid gap-1">{worst.filter((d) => d.pnl < 0).map(row)}</ul>
        </div>
      </div>
    </Panel>
  );
}

