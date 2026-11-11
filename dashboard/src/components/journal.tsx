// The Trades page's panels. Server-rendered; the charts and the table are the only client parts.
import { Activity, ArrowDownToLine, ArrowUpFromLine, CalendarDays, ChartColumn, ChartLine, Clock, Hourglass, Inbox, Landmark, Layers, Lightbulb, ListOrdered, Ruler, Scale, Target, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { DivergingBars } from "@/components/charts/diverging-bars";
import { MoneyChart } from "@/components/charts/money-chart";
import { MonthBars } from "@/components/charts/month-bars";
import { PnlCurve } from "@/components/charts/pnl-curve";
import { JournalTable, type JournalRow } from "@/components/client/journal-table";
import { packRow, type Piece, pieceText, whenText } from "@/lib/journal-list";
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
  MIN_SAMPLE,
  MONTH,
  nyTime,
  shortDay,
  summarize,
  SIZE_ORDER,
  sizeKey,
  WEEKDAY_ORDER,
  weekdayKey,
  type DayRow,
  type MarketState,
  type MoneyView,
  type SessionView,
  type Filter,
  type GroupRow,
  type Lesson,
  type Summary,
  type Trade,
} from "@/lib/journal";
import { exitStats, MEAN_MIN_POSITIONS, MEAN_MIN_SESSIONS, meanR25, OWNER_FEES, R25_SHARE, SMALL_WIN_UNDER, netPieces, tradeUnits, type OwnerPosition, type TradeUnit } from "@/lib/owner-positions";
import type { JournalResult } from "@/lib/snapshot";
import { RAN_TO_MARK } from "@/lib/trade-rules";
import { cn } from "@/lib/utils";

const usd = (v: number | null | undefined, digits = 0) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  // The word joiner keeps the sign on the same line as the amount.
  return `${v > 0 ? "+\u2060" : v < 0 ? "−\u2060" : ""}$${s}`;
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
        "inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors max-sm:h-11 max-sm:px-3.5 max-sm:text-sm",
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

/** What the fee note says: the fees taken off, or that the journal already carries them. */
export interface FeeBasis {
  /** True when the journal says its results already carry fees: none are taken off. */
  included: boolean;
  /** The fees taken off the trades in view, in dollars (zero or above). */
  total: number;
}

const feeRate = `$${OWNER_FEES.openPerContract.toFixed(2)} in, $${OWNER_FEES.closePerContract.toFixed(2)} out a contract`;

/**
 * The fees taken off are an estimate: today's Webull rates, applied to every piece back to 2023. What earlier years
 * were charged has not been established, so every label that rests on the deduction says "est.", and only a journal
 * whose results already carry the broker's fees (`fees_included`) says plain "after fees" or nothing.
 */
export const EST = "after est. fees";
/**
 * A tile's label: "Net result, after fees" (or the plain label when the broker's results already carry the fees). The
 * label keeps its old length so it never truncates in the four-column grid; the estimate is said in the tile's hint
 * (feeHint), in the same tile.
 */
export const feeLabel = (label: string, included: boolean) => (included ? label : `${label}, after fees`);
/** A tile's hint, led by "After est. fees" when the fees taken off are the estimate; the hint alone otherwise. */
export const feeHint = (hint: string | undefined, included: boolean) => (included ? hint : hint ? `After est. fees · ${hint}` : "After est. fees");

/** The line under the headline: what the fees taken off are, and what a trade is. */
export function feeNote(fees: FeeBasis): string {
  const what =
    "A trade is a position: an option bought and sold in several fills counts once, and buying it again after selling it all is a new trade. Trades are counted on the day they finished; dollars on the day each part was sold.";
  if (fees.included) return `Webull's results already carry fees, so none are taken off. ${what}`;
  return `After estimated fees on options, ${usd(-fees.total)} on the trades in view: today's Webull rates (${feeRate}) are applied to every year, and older years may have differed. Shares are before fees. ${what}`;
}

