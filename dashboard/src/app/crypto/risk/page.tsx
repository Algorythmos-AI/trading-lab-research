import { BellRing, Link2, Lock, Power, Scale, Wallet } from "lucide-react";
import { NoCryptoSnapshot } from "@/components/crypto/panels";
import { Empty } from "@/components/empty";
import { Meter } from "@/components/meter";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { aud, items, type Crypto } from "@/lib/crypto";
import { num, shortDate, signed, sydney, zoned } from "@/lib/format";
import { loadCryptoSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Crypto risk" };

export default async function CryptoRiskPage() {
  const result = await loadCryptoSnapshot();
  return (
    <>
      <PageHeading
        title="Risk"
        intro="The controls around the crypto paper book: its own kill switch, the daily loss latch, the entry limits and how much of each is used today (UTC)."
      />
      {result.status !== "ok" ? (
        <NoCryptoSnapshot status={result.status} />
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-3">
            <KillPanel s={result.snapshot} />
            <LatchPanel s={result.snapshot} />
            <ChainPanel s={result.snapshot} />
          </div>
          <LimitsPanel s={result.snapshot} />
          <PositionsPanel s={result.snapshot} />
          <AlertsPanel s={result.snapshot} />
        </>
      )}
    </>
  );
}

function KillPanel({ s }: { s: Crypto }) {
  const k = s.kill;
  return (
    <Panel
      title="Kill switch"
      icon={Power}
      means="The crypto desk's own switch. When on, it opens no positions but keeps recording bars and managing exits. It is switched on the host."
      action={k?.on === true ? <StatusBadge tone="warn">On</StatusBadge> : k?.on === false ? <StatusBadge tone="good">Off</StatusBadge> : <StatusBadge tone="neutral">Unknown</StatusBadge>}
    >
      {k?.on ? <p className="text-sm">Since {sydney(k.since)} Sydney.</p> : <p className="text-muted-foreground text-sm">New entries are allowed.</p>}
    </Panel>
  );
}

function LatchPanel({ s }: { s: Crypto }) {
  const on = s.risk?.latched;
  return (
    <Panel
      title="Daily loss latch"
      icon={Lock}
      means="Set when a UTC day's realised loss reaches the limit. Entries then stay off, on later days too, until the owner resets it."
      action={on === true ? <StatusBadge tone="bad">Latched</StatusBadge> : on === false ? <StatusBadge tone="good">Clear</StatusBadge> : <StatusBadge tone="neutral">Unknown</StatusBadge>}
    >
      <p className="text-muted-foreground text-sm">
        Limit {aud(s.risk?.limits?.daily_loss_latch)} a day. Realised today: {aud(s.risk?.today?.realised)}.
      </p>
    </Panel>
  );
}

function ChainPanel({ s }: { s: Crypto }) {
  const ok = s.risk?.chain_ok;
  return (
    <Panel
      title="Evidence chain"
      icon={Link2}
      means="Every decision is a line in a hash-chained journal, checked and anchored off the host each night. A break switches this desk's entries off."
      action={ok === true ? <StatusBadge tone="good">Intact</StatusBadge> : ok === false ? <StatusBadge tone="bad">Broken</StatusBadge> : <StatusBadge tone="neutral">Unknown</StatusBadge>}
    >
      <p className="text-muted-foreground text-sm">{ok === false ? "Entries are off until the owner clears it." : "No break has been flagged."}</p>
    </Panel>
  );
}

function LimitsPanel({ s }: { s: Crypto }) {
  const l = s.risk?.limits;
  const t = s.risk?.today;
  return (
    <Panel title="Limits in force" icon={Scale} means="Hard limits on new entries, checked before every paper order. An exit is never blocked by any of them.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Meter label="Open exposure" value={s.book?.exposure} max={l?.max_open_exposure} valueText={`${aud(s.book?.exposure)} of ${aud(l?.max_open_exposure, 0)}`} />
        <Meter label={`Entries today (${shortDate(t?.day)})`} value={t?.entries} max={l?.max_entries_per_day} valueText={`${num(t?.entries)} of ${num(l?.max_entries_per_day)}`} />
        <Meter label="Orders today" value={t?.orders} max={l?.max_orders_per_day} valueText={`${num(t?.orders)} of ${num(l?.max_orders_per_day)}`} />
        <Meter
          label="Realised loss today against the latch"
          value={Math.max(0, -(t?.realised ?? 0))}
          max={l?.daily_loss_latch}
          tone="warn"
          valueText={`${aud(t?.realised)} (latch at −${aud(l?.daily_loss_latch, 0)})`}
        />
      </div>
      <p className="text-muted-foreground mt-4 text-xs">At most {aud(l?.max_notional, 0)} per entry.</p>
    </Panel>
  );
}

function PositionsPanel({ s }: { s: Crypto }) {
  const rows = items(s.book?.positions);
  return (
    <Panel
      title="Paper book"
      icon={Wallet}
      means="Open paper positions with their stop and target. Fills are simulated at the quote with fee and slippage; nothing is sent to the venue."
      action={<span className="text-muted-foreground text-xs">Equity {aud(s.book?.equity)} · cash {aud(s.book?.cash)}</span>}
    >
      {rows.length === 0 ? (
        <Empty title="No open position" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pair</TableHead>
              <TableHead>Opened (UTC)</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Entry</TableHead>
              <TableHead className="text-right">Stop</TableHead>
              <TableHead className="text-right">Target</TableHead>
              <TableHead className="text-right">Now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.pair}>
                <TableCell className="font-medium">{p.pair}</TableCell>
                <TableCell className="font-mono text-xs">{zoned(p.entry_time, "UTC")}</TableCell>
                <TableCell className="text-right font-mono">{num(p.qty, 6)}</TableCell>
                <TableCell className="text-right font-mono">{num(p.entry_price, 2)}</TableCell>
                <TableCell className="text-right font-mono">{num(p.stop, 2)}</TableCell>
                <TableCell className="text-right font-mono">{num(p.target, 2)}</TableCell>
                <TableCell className="text-right font-mono">{p.unrealised_pct == null ? "—" : `${signed(p.unrealised_pct, 2)}%`}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

const ALERT: Record<string, string> = {
  "crypto:data-stale": "No market data from the venue",
  "crypto:latch": "Daily loss limit reached",
  "crypto:evidence-chain": "Evidence chain broken",
};

function AlertsPanel({ s }: { s: Crypto }) {
  const rows = items(s.alerts?.firing);
  return (
    <Panel title="Firing alerts" icon={BellRing} means="Alerts raised by the crypto desk that have not cleared. The stocks desk's alerts are on its own Risk page.">
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No alerts are firing.</p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {rows.map((a) => (
            <li key={a.key} className="flex flex-wrap justify-between gap-x-3">
              <span>{ALERT[a.key ?? ""] ?? (a.key?.startsWith("crypto:exit-gap") ? "An open position has an unobserved gap" : a.key)}</span>
              <span className="text-muted-foreground">since {sydney(a.since)} Sydney</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
