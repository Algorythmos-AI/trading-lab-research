import { CalendarClock, ClipboardList, FlaskConical, Grid2x2, Inbox, Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { TradeBars } from "@/components/charts/trade-bars";
import { Empty } from "@/components/empty";
import { LiveCardChip } from "@/components/client/live-layer";
import { EvidenceBars, LevelMap, RuleRanges, StructureMap } from "@/components/options-charts";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fracPct, num, rMult, shortDate, signed, sydney } from "@/lib/format";
import {
  CHIP_LABEL,
  chipTone,
  CORNER_COST,
  editionState,
  findingsOf,
  ladder,
  levelName,
  moveBands,
  nearest,
  ONE_SIGMA_PCT,
  RULE_STATUS_LABEL,
  ruleLabel,
  ruleTone,
  structureView,
  type Corner,
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
        <details className="text-sm">
          <summary className="text-muted-foreground cursor-pointer text-xs">How the levels are built</summary>
          <p className="text-muted-foreground mt-2 max-w-prose">
            Support and resistance roll forward after every close: yesterday, last week, last month, the 52-week range, the 20, 50
            and 200-day averages and supply and demand bases. Levels within half a percent merge into one zone; the more
            timeframes agree, the heavier the zone.
          </p>
        </details>
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

/** The glance strip's numbers as a table: close, expected move, IV percentile and the nearest zone each way. */
export function BoardTable({ e }: { e: Options }) {
  return (
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
    <section aria-label="Level ladders" className="grid gap-5 lg:grid-cols-2 group-data-[focus=on]/focus:xl:grid-cols-3">
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
            action={<LiveCardChip t={{ ...t, bars: undefined }} />}
            means={
              <span className="font-mono">
                H {num(t.last?.high, 2)} · L {num(t.last?.low, 2)} · ATR {num(t.atr14, 2)}
                {t.expected_move?.annual_iv != null ? ` · IV ${fracPct(t.expected_move.annual_iv, 1)}` : ""}
                {t.half_day ? " · half day" : ""}
              </span>
            }
          >
            <div className="grid gap-3">
              <LevelMap t={t} />
              <details className="text-sm">
                <summary className="text-muted-foreground cursor-pointer text-xs">Nearest zones as a list</summary>
              <ol aria-label={`${t.symbol} zones, highest first`} className="mt-2 grid gap-1.5">
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
              </details>
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
      <RuleRanges rules={rules} />
      <ul className="text-muted-foreground mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Key">
        <li className="flex items-center gap-1.5">
          <span className="bg-neutral-fill inline-block h-1.5 w-4 rounded-full" />
          backtest 95% range (grey when it crosses zero: no edge)
        </li>
        <li className="flex items-center gap-1.5">
          <span className="border-info-fill inline-block size-2.5 rounded-full border-2" />
          live paper so far
        </li>
        <li>Promotion needs 30 paper cases, a range above zero after costs, both halves of history and 4 weeks live.</li>
      </ul>
      <details className="mt-3 text-sm">
        <summary className="text-muted-foreground cursor-pointer text-xs">Show the numbers as a table</summary>
      <Table className="mt-2">
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
      <p className="text-muted-foreground mt-2 max-w-prose text-xs">
        R is the result in units of the risk taken: +1R made what the stop would have lost. It is measured on the stock&apos;s
        price, not on an option&apos;s, with no trading costs taken off.
      </p>
      </details>
    </Panel>
  );
}

export function PaperPanel({ e }: { e: Options }) {
  const rows = e.paper ?? [];
  return (
    <Panel
      title="Paper scorecard"
      means="Each probation rule's triggers, replayed on hourly bars after the close. Paper only. R is measured on the stock, with no option prices or costs."
      icon={ClipboardList}
    >
      {rows.length === 0 ? (
        <Empty title="No paper trades yet" />
      ) : (
        <div className="grid gap-3">
          <TradeBars
            trades={rows.map((p, i) => ({
              i: i + 1,
              r: p.r ?? 0,
              what: `${p.symbol} ${p.side ?? ""} · ${ruleLabel(e, p.rule)}`,
              when: shortDate(p.session),
            }))}
            whenLabel="Session"
            label="Each paper trade's result in R, in the order logged"
          />
          <p className="text-muted-foreground font-mono text-xs">
            {rows.length} trades · total {rMult(rows.reduce((a, p) => a + (p.r ?? 0), 0), 2)} · {rows.filter((p) => (p.r ?? 0) > 0).length} won
          </p>
          <details className="text-sm">
            <summary className="text-muted-foreground cursor-pointer text-xs">Show every trade</summary>
        <Table className="mt-2">
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
          </details>
        </div>
      )}
    </Panel>
  );
}

const CORNERS: { key: Corner; title: string; tone: string }[] = [
  { key: "strong-cheap", title: "Strong close, cheap options", tone: "border-info/40" },
  { key: "strong-rich", title: "Strong close, rich options", tone: "border-warn/40" },
  { key: "weak-cheap", title: "Weak close, cheap options", tone: "border-info/40" },
  { key: "weak-rich", title: "Weak close, rich options", tone: "border-warn/40" },
];

/**
 * Close strength against option price: the two leads from early testing, on one picture. The corners name which
 * names sit where and what a single call or put costs there against its own year. A location, never a trade.
 */
export function StructurePanel({ e }: { e: Options }) {
  const view = structureView(e.tickers);
  if (view.points.length === 0) return null;
  return (
    <Panel
      title="Close strength vs option price"
      means="Up is a stronger close; right is pricier options. A corner says where a name sits, never what to trade."
      icon={Grid2x2}
    >
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <StructureMap view={view} />
        <div className="grid gap-3">
          <ul className="grid grid-cols-2 gap-2" aria-label="Names in each corner">
            {CORNERS.map((c) => (
              <li key={c.key} className={cn("rounded-md border p-2", c.tone)}>
                <span className="block text-xs font-medium">{c.title}</span>
                <span className="text-muted-foreground block text-[0.6875rem]">{CORNER_COST[c.key]}</span>
                <span className="mt-1 block font-mono text-sm font-semibold">
                  {view.corners[c.key].length > 0 ? view.corners[c.key].join(" · ") : <span className="text-muted-foreground font-normal">none</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            A location, not a trade. Corners are the top or bottom quarter of the day&apos;s range with the IV percentile at or
            under 25% or at or over 60%.
          </p>
          {view.missing.length > 0 ? (
            <p className="text-muted-foreground text-xs">No IV percentile or close position in this edition for {view.missing.join(", ")}.</p>
          ) : null}
          <details className="text-sm">
            <summary className="text-muted-foreground cursor-pointer text-xs">Why these two axes</summary>
            <ul className="text-muted-foreground mt-2 grid list-disc gap-1 pl-4 text-xs">
              <li>
                Exploratory, with no registered experiment behind it yet: a close in the top quarter of the day&apos;s range was
                followed by a higher high the next day 77.6% of the time, against 52.9% on an ordinary day (2 years, 10 names).
              </li>
              {e.expected_move_check?.inside_1d_pct != null ? (
                <li>
                  Also exploratory: price stayed inside the 1-day expected move on {Math.round(e.expected_move_check.inside_1d_pct)}%
                  of days, against {ONE_SIGMA_PCT}% if the implied vol were exactly right. A long call or put pays for the move
                  that is priced in, and pays more when options are rich.
                </li>
              ) : null}
            </ul>
          </details>
        </div>
      </div>
    </Panel>
  );
}

export function HowToRead({ e }: { e: Options }) {
  const findings = findingsOf(e);
  return (
    <Panel title="What the testing found" means="So the levels are used for what they are good at." icon={Info}>
      <EvidenceBars findings={findings} />
      {findings.some((f) => f.exploratory) ? (
        <p className="text-muted-foreground mt-3 max-w-prose text-xs">
          Exploratory means no registered experiment stands behind the number yet. The first two are fixed figures from early
          testing; the expected-move check is recomputed by the after-close run. Treat them as leads to test, not as results.
        </p>
      ) : null}
      <details className="mt-4 text-sm">
        <summary className="text-muted-foreground cursor-pointer text-xs">What the live states mean</summary>
        <p className="text-muted-foreground mt-2 max-w-prose">
          Judged at each quote&apos;s own time: NO TRADE for the first 15 minutes; GAP ABOVE or GAP BELOW when the session opened
          beyond yesterday&apos;s high or low and is still beyond it; TESTING SUPPORT or TESTING RESISTANCE within a quarter ATR of a
          major zone; otherwise ABOVE PDH, BELOW PDL or INSIDE. A state is a location, not a signal.
        </p>
      </details>
      <p className="text-muted-foreground mt-3 text-xs">Research only. Nothing here is an order, and no rule is a recommendation until it is marked proven.</p>
    </Panel>
  );
}
