import { ArrowDownRight, ArrowUpRight, Briefcase, ListChecks, Minus, ReceiptText, Signal, Trophy } from "lucide-react";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { code, codes, moneyOf, type Crypto } from "@/lib/crypto";
import { fracPct, num, rMult, signed, zoned } from "@/lib/format";
import { sleeveLabel, tournamentLine, type Tournament } from "@/lib/tournament";
import { cn } from "@/lib/utils";

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
      means="Three strategies trading on paper side by side, each on its own US$10,000 paper book, best return first. They are in incubation: these results are not evidence until a strategy also passes its backtest. Paper money only."
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
              <TableCell>
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
