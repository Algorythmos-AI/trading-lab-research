import { Database } from "lucide-react";
import { Columns } from "@/components/charts/columns";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { moneyOf, type Crypto } from "@/lib/crypto";
import { fracPct, num, rMult, signed } from "@/lib/format";
import { harvestLine, type Harvest } from "@/lib/harvest";

const dayLabel = (d: string) => (d.length >= 10 ? `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}` : d);

/** The data harvest (DEC-0027): how much the desk is collecting for the models, per day and per book. */
export function HarvestPanel({ s, h }: { s: Crypto; h: Harvest }) {
  const m = moneyOf(s);
  return (
    <Panel
      title="Data harvest"
      icon={Database}
      means={`Paper books that trade often to collect training data for the models: the three tournament rules on ${num(h.coins)} coins, on 4-hour and 1-hour bars, plus one random entry an hour. Losing trades are expected and are data too. None of this counts as evidence for any strategy.`}
      action={h.switchOn ? <StatusBadge tone="good">Collecting</StatusBadge> : <StatusBadge tone="warn">Switched off</StatusBadge>}
    >
      <div className="grid gap-5">
        <p className="text-[0.8125rem]">{harvestLine(h)}</p>
        <StatTiles>
          <StatTile label="Signals today" value={num(h.signalsToday)} hint={`${num(h.perDay7d, 0)} a day over the last 7 days`} tone="info" />
          <StatTile label="Paper entries today" value={num(h.entriesToday)} hint={`${num(h.exitsToday)} closed today`} />
          <StatTile
            label="Labelled trades"
            value={num(h.labelled)}
            hint={h.winRate == null ? "None finished yet" : `${fracPct(h.winRate)} ended in profit, average ${rMult(h.meanR, 2)}`}
          />
          <StatTile label="Feature rows, 7 days" value={num(h.featureRows7d)} hint="One per coin per closed hour, traded or not" />
        </StatTiles>
        {h.days.length === 0 ? (
          <Empty title="No days recorded yet" />
        ) : (
          <div className="grid gap-1.5">
            <p className="text-muted-foreground text-xs">Signals recorded per day (UTC), last {h.days.length} days</p>
            <Columns label="Harvest signals per day" columns={h.days.map((d, i) => ({ key: d.day, label: (h.days.length - 1 - i) % 2 === 0 ? dayLabel(d.day) : "", count: d.signals }))} />
          </div>
        )}
        {h.books.length === 0 ? null : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Book</TableHead>
                <TableHead className="text-right">Signals, 7 days</TableHead>
                <TableHead className="text-right">Signals, all</TableHead>
                <TableHead className="text-right">Closed trades</TableHead>
                <TableHead className="text-right">Open</TableHead>
                <TableHead className="text-right">Paper equity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {h.books.map((b) => (
                <TableRow key={b.name}>
                  <TableCell className="font-medium">{b.label}</TableCell>
                  <TableCell className="text-right font-mono">{num(b.signals7d)}</TableCell>
                  <TableCell className="text-right font-mono">{num(b.signals)}</TableCell>
                  <TableCell className="text-right font-mono">{num(b.trades)}</TableCell>
                  <TableCell className="text-right font-mono">{num(b.open)}</TableCell>
                  <TableCell className="text-right font-mono">
                    {m(b.equity)}
                    <span className="text-muted-foreground ml-1.5 text-xs">{b.returnPct == null ? "" : `${signed(b.returnPct, 2)}%`}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Panel>
  );
}