/** The fee words a panel's intro carries, in step with `feeNote`: estimated fees off options, unless Webull's results already carry them. */
export function feeWords(included: boolean): string {
  return included ? "Webull's results already carry its fees." : "After estimated fees on options (today's rates for every year); shares are before fees.";
}

/** What a trade is, for the panels that count trades rather than add up dollars. */
const WHOLE_POSITION = "A trade is a whole position, however many fills it took.";

/** The headline, after fees, with the figure before fees beside the net result. `s` and `gross` count the same trades. */
export function JournalTiles({ s, gross, fees }: { s: Summary; gross: Summary; fees: FeeBasis }) {
  return (
    <div className="grid gap-2">
      <StatTiles className="lg:grid-cols-4">
        <StatTile
          label={feeLabel("Net result", fees.included)}
          icon={Wallet}
          tone={toneOf(s.net)}
          value={usd(s.net)}
          hint={feeHint(`${s.trades.toLocaleString("en-US")} closed trades${fees.included ? "" : ` · before fees ${usd(gross.net)}`}`, fees.included)}
        />
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
          hint={`Dollars won for each dollar lost. Above 1 makes money.${gross.profitFactor === null || fees.included ? "" : ` Before fees ${gross.profitFactor.toFixed(2)}.`}`}
        />
        <StatTile label="Per trade" icon={Layers} tone={toneOf(s.expectancy)} value={usd(s.expectancy, 2)} hint={`The average result of one trade${fees.included ? "" : ` · before fees ${usd(gross.expectancy, 2)}`}`} />
        <StatTile label={feeLabel("Average win", fees.included)} icon={TrendingUp} tone="good" value={usd(s.avgWin, 2)} hint={feeHint(s.best ? `Best: ${usd(s.best.pnl)} · ${contractLabel(s.best)}` : undefined, fees.included)} />
        <StatTile
          label={feeLabel("Average loss", fees.included)}
          icon={TrendingDown}
          tone="bad"
          value={usd(s.avgLoss, 2)}
          hint={feeHint(s.payoff === null ? undefined : `A win is ${s.payoff.toFixed(2)}× a loss · worst ${usd(s.worst?.pnl)}`, fees.included)}
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
      <p className="text-muted-foreground text-xs">{feeNote(fees)}</p>
    </div>
  );
}

// ── Loss size ────────────────────────────────────────────────────────────────────────────────────────────────────

