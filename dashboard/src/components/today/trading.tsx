import { ArrowDownRight, ArrowUpRight, Briefcase, CircleDollarSign, Crosshair, Minus, ReceiptText } from "lucide-react";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { newYork, num, rMult, shortDate, signed, sydney, usd } from "@/lib/format";
import { outcomeLine, reasonLabel, type Trading } from "@/lib/trading";
import { cn } from "@/lib/utils";
import { TradeBars } from "@/components/charts/trade-bars";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Signed paper dollars: "+US$1.20", "−US$2.00", "US$0.00". */
export function money(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  const body = usd(Math.abs(v));
  return Math.abs(v) < 0.005 ? body : `${v > 0 ? "+" : "−"}${body}`;
}

const toneOf = (v: number | null | undefined) => (!isNum(v) || Math.abs(v) < 0.005 ? "text-foreground" : v > 0 ? "text-good" : "text-bad");

function Direction({ v }: { v: number | null | undefined }) {
  const Icon = !isNum(v) || Math.abs(v) < 0.005 ? Minus : v > 0 ? ArrowUpRight : ArrowDownRight;
  return <Icon aria-hidden className={cn("size-4 shrink-0", toneOf(v))} />;
}

/** The four profit-and-loss figures: today, this week, this month and all time. */
export function PnlTiles({ v }: { v: Trading }) {
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {v.periods.map((p) => (
        <div key={p.key} className="bg-muted/40 border-border min-w-0 rounded-lg border p-3">
          <dt className="text-muted-foreground text-xs">{p.label}</dt>
          <dd className="mt-1 flex items-center gap-1.5">
            <Direction v={p.money} />
            <span className={cn("font-mono text-lg font-semibold tabular-nums", toneOf(p.money))}>{money(p.money)}</span>
          </dd>
          <dd className="text-muted-foreground mt-0.5 text-xs">
            {rMult(p.r, 2)} · {num(p.trades)} {p.trades === 1 ? "trade" : "trades"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PnlPanel({ v }: { v: Trading }) {
  const s = v.stats;
  const open = v.position?.openPnl ?? null;
  return (
    <Panel
      title="Profit and loss"
      icon={CircleDollarSign}
      means="What Paper B's closed paper trades have made or lost, on its US$600 paper ledger. R is the result measured against the amount risked on that trade. Paper money only."
      action={v.session ? <span className="text-muted-foreground text-xs">Latest session {shortDate(v.session)}</span> : undefined}
    >
      <div className="grid gap-4">
        <PnlTiles v={v} />
        <KeyValues
          className="sm:grid-cols-4"
          items={[
            { label: "Ledger now", value: usd(v.equity), mono: true },
            { label: "Return since start", value: isNum(v.returnPct) ? `${signed(v.returnPct, 2)}%` : "—", mono: true },
            { label: "Open position", value: v.position?.state === "in_position" ? money(open) : "None", mono: true },
            { label: "Closed trades", value: `${num(s.trades)} (${num(s.wins)} won, ${num(s.losses)} lost)` },
            { label: "Win rate", value: isNum(s.winRate) ? `${num(s.winRate, 1)}%` : "—", mono: true },
            { label: "Average win / loss", value: `${money(s.avgWin)} / ${money(s.avgLoss)}`, mono: true },
            { label: "Best / worst trade", value: `${money(s.best)} / ${money(s.worst)}`, mono: true },
            { label: "Largest drawdown", value: money(s.maxDd), mono: true },
          ]}
        />
        {v.days.filter((d) => isNum(d.r)).length >= 2 ? (
          <section className="grid gap-2">
            <h3 className="text-sm font-medium">Result of each day with a closed trade</h3>
            <TradeBars
              label="Result in R of each day with a closed trade, oldest first"
              whenLabel="Day"
              trades={v.days
                .filter((d) => isNum(d.r))
                .slice(-90)
                .map((d, i) => ({ i: i + 1, r: d.r as number, what: `${num(d.trades)} ${d.trades === 1 ? "trade" : "trades"} · ${money(d.pnl)}`, when: shortDate(d.date) }))}
            />
          </section>
        ) : null}
        {v.days.length > 0 ? (
          <div>
            <p className="text-muted-foreground mb-2 text-xs">Days with a closed trade, newest first</p>
            <ul className="flex flex-wrap gap-1.5">
              {v.days
                .slice(-30)
                .reverse()
                .map((d) => (
                  <li key={d.date} className="border-border flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                    <Direction v={d.pnl} />
                    <span className="text-muted-foreground">{shortDate(d.date)}</span>
                    <span className={cn("font-mono tabular-nums", toneOf(d.pnl))}>{money(d.pnl)}</span>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

export function OutcomePanel({ v, asOf }: { v: Trading; asOf: string | null | undefined }) {
  const o = outcomeLine(v);
  return (
    <Panel
      title={v.current || v.session === null ? "Paper B today" : `Paper B, ${shortDate(v.session)}`}
      icon={Crosshair}
      means="Did Paper B trade in its latest session, and if not, why. It watches QQQ, trades QQQM, and takes at most one trade a day."
      action={<StatusBadge tone={o.tone}>{o.title}</StatusBadge>}
    >
      <div className="grid gap-3">
        <p className="text-sm">{o.detail}</p>
        {v.signals.length > 0 ? (
          <ul className="divide-border grid divide-y">
            {v.signals.map((x, i) => (
              <li key={`${x.at}-${i}`} className="grid gap-0.5 py-2 first:pt-0 last:pb-0 sm:grid-cols-[11rem_1fr] sm:gap-3">
                <span className="text-muted-foreground font-mono text-xs">{newYork(x.at)} NY</span>
                <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                  Signal on QQQ: buy above {num(x.trigger, 2)}, stop {num(x.stop, 2)}.{" "}
                  <span className="text-muted-foreground">
                    {x.acted ? "Acted on." : x.blockers ? `Not taken: ${x.blockers}.` : "Not acted on."}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {v.position ? <PositionCard v={v} asOf={asOf} /> : null}
      </div>
    </Panel>
  );
}

function PositionCard({ v, asOf }: { v: Trading; asOf: string | null | undefined }) {
  const p = v.position!;
  const filled = p.state === "in_position";
  return (
    <div className="bg-muted/40 border-border rounded-lg border p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Briefcase aria-hidden className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">
          {filled ? `Holding ${num(p.qty)} ${p.symbol}` : `Buy order waiting: ${num(p.qty)} ${p.symbol} above ${num(p.trigger, 2)}`}
        </span>
        {filled ? <span className={cn("font-mono text-sm font-semibold tabular-nums", toneOf(p.openPnl))}>{money(p.openPnl)}</span> : null}
        {filled && isNum(p.openR) ? <span className="text-muted-foreground font-mono text-xs">{rMult(p.openR, 2)}</span> : null}
      </div>
      <KeyValues
        className="sm:grid-cols-5"
        items={[
          { label: "Bought at", value: filled ? num(p.entry, 2) : "—", mono: true },
          { label: "Bought (NY)", value: filled ? newYork(p.entryAt) : "—" },
          { label: "Price now", value: num(p.mark, 2), mono: true },
          { label: "Stop", value: num(p.stop, 2), mono: true },
          { label: "Target", value: num(p.target, 2), mono: true },
        ]}
      />
      <p className="text-muted-foreground mt-2 text-xs">
        Price as of the last update{asOf ? ` (${newYork(asOf)} NY)` : ""}. It is closed before the bell if neither the stop nor the target is reached.
      </p>
    </div>
  );
}

export function TradesPanel({ v }: { v: Trading }) {
  return (
    <Panel
      title="Trades"
      icon={ReceiptText}
      means="Every closed Paper B trade, newest first: when it bought and sold, at what price, and what it made or lost. Times are New York, with Sydney beside them."
      action={<span className="text-muted-foreground text-xs">{num(v.stats.trades)} closed</span>}
    >
      {v.trades.length === 0 ? (
        <Empty title="No closed trades yet">The first one appears here the day Paper B takes a trade and closes it.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bought</TableHead>
              <TableHead>Sold</TableHead>
              <TableHead>Ticker</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Buy</TableHead>
              <TableHead className="text-right">Sell</TableHead>
              <TableHead className="text-right">Stop</TableHead>
              <TableHead className="text-right">Result</TableHead>
              <TableHead className="text-right">R</TableHead>
              <TableHead>How it ended</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {v.trades.map((t, i) => (
              <TableRow key={`${t.session}-${i}`}>
                <TableCell className="text-xs whitespace-nowrap">
                  {t.entryAt ? newYork(t.entryAt) : shortDate(t.session)}
                  {t.entryAt ? <span className="text-muted-foreground block">{sydney(t.entryAt)} Sydney</span> : null}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {t.exitAt ? newYork(t.exitAt, false) : "—"}
                  {isNum(t.heldMin) ? <span className="text-muted-foreground block">held {num(t.heldMin)} min</span> : null}
                </TableCell>
                <TableCell className="font-mono">{t.symbol}</TableCell>
                <TableCell className="text-right font-mono">{num(t.qty)}</TableCell>
                <TableCell className="text-right font-mono">{num(t.entry, 2)}</TableCell>
                <TableCell className="text-right font-mono">
                  {num(t.exit, 2)}
                  {t.estimated ? <span className="text-muted-foreground"> est.</span> : null}
                </TableCell>
                <TableCell className="text-right font-mono">{num(t.stop, 2)}</TableCell>
                <TableCell className={cn("text-right font-mono font-medium", toneOf(t.pnl))}>{money(t.pnl)}</TableCell>
                <TableCell className={cn("text-right font-mono", toneOf(t.r))}>{rMult(t.r, 2)}</TableCell>
                <TableCell className="text-sm">{reasonLabel(t.reason)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
