// The Stocks Overview: the owner's own trading first (account, day rules, profit and loss, patterns), then the next
// session's names, then the paper robots and the lab's health in one line each. Server-rendered.
import { Bot, CalendarCheck, Lightbulb, ChartColumn, Clock3, Crosshair, Flame, Radar as RadarIcon, Scale, ShieldCheck, Wallet } from "lucide-react";
import Link from "next/link";
import { DivergingBars } from "@/components/charts/diverging-bars";
import { SessionBars } from "@/components/charts/session-bars";
import { Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import { StatusBadge, TONE_TEXT, ToneIcon } from "@/components/status";
import type { Health } from "@/lib/health";
import { lessons, marketState, moneyView, sessionView, shortDay, summarize, type JournalDoc, type Trade } from "@/lib/journal";
import type { Tone } from "@/lib/labels";
import type { OptionsEdition } from "@/lib/options.types";
import { hourBands, keptStreak, keptVsBroken, nextOpen, periodTotals, quickVsSlow, ruleDays, since, tickerEnds, untilText, withRun } from "@/lib/overview";
import type { RadarEdition } from "@/lib/radar.types";
import { scan } from "@/lib/today";
import { DAY_LOSS_LIMIT, MAX_TRADES_PER_DAY, TIME_STOP_MINUTES, dayCheck } from "@/lib/trade-rules";
import { outcomeLine, trading } from "@/lib/trading";
import type { Snapshot } from "@/lib/types";
import { cn } from "@/lib/utils";

const usd = (v: number | null | undefined, digits = 0) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  // The word joiner keeps the sign on the same line as the amount.
  return `${v > 0 ? "+⁠" : v < 0 ? "−⁠" : ""}$${s}`;
};
const aud = (v: number | null | undefined, signed = false) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = `A$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return signed ? `${v > 0 ? "+⁠" : v < 0 ? "−⁠" : ""}${s}` : v < 0 ? `−⁠${s}` : s;
};
const shortMonthYear = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "America/New_York" });
const toneOf = (v: number | null | undefined): Tone => (v === null || v === undefined || v === 0 ? "neutral" : v > 0 ? "good" : "bad");
const dayFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const dayLabel = (ymd: string) => dayFmt.format(new Date(`${ymd}T12:00:00Z`)).replace(",", "");
const sydneyOpen = (ymd: string) => {
  // 9:30 New York on that day, shown in Sydney. New York is UTC-4 or UTC-5: find the offset from the zone itself.
  const probe = new Date(`${ymd}T13:30:00Z`);
  const nyHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(probe));
  const at = new Date(probe.getTime() + (9 - nyHour) * 3_600_000);
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at).replace(",", "");
};

// ── Your account ─────────────────────────────────────────────────────────────────────────────────────────────────

function Meter({ label, text, share, tone }: { label: string; text: string; share: number; tone: Tone }) {
  const fill = { good: "bg-good-fill", warn: "bg-warn-fill", bad: "bg-bad-fill", info: "bg-info-fill", neutral: "bg-neutral-fill" }[tone];
  return (
    <div className="grid content-start gap-1.5">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="font-mono text-base font-semibold">{text}</p>
      <span className="bg-muted h-2 overflow-hidden rounded-full" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <span className={cn("block h-full rounded-full", fill)} style={{ width: `${Math.min(100, Math.max(share > 0 ? 4 : 0, share * 100))}%` }} />
      </span>
    </div>
  );
}

const RULE_CHIP = {
  clear: { tone: "good" as Tone, word: "OK to trade" },
  careful: { tone: "warn" as Tone, word: "Careful" },
  stop: { tone: "bad" as Tone, word: "Stop for today" },
};

/** The account at a glance: what it is worth, the latest day, and how much of today's room is left. */
export function AccountHero({ doc, now }: { doc: JournalDoc; now: Date }) {
  const view = sessionView(doc, now);
  const check = dayCheck(view);
  const market = marketState(now);
  const next = nextOpen(now);
  const money = doc.money ? moneyView(doc.money, summarize(doc.trades).net) : null;
  const chip = RULE_CHIP[check.status];
  const lossUsed = Math.max(0, -check.net);
  const s = view?.summary;
  return (
    <section aria-labelledby="account-title" className="bg-card grid gap-4 rounded-xl border p-4 sm:p-5" data-testid="account-hero">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="account-title" className="flex items-center gap-2 text-base font-semibold">
          <Wallet aria-hidden className="text-muted-foreground size-4" />
          Your account
        </h2>
        <span className="flex flex-wrap gap-1.5">
          <StatusBadge tone={market === "open" ? "good" : "neutral"}>
            {next.open ? `Market open · closes in ${untilText(next.minutes)}` : `Opens in ${untilText(next.minutes)} · ${sydneyOpen(next.day)} Sydney`}
          </StatusBadge>
          <StatusBadge tone={chip.tone}>{check.isToday ? chip.word : "New day · OK to trade"}</StatusBadge>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4">
        <div className="grid content-start gap-1">
          <p className="text-muted-foreground text-xs">Worth now</p>
          <p className="font-mono text-2xl font-semibold tracking-tight sm:text-3xl">{money ? aud(money.value) : "—"}</p>
          {money && money.gain !== null ? (
            <p className="text-muted-foreground text-xs">
              Put in {aud(money.netIn)} net · <span className={TONE_TEXT[toneOf(money.gain)]}>{aud(money.gain, true)}</span>
            </p>
          ) : null}
        </div>
        <div className="grid content-start gap-1">
          <p className="text-muted-foreground text-xs">{view ? (view.isToday ? "Today" : `Last session · ${dayLabel(view.day)}`) : "Latest session"}</p>
          <p className={cn("font-mono text-2xl font-semibold tracking-tight sm:text-3xl", TONE_TEXT[toneOf(s?.trades ? s.net : null)])}>{s?.trades ? usd(s.net) : "$0"}</p>
          <p className="text-muted-foreground text-xs">
            {s?.trades ? `${s.trades} trade${s.trades === 1 ? "" : "s"} · ${s.wins} won` : "No trades closed"}
            {view?.open.length ? ` · ${view.open.length} open` : ""}
          </p>
        </div>
        <Meter
          label="Trades today"
          text={`${check.used} of ${MAX_TRADES_PER_DAY}`}
          share={check.used / MAX_TRADES_PER_DAY}
          tone={check.used >= MAX_TRADES_PER_DAY ? "bad" : check.used >= MAX_TRADES_PER_DAY - 1 ? "warn" : "good"}
        />
        <Meter
          label="Day loss used"
          text={`${lossUsed ? `−$${Math.round(lossUsed)}` : "$0"} of −$${DAY_LOSS_LIMIT}`}
          share={lossUsed / DAY_LOSS_LIMIT}
          tone={lossUsed >= DAY_LOSS_LIMIT ? "bad" : lossUsed >= DAY_LOSS_LIMIT * 0.6 ? "warn" : "good"}
        />
      </div>
      <p className={cn("text-sm", TONE_TEXT[check.isToday ? chip.tone : "neutral"])}>{check.line}</p>
      <RuleStreak trades={doc.trades} />
    </section>
  );
}

/** The latest twenty trading days as dots, kept or broken against the day rules, and what each kind of day made. */
function RuleStreak({ trades }: { trades: readonly Trade[] }) {
  const days = ruleDays(trades, 20);
  if (days.length === 0) return null;
  const streak = keptStreak(days);
  const kb = keptVsBroken(days);
  return (
    <div className="grid gap-2 border-t pt-4" data-testid="rule-streak">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Flame aria-hidden className={cn("size-4", streak >= 3 ? "text-good" : "text-muted-foreground")} />
          {streak} day{streak === 1 ? "" : "s"} in a row inside your day rules
        </p>
        <p className="text-muted-foreground text-xs">
          Last {days.length} trading days: at most {MAX_TRADES_PER_DAY} trades, no worse than −${DAY_LOSS_LIMIT}
        </p>
      </div>
      <ol className="flex flex-wrap gap-1.5" aria-label="Latest trading days, oldest first">
        {days.map((d) => (
          <li
            key={d.day}
            title={`${shortDay(d.day)}: ${usd(d.pnl)} · ${d.trades} trade${d.trades === 1 ? "" : "s"} · ${d.kept ? "rules kept" : d.broke === "loss" ? `lost more than $${DAY_LOSS_LIMIT}` : d.broke === "count" ? `more than ${MAX_TRADES_PER_DAY} trades` : "both rules broken"}`}
            className={cn(
              "grid size-6 place-items-center rounded-full text-[0.625rem] font-semibold",
              d.kept ? (d.pnl >= 0 ? "bg-good-fill text-white" : "bg-good-fill/35 text-foreground") : "bg-bad-fill text-white",
            )}
          >
            <span aria-hidden>{d.kept ? "" : "!"}</span>
            <span className="sr-only">{`${d.day} ${d.kept ? "kept" : "broken"} ${usd(d.pnl)}`}</span>
          </li>
        ))}
      </ol>
      <p className="text-muted-foreground text-xs">
        Days that kept the rules: <span className={cn("font-mono font-semibold", TONE_TEXT[toneOf(kb.keptPnl)])}>{usd(kb.keptPnl)}</span> over {kb.kept}.{" "}
        Days that broke one: <span className={cn("font-mono font-semibold", TONE_TEXT[toneOf(kb.brokenPnl)])}>{usd(kb.brokenPnl)}</span> over {kb.broken}. Solid green made money, pale green lost
        a little inside the rules, red with ! broke a rule.
      </p>
    </div>
  );
}

// ── Profit and loss ──────────────────────────────────────────────────────────────────────────────────────────────

export function PnlOverview({ trades, now }: { trades: readonly Trade[]; now: Date }) {
  const periods = periodTotals(trades, now);
  const bars = withRun(ruleDays(trades, 20));
  const first = trades.reduce<string | null>((m, t) => (m === null || t.closed_at < m ? t.closed_at : m), null);
  return (
    <Panel
      id="pnl"
      title="Profit and loss"
      icon={ChartColumn}
      means="Your closed trades from Webull, in US dollars before fees, matched first in, first out. The chart is your last 20 trading days, with their running total as the line."
      action={
        <Link href="/trades" className="text-xs underline underline-offset-2">
          Every trade
        </Link>
      }
    >
      <div className="grid gap-4">
        <StatTiles className="grid-cols-2 lg:grid-cols-4">
          {periods.map((p) => (
            <StatTile
              key={p.key}
              label={p.label}
              tone={toneOf(p.trades ? p.pnl : null)}
              value={p.trades ? usd(p.pnl) : "$0"}
              hint={`${p.trades.toLocaleString("en-US")} trade${p.trades === 1 ? "" : "s"}${p.key === "all" && first ? ` since ${shortMonthYear(first)}` : ""}`}
            />
          ))}
        </StatTiles>
        {bars.length >= 2 ? <SessionBars days={bars} /> : null}
      </div>
    </Panel>
  );
}

// ── Patterns ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where this year's money was made and lost: by hour of the day, by how long a trade was held, and by ticker. */
export function PatternsPanel({ trades, now }: { trades: readonly Trade[]; now: Date }) {
  const year = periodTotals(trades, now)[2]!;
  const these = since(trades, year.from!);
  if (these.length < 5) return null;
  const hours = hourBands(these);
  const qs = quickVsSlow(these);
  const ends = tickerEnds(these, 4);
  const kinds = (["call", "put", "stock"] as const).map((k) => ({ k, pnl: these.filter((t) => t.kind === k).reduce((a, t) => a + t.pnl, 0), n: these.filter((t) => t.kind === k).length })).filter((x) => x.n > 0);
  const label = { call: "Calls", put: "Puts", stock: "Shares" };
  const found = lessons(these);
  const lesson = found.find((l) => l.tone === "bad") ?? found[0] ?? null;
  return (
    <Panel id="patterns" title={`Your patterns in ${year.label}`} icon={Crosshair} means="What this year's trades say about when and how you make money. Each bar is the total made or lost; hover or tap for the count.">
      <div className="grid gap-6 lg:grid-cols-3">
        {lesson ? (
          <Link
            href="/trades#lessons"
            data-testid="top-lesson"
            className={cn(
              "hover:bg-muted/40 grid gap-1 rounded-lg border px-4 py-3 transition-colors lg:col-span-3",
              lesson.tone === "bad" ? "border-bad/40 bg-bad-soft" : lesson.tone === "good" ? "border-good/40 bg-good-soft" : "bg-muted/30",
            )}
          >
            <span className={cn("flex items-center gap-1.5 text-xs font-semibold", TONE_TEXT[lesson.tone])}>
              <Lightbulb aria-hidden className="size-3.5" />
              {lesson.tone === "bad" ? "The biggest thing costing you this year" : "Worth knowing this year"}
            </span>
            <span className="text-sm font-medium">{lesson.title}</span>
            <span className="text-muted-foreground text-[0.8125rem]">{lesson.finding}</span>
          </Link>
        ) : null}
        <section className="grid content-start gap-2" aria-labelledby="hours-title">
          <h3 id="hours-title" className="flex items-center gap-1.5 text-sm font-semibold">
            <Clock3 aria-hidden className="text-muted-foreground size-4" />
            By the hour you opened (New York)
          </h3>
          <DivergingBars
            label="Result by hour of entry"
            better="positive"
            format={(v) => usd(v)}
            rows={hours.rows.map((r) => ({ key: r.key, label: <span title={`${r.trades} trades`}>{r.label}</span>, value: r.trades ? r.pnl : null }))}
          />
          <p className="text-muted-foreground text-xs">
            {hours.best ? `Best: ${hours.best.label} (${usd(hours.best.pnl)}). ` : ""}
            {hours.worst ? `Worst: ${hours.worst.label} (${usd(hours.worst.pnl)}).` : ""}
          </p>
        </section>
        <section className="grid content-start gap-2" aria-labelledby="hold-title">
          <h3 id="hold-title" className="flex items-center gap-1.5 text-sm font-semibold">
            <Scale aria-hidden className="text-muted-foreground size-4" />
            Quick exits against slow ones
          </h3>
          <DivergingBars
            label="Result by holding time"
            better="positive"
            format={(v) => usd(v)}
            rows={[
              { key: "q", label: `Closed within ${TIME_STOP_MINUTES} min · ${qs.quick.trades}`, value: qs.quick.trades ? qs.quick.pnl : null },
              { key: "s", label: `Held longer · ${qs.slow.trades}`, value: qs.slow.trades ? qs.slow.pnl : null },
            ]}
          />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {kinds.map((x) => (
              <span key={x.k} className="bg-muted/60 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs">
                {label[x.k]} <b className={cn("font-mono", TONE_TEXT[toneOf(x.pnl)])}>{usd(x.pnl)}</b>
              </span>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">Rule 6 says exit if a trade is not working after {TIME_STOP_MINUTES} minutes. This is why.</p>
        </section>
        <section className="grid content-start gap-2" aria-labelledby="tickers-title">
          <h3 id="tickers-title" className="flex items-center gap-1.5 text-sm font-semibold">
            <ChartColumn aria-hidden className="text-muted-foreground size-4" />
            Best and worst tickers
          </h3>
          {ends.length ? (
            <DivergingBars
              label="Result by ticker"
              better="positive"
              format={(v) => usd(v)}
              rows={ends.map((g) => ({
                key: g.key,
                label: (
                  <Link href={`/trades?symbol=${encodeURIComponent(g.key)}`} className="font-mono underline-offset-2 hover:underline" title={`${g.trades} trades`}>
                    {g.key}
                  </Link>
                ),
                value: g.pnl,
              }))}
            />
          ) : (
            <p className="text-muted-foreground text-sm">No ticker has a result yet this year.</p>
          )}
        </section>
      </div>
    </Panel>
  );
}

// ── The next session ─────────────────────────────────────────────────────────────────────────────────────────────

type FocusItem = NonNullable<OptionsEdition["focus"]>["items"][number];

/** Close, support and resistance on one strip, 1.5 ATR either side of the close. */
function RoomStrip({ f }: { f: FocusItem }) {
  if (typeof f.close !== "number" || typeof f.atr !== "number" || f.atr <= 0) return <span className="bg-muted h-1 rounded" />;
  const atr = f.atr;
  const lo = f.close - 1.5 * atr;
  const at = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (3 * atr)) * 100));
  return (
    <span className="relative block h-6" aria-hidden>
      <span className="bg-muted absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded" />
      {f.support ? <span className="bg-good-fill absolute top-1 h-4 w-1 rounded-sm" style={{ left: `calc(${at(f.support.price)}% - 2px)` }} /> : null}
      {f.resistance ? <span className="bg-bad-fill absolute top-1 h-4 w-1 rounded-sm" style={{ left: `calc(${at(f.resistance.price)}% - 2px)` }} /> : null}
      <span className="bg-foreground absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--card)]" style={{ left: `${at(f.close)}%` }} />
    </span>
  );
}

const BIAS: Record<FocusItem["bias"], { tone: Tone; word: string }> = {
  breakout: { tone: "info", word: "Breakout" },
  support: { tone: "good", word: "Support" },
  range: { tone: "neutral", word: "Range" },
};

export function NextSessionPanel({ options, radar }: { options: OptionsEdition | null; radar: RadarEdition | null }) {
  const items = [...(options?.focus?.items ?? [])].sort((a, b) => a.rank - b.rank).slice(0, 4);
  if (items.length === 0 && !radar) return null;
  const regime = radar?.regime_word;
  const p = (v: number | null | undefined) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—");
  return (
    <Panel
      id="next"
      title={options ? `Top names for ${dayLabel(options.session)}` : "The next session"}
      icon={CalendarCheck}
      means="The four names with the clearest level from the last close, picked for options. Green mark: support. Red mark: resistance. Dot: the close."
      action={regime ? <StatusBadge tone={regime === "risk-on" ? "good" : regime === "risk-off" ? "bad" : "neutral"}>Market {regime}</StatusBadge> : undefined}
    >
      <div className="grid gap-3">
        {items.length ? (
          <ul className="grid gap-3" data-testid="next-focus">
            {items.map((f) => (
              <li key={f.symbol} className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
                <Link href={`/options?s=${encodeURIComponent(f.symbol)}`} className="font-mono text-sm font-semibold underline-offset-2 hover:underline">
                  {f.symbol}
                </Link>
                <RoomStrip f={f} />
                <StatusBadge tone={BIAS[f.bias].tone}>{BIAS[f.bias].word}</StatusBadge>
                <span />
                <span className="text-muted-foreground font-mono text-[0.6875rem]">
                  <span className="text-good">S {p(f.support?.price)}</span> · close {p(f.close)} · <span className="text-bad">R {p(f.resistance?.price)}</span>
                </span>
                <span />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">The top names appear after the next close.</p>
        )}
        <p className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <Link href="/options" className="underline underline-offset-2">
            Levels and the desk on Options
          </Link>
          {radar ? (
            <Link href="/radar" className="underline underline-offset-2">
              Radar for {shortDay(radar.edition_date)}
              {radar.tickers?.length ? ` · ${radar.tickers.length} tickers` : ""}
            </Link>
          ) : null}
        </p>
      </div>
    </Panel>
  );
}

// ── The robots and the lab ───────────────────────────────────────────────────────────────────────────────────────

/** Paper B and the small-cap scan in one row each: the detail lives on the Today page. */
export function RobotsStrip({ s }: { s: Snapshot | null }) {
  if (!s) return null;
  const v = trading(s);
  const o = outcomeLine(v);
  const sc = scan(s);
  const l = sc.latest;
  const steps = l ? [l.universe, l.traded, l.gapping, l.candidates, l.shortList] : [];
  const top = Math.max(1, ...steps.map((x) => x ?? 0));
  return (
    <section aria-labelledby="robots-title" className="grid gap-2">
      <h2 id="robots-title" className="text-muted-foreground flex items-center gap-2 text-sm font-semibold">
        <Bot aria-hidden className="size-4" />
        The robots, paper money only
      </h2>
      <div className="bg-border grid gap-px overflow-hidden rounded-lg border sm:grid-cols-2">
        <Link href="/today" className="bg-card hover:bg-muted/40 grid content-start gap-1.5 p-3 transition-colors">
          <span className="text-muted-foreground text-xs">Paper B · QQQ rule</span>
          <span className="font-mono text-sm font-semibold">
            {v.available ? `${usd(v.periods.find((x) => x.key === "total")?.money ?? 0, 2)} · ${v.stats.trades} trade${v.stats.trades === 1 ? "" : "s"}` : "No session yet"}
          </span>
          <StatusBadge tone={o.tone} className="justify-self-start">
            {v.session ? `${shortDay(v.session)}: ${o.title}` : o.title}
          </StatusBadge>
        </Link>
        <Link href="/today" className="bg-card hover:bg-muted/40 grid content-start gap-1.5 p-3 transition-colors">
          <span className="text-muted-foreground text-xs">Small-cap scan{sc.date ? ` · ${shortDay(sc.date)}` : ""}</span>
          {l ? (
            <>
              <span className="flex h-8 items-end gap-1" aria-hidden>
                {steps.map((x, i) => (
                  <span key={i} className="bg-info-fill/70 flex-1 rounded-t-sm" style={{ height: `${Math.max(4, Math.sqrt((x ?? 0) / top) * 100)}%` }} />
                ))}
              </span>
              <span className="text-muted-foreground font-mono text-xs">{steps.map((x) => (x ?? 0).toLocaleString("en-US")).join(" → ")}</span>
            </>
          ) : (
            <span className="text-muted-foreground text-sm">No scan yet</span>
          )}
        </Link>
      </div>
    </section>
  );
}

const HEALTH_TONE: Record<Health["level"], Tone> = { green: "good", amber: "warn", red: "bad" };
const HEALTH_WORD: Record<Health["level"], string> = { green: "All clear", amber: "Needs a look", red: "Action needed" };

/** The lab's health in one line, with the first reason; the jobs and decisions live on Operations. */
export function HealthLine({ health, needsYou }: { health: Health; needsYou: number }) {
  const tone = HEALTH_TONE[health.level];
  const first = health.reasons[0];
  return (
    <section aria-label="Lab health" className="bg-card flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-4 py-3 text-sm" data-testid="health-line">
      <span className={cn("inline-flex items-center gap-1.5 font-semibold", TONE_TEXT[tone])}>
        {health.level === "green" ? <ShieldCheck aria-hidden className="size-4" /> : <ToneIcon tone={tone} />}
        {HEALTH_WORD[health.level]}
      </span>
      {first ? <span className="min-w-0">{first.text}</span> : <span className="text-muted-foreground">The lab&apos;s jobs ran as planned.</span>}
      {health.reasons.length > 1 ? <span className="text-muted-foreground">+{health.reasons.length - 1} more</span> : null}
      {needsYou ? <span className="text-muted-foreground">· {needsYou} decision{needsYou === 1 ? "" : "s"} waiting</span> : null}
      <Link href="/operations" className="ml-auto inline-flex items-center gap-1 text-xs underline underline-offset-2">
        <RadarIcon aria-hidden className="size-3.5" />
        Operations
      </Link>
    </section>
  );
}
