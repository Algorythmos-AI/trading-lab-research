// The Risk page's account section: the owner's real trading measured against the limits in "Rules before every trade".
// Server-rendered; the only client piece is the day chart.
import { Activity, CircleCheck, Gauge, Hand, OctagonX, ShieldAlert, TrendingDown, TriangleAlert, Wallet } from "lucide-react";
import { DayLimitBars } from "@/components/charts/day-limit-bars";
import { Empty } from "@/components/empty";
import { Meter } from "@/components/meter";
import { Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import { StatusBadge, TONE_TEXT } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type AccountRisk, type HeldBy, type LimitRow } from "@/lib/account-risk";
import { newYork } from "@/lib/format";
import { shortDay, type MoneyView } from "@/lib/journal";
import type { Tone } from "@/lib/labels";
import { DAY_LOSS_LIMIT, MAX_PREMIUM, MAX_TRADES_PER_DAY } from "@/lib/trade-rules";
import { cn } from "@/lib/utils";

const money0 = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const plain = (v: number) => `$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const STATUS = {
  clear: { word: "Clear to trade", icon: CircleCheck, tone: "good", soft: "bg-good-soft border-good-fill/40" },
  careful: { word: "Careful", icon: TriangleAlert, tone: "warn", soft: "bg-warn-soft border-warn-fill/50" },
  stop: { word: "Stop for today", icon: OctagonX, tone: "bad", soft: "bg-bad-soft border-bad-fill/50" },
} as const;

const HELD: Record<HeldBy, { word: string; tone: Tone; means: string }> = {
  broker: { word: "Webull stop order", tone: "good", means: "Holds only if you place the stop order in Webull as soon as you are filled." },
  flagged: { word: "Flagged after", tone: "warn", means: "This page counts it once Webull reports the trade. It cannot stop the trade." },
  you: { word: "You, before the order", tone: "info", means: "Nobody else sees it before you press buy." },
};

const meterTone = (share: number | null): Tone => (share === null ? "neutral" : share >= 1 ? "bad" : share >= 0.6 ? "warn" : "good");

/** The one sentence every enforcement question gets. */
export function EnforcementNote({ className }: { className?: string }) {
  return (
    <p className={cn("text-muted-foreground flex items-start gap-2 text-xs leading-snug", className)}>
      <Hand aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>
        This site reads your Webull account and never places, blocks or cancels an order. The only limit that closes a trade for you is a stop order you set in Webull; every other limit is yours to keep, and this page
        shows when one was broken.
      </span>
    </p>
  );
}

/** Today: the status, the two day meters, and what is open now. */
export function AccountTodayPanel({ r, asOf, now }: { r: AccountRisk; asOf: string; now: Date }) {
  const c = r.check;
  const s = STATUS[c.status];
  const lossUsed = Math.max(0, -c.net);
  const o = r.open;
  const openTone: Tone = o.lots.length === 0 ? "good" : o.optionCost > MAX_PREMIUM || o.overnight > 0 || o.uncapped > 0 ? "warn" : "info";
  return (
    <Panel
      id="account-today"
      title="Your account today"
      icon={Gauge}
      means={`Your Webull trades against the day limits, read ${newYork(asOf)} New York time. Trades show here a few minutes after they fill during the session.`}
      action={<StatusBadge tone="info">Real money</StatusBadge>}
    >
      <div className="grid gap-5">
        <div className={cn("flex items-center gap-3 rounded-lg border px-3.5 py-3", s.soft)} role="status">
          <s.icon aria-hidden className={cn("size-7 shrink-0", TONE_TEXT[s.tone])} />
          <div className="grid min-w-0 leading-tight">
            <span className={cn("text-base font-semibold", TONE_TEXT[s.tone])}>{c.isToday ? s.word : "New day"}</span>
            <span className="text-muted-foreground text-sm">
              {c.line}
              {!c.isToday && r.day ? ` Last session traded: ${shortDay(r.day)}.` : ""}
            </span>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Meter
            label="Day loss limit (closed trades)"
            value={lossUsed}
            max={DAY_LOSS_LIMIT}
            tone={meterTone(lossUsed / DAY_LOSS_LIMIT)}
            valueText={`${c.isToday ? money0(c.net) : "$0"} of −$${DAY_LOSS_LIMIT}`}
          />
          <Meter
            label="Trades today"
            value={c.used}
            max={MAX_TRADES_PER_DAY}
            tone={meterTone(c.used / MAX_TRADES_PER_DAY)}
            valueText={`${c.used} of ${MAX_TRADES_PER_DAY}`}
          />
          <Meter
            label="Open options at cost"
            value={o.optionCost}
            max={MAX_PREMIUM}
            tone={o.lots.length === 0 ? "neutral" : meterTone(o.optionCost / MAX_PREMIUM)}
            valueText={o.lots.length === 0 ? "Flat" : `${plain(o.optionCost)} of $${MAX_PREMIUM}`}
          />
        </div>
        {o.lots.length > 0 ? (
          <div className="grid gap-1.5">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Wallet aria-hidden className="text-muted-foreground size-4" />
              Open now
              <StatusBadge tone={openTone}>{o.lots.length} open</StatusBadge>
            </p>
            <ul className="grid gap-1 text-sm">
              {o.lots.map((l) => (
                <li key={l.label} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-xs font-medium">{l.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {l.qty.toLocaleString("en-US")} at a cost of {plain(l.cost)}
                  </span>
                  {l.overPremium ? <StatusBadge tone="warn">Over ${MAX_PREMIUM}</StatusBadge> : null}
                  {l.overnight ? <StatusBadge tone="warn">Held overnight</StatusBadge> : null}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              The broker&apos;s history carries no live price, so open losses are not counted here; check them in Webull against the −${DAY_LOSS_LIMIT} day limit.
              {o.uncapped > 0 ? " Stock and short positions can lose more than they cost." : " A long option can lose at most what it cost."}
            </p>
          </div>
        ) : null}
        {c.isToday && now.getTime() - Date.parse(asOf) > 30 * 60_000 ? (
          <p className="text-warn text-xs">This reading is more than 30 minutes old: trades since {newYork(asOf, false)} New York time are not in it yet.</p>
        ) : null}
      </div>
    </Panel>
  );
}

function BrokenCell({ row }: { row: LimitRow }) {
  const tone: Tone = row.broken === 0 ? "good" : row.unit === "days" || row.broken >= 5 ? "bad" : "warn";
  return (
    <div className="grid gap-0.5">
      <StatusBadge tone={tone}>{row.broken === 0 ? "Kept" : `${row.broken} ${row.broken === 1 ? row.unit.slice(0, -1) : row.unit}`}</StatusBadge>
      {row.worst && row.broken > 0 ? <span className="text-muted-foreground text-xs">{row.worst}</span> : null}
    </div>
  );
}

/** Every limit, today's reading, how often it was broken lately, and who holds it. */
export function AccountLimitsPanel({ r }: { r: AccountRisk }) {
  const sessions = r.recent.length;
  return (
    <Panel
      id="account-limits"
      title="Your limits"
      icon={ShieldAlert}
      means={`The risk limits from "Rules before every trade", what today has used, and how often each was broken over your last ${sessions} trading day${sessions === 1 ? "" : "s"}.`}
    >
      <div className="grid gap-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Limit</TableHead>
              <TableHead className="hidden sm:table-cell">Set at</TableHead>
              <TableHead>Today</TableHead>
              <TableHead>Broken, last {sessions} days</TableHead>
              <TableHead className="hidden md:table-cell">Who holds it</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.limits.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium whitespace-normal">
                  <span className="text-muted-foreground mr-1.5 font-mono text-xs">{row.rule}</span>
                  {row.label}
                  <span className="text-muted-foreground block text-xs font-normal sm:hidden">{row.setAt}</span>
                  <span className={cn("block text-xs font-normal md:hidden", TONE_TEXT[HELD[row.heldBy].tone])}>{HELD[row.heldBy].word}</span>
                </TableCell>
                <TableCell className="hidden whitespace-normal sm:table-cell">{row.setAt}</TableCell>
                <TableCell>
                  {row.today === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className={cn(row.todayShare !== null && row.todayShare >= 1 ? "text-bad font-semibold" : "")}>{row.today}</span>
                  )}
                </TableCell>
                <TableCell>
                  <BrokenCell row={row} />
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <StatusBadge tone={HELD[row.heldBy].tone}>{HELD[row.heldBy].word}</StatusBadge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <dl className="grid gap-2 text-xs sm:grid-cols-3">
          {(Object.keys(HELD) as HeldBy[]).map((k) => (
            <div key={k} className="grid gap-1">
              <dt>
                <StatusBadge tone={HELD[k].tone}>{HELD[k].word}</StatusBadge>
              </dt>
              <dd className="text-muted-foreground leading-snug">{HELD[k].means}</dd>
            </div>
          ))}
        </dl>
        <EnforcementNote />
      </div>
    </Panel>
  );
}

/** The last trading days against the day loss limit, and how far the account is below its high. */
export function AccountRecentPanel({ r, money }: { r: AccountRisk; money: MoneyView | null }) {
  const d = r.drawdown;
  const over = r.recent.filter((x) => x.pnl <= -DAY_LOSS_LIMIT).length;
  const sum = r.recent.reduce((s, x) => s + x.pnl, 0);
  return (
    <Panel
      id="account-recent"
      title={`Last ${r.recent.length} trading days`}
      icon={Activity}
      means={`Each day's closed result against the −$${DAY_LOSS_LIMIT} day limit. A red bar is a day that went past it.`}
      action={<StatusBadge tone={over === 0 ? "good" : "bad"}>{over === 0 ? "No day past the limit" : `${over} day${over === 1 ? "" : "s"} past the limit`}</StatusBadge>}
    >
      {r.recent.length === 0 ? (
        <Empty title="No closed trades yet" />
      ) : (
        <div className="grid gap-5">
          <DayLimitBars days={r.recent.map(({ day, pnl, trades }) => ({ day, pnl, trades }))} limit={DAY_LOSS_LIMIT} cap={MAX_TRADES_PER_DAY} />
          <StatTiles>
            <StatTile label={`Last ${r.recent.length} days`} value={money0(sum)} tone={sum >= 0 ? "good" : "bad"} icon={Activity} hint="Closed trades, before fees" />
            <StatTile
              label="Below the high now"
              value={d.now === 0 ? "At the high" : money0(d.now)}
              tone={d.now === 0 ? "good" : "warn"}
              icon={TrendingDown}
              hint={d.peakDay ? `High of ${money0(d.peak)} on ${shortDay(d.peakDay)}` : "Running total of every closed trade"}
            />
            <StatTile label="Deepest fall" value={money0(d.max)} tone={d.max < 0 ? "bad" : "good"} icon={TrendingDown} hint={d.maxDay ? `Reached ${shortDay(d.maxDay)}` : undefined} />
            {money && money.value !== null ? (
              <StatTile
                label="Account worth"
                value={`${money.currency} ${money.value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
                tone={money.gain !== null && money.gain < 0 ? "warn" : "neutral"}
                icon={Wallet}
                hint={money.gain !== null ? `${money.gain < 0 ? "Down" : "Up"} ${money.currency} ${Math.abs(money.gain).toLocaleString("en-US", { maximumFractionDigits: 0 })} on the money put in` : undefined}
              />
            ) : null}
          </StatTiles>
          <p className="text-muted-foreground text-xs">
            Your {r.tradeCount.toLocaleString("en-US")} closed trades, matched first in, first out from Webull&apos;s history, in US dollars before fees. Days are New York trading days.
          </p>
        </div>
      )}
    </Panel>
  );
}
