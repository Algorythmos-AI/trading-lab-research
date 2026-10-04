import { Calculator, History, ScrollText, ShieldX } from "lucide-react";
import { NoCryptoSnapshot } from "@/components/crypto/panels";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { code, items, moneyOf, type Crypto } from "@/lib/crypto";
import { fracPct, num, pct, rMult, signed, zoned } from "@/lib/format";
import { loadCryptoSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Crypto strategy" };

export default async function CryptoStrategyPage() {
  const result = await loadCryptoSnapshot();
  return (
    <>
      <PageHeading
        title="Strategy"
        intro="The one registered rule set on the crypto desk, what a win and a loss are worth after costs, and every paper trade it has closed."
      />
      {result.status !== "ok" ? (
        <NoCryptoSnapshot status={result.status} />
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <RulesPanel s={result.snapshot} />
            <EconomicsPanel s={result.snapshot} />
          </div>
          <TradesPanel s={result.snapshot} />
          <RefusedPanel s={result.snapshot} />
        </>
      )}
    </>
  );
}

function RulesPanel({ s }: { s: Crypto }) {
  const r = s.strategy;
  return (
    <Panel
      title="Rules in force"
      icon={ScrollText}
      means="Long only, on closed 15-minute bars. All three entry conditions must hold on a bar that traded. Changing any number is a new registered trial."
    >
      <KeyValues
        items={[
          { label: "Entry", value: `Close above session VWAP and EMA-${num(r?.ema_period)}, RSI-${num(r?.rsi_period)} below ${num(r?.rsi_below)}` },
          { label: "Stop", value: pct(r?.stop_loss_pct, 2) },
          { label: "Target", value: pct(r?.take_profit_pct, 2) },
          { label: "Time stop", value: `${num(r?.time_stop_bars)} bars` },
          { label: "Taker fee, each side", value: pct(r?.taker_fee_pct, 2) },
          { label: "Config", value: s.config?.hash ?? "—", mono: true },
        ]}
      />
    </Panel>
  );
}

function EconomicsPanel({ s }: { s: Crypto }) {
  const r = s.strategy;
  const p = s.perf;
  const need = r?.breakeven_win_rate;
  const tone = typeof need === "number" && need > 0.6 ? "bad" : "info";
  return (
    <Panel
      title="What a trade is worth after costs"
      icon={Calculator}
      means="A full target and a full stop, after two taker fees and slippage both ways. The win rate needed just to break even follows from those two numbers."
      action={typeof need === "number" && need > 0.6 ? <StatusBadge tone="bad">Costs dominate</StatusBadge> : undefined}
    >
      <div className="grid gap-4">
        <KeyValues
          className="sm:grid-cols-2"
          items={[
            { label: "A win at the target nets", value: r?.net_win_pct == null ? "—" : `${signed(r.net_win_pct, 2)}%` },
            { label: "A loss at the stop costs", value: r?.net_loss_pct == null ? "—" : `${signed(r.net_loss_pct, 2)}%` },
          ]}
        />
        <Meter
          label="Win rate so far, against the rate needed to break even"
          value={p?.win_rate}
          max={1}
          threshold={need}
          thresholdLabel={`Break-even at ${fracPct(need)}`}
          valueText={`${fracPct(p?.win_rate)} over ${num(p?.trades)} trades`}
          tone={tone}
        />
      </div>
    </Panel>
  );
}

function TradesPanel({ s }: { s: Crypto }) {
  const m = moneyOf(s);
  const rows = items(s.perf?.recent);
  const p = s.perf;
  return (
    <Panel
      title="Closed paper trades"
      icon={History}
      means="Newest first. R is the result as a multiple of the amount risked at the stop, after fees."
      action={<span className="text-muted-foreground text-xs">{num(p?.trades)} trades · {rMult(p?.total_r, 2)} · {m(p?.total_pnl)}</span>}
    >
      {rows.length === 0 ? (
        <Empty title="No closed trades yet">The kill switch is on, or no bar has met every entry condition.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Closed (UTC)</TableHead>
              <TableHead>Pair</TableHead>
              <TableHead>Exit</TableHead>
              <TableHead className="text-right">Held</TableHead>
              <TableHead className="text-right">Result</TableHead>
              <TableHead className="text-right">Paper P&amp;L</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t, i) => (
              <TableRow key={`${t.t}-${i}`}>
                <TableCell className="font-mono text-xs">{zoned(t.t, "UTC")}</TableCell>
                <TableCell>{t.pair}</TableCell>
                <TableCell>{code(t.reason)}</TableCell>
                <TableCell className="text-right font-mono">{num(t.held_min, 0)} min</TableCell>
                <TableCell className="text-right font-mono">{rMult(t.r, 2)}</TableCell>
                <TableCell className="text-right font-mono">{m(t.pnl)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function RefusedPanel({ s }: { s: Crypto }) {
  const why = Object.entries(s.activity?.refused_7d ?? {}).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  return (
    <Panel
      title="Signals and refusals, last 7 days"
      icon={ShieldX}
      means="How often every entry condition held, how many of those became paper entries, and why the rest were refused."
    >
      <div className="grid gap-4">
        <KeyValues
          items={[
            { label: "Bars observed", value: num(s.activity?.observations_7d) },
            { label: "Entry signals", value: num(s.activity?.fires_7d) },
            { label: "Paper entries", value: num(s.activity?.entries_7d) },
          ]}
        />
        {why.length === 0 ? (
          <p className="text-muted-foreground text-sm">No signal was refused.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {why.map(([k, n]) => (
              <li key={k} className="flex justify-between gap-3">
                <span>{code(k)}</span>
                <span className="font-mono">{num(n)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
