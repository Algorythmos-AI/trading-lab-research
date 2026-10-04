import { Activity, Gauge, LineChart, ListChecks } from "lucide-react";
import { CryptoKillNotice, NoCryptoSnapshot } from "@/components/crypto/panels";
import { Empty } from "@/components/empty";
import { HealthBanner } from "@/components/health-banner";
import { KeyValues } from "@/components/kv";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sparkline } from "@/components/v3/sparkline";
import { CURRENCY_NAME, codes, cryptoHealth, items, moneyOf, spreadPct, type Crypto } from "@/lib/crypto";
import { fracPct, num, rMult, shortDate, signed, zoned } from "@/lib/format";
import { freshness } from "@/lib/freshness";
import { requestTime } from "@/lib/now";
import { loadCryptoSnapshot } from "@/lib/snapshot";
import { list } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Crypto overview" };

export default async function CryptoOverviewPage() {
  const result = await loadCryptoSnapshot();
  const now = requestTime().getTime();
  return (
    <>
      <PageHeading
        title="Overview"
        intro="The crypto desk: Kraken spot pairs on public market data, booked on the lab's own paper simulator. It never holds venue credentials and cannot place a real order."
      />
      {result.status !== "ok" ? (
        <NoCryptoSnapshot status={result.status} />
      ) : (
        <>
          <HealthBanner health={cryptoHealth(result.snapshot, freshness(result.snapshot.as_of ?? null, list(result.snapshot.expected_windows), now))} />
          <CryptoKillNotice s={result.snapshot} />
          <KeyNumbers s={result.snapshot} />
          <MarketPanel s={result.snapshot} />
          <div className="grid gap-5 lg:grid-cols-2">
            <EquityPanel s={result.snapshot} />
            <DailyPanel s={result.snapshot} />
          </div>
        </>
      )}
    </>
  );
}

function KeyNumbers({ s }: { s: Crypto }) {
  const m = moneyOf(s);
  const p = s.perf;
  const passing = items(s.quality?.pairs).filter((x) => x.passes === true).length;
  const pairs = items(s.quality?.pairs).length;
  return (
    <Panel title="Key numbers" icon={Gauge} means={`The figures the crypto desk is judged on. Money is paper money in ${CURRENCY_NAME[s.config?.quote_currency ?? ""] ?? "the desk's quote currency"}.`}>
      <KeyValues
        className="sm:grid-cols-4"
        items={[
          { label: "Paper equity", value: m(s.book?.equity) },
          { label: "Return since start", value: s.book?.return_pct == null ? "—" : `${signed(s.book.return_pct, 2)}%` },
          { label: "Closed trades", value: num(p?.trades) },
          { label: "Win rate", value: fracPct(p?.win_rate) },
          { label: "Average result", value: rMult(p?.mean_r, 2) },
          { label: "Win rate needed to break even", value: fracPct(s.strategy?.breakeven_win_rate) },
          { label: "Bar cycles, last 24 h", value: `${num(s.activity?.cycles_24h)} of ${num(s.activity?.expected_24h)}` },
          { label: "Pairs passing the data gate", value: `${passing} of ${pairs}` },
        ]}
      />
    </Panel>
  );
}

function MarketPanel({ s }: { s: Crypto }) {
  const rows = items(s.market);
  return (
    <Panel
      title="Latest bar, per pair"
      icon={Activity}
      means="What the strategy saw on the most recent closed 15-minute bar. A pair is tradable only if the bar had trades and the quote was tight."
    >
      {rows.length === 0 ? (
        <Empty title="No bars recorded yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pair</TableHead>
              <TableHead>Bar (UTC)</TableHead>
              <TableHead className="text-right">Close</TableHead>
              <TableHead className="text-right">RSI</TableHead>
              <TableHead className="text-right">Spread</TableHead>
              <TableHead>Market</TableHead>
              <TableHead>Signal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => (
              <TableRow key={m.pair}>
                <TableCell className="font-medium">{m.pair}</TableCell>
                <TableCell className="font-mono text-xs">{zoned(m.bar, "UTC")}</TableCell>
                <TableCell className="text-right font-mono">{num(m.close, 2)}</TableCell>
                <TableCell className="text-right font-mono">{num(m.rsi, 1)}</TableCell>
                <TableCell className="text-right font-mono">{spreadPct(m.spread_pct)}</TableCell>
                <TableCell>
                  {m.tradable ? <StatusBadge tone="good">Tradable</StatusBadge> : <StatusBadge tone="warn">{codes(m.quality)}</StatusBadge>}
                </TableCell>
                <TableCell>
                  {m.would_fire ? <StatusBadge tone="info">Entry signal</StatusBadge> : <span className="text-muted-foreground text-[0.8125rem]">{codes(m.why_not)}</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function EquityPanel({ s }: { s: Crypto }) {
  const m = moneyOf(s);
  const curve = items(s.perf?.equity_curve).map((p) => p.equity).filter((v): v is number => typeof v === "number");
  const start = s.book?.start_equity ?? curve[0] ?? 0;
  return (
    <Panel title="Paper equity" icon={LineChart} means="Equity of the paper book hour by hour, as a change from where it started. Fees are included.">
      {curve.length < 2 ? (
        <Empty title="Not enough history yet" />
      ) : (
        <>
          <Sparkline values={curve.map((v) => v - start)} label="Paper equity change since the start" />
          <p className="text-muted-foreground mt-2 text-xs">
            {m(curve[0])} → {m(curve[curve.length - 1])} over {curve.length} hours
          </p>
        </>
      )}
    </Panel>
  );
}

function DailyPanel({ s }: { s: Crypto }) {
  const days = items(s.activity?.daily).slice(-7).reverse();
  return (
    <Panel title="Daily summary" icon={ListChecks} means="Per UTC day: bars observed, bars where every entry condition held, and what the desk did.">
      {days.length === 0 ? (
        <Empty title="No days recorded yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Observed</TableHead>
              <TableHead className="text-right">Signals</TableHead>
              <TableHead className="text-right">Entries</TableHead>
              <TableHead className="text-right">Exits</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.map((d) => (
              <TableRow key={d.day}>
                <TableCell>{shortDate(d.day)}</TableCell>
                <TableCell className="text-right font-mono">{num(d.observations)}</TableCell>
                <TableCell className="text-right font-mono">{num(d.fires)}</TableCell>
                <TableCell className="text-right font-mono">{num(d.entries)}</TableCell>
                <TableCell className="text-right font-mono">{num(d.exits)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
