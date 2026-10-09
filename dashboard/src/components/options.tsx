import { CalendarClock, ClipboardList, FlaskConical, Inbox, Info, Layers, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fracPct, num, rMult, shortDate, signed, sydney } from "@/lib/format";
import {
  CHIP_LABEL,
  chipTone,
  editionState,
  ladder,
  levelName,
  moveBands,
  nearest,
  RULE_STATUS_LABEL,
  ruleLabel,
  ruleTone,
  type Options,
  type OptionsTicker,
  type Rung,
} from "@/lib/options";
import type { OptionsResult } from "@/lib/snapshot";
import { cn } from "@/lib/utils";

/** How many zones each side of the close the ladder shows before "all levels". */
const LADDER_DEPTH = 3;

export function NoOptions({ status, date }: { status: Exclude<OptionsResult["status"], "ok">; date?: string }) {
  if (status === "error") {
    return <Empty title="Storage could not be read">The dashboard could not read the options levels. Reload in a minute.</Empty>;
  }
  return date ? (
    <Empty icon={Inbox} title={`No options levels for ${shortDate(date)}`}>
      <Link href="/options" className="underline">
        Show the newest edition
      </Link>
    </Empty>
  ) : (
    <Empty icon={Inbox} title="The options levels have not published yet">
      The after-close run publishes here each weekday, with the levels for the next session.
    </Empty>
  );
}

/** "Mon 12 Oct" from YYYY-MM-DD, without timezone drift. */
function sessionDay(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(
    new Date(Date.UTC(y!, m! - 1, d!)),
  );
}

export function EditionPanel({ e, now }: { e: Options; now: Date }) {
  const state = editionState(e.session, now);
  const stale = state === "stale";
  return (
    <Panel
      title={`Levels for ${sessionDay(e.session)}`}
      means={`Built from the ${sessionDay(e.built_from)} close. Source: ${e.source ?? "not stated"}. Published ${sydney(e.as_of)} Sydney.`}
      icon={CalendarClock}
      action={
        <Badge variant={stale ? "bad" : state === "today" ? "good" : "info"}>
          {stale ? "Out of date" : state === "today" ? "Today's session" : "Next session"}
        </Badge>
      }
    >
      {stale ? (
        <p role="alert" className="text-bad flex items-start gap-2 text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          These levels were for {sessionDay(e.session)}. A later session has started and no newer edition has published, so do not
          trade from them.
        </p>
      ) : (
        <p className="text-muted-foreground max-w-prose text-sm">
          Support and resistance roll forward after every close: yesterday, last week, last month, the 52-week range, the 20, 50
          and 200-day averages and supply and demand bases. Levels within half a percent merge into one zone; the more timeframes
          agree, the heavier the zone.
        </p>
      )}
    </Panel>
  );
}

function Chip({ chip }: { chip: string | null | undefined }) {
  if (!chip) return null;
  return <Badge variant={chipTone(chip)}>{CHIP_LABEL[chip] ?? chip}</Badge>;
}

function Distance({ r }: { r: Rung | null }) {
  if (!r) return <span className="text-muted-foreground">none</span>;
  return (
    <span className="grid justify-items-end">
      <span>{num(r.edge, 2)}</span>
      <span className="text-muted-foreground text-[0.6875rem]">{signed(r.distPct, 1)}%</span>
      {r.distAtr !== null ? <span className="text-muted-foreground text-[0.6875rem]">{num(r.distAtr, 1)} ATR</span> : null}
    </span>
  );
}