const r = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`);
const share = (part: number, of: number) => (of >= MIN_SAMPLE ? ` (${Math.round((part / of) * 100)}% of ${of.toLocaleString("en-US")})` : ` of ${of.toLocaleString("en-US")}`);
const stopPct = Math.round(R25_SHARE * 100);
const smallWinPct = Math.round(SMALL_WIN_UNDER * 100);

/**
 * How big the losses are against the wins, over every position in view together: the losers sold past the −25% stop
 * and what that cost beyond it, the winners sold before twice that risk, and the average loser and winner in R25.
 * Never split by any label. A figure needs its own n of at least MIN_SAMPLE to be averaged or shared out.
 */
export function LossSizePanel({ positions, feesIncluded }: { positions: OwnerPosition[]; feesIncluded?: boolean }) {
  const x = exitStats(positions, MIN_SAMPLE);
  // The R25 figures rest on the fees taken off: an estimate unless the broker's results carry them.
  const after = (feesIncluded ?? (positions.length > 0 && positions.every((p) => p.flags.feesIncluded))) ? "after fees" : EST;
  const m = meanR25(positions);
  const n = (v: number) => v.toLocaleString("en-US");
  // The two averages together give back the overall mean, so they wait for the same sample as the mean does.
  const pairShown = m.mean !== null && x.avgLoserR25 !== null && x.avgWinnerR25 !== null;
  return (
    <Panel
      id="loss-size"
      title="Loss size"
      icon={Ruler}
      means={`How big your losses ran against your wins, over the option trades in view. R25 is a result in units of a quarter of the premium: −1R is the −${stopPct}% stop, ${after}.`}
    >
      {x.n === 0 ? (
        <Empty title="No option trades to measure in this view">
          {x.leftOut
            ? `${n(x.leftOut)} option trade${x.leftOut === 1 ? " was" : "s were"} left out: no cost, a gap in the broker's history, or contracts still open.`
            : "Pick a wider period, or calls or puts."}
        </Empty>
      ) : (
        <div className="grid gap-3">
          <StatTiles className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label={`Losers past the −${stopPct}% stop`}
              icon={TrendingDown}
              tone={x.pastStop > 0 ? "bad" : "neutral"}
              value={n(x.pastStop)}
              hint={`${n(x.pastStop)}${share(x.pastStop, x.losers)} losers were sold more than ${stopPct}% down, the whole trade taken together`}
            />
            <StatTile
              label={`A part held past −${stopPct}%`}
              icon={TrendingDown}
              tone={x.partPastStop > 0 ? "bad" : "neutral"}
              value={n(x.partPastStop)}
              hint={`${n(x.partPastStop)}${share(x.partPastStop, x.n)} trades had some contracts sold or left to expire more than ${stopPct}% under what they cost, whatever the whole trade made`}
            />
            <StatTile
              label={`Lost beyond the −${stopPct}% stop`}
              icon={Scale}
              tone={x.beyondStop > 0 ? "bad" : "neutral"}
              value={usd(-x.beyondStop)}
              hint={`Over ${n(x.losers)} losers: what each lost past ${stopPct}% of its cost, added up. A replay of the stop, not a forecast.`}
            />
            <StatTile
              label={`Winners closed under +${smallWinPct}% on premium`}
              icon={TrendingUp}
              tone="neutral"
              value={n(x.smallWins)}
              hint={`${n(x.smallWins)}${share(x.smallWins, x.winners)} winners: the whole trade sold up less than +${smallWinPct}% on its premium (not the rules' +${Math.round(RAN_TO_MARK * 100)}% mark)`}
            />
            <StatTile
              label="Average loser and winner"
              icon={Ruler}
              tone="neutral"
              value={pairShown ? `${r(x.avgLoserR25)} / ${r(x.avgWinnerR25)}` : "—"}
              hint={
                pairShown
                  ? `R25 ${after}, losers (n = ${n(x.losers)}) against winners (n = ${n(x.winners)})`
                  : `Losers n = ${n(x.losers)}, winners n = ${n(x.winners)}: too few to average (it needs ${MEAN_MIN_POSITIONS} trades over ${MEAN_MIN_SESSIONS} sessions, and ${MIN_SAMPLE} of each)`
              }
            />
          </StatTiles>
          <p className="text-sm">
            Your average trade:{" "}
            {m.mean === null ? (
              <span className="text-muted-foreground">
                n = {n(m.n)} over {n(m.sessions)} session{m.sessions === 1 ? "" : "s"}: too few to average (it needs {MEAN_MIN_POSITIONS} trades over {MEAN_MIN_SESSIONS} sessions).
              </span>
            ) : (
              <span>
                <span className={cn("font-mono font-semibold", m.mean > 0 ? "text-good" : m.mean < 0 ? "text-bad" : "")}>{r(m.mean)}</span> {after}, n = {n(m.n)} over {n(m.sessions)} sessions.
              </span>
            )}
          </p>
          <p className="text-muted-foreground text-xs">
            Counted on what the option was sold for against what it cost, so the fees, the same either way, do not change who passed the stop. A trade with no cost, one with a
            gap in the broker&apos;s history, or one with contracts still open is left out{x.leftOut ? ` (${n(x.leftOut)} here)` : ""}. Shares are not counted.
          </p>
        </div>
      )}
    </Panel>
  );
}

// ── Today ────────────────────────────────────────────────────────────────────────────────────────────────────────

