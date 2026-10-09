import { ArrowDownRight, ArrowUpRight, BarChart3, Briefcase, FlaskConical, LineChart, ListChecks, Minus, ReceiptText, Signal, Trophy } from "lucide-react";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { code, codes, moneyOf, type Crypto } from "@/lib/crypto";
import { fracPct, num, rMult, signed, zoned } from "@/lib/format";
import { challengersLine, sleeveLabel, tournamentLine, type ChallengerRow, type Challengers, type Tournament, deskTotals, equityLines, tradeStats } from "@/lib/tournament";
import { cn } from "@/lib/utils";
import { DivergingBars } from "@/components/charts/diverging-bars";
import { Forest } from "@/components/charts/forest";
import { LinesChart } from "@/components/charts/lines-chart";
import { TradeBars } from "@/components/charts/trade-bars";
import { StatTile, StatTiles } from "@/components/stat-tile";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const toneOf = (v: number | null | undefined) => (!isNum(v) || Math.abs(v) < 0.005 ? "text-foreground" : v > 0 ? "text-good" : "text-bad");
const utc = (iso: string | null | undefined) => (iso ? zoned(iso, "UTC") : "—");
const ny = (iso: string | null | undefined) => (iso ? zoned(iso, "America/New_York") : "—");

function Direction({ v }: { v: number | null | undefined }) {
  const Icon = !isNum(v) || Math.abs(v) < 0.005 ? Minus : v > 0 ? ArrowUpRight : ArrowDownRight;
  return <Icon aria-hidden className={cn("inline size-3.5 shrink-0", toneOf(v))} />;
}

