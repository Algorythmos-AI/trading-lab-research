import { BellRing, CalendarClock, Landmark, Lock, Power, ShieldCheck } from "lucide-react";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertHistoryPanel } from "@/components/v3/audit";
import { RiskLimitsPanel } from "@/components/v3/risk-limits";
import { newYork, num, shortDate, sydney, txt, usd } from "@/lib/format";
import { RED_ALERT_PREFIXES } from "@/lib/health";
import { activeWindow } from "@/lib/freshness";
import { requestTime } from "@/lib/now";
import { loadSnapshot } from "@/lib/snapshot";
import { list, type Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Risk" };

export default async function RiskPage() {
  const result = await loadSnapshot();
  const now = requestTime();
  return (
    <>
      <PageHeading
        title="Risk"
        intro="The safety controls around paper trading: the kill switch, the virtual account latch, progress towards the G2 gate, the paper broker account and any alerts that are firing."
      />
      {result.status !== "ok" ? (
        <NoSnapshot status={result.status} />
      ) : (
        <>
          <RiskLimitsPanel s={result.snapshot} />
          <div className="grid gap-5 lg:grid-cols-3">
            <KillPanel s={result.snapshot} />
            <LatchPanel s={result.snapshot} />
            <G2Panel s={result.snapshot} />
          </div>
          <AlertsPanel s={result.snapshot} />
          <AlertHistoryPanel s={result.snapshot} />
          <AccountPanel s={result.snapshot} />
          <WindowsPanel s={result.snapshot} now={now} />
        </>
      )}
    </>
  );
}

function KillPanel({ s }: { s: Snapshot }) {
  const k = s.kill;
  return (
    <Panel
      title="Kill switch"
      icon={Power}
      means="When on, paper B opens no new trades but keeps managing open ones. It is switched on the Mac, never from this page."
      action={
        k?.on === true ? (
          <StatusBadge tone="warn">On</StatusBadge>
        ) : k?.on === false ? (
          <StatusBadge tone="good">Off</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Unknown</StatusBadge>
        )
      }
    >
      {k?.on ? (
        <KeyValues
          className="sm:grid-cols-1"
          items={[
            { label: "Since", value: `${sydney(k.since)} Sydney` },
            { label: "Reason", value: txt(k.reason) },
          ]}
        />
      ) : (
        <p className="text-muted-foreground text-sm">New entries are allowed.</p>
      )}
    </Panel>
  );
}

function LatchPanel({ s }: { s: Snapshot }) {
  const v = s.ops?.paper?.virtual;
  return (
    <Panel
      title="Virtual account latch"
      icon={Lock}
      means="The paper runner locks itself (latches) after a loss limit or an unexpected state, and stays locked until the owner resets it on the Mac."
      action={
        v?.latched === true ? (
          <StatusBadge tone="bad">Latched</StatusBadge>
        ) : v?.latched === false ? (
          <StatusBadge tone="good">Clear</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Unknown</StatusBadge>
        )
      }
    >
      {v?.latched ? (
        <p className="text-sm">{txt(v.latch_reason)}</p>
      ) : (
        <p className="text-muted-foreground text-sm">The runner is not locked.</p>
      )}
    </Panel>
  );
}

function G2Panel({ s }: { s: Snapshot }) {
  const g2 = s.ops?.paper?.g2;
  return (
    <Panel
      title="G2 paper evidence"
      icon={ShieldCheck}
      means="Paper trading must reach these counts before any real-money step can even be considered."
    >
      <div className="grid gap-4">
        <Meter label="Trades" value={g2?.trades} max={g2?.trades_needed} valueText={`${num(g2?.trades)} of ${num(g2?.trades_needed)}`} />
        <Meter
          label="Sessions"
          value={g2?.sessions}
          max={g2?.sessions_needed}
          valueText={`${num(g2?.sessions)} of ${num(g2?.sessions_needed)}`}
        />
      </div>
    </Panel>
  );
}

function AlertsPanel({ s }: { s: Snapshot }) {
  const alerts = list(s.alerts?.firing);
  return (
    <Panel
      title="Firing alerts"
      icon={BellRing}
      means="Alerts raised on the Mac that have not cleared. Position alerts are the most serious; job alerts usually clear on the next good run."
      action={<StatusBadge tone={alerts.length === 0 ? "good" : "warn"}>{alerts.length === 0 ? "None" : `${alerts.length} firing`}</StatusBadge>}
    >
      {alerts.length === 0 ? (
        <Empty icon={BellRing} title="No alerts are firing" />
      ) : (
        <ul className="divide-border grid divide-y">
          {alerts.map((a, i) => {
            const serious = RED_ALERT_PREFIXES.some((p) => (a.key ?? "").startsWith(p));
            return (
              <li key={`${a.key}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                <StatusBadge tone={serious ? "bad" : "warn"}>{serious ? "Urgent" : "Check"}</StatusBadge>
                <span className="text-sm font-medium">{txt(a.title)}</span>
                <span className="text-muted-foreground font-mono text-xs">{txt(a.key)}</span>
                <span className="text-muted-foreground ml-auto text-xs">Since {sydney(a.since)} Sydney</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function AccountPanel({ s }: { s: Snapshot }) {
  const a = s.ops?.account;
  const positions = list(a?.positions);
  return (
    <Panel
      title="Paper broker account"
      icon={Landmark}
      means="Paper money: the simulated account at the broker that paper B trades in. None of these amounts are real funds."
      action={
        <div className="flex flex-wrap justify-end gap-1.5">
          <StatusBadge tone="info">Paper money</StatusBadge>
          {a?.trading_blocked === true ? <StatusBadge tone="bad">Trading blocked</StatusBadge> : null}
        </div>
      }
    >
      {!a ? (
        <Empty title="No account snapshot">The collector did not read the paper account this time.</Empty>
      ) : (
        <div className="grid gap-5">
          {a.paper === false ? (
            <p className="text-bad text-sm font-medium">This account is not flagged as paper. Check the collector configuration.</p>
          ) : null}
          <KeyValues
            className="sm:grid-cols-4"
            items={[
              { label: "Equity (paper)", value: usd(a.equity) },
              { label: "Previous close equity", value: usd(a.last_equity) },
              { label: "Cash (paper)", value: usd(a.cash) },
              { label: "Buying power (paper)", value: usd(a.buying_power) },
              { label: "Status", value: txt(a.status) },
              { label: "Trading blocked", value: a.trading_blocked === true ? "Yes" : a.trading_blocked === false ? "No" : "—" },
              { label: "Day trades (5 days)", value: num(a.daytrade_count) },
              {
                label: "Pattern day trader",
                value: a.pattern_day_trader === true ? "Yes" : a.pattern_day_trader === false ? "No" : "—",
              },
              { label: "Market open at snapshot", value: a.market_is_open === true ? "Yes" : a.market_is_open === false ? "No" : "—" },
              { label: "Next open", value: `${newYork(a.next_open)} NY` },
              { label: "Next close", value: `${newYork(a.next_close)} NY` },
            ]}
          />
          <div>
            <h3 className="mb-1 text-sm font-medium">Open positions (paper)</h3>
            {positions.length === 0 ? (
              <p className="text-muted-foreground text-sm">No open positions: the account is flat.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Mandate</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Market value</TableHead>
                    <TableHead className="text-right">Unrealised P/L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {positions.map((p, i) => (
                    <TableRow key={`${p.symbol}-${i}`}>
                      <TableCell className="font-mono text-xs font-medium">{txt(p.symbol)}</TableCell>
                      <TableCell>
                        {p.in_mandate === true ? (
                          <StatusBadge tone="good">Strategy B</StatusBadge>
                        ) : p.legacy === true ? (
                          <StatusBadge tone="neutral">Legacy (accepted)</StatusBadge>
                        ) : p.in_mandate === false ? (
                          <StatusBadge tone="bad">Outside mandate</StatusBadge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right">{num(p.qty, 0)}</TableCell>
                      <TableCell className="text-right">{usd(p.market_value)}</TableCell>
                      <TableCell
                        className={
                          typeof p.unrealized_pl === "number" && p.unrealized_pl < 0 ? "text-bad text-right" : "text-right"
                        }
                      >
                        {usd(p.unrealized_pl)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function WindowsPanel({ s, now }: { s: Snapshot; now: Date }) {
  const windows = list(s.expected_windows);
  const active = activeWindow(windows, now.getTime());
  return (
    <Panel
      title="Expected activity windows"
      icon={CalendarClock}
      means="When the Mac is expected to be awake and publishing. Outside these windows silence is normal and nobody is paged."
    >
      {windows.length === 0 ? (
        <Empty title="No trading window in the next 48 hours" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Starts (Sydney)</TableHead>
              <TableHead>Ends (Sydney)</TableHead>
              <TableHead>New York</TableHead>
              <TableHead>Now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {windows.map((w, i) => (
              <TableRow key={`${w.session}-${i}`}>
                <TableCell className="font-medium">{shortDate(w.session)}</TableCell>
                <TableCell>{sydney(w.start)}</TableCell>
                <TableCell>{sydney(w.end)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {newYork(w.start, false)} to {newYork(w.end, false)}
                </TableCell>
                <TableCell>{active === w ? <StatusBadge tone="info">In window</StatusBadge> : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