const clock = (tz: string) => new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const nyClock = clock("America/New_York");
const sydClock = clock("Australia/Sydney");
const dayFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const dayLabel = (ymd: string) => dayFmt.format(new Date(`${ymd}T12:00:00Z`)).replace(",", "");
const price = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const MARKET_WORDS: Record<MarketState, string> = { open: "Market open", pre: "Before the open", after: "After the close", closed: "Market closed" };

/** How fresh the journal is, in one line: a live dot while the market is open and the last check is recent. */
function SyncLine({ asOf, market, ago }: { asOf: string; market: MarketState; ago: number | null }) {
  const at = new Date(asOf);
  const live = market === "open" && ago !== null && ago <= 10;
  const late = market === "open" && (ago === null || ago > 10);
  const agoText = ago === null ? "" : ago < 1 ? "just now" : ago < 90 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" role="status">
      <span className={cn("inline-flex items-center gap-1.5 font-medium", live ? "text-good" : late ? "text-warn" : "text-muted-foreground")}>
        <span className="relative flex size-2" aria-hidden>
          {live ? <span className="bg-good-fill absolute inline-flex size-full animate-ping rounded-full opacity-60" /> : null}
          <span className={cn("relative inline-flex size-2 rounded-full", live ? "bg-good-fill" : late ? "bg-warn-fill" : "bg-muted-foreground/50")} />
        </span>
        {live ? "Live" : MARKET_WORDS[market]}
      </span>
      <span className="text-muted-foreground">
        Checked with the broker {agoText} ({nyClock.format(at)} New York, {sydClock.format(at)} Sydney).
        {late ? " New trades may not be in yet." : ""}
      </span>
    </p>
  );
}

/**
 * The session's closed trades as the rules count them: an option bought and sold in several fills is one trade, after
 * fees, with its pieces one click away. The day's result before fees, which the day's loss limit reads, sits beside.
 */