/** A price in the pair's own scale: 85,486.5 and 0.6213 both read correctly. */
function px(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  const digits = v >= 1000 ? 1 : v >= 10 ? 3 : v >= 1 ? 4 : 5;
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function Money({ v, m, strong = false }: { v: number | null | undefined; m: (v: number | null | undefined) => string; strong?: boolean }) {
  if (!isNum(v)) return <span className="text-muted-foreground">—</span>;
  const body = m(Math.abs(v));
  return (
    <span className={cn("font-mono tabular-nums", toneOf(v), strong && "font-semibold")}>
      {Math.abs(v) < 0.005 ? body : `${v > 0 ? "+" : "−"}${body}`}
    </span>
  );
}

export function TournamentBoard({ s, t }: { s: Crypto; t: Tournament }) {
  const m = moneyOf(s);
  const rows = [...t.rows].sort((a, b) => (b.returnPct ?? 0) - (a.returnPct ?? 0));
  return (
    <Panel
      title="Tournament"
      icon={Trophy}
      means="The strategies trading on paper side by side, each on its own US$10,000 paper book, best return first: the three registered rules, and any challenger that passed its backtest. All of it is incubation: these results are not evidence of an edge. Paper money only."
      action={<span className="text-muted-foreground text-xs">{tournamentLine(t)}</span>}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sleeve</TableHead>
            <TableHead className="text-right">Book value</TableHead>
            <TableHead className="text-right">Return</TableHead>
            <TableHead className="text-right">Open P&amp;L</TableHead>
            <TableHead className="text-right">Closed today</TableHead>
            <TableHead className="text-right">This week</TableHead>
            <TableHead className="text-right">All time</TableHead>
            <TableHead className="text-right">Trades</TableHead>
            <TableHead className="text-right">Win rate</TableHead>
            <TableHead className="text-right">Avg R</TableHead>
            <TableHead className="text-right">Open</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.name}>
              <TableCell className="max-w-md min-w-56 whitespace-normal">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.label}</span>
                  <StatusBadge tone={r.stage === "passed" ? "good" : r.stage === "failed" ? "bad" : "info"}>
                    {r.stage === "incubation" ? "Incubation" : r.stage === "passed" ? "Passed backtest" : "Failed backtest"}
                  </StatusBadge>
                  {r.latched ? <StatusBadge tone="warn">Loss limit reached</StatusBadge> : null}
                </span>
                <span className="text-muted-foreground block text-xs">{r.does}</span>
              </TableCell>
              <TableCell className="text-right font-mono">{m(r.equity)}</TableCell>
              <TableCell className={cn("text-right font-mono", toneOf(r.returnPct))}>
                <Direction v={r.returnPct} /> {isNum(r.returnPct) ? `${signed(r.returnPct, 2)}%` : "—"}
              </TableCell>
              <TableCell className="text-right">
                <Money v={r.openPnl} m={m} />
              </TableCell>
              <TableCell className="text-right">
                <Money v={r.today} m={m} />
              </TableCell>
              <TableCell className="text-right">
                <Money v={r.week} m={m} />
              </TableCell>
              <TableCell className="text-right">
                <Money v={r.total} m={m} strong />
              </TableCell>
              <TableCell className="text-right font-mono">
                {num(r.trades)}
                {r.trades > 0 ? <span className="text-muted-foreground"> ({num(r.wins)}W {num(r.losses)}L)</span> : null}
              </TableCell>
              <TableCell className="text-right font-mono">{fracPct(r.winRate)}</TableCell>
              <TableCell className="text-right font-mono">{rMult(r.meanR, 2)}</TableCell>
              <TableCell className="text-right font-mono">{num(r.open)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

export function SleevePositions({ s, t }: { s: Crypto; t: Tournament }) {
  const m = moneyOf(s);
  return (
    <Panel
      title="Open positions"
      icon={Briefcase}
      means="What each sleeve is holding now. The price is the last one the desk read, at most 15 minutes old; the result includes the entry fee. A position leaves at its stop, its target, or when its rule says so."
      action={<span className="text-muted-foreground text-xs">{num(t.positions.length)} open</span>}
    >
      {t.positions.length === 0 ? (
        <Empty title="Nothing is open">A sleeve buys only on a freshly closed 4-hour bar that meets its rule. The next bar closes on the next 4-hour mark, UTC.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sleeve</TableHead>
              <TableHead>Pair</TableHead>
              <TableHead>Bought (UTC)</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Bought at</TableHead>
              <TableHead className="text-right">Price now</TableHead>
              <TableHead className="text-right">Stop</TableHead>
              <TableHead className="text-right">Target</TableHead>
              <TableHead className="text-right">Open P&amp;L</TableHead>
              <TableHead className="text-right">R</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.positions.map((p) => (
              <TableRow key={`${p.sleeve}-${p.pair}`}>
                <TableCell className="font-medium">{sleeveLabel(p.sleeve)}</TableCell>
                <TableCell className="font-mono">{p.pair}</TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {utc(p.entryAt)}
                  <span className="text-muted-foreground block">{ny(p.entryAt)} NY</span>
                </TableCell>
                <TableCell className="text-right font-mono">{num(p.qty, 2)}</TableCell>
                <TableCell className="text-right font-mono">{px(p.entry)}</TableCell>
                <TableCell className="text-right font-mono">
                  {px(p.mark)}
                  {isNum(p.openPct) ? <span className={cn("block text-xs", toneOf(p.openPct))}>{signed(p.openPct, 2)}%</span> : null}
                </TableCell>
                <TableCell className="text-right font-mono">{px(p.stop)}</TableCell>
                <TableCell className="text-right font-mono">{isNum(p.target) ? px(p.target) : <span className="text-muted-foreground">trailing</span>}</TableCell>
                <TableCell className="text-right">
                  <Money v={p.openPnl} m={m} strong />
                </TableCell>
                <TableCell className={cn("text-right font-mono", toneOf(p.openR))}>{rMult(p.openR, 2)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

export function SleeveTrades({ s, t }: { s: Crypto; t: Tournament }) {
  const m = moneyOf(s);
  return (
    <Panel
      title="Closed trades"
      icon={ReceiptText}
      means="Every trade a sleeve has closed, newest first: when it bought and sold, at what price, and what it made or lost after both fees."
      action={<span className="text-muted-foreground text-xs">{num(t.trades.length)} shown</span>}
    >
      {t.trades.length === 0 ? (
        <Empty title="No closed trades yet">The first one appears here when an open position reaches its stop, its target or its exit rule.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sleeve</TableHead>
              <TableHead>Pair</TableHead>
              <TableHead>Bought (UTC)</TableHead>
              <TableHead>Sold (UTC)</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Buy</TableHead>
              <TableHead className="text-right">Sell</TableHead>
              <TableHead className="text-right">Result</TableHead>
              <TableHead className="text-right">R</TableHead>
              <TableHead>How it ended</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.trades.map((x, i) => (
              <TableRow key={`${x.sleeve}-${x.pair}-${x.exitAt}-${i}`}>
                <TableCell className="font-medium">{sleeveLabel(x.sleeve)}</TableCell>
                <TableCell className="font-mono">{x.pair}</TableCell>
                <TableCell className="text-xs whitespace-nowrap">{utc(x.entryAt)}</TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {utc(x.exitAt)}
                  {isNum(x.heldMin) ? <span className="text-muted-foreground block">held {num(x.heldMin / 60, 1)} h</span> : null}
                </TableCell>
                <TableCell className="text-right font-mono">{num(x.qty, 2)}</TableCell>
                <TableCell className="text-right font-mono">{px(x.entry)}</TableCell>
                <TableCell className="text-right font-mono">{px(x.exit)}</TableCell>
                <TableCell className="text-right">
                  <Money v={x.pnl} m={m} strong />
                </TableCell>
                <TableCell className={cn("text-right font-mono", toneOf(x.r))}>{rMult(x.r, 2)}</TableCell>
                <TableCell className="text-sm">{code(x.reason)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

export function SleeveSignals({ t }: { t: Tournament }) {
  return (
    <Panel
      title="Signals"
      icon={Signal}
      means="Each time a sleeve's rule was met, newest first, and what became of it: bought, or not taken and why."
    >
      {t.signals.length === 0 ? (
        <Empty title="No signal yet" />
      ) : (
        <ul className="divide-border grid divide-y">
          {t.signals.slice(0, 12).map((g, i) => (
            <li key={`${g.sleeve}-${g.pair}-${g.at}-${i}`} className="grid gap-0.5 py-2 first:pt-0 last:pb-0 sm:grid-cols-[11rem_1fr] sm:gap-3">
              <span className="text-muted-foreground font-mono text-xs">{utc(g.at)} UTC</span>
              <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                <span className="font-medium">{sleeveLabel(g.sleeve)}</span> on <span className="font-mono">{g.pair}</span>:{" "}
                {g.entered ? <span className="text-good">bought</span> : <span className="text-muted-foreground">not taken ({codes(g.why)})</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function SleeveChecks({ t }: { t: Tournament }) {
  const names = t.rows.map((r) => r.name);
  const bar = t.checks.find((c) => c.bar)?.bar ?? null;
  return (
    <Panel
      title="Why no trade"
      icon={ListChecks}
      means="What each sleeve said about each pair on the newest closed 4-hour bar. A pair is bought only when every condition of a rule is met."
      action={bar ? <span className="text-muted-foreground text-xs">Bar opened {utc(bar)} UTC</span> : undefined}
    >
      {t.checks.length === 0 ? (
        <Empty title="No 4-hour bar has been checked yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pair</TableHead>
              {names.map((x) => (
                <TableHead key={x}>{sleeveLabel(x)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.checks.map((c) => (
              <TableRow key={c.pair}>
                <TableCell className="font-mono">{c.pair}</TableCell>
                {names.map((x) => {
                  const v = c.by[x];
                  return (
                    <TableCell key={x} className="text-sm">
                      {!v ? <span className="text-muted-foreground">—</span> : v.fire ? <span className="text-good font-medium">Signal</span> : <span className="text-muted-foreground">{codes(v.why)}</span>}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

const CHALLENGER_STATUS: Record<string, { tone: "good" | "warn" | "bad" | "info" | "neutral"; label: string }> = {
  live: { tone: "good", label: "Passed backtest, trading" },
  passed: { tone: "info", label: "Passed backtest, not admitted yet" },
  failed: { tone: "bad", label: "Failed backtest" },
  registered: { tone: "info", label: "Waiting for its backtest" },
  retired: { tone: "neutral", label: "Retired" },
};

function challengerNote(r: ChallengerRow): string {
  if (r.status === "failed") return `Failed on: ${codes(r.failedOn)}.`;
  if (r.status === "retired") return `Retired: ${code(r.retiredWhy)}.`;
  if (r.status === "live") return "Has its own paper book on the board above.";
  if (r.status === "registered") return "Its rules are on record; the backtest has not run yet.";
  return "";
}

/** Every strategy idea the desk has tried by itself (DEC-0016), with the verdict of its backtest. */
export function ChallengersPanel({ c }: { c: Challengers }) {
  return (
    <Panel
      title="Challengers"
      icon={FlaskConical}
      means="New strategy ideas the desk tries by itself: at most two a week, each a variation of the three rules. An idea is written down before it is tested on two years of history after costs. One that passes is then run once on the two years before that, which it was not chosen on, and must make money there too. Only then does it join the tournament, on its own paper book; one that fails never trades. Every idea tried raises the bar for the next, so luck is not mistaken for skill."
      action={<span className="text-muted-foreground text-xs">{challengersLine(c)}</span>}
    >
      <p className="text-muted-foreground mb-3 flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge tone={c.learningOn ? "good" : "warn"}>{c.learningOn ? "Learning on" : "Learning switched off"}</StatusBadge>
        <span>
          This week: {num(c.drawnThisWeek)} of {num(c.perWeek)} drawn. Trading: {num(c.live)} of {num(c.maxLive)}. Tried in all: {num(c.registered)} of{" "}
          {num(c.maxRegistered)}.
        </span>
      </p>
      {c.rows.some((r) => isNum(r.meanR)) ? (
        <section className="mb-4 grid gap-2">
          <h3 className="text-sm font-medium">Average result of each idea&apos;s backtest, with its range at higher costs</h3>
          <Forest
            label="Average R of each challenger's backtest, with its range at higher costs"
            format={(v) => rMult(v, 2)}
            rows={c.rows
              .filter((r) => isNum(r.meanR))
              .map((r) => ({ key: r.id, label: r.label, sub: (CHALLENGER_STATUS[r.status] ?? { label: r.status }).label, value: r.meanR, low: r.ciLow, high: r.ciHigh }))}
          />
          <p className="text-muted-foreground text-xs">Green: the whole range is above zero, one of the conditions for passing. Grey: the range includes zero.</p>
        </section>
      ) : null}
      {c.rows.length === 0 ? (
        <Empty title="No idea has been tried yet">The desk draws its first ideas on its next daily run, at 03:30 New York time.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Idea</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Recorded (UTC)</TableHead>
              <TableHead className="text-right">Backtest trades</TableHead>
              <TableHead className="text-right">Win rate</TableHead>
              <TableHead className="text-right">Avg R</TableHead>
              <TableHead className="text-right">Range at higher costs</TableHead>
              <TableHead className="text-right">Chance it is random</TableHead>
              <TableHead className="text-right">Earlier two years</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.rows.map((r) => {
              const st = CHALLENGER_STATUS[r.status] ?? { tone: "neutral" as const, label: r.status };
              return (
                <TableRow key={r.id}>
                  <TableCell className="max-w-sm min-w-48 align-top whitespace-normal">
                    <span className="font-medium">{r.label}</span>
                    <span className="text-muted-foreground ml-2 text-xs">
                      {r.slot === "neighbour" ? `one step from ${sleeveLabel(r.of)}` : "drawn at random"}
                    </span>
                    <span className="text-muted-foreground block text-xs">{r.rules}</span>
                  </TableCell>
                  <TableCell className="max-w-xs min-w-40 align-top whitespace-normal">
                    <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                    <span className="text-muted-foreground block text-xs">{challengerNote(r)}</span>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{utc(r.registeredAt)}</TableCell>
                  <TableCell className="text-right font-mono">
                    {num(r.trades)}
                    {isNum(r.perMonth) ? <span className="text-muted-foreground"> ({r.perMonth.toFixed(1)}/month)</span> : null}
                  </TableCell>
                  <TableCell className="text-right font-mono">{fracPct(r.winRate)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <span className={cn("font-mono", toneOf(r.meanR))}>{rMult(r.meanR, 3)}</span>
                    {r.cost ? (
                      <span className="text-muted-foreground block text-xs">
                        {rMult(r.cost.grossR, 2)} before costs of {r.cost.meanR.toFixed(2)}R
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right font-mono whitespace-nowrap">
                    {isNum(r.ciLow) && isNum(r.ciHigh) ? `${rMult(r.ciLow, 2)} to ${rMult(r.ciHigh, 2)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono">{isNum(r.controlP) ? `${(r.controlP * 100).toFixed(1)}%` : "—"}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {r.confirm ? (
                      <>
                        <span className={cn("font-mono", toneOf(r.confirm.meanR))}>{rMult(r.confirm.meanR, 3)}</span>
                        <span className="text-muted-foreground block text-xs">
                          {num(r.confirm.trades)} trades, {r.confirm.passed ? "held up" : "did not hold up"}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">{r.status === "failed" ? "Not run" : "—"}</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

const LINE_COLOURS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-7)", "var(--chart-8)", "var(--chart-6)"];

/** The tournament's headline numbers. The books are added up for reading only; they are never pooled. */
export function TournamentTiles({ s, t }: { s: Crypto; t: Tournament }) {
  const m = moneyOf(s);
  const d = deskTotals(t);
  const sign = (v: number | null) => (!isNum(v) || Math.abs(v) < 0.005 ? "neutral" : v > 0 ? "good" : "bad");
  const money = (v: number | null) => (!isNum(v) ? "—" : Math.abs(v) < 0.005 ? m(0) : `${v > 0 ? "+" : "−"}${m(Math.abs(v))}`);
  return (
    <StatTiles>
      <StatTile
        label={`All ${num(d.books)} paper books`}
        value={m(d.equity)}
        hint={isNum(d.returnPct) ? `${signed(d.returnPct, 2)}% since they started` : "No return yet"}
        tone={sign(d.returnPct)}
      />
      <StatTile label="Closed this week" value={money(d.week)} hint={`Today: ${money(d.today)}`} tone={sign(d.week)} />
      <StatTile
        label="Closed trades"
        value={num(d.trades)}
        hint={isNum(d.winRate) ? `${fracPct(d.winRate)} made money` : "None closed yet"}
      />
      <StatTile
        label="Open positions"
        value={num(d.open)}
        hint={d.leader ? `Ahead so far: ${d.leader.label}, ${signed(d.leader.returnPct, 2)}%` : "No book has moved yet"}
        tone={d.open > 0 ? "info" : "neutral"}
      />
    </StatTiles>
  );
}

/** Every paper book on one chart, each as a change from its own start, with the baseline rule beside them. */
export function EquityLinesPanel({ s }: { s: Crypto }) {
  const lines = equityLines(s);
  const drawn = lines.filter((l) => l.points.length >= 2);
  return (
    <Panel
      title="Return of each paper book"
      icon={LineChart}
      means="Each strategy's paper book over the last 90 days, as a percentage change from where it started, fees included. The host keeps one mark every four hours. The dashed line is the original 15-minute rule, kept as the baseline. All of it is incubation on paper money: a line going up is not evidence of an edge."
    >
      {lines.length === 0 ? (
        <Empty title="No book has published a mark yet" />
      ) : (
        <div className="grid gap-3">
          {drawn.length === 0 ? (
            <Empty title="Not enough history yet">Each book has one mark so far; the lines start with the next one.</Empty>
          ) : (
            <LinesChart
              label="Return of each paper book since its start, in percent"
              series={lines.map((l, i) => ({
                key: l.name,
                label: l.label,
                color: l.baseline ? "var(--chart-na)" : (LINE_COLOURS[i % LINE_COLOURS.length] as string),
                dashed: l.baseline,
                points: l.points.map((p) => ({ t: p.t, v: p.pct })),
              }))}
            />
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
            {lines.map((l) => (
              <div key={l.name} className="min-w-0">
                <dt className="text-muted-foreground truncate text-xs">{l.label}</dt>
                <dd className={cn("font-mono text-sm font-medium", toneOf(l.lastPct))}>{isNum(l.lastPct) ? `${signed(l.lastPct, 2)}%` : "—"}</dd>
                <dd className="text-muted-foreground text-xs">
                  {isNum(l.worstDrawdownPct) ? `deepest fall ${signed(l.worstDrawdownPct, 2)}%` : `${num(l.points.length)} ${l.points.length === 1 ? "mark" : "marks"} so far`}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Panel>
  );
}

/** The closed trades as pictures: each trade's result in order, then the average by strategy and by how it ended. */
export function TradeResultsPanel({ t }: { t: Tournament }) {
  const st = tradeStats(t.trades);
  return (
    <Panel
      title="Tournament: results of the closed trades"
      icon={BarChart3}
      means="One bar per closed trade of the tournament's strategies, in the order they ended. R is the result as a multiple of what the trade risked: +1R made what it risked, −1R lost it. Only the newest trades of each strategy are published, so a long history is cut off at the left."
      action={<span className="text-muted-foreground text-xs">{num(st.series.length)} trades</span>}
    >
      {st.series.length === 0 ? (
        <Empty title="No closed trades yet">The first bar appears when an open position reaches its stop, its target or its exit rule.</Empty>
      ) : (
        <div className="grid gap-5">
          <TradeBars trades={st.series.map((x) => ({ i: x.i, r: x.r, what: `${x.label} · ${x.pair}`, when: utc(x.at) }))} />
          <div className="grid gap-5 lg:grid-cols-2">
            <section className="grid content-start gap-2">
              <h3 className="text-sm font-medium">Average result by strategy</h3>
              <DivergingBars
                label="Average R per strategy"
                better="positive"
                format={(v) => rMult(v, 2)}
                rows={st.bySleeve.map((g) => ({ key: g.key, label: `${g.label} (${num(g.n)})`, value: g.meanR }))}
              />
            </section>
            <section className="grid content-start gap-2">
              <h3 className="text-sm font-medium">Average result by how the trade ended</h3>
              <DivergingBars
                label="Average R per exit reason"
                better="positive"
                format={(v) => rMult(v, 2)}
                rows={st.byReason.map((g) => ({ key: g.key, label: <span className="inline-block first-letter:uppercase">{`${code(g.key)} (${num(g.n)})`}</span>, value: g.meanR }))}
              />
            </section>
          </div>
          <p className="text-muted-foreground text-xs">The number in brackets is how many trades the average is over. A few trades prove nothing either way.</p>
        </div>
      )}
    </Panel>
  );
}
