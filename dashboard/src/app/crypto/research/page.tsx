import { BarChart3, BrainCircuit, Microscope } from "lucide-react";
import { Histogram, NoCryptoSnapshot } from "@/components/crypto/panels";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { items, plural, spreadPct, type Crypto } from "@/lib/crypto";
import { fracPct, num, pct } from "@/lib/format";
import { loadCryptoSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Crypto research" };

const DISTRIBUTIONS: { key: string; title: string; digits: number }[] = [
  { key: "rsi", title: "RSI-14", digits: 0 },
  { key: "atr_pct", title: "ATR, % of price", digits: 2 },
  { key: "vwap_distance_pct", title: "Distance from session VWAP, %", digits: 2 },
  { key: "volume_ratio", title: "Volume against the 20-bar average", digits: 1 },
];

export default async function CryptoResearchPage() {
  const result = await loadCryptoSnapshot();
  return (
    <>
      <PageHeading
        title="Research"
        intro="Whether these pairs are markets at all (gate C0), what the recorded bars look like, and where the shadow model stands. Nothing here changes an order."
      />
      {result.status !== "ok" ? (
        <NoCryptoSnapshot status={result.status} />
      ) : (
        <>
          <QualityPanel s={result.snapshot} />
          <DistributionsPanel s={result.snapshot} />
          <MlPanel s={result.snapshot} />
        </>
      )}
    </>
  );
}

function QualityPanel({ s }: { s: Crypto }) {
  const q = s.quality;
  const rows = items(q?.pairs);
  return (
    <Panel
      title="Gate C0: data quality"
      icon={Microscope}
      means="A pair is eligible only when enough of its bars had trades and its spread is tight, over enough recorded days. A bar nobody traded in is a carried-forward price, not a market."
    >
      <div className="grid gap-4">
        <Meter
          label="Days recorded"
          value={q?.days}
          max={Math.max(q?.min_days ?? 0, q?.days ?? 0)}
          threshold={q?.min_days}
          thresholdLabel={`Needs ${plural(q?.min_days, "day")}`}
          valueText={plural(q?.days, "day")}
        />
        {rows.length === 0 ? (
          <Empty title="No bars recorded yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pair</TableHead>
                <TableHead className="text-right">Bars</TableHead>
                <TableHead className="text-right">Bars with trades (needs {fracPct(q?.min_traded_share, 0)})</TableHead>
                <TableHead className="text-right">Median spread (max {pct(q?.max_median_spread_pct, 2)})</TableHead>
                <TableHead className="text-right">95th-percentile spread</TableHead>
                <TableHead>Gate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.pair}>
                  <TableCell className="font-medium">{p.pair}</TableCell>
                  <TableCell className="text-right font-mono">{num(p.bars)}</TableCell>
                  <TableCell className="text-right font-mono">{fracPct(p.traded_share)}</TableCell>
                  <TableCell className="text-right font-mono">{spreadPct(p.median_spread_pct)}</TableCell>
                  <TableCell className="text-right font-mono">{spreadPct(p.p95_spread_pct)}</TableCell>
                  <TableCell>
                    {p.passes ? <StatusBadge tone="good">Passes</StatusBadge> : <StatusBadge tone="warn">Not yet</StatusBadge>}
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

function DistributionsPanel({ s }: { s: Crypto }) {
  const d = s.distributions ?? {};
  return (
    <Panel title="Feature distributions, last 7 days" icon={BarChart3} means="How four of the recorded features were spread across every observed bar. The ends of each chart are the 1st and 99th percentile.">
      <div className="grid gap-5 sm:grid-cols-2">
        {DISTRIBUTIONS.map((x) => (
          <div key={x.key} className="grid gap-1.5">
            <p className="text-[0.8125rem] font-medium">{x.title}</p>
            <Histogram bins={items(d[x.key])} label={x.title} digits={x.digits} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

function MlPanel({ s }: { s: Crypto }) {
  const m = s.ml;
  return (
    <Panel
      title="Shadow model"
      icon={BrainCircuit}
      means="A classifier trained offline on the recorded bars. It only logs what it would have predicted; it never changes an order."
      action={<StatusBadge tone="neutral">{m?.status === "not_trained" ? "Not trained" : (m?.status ?? "Unknown")}</StatusBadge>}
    >
      <KeyValues
        items={[
          { label: "Observations recorded", value: num(m?.observations) },
          { label: "With a resolved label", value: num(m?.labelled) },
          { label: "Model", value: m?.model ?? "None" },
        ]}
      />
    </Panel>
  );
}