export function TodayPanel({ view, asOf, now, market, feesIncluded }: { view: SessionView; asOf: string; now: Date; market: MarketState; feesIncluded?: boolean | null }) {
  const units = tradeUnits(view.trades, { basis: "net", feesIncluded }).sort((a, b) => Date.parse(b.unit.closed_at) - Date.parse(a.unit.closed_at) || a.unit.id.localeCompare(b.unit.id));
  // The day's result books each piece to this day, after its own fees: the same figure as this day on the calendar.
  const s = summarize(
    units.map((u) => u.unit),
    netPieces(view.trades, feesIncluded),
  );
  const grossNet = view.summary.net;
  // The count the day's rules use: trades opened this session. One opened on an earlier day and closed in this one is
  // listed, and named apart.
  // The tile counts those, and its won and lost count the same ones, so the value and the hint agree; the day result
  // beside it still adds up every trade closed today.
  const openedUnits = units.filter((u) => nyTime(u.unit.opened_at).day === view.day);
  const opened = openedUnits.length;
  const os = summarize(openedUnits.map((u) => u.unit));
  const carried = units.length - opened;
  const rows = new Map(toRows(units).map((r) => [r.id, r]));
  const ago = Number.isFinite(Date.parse(asOf)) ? Math.max(0, Math.floor((now.getTime() - Date.parse(asOf)) / 60_000)) : null;
  const reach = Math.max(1, ...units.map((u) => Math.abs(u.unit.pnl)));
  const shown = units.slice(0, 12);
  const label = dayLabel(view.day);
  const included = feesIncluded === true;
  return (
    <Panel
      id="today"
      title={view.isToday ? `Today · ${label}` : `Last session · ${label}`}
      icon={Activity}
      means="This New York trading day as it happens: each trade appears within about two minutes of closing while the market is open, and this page refreshes itself every minute."
    >
      <div className="grid gap-4">
        <SyncLine asOf={asOf} market={market} ago={ago} />
        <StatTiles className="lg:grid-cols-4">
          <StatTile
            label={feeLabel("Day result", included)}
            icon={Wallet}
            tone={toneOf(s.trades ? s.net : null)}
            value={s.trades ? usd(s.net) : "—"}
            hint={feeHint(s.trades ? (included ? "Closed trades" : `Closed trades · before fees ${usd(grossNet)}`) : "Closed trades", included)}
          />
          <StatTile
            label="Closed trades"
            icon={ListOrdered}
            value={opened.toLocaleString("en-US")}
            hint={
              s.trades
                ? `${opened ? `Opened this session: ${os.wins} won · ${os.losses} lost${os.winRate === null ? "" : ` · ${pct(os.winRate)}`}` : "None opened this session"}${carried ? ` · ${carried} more opened on an earlier day, not counted here` : ""}`
                : view.isToday
                  ? "None closed yet today"
                  : undefined
            }
          />
          <StatTile label="Best and worst" icon={Target} tone={toneOf(s.best?.pnl ?? null)} value={s.best ? usd(s.best.pnl) : "—"} hint={s.worst && s.worst !== s.best ? `${s.worst.pnl < 0 ? "Worst" : "Smallest"} ${usd(s.worst.pnl)}` : undefined} />
          <StatTile
            label="Open now"
            icon={Hourglass}
            tone={view.open.length ? "warn" : "neutral"}
            value={view.open.length.toLocaleString("en-US")}
            hint={view.open.length ? view.open.slice(0, 2).map((l) => `${l.qty.toLocaleString("en-US")} × ${contractLabel(l)}`).join(" · ") + (view.open.length > 2 ? " …" : "") : "Nothing held"}
          />
        </StatTiles>
        {shown.length ? (
          <ul className="grid" aria-label="Trades closed this session, newest first">
            {shown.map(({ unit: t }) => {
              const row = rows.get(t.id)!;
              return (
                <li key={t.id} className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3 py-1.5 text-[0.8125rem] not-last:border-b max-sm:text-sm">
                  <span className="text-muted-foreground font-mono text-xs max-sm:text-[0.8125rem]">{nyClock.format(new Date(t.closed_at))}</span>
                  <div className="grid min-w-0 leading-tight">
                    <span className="truncate font-medium">{contractLabel(t)}</span>
                    <span className="text-muted-foreground truncate text-xs max-sm:whitespace-normal max-sm:text-[0.8125rem]">
                      {t.qty.toLocaleString("en-US")} × {price(t.entry)} → {price(t.exit)} · {t.close === "expired" ? "held to expiry" : `held ${fmtMinutes(holdMinutes(t))}`}
                      {row.fees !== null && row.fees > 0 ? ` · ${usd(row.gross, 0)} before fees` : ""}
                    </span>
                    {row.pieces.length ? (
                      <details className="text-muted-foreground mt-0.5 text-xs">
                        <summary className="hover:text-foreground cursor-pointer max-sm:text-sm">{row.pieces.length} pieces</summary>
                        <ul className="mt-1 grid gap-0.5">
                          {row.pieces.map((p) => (
                            <li key={p.id} className="font-mono text-[0.6875rem] max-sm:text-xs">
                              {p.text}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                  <span className="grid justify-items-end gap-1">
                    <span className={cn("font-mono font-semibold whitespace-nowrap", t.pnl > 0 ? "text-good" : t.pnl < 0 ? "text-bad" : "text-muted-foreground")}>{usd(t.pnl, 0)}</span>
                    <span className="bg-muted h-1 w-16 overflow-hidden rounded-full" aria-hidden>
                      <span className={cn("block h-full rounded-full", t.pnl >= 0 ? "bg-good-fill" : "bg-bad-fill")} style={{ width: `${Math.max(4, (Math.abs(t.pnl) / reach) * 100)}%` }} />
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No trades closed yet {view.isToday ? "today" : "this session"}.</p>
        )}
        {units.length > shown.length ? (
          <p className="text-muted-foreground text-xs">
            {units.length - shown.length} more in <a href="#trades" className="underline underline-offset-2">every trade</a>, in the record below.
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          Times are New York. {included ? "" : `Option results are after estimated fees (today's rates, ${feeRate}); the day's loss limit reads the result before fees. `}The broker is read every two minutes from 9:24 to 16:20 New York on weekdays, and once more after the close.
        </p>
      </div>
    </Panel>
  );
}

// ── Money in and out ─────────────────────────────────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOL: Record<string, string> = { AUD: "A$", USD: "US$" };

export function MoneyPanel({ m }: { m: MoneyView }) {
  const sym = CURRENCY_SYMBOL[m.currency] ?? `${m.currency} `;
  const amt = (v: number | null, signed = false) => {
    if (v === null || !Number.isFinite(v)) return "—";
    const s = `${sym}${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    return signed ? `${v > 0 ? "+\u2060" : v < 0 ? "−\u2060" : ""}${s}` : v < 0 ? `−\u2060${s}` : s;
  };
  const shown = m.transfers.slice(0, 8);
  return (
    <Panel id="money" title="Money in and out" icon={Landmark} means={`What you have put into the account and taken out, against what it is worth now. In ${m.currency === "AUD" ? "Australian dollars" : m.currency}, the account's own currency.`}>
      <div className="grid gap-4">
        {!m.complete ? (
          <p className="text-warn text-xs" role="status">
            Deposits and withdrawals before the dashboard started recording are not in yet. They are added once your Webull transfer history is loaded; until then the totals below cover only what has been recorded.
          </p>
        ) : null}
        <StatTiles className="lg:grid-cols-4">
          <StatTile label="Put in" icon={ArrowDownToLine} value={amt(m.deposits)} hint={`${m.depositCount} deposit${m.depositCount === 1 ? "" : "s"}`} />
          <StatTile label="Taken out" icon={ArrowUpFromLine} value={amt(m.withdrawals)} hint={`${m.withdrawalCount} withdrawal${m.withdrawalCount === 1 ? "" : "s"}`} />
          <StatTile label="Worth now" icon={Wallet} value={amt(m.value)} hint={m.netIn > 0 ? `Against ${amt(m.netIn)} put in, less taken out` : undefined} />
          <StatTile
            label="Up or down on it"
            icon={Scale}
            tone={toneOf(m.gain)}
            value={amt(m.gain, true)}
            hint={m.gainPct === null ? "Needs the full transfer history" : `${m.gainPct >= 0 ? "+" : "−"}${Math.abs(Math.round(m.gainPct * 100))}% of the money put in, the broker's own figure`}
          />
        </StatTiles>
        {m.series.length >= 2 ? <MoneyChart points={m.series} symbol={sym} /> : null}
        {shown.length ? (
          <ul className="grid" aria-label="Deposits and withdrawals, newest first">
            {shown.map((t, i) => (
              <li key={`${t.date}-${i}`} className="flex items-center justify-between gap-3 py-1.5 text-[0.8125rem] not-last:border-b">
                <span className="grid min-w-0 leading-tight">
                  <span className="font-medium">{t.amount >= 0 ? "Deposit" : "Withdrawal"}</span>
                  <span className="text-muted-foreground text-xs">
                    {shortDay(t.date)} · {t.source === "statement" ? "from your Webull records" : "found from the account value"}
                  </span>
                </span>
                <span className={cn("shrink-0 font-mono font-semibold whitespace-nowrap", t.amount >= 0 ? "text-good" : "text-bad")}>{amt(t.amount, true)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No deposits or withdrawals recorded yet.</p>
        )}
        <p className="text-muted-foreground text-xs">
          The account value is read from Webull after every close. A change in it that your trades do not explain is logged as a deposit or withdrawal.
          {m.tradingLocal !== null ? ` Your closed trades come to about ${amt(m.tradingLocal, true)} at today's exchange rate, before fees.` : ""}
        </p>
      </div>
    </Panel>
  );
}

// ── Curve and months ─────────────────────────────────────────────────────────────────────────────────────────────

export function CurvePanel({ days, feesIncluded }: { days: DayRow[]; feesIncluded: boolean }) {
  return (
    <Panel
      id="curve"
      title="Running total"
      icon={ChartLine}
      means={`Every closed trade added up, day by day. The shaded band above the line is how far the total stood below its best so far. ${feeWords(feesIncluded)}`}
    >
      <PnlCurve points={days.map((d) => ({ day: d.day, pnl: d.pnl, cum: d.cum, dd: d.dd, trades: d.trades }))} />
    </Panel>
  );
}

export function MonthsPanel({ trades, feesIncluded }: { trades: Trade[]; feesIncluded: boolean }) {
  const months = groupBy(trades, MONTH)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((g) => ({ month: g.key, pnl: g.pnl, trades: g.trades, winRate: g.winRate }));
  return (
    <Panel id="months" title="Month by month" icon={ChartColumn} means={`What each month made or lost. Months with no trades are left out. ${feeWords(feesIncluded)}`}>
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

export function CalendarPanel({ days, feesIncluded }: { days: DayRow[]; feesIncluded: boolean }) {
  const months = calendar(days, 6);
  const reach = Math.max(1, ...days.slice(-130).map((d) => Math.abs(d.pnl)));
  return (
    <Panel id="calendar" title="Trading calendar" icon={CalendarDays} means={`The latest months with trades, Monday to Friday. Green made money that day, red lost it; the stronger the colour, the bigger the day. ${feeWords(feesIncluded)}`}
    >
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {months.map((m, i) => (
          // A phone shows the latest three months; the rest would be a long scroll.
          <div key={m.month} className={cn("gap-1.5", i >= 3 ? "hidden sm:grid" : "grid")}>
            <p className="flex items-baseline justify-between text-sm">
              <span className="font-medium">{new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</span>
              <span className={cn("font-mono text-xs", m.pnl > 0 ? "text-good" : m.pnl < 0 ? "text-bad" : "text-muted-foreground")}>{usd(m.pnl)}</span>
            </p>
            <div className="text-muted-foreground grid grid-cols-5 gap-1 text-center text-[0.625rem] max-sm:text-xs">
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
                      className={cn("relative flex h-8 items-end justify-end rounded-[3px] px-1 pb-0.5 text-[0.5625rem] max-sm:text-xs", heat(c.pnl, reach), c.pnl !== null && Math.abs(c.pnl) / reach > 0.66 ? "text-white" : "text-muted-foreground")}
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

export function LessonsPanel({ lessons, feesIncluded }: { lessons: Lesson[]; feesIncluded: boolean }) {
  return (
    <Panel id="lessons" title="What the record says" icon={Lightbulb} means={`Patterns measured from these trades, each comparing like with like. They describe what happened; they do not predict anything. ${WHOLE_POSITION} ${feeWords(feesIncluded)}`}
    >
      {lessons.length === 0 ? (
        <Empty title="Not enough trades in this view">Pick a wider period to see patterns.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {lessons.map((l) => (
            <div key={l.id} className={cn("bg-card relative grid content-start gap-2 overflow-hidden rounded-lg border py-3 pr-3.5 pl-4", "before:absolute before:inset-y-0 before:left-0 before:w-1", LESSON_EDGE[l.tone])}>
              <p className={cn("text-[0.6875rem] font-medium tracking-wide uppercase max-sm:text-xs", LESSON_TAG_TONE[l.tone])}>{LESSON_TAG[l.tone]}</p>
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
                <span className="text-muted-foreground shrink-0 font-mono text-[0.6875rem] max-sm:text-xs">
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

export function BreakdownPanel({ trades, feesIncluded }: { trades: Trade[]; feesIncluded: boolean }) {
  const bySymbol = groupBy(trades, (t) => t.symbol);
  const worst = bySymbol.slice(0, 6);
  const best = bySymbol.slice(-6).reverse().filter((r) => !worst.some((w) => w.key === r.key));
  const symbols = [...best, ...worst.reverse()].sort((a, b) => b.pnl - a.pnl);
  return (
    <Panel id="breakdown" title="Where it was made and lost" icon={Layers} means={`The same trades cut six ways. Each bar is the dollars made or lost; the small numbers are how many trades and the share that won. ${WHOLE_POSITION} ${feeWords(feesIncluded)}`}
    >
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

/** One row per trade, after fees: a position for options (its pieces under it), the piece itself for shares. */
export function toRows(units: readonly TradeUnit[]): JournalRow[] {
  return units.map(({ unit: t, pieces, position: p }) => ({
    id: t.id,
    when: whenText(Date.parse(t.closed_at)),
    at: Date.parse(t.closed_at),
    symbol: t.symbol,
    what: contractLabel(t),
    kind: t.kind,
    qty: t.qty,
    entry: t.entry,
    exit: t.exit,
    pnl: t.pnl,
    gross: p ? p.gross : t.pnl,
    fees: p ? p.fees : null,
    optionPct: p ? p.optionPct : null,
    r25: p ? p.r25 : null,
    r50: p ? p.r50 : null,
    held: t.close === "expired" ? "to expiry" : fmtMinutes(holdMinutes(t)),
    holdMin: holdMinutes(t),
    expired: t.close === "expired",
    pieces:
      pieces.length > 1
        ? pieces.map((x) => {
            const n: Piece = { qty: x.qty, entry: x.entry, exit: x.exit, closedAt: x.close === "expired" ? null : Date.parse(x.closed_at), pnl: x.pnl };
            return { id: x.id, text: pieceText(n), n };
          })
        : [],
  }));
}

export function TradesPanel({ units, feesIncluded }: { units: TradeUnit[]; feesIncluded: boolean }) {
  return (
    <Panel
      id="trades"
      title="Every trade"
      icon={ListOrdered}
      means={`Each closed trade. An option bought and sold in several fills is one trade; open it to see the pieces the broker's fills were matched into, first in, first out. Buying it again after selling it all is a new trade. ${feesIncluded ? "Results already carry Webull's fees." : `Results are after estimated fees on options (today's rates, ${feeRate}, for every year); shares are before fees.`}`}
    >
      {/* Every row of the view, for the search and the sort, packed short; a trade's pieces are written out when opened. */}
      <JournalTable rows={toRows(units).map(packRow)} feesIncluded={feesIncluded} />
    </Panel>
  );
}

export function DayList({ days, feesIncluded }: { days: DayRow[]; feesIncluded: boolean }) {
  const sorted = [...days].sort((a, b) => a.pnl - b.pnl);
  const worst = sorted.slice(0, 5);
  const best = sorted.slice(-5).reverse();
  const row = (d: DayRow) => (
    <li key={d.day} className="flex items-center justify-between gap-3 py-1 text-[0.8125rem] not-last:border-b">
      <span className="grid min-w-0 leading-tight">
        <span className="font-medium whitespace-nowrap">{shortDay(d.day)}</span>
        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {d.trades} trade{d.trades === 1 ? "" : "s"}
        </span>
      </span>
      <span className={cn("shrink-0 font-mono text-[0.8125rem] font-semibold whitespace-nowrap", d.pnl > 0 ? "text-good" : "text-bad")}>{usd(d.pnl, 0)}</span>
    </li>
  );
  return (
    <Panel id="days" title="Best and worst days" icon={Clock} means={`The five biggest days each way; the calendar under History shows when they fell. ${feeWords(feesIncluded)}`}>
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        <div className="grid content-start gap-1">
          <p className="text-good text-xs font-medium">Best</p>
          <ul className="grid">{best.filter((d) => d.pnl > 0).map(row)}</ul>
        </div>
        <div className="grid content-start gap-1">
          <p className="text-bad text-xs font-medium">Worst</p>
          <ul className="grid">{worst.filter((d) => d.pnl < 0).map(row)}</ul>
        </div>
      </div>
    </Panel>
  );
}