export function BoardPanel({ e }: { e: Options }) {
  return (
    <Panel
      title="Board"
      means="Every name at a glance: how it closed, how far the options market expects it to move, and the nearest zone each way."
      icon={Layers}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Ticker</TableHead>
            <TableHead className="text-right">Close</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Expected move, 1 day</TableHead>
            <TableHead className="hidden text-right md:table-cell">IV percentile, 52 wk</TableHead>
            <TableHead className="text-right">Support</TableHead>
            <TableHead className="text-right">Resistance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {e.tickers.map((t) => {
            const n = nearest(t);
            return (
              <TableRow key={t.symbol}>
                <TableCell className="align-top">
                  <a href={`#o-${t.symbol}`} className="font-mono font-semibold">
                    {t.symbol}
                  </a>
                  <div className="mt-1">
                    <Chip chip={t.close_strength?.chip} />
                  </div>
                </TableCell>
                <TableCell className="text-right align-top font-mono">
                  <span className="grid justify-items-end">
                    <span>{num(t.last?.close, 2)}</span>
                    {t.expected_move?.day != null ? (
                      <span className="text-muted-foreground text-[0.6875rem] sm:hidden">±{num(t.expected_move.day, 2)}/day</span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right align-top font-mono sm:table-cell">
                  {t.expected_move?.day == null ? "—" : `±${num(t.expected_move.day, 2)}`}
                </TableCell>
                <TableCell className="hidden text-right align-top font-mono md:table-cell">{fracPct(t.expected_move?.iv_pct_52w, 0)}</TableCell>
                <TableCell className="text-right align-top font-mono">
                  <Distance r={n.support} />
                </TableCell>
                <TableCell className="text-right align-top font-mono">
                  <Distance r={n.resistance} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Panel>
  );
}

function RungRow({ r, side }: { r: Rung; side: "above" | "at" | "below" }) {
  const z = r.zone;
  const members = (z.members ?? []).map(levelName).join(", ");
  return (
    <li
      className={cn(
        "grid grid-cols-[1fr_auto] items-baseline gap-x-3 rounded-md border px-2.5 py-1.5",
        side === "above" ? "border-bad/25 bg-bad-soft/40" : side === "below" ? "border-good/25 bg-good-soft/40" : "bg-card",
        z.big ? "border-l-4" : "",
      )}
    >
      <span className="font-mono text-sm">
        {z.lo === z.hi ? num(z.lo, 2) : `${num(z.lo, 2)}–${num(z.hi, 2)}`}
        {z.big ? <span className="ml-2 font-sans text-xs font-medium">Major</span> : null}
      </span>
      <span className="text-muted-foreground text-right font-mono text-xs">
        {r.inside ? "price inside" : `${signed(r.distPct, 1)}%`}
        {r.distAtr !== null && !r.inside ? ` · ${num(r.distAtr, 1)} ATR` : ""}
      </span>
      <span className="text-muted-foreground col-span-2 text-xs">
        {(z.members ?? []).join(" + ")} <span className="sr-only">({members})</span>
        {z.weight != null ? ` · weight ${z.weight}` : ""}
      </span>
    </li>
  );
}

function CloseRow({ t }: { t: OptionsTicker }) {
  const b = moveBands(t);
  return (
    <li className="bg-muted grid gap-0.5 rounded-md px-2.5 py-2 text-sm">
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span>
          Close <span className="font-mono font-semibold">{num(t.last?.close, 2)}</span>
        </span>
        <Chip chip={t.close_strength?.chip} />
      </span>
      {b.day ? (
        <span className="text-muted-foreground font-mono text-xs">
          1 day: {num(b.day[0], 2)} to {num(b.day[1], 2)}
          {b.week ? ` · 1 week: ${num(b.week[0], 2)} to ${num(b.week[1], 2)}` : ""}
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">No implied volatility today, so no expected move.</span>
      )}
    </li>
  );
}

export function TickerCards({ e }: { e: Options }) {
  return (
    <section aria-label="Level ladders" className="grid gap-5 lg:grid-cols-2">
      {e.tickers.map((t) => {
        const { above, at, below } = ladder(t);
        const shownAbove = above.slice(0, LADDER_DEPTH).reverse();
        const shownBelow = below.slice(0, LADDER_DEPTH);
        const hidden = above.length + below.length - shownAbove.length - shownBelow.length;
        return (
          <Panel
            key={t.symbol}
            id={`o-${t.symbol}`}
            title={<span className="font-mono">{t.symbol}</span>}
            means={
              <span className="font-mono">
                H {num(t.last?.high, 2)} · L {num(t.last?.low, 2)} · ATR {num(t.atr14, 2)}
                {t.expected_move?.annual_iv != null ? ` · IV ${fracPct(t.expected_move.annual_iv, 1)}` : ""}
                {t.half_day ? " · half day" : ""}
              </span>
            }
          >
            <div className="grid gap-3">
              <ol aria-label={`${t.symbol} zones, highest first`} className="grid gap-1.5">
                {shownAbove.map((r, i) => (
                  <RungRow key={`a${i}`} r={r} side="above" />
                ))}
                <CloseRow t={t} />
                {at.map((r, i) => (
                  <RungRow key={`i${i}`} r={r} side="at" />
                ))}
                {shownBelow.map((r, i) => (
                  <RungRow key={`b${i}`} r={r} side="below" />
                ))}
              </ol>
              <details className="text-sm">
                <summary className="text-muted-foreground cursor-pointer text-xs">
                  All {(t.levels ?? []).length} levels{hidden > 0 ? ` (${hidden} more zones)` : ""}
                </summary>
                <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-3">
                  {[...(t.levels ?? [])]
                    .sort((a, b) => b.price - a.price)
                    .map((l) => (
                      <li key={l.name} title={levelName(l.name)} className="flex justify-between gap-2">
                        <span className="text-muted-foreground">{l.name}</span>
                        <span>{l.lo != null && l.hi != null ? `${num(l.lo, 2)}–${num(l.hi, 2)}` : num(l.price, 2)}</span>
                      </li>
                    ))}
                </ul>
              </details>
              {(t.problems ?? []).length > 0 ? (
                <p className="text-warn flex items-start gap-1.5 text-xs">
                  <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {(t.problems ?? []).join(" ")}
                </p>
              ) : null}
            </div>
          </Panel>
        );
      })}
    </section>
  );
}

export function RulesPanel({ e }: { e: Options }) {
  const rules = e.rules ?? [];
  if (rules.length === 0) return null;
  const proven = rules.some((r) => r.status === "proven");
  return (
    <Panel
      title="Entry rules"
      means={
        proven
          ? "Only proven rules have earned real use. The rest are tracked on paper."
          : "No rule is proven yet. Every one is tracked on paper until it passes the promotion test, so none of these is a signal to trade."
      }
      icon={FlaskConical}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rule</TableHead>
            <TableHead className="text-right">Backtest</TableHead>
            <TableHead className="text-right">Paper so far</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="min-w-40 align-top whitespace-normal">
                <p className="text-sm break-words">{r.label ?? r.id}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant={ruleTone(r.status)}>{RULE_STATUS_LABEL[r.status]}</Badge>
                  {r.side ? <Badge variant="outline">{r.side === "call" ? "Calls" : "Puts"}</Badge> : null}
                </div>
              </TableCell>
              <TableCell className="text-right align-top font-mono text-xs">
                {r.backtest ? (
                  <span className="grid justify-items-end">
                    <span className="text-sm">{rMult(r.backtest.avg_r)}</span>
                    <span className="text-muted-foreground hidden sm:inline">
                      {r.backtest.ci_lo != null && r.backtest.ci_hi != null
                        ? `${signed(r.backtest.ci_lo, 2)} to ${signed(r.backtest.ci_hi, 2)}`
                        : ""}
                    </span>
                    <span className="text-muted-foreground">n {num(r.backtest.n)}</span>
                  </span>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="text-right align-top font-mono text-xs">
                {r.live && (r.live.n ?? 0) > 0 ? (
                  <span className="grid justify-items-end">
                    <span className="text-sm">{rMult(r.live.avg_r)}</span>
                    <span className="text-muted-foreground">
                      {num(r.live.wins)} of {num(r.live.n)} won
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">no trades yet</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-muted-foreground mt-3 max-w-prose text-xs">
        R is the result in units of the risk taken: +1R made what the stop would have lost. Each backtest average shows its number of
        cases and, on wider screens, its 95% range. An average near 0R with a range that straddles zero means no edge after costs. Promotion needs 30 or more cases, a range above zero after costs, a result
        that holds in both halves of history and four weeks of live paper tracking.
      </p>
    </Panel>
  );
}

export function PaperPanel({ e }: { e: Options }) {
  const rows = e.paper ?? [];
  return (
    <Panel title="Paper scorecard" means="Each probation rule's triggers, replayed on hourly bars after the close. Paper only." icon={ClipboardList}>
      {rows.length === 0 ? (
        <Empty title="No paper trades yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Ticker</TableHead>
              <TableHead className="hidden sm:table-cell">Rule</TableHead>
              <TableHead className="text-right">Entry</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Stop</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Exit</TableHead>
              <TableHead className="text-right">Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p, i) => (
              <TableRow key={`${p.session}-${p.symbol}-${p.rule}-${i}`}>
                <TableCell className="font-mono text-xs">{shortDate(p.session)}</TableCell>
                <TableCell>
                  <span className="font-mono font-semibold">{p.symbol}</span>
                  {p.side ? <span className="text-muted-foreground ml-1.5 text-xs">{p.side}</span> : null}
                </TableCell>
                <TableCell className="hidden text-xs whitespace-normal sm:table-cell">{ruleLabel(e, p.rule)}</TableCell>
                <TableCell className="text-right font-mono">{num(p.entry, 2)}</TableCell>
                <TableCell className="hidden text-right font-mono sm:table-cell">{num(p.stop, 2)}</TableCell>
                <TableCell className="hidden text-right text-xs sm:table-cell">{p.exit ?? "—"}</TableCell>
                <TableCell
                  className={cn(
                    "text-right font-mono",
                    p.r == null ? "" : p.r > 0 ? "text-good" : p.r < 0 ? "text-bad" : "",
                  )}
                >
                  {rMult(p.r, 2)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

export function HowToRead({ e }: { e: Options }) {
  const check = e.expected_move_check;
  return (
    <Panel title="How to read this" means="What the testing behind this page found, so the levels are used for what they are good at." icon={Info}>
      <ul className="grid max-w-prose list-disc gap-2 pl-5 text-sm">
        <li>
          The levels are a map, not a signal. Over two years of daily bars on these ten names, price reached yesterday&apos;s high or
          low on 88.5% of days, which makes them good targets and stop references.
        </li>
        <li>
          A strong close (top quarter of the day&apos;s range) was followed by a higher high the next day 77.6% of the time, against
          52.9% on an ordinary day. That edge comes from the close, not from breaking a level.
        </li>
        {check ? (
          <li>
            The options market tends to overprice moves: {check.period ?? "in testing"}, price stayed inside the one-day expected move
            on {num(check.inside_1d_pct, 0)}% of days ({num(check.n)} days), against about 68% if it were fairly priced. Within a week
            it touched beyond the expected move {num(check.touch_5d_pct, 0)}% of the time. That favours spreads over buying single
            calls or puts.
          </li>
        ) : null}
        <li>Research only. Nothing here is an order, and no rule is a recommendation until it is marked proven.</li>
      </ul>
    </Panel>
  );
}
