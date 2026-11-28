import { BellRing, Bot, CalendarClock, ChevronDown, Power } from "lucide-react";
import { AccountLimitsPanel, AccountRecentPanel, AccountTodayPanel, EnforcementNote } from "@/components/account-risk";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { Empty } from "@/components/empty";
import { NoJournal } from "@/components/journal";
import { KeyValues } from "@/components/kv";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { RobotsRow } from "@/components/robots-row";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertHistoryPanel } from "@/components/v3/audit";
import { accountRisk } from "@/lib/account-risk";
import { newYork, shortDate, sydney, txt } from "@/lib/format";
import { anyKillOn, deskKills, killOverall } from "@/lib/kill";
import { activeWindow } from "@/lib/freshness";
import { moneyView, type JournalDoc } from "@/lib/journal";
import type { OptionsClone } from "@/lib/options-clone.types";
import { robotLines } from "@/lib/programme";
import { alertTitle, isRedAlert } from "@/lib/robots";
import { loadJournal, loadOptionsClone, loadSnapshot, pageTime } from "@/lib/snapshot";
import { list, type Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Risk" };

export default async function RiskPage() {
  const [result, journal, clone, now] = await Promise.all([loadSnapshot(), loadJournal(), loadOptionsClone(), pageTime()]);
  return (
    <>
      <PageHeading
        title="Risk"
        intro="Your real Webull account first: how much of today's limits you have used, what is open, and how often each limit was broken lately. The three paper robots, their alerts and the kill switch are at the bottom. Read only: nothing here can place, block or cancel an order."
      />
      {journal.status !== "ok" ? (
        <>
          <NoJournal status={journal.status} />
          <EnforcementNote />
        </>
      ) : (
        <PaneBoundary name="Your account">
          <AccountSection doc={journal.doc} now={now} />
        </PaneBoundary>
      )}
      {result.status !== "ok" ? (
        <NoSnapshot status={result.status} />
      ) : (
        <PaneBoundary name="The robots (paper)">
          <RobotsSection s={result.snapshot} clone={clone.status === "ok" ? clone.doc : null} now={now} />
        </PaneBoundary>
      )}
    </>
  );
}

function AccountSection({ doc, now }: { doc: JournalDoc; now: Date }) {
  const r = accountRisk(doc, now);
  const money = doc.money ? moneyView(doc.money, doc.trades.reduce((sum, t) => sum + t.pnl, 0)) : null;
  return (
    <>
      <AccountTodayPanel r={r} asOf={doc.as_of} now={now} />
      <AccountLimitsPanel r={r} />
      <AccountRecentPanel r={r} money={money} />
    </>
  );
}

/** True when a robot has something that needs a look: then the section opens by itself. */
function robotsNeedLook(s: Snapshot): boolean {
  return anyKillOn(s) === true || list(s.alerts?.firing).some((a) => isRedAlert(a.key));
}

/**
 * The paper robots' side of risk: the three of them in a line each, then what the host reports about them all (the
 * alerts that have not cleared, each desk's kill switch, when it expects to be awake). No money is shown here.
 */
function RobotsSection({ s, clone, now }: { s: Snapshot; clone: OptionsClone | null; now: Date }) {
  const alerts = list(s.alerts?.firing).length;
  const kill = anyKillOn(s);                      // every desk's file the snapshot carries, not the root one alone
  return (
    <>
      <RobotsRow lines={robotLines(s, clone)} />
      <details id="robots-safety" className="group grid gap-5" open={robotsNeedLook(s)}>
        <summary className="bg-card hover:bg-muted/40 flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 shadow-sm [&::-webkit-details-marker]:hidden">
          <Bot aria-hidden className="text-muted-foreground size-5 shrink-0" />
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="font-semibold">Robot alerts and the kill switch</span>
            <span className="text-muted-foreground text-xs">What the host reports about the paper robots. None of it touches your Webull account.</span>
          </span>
          <span className="flex flex-wrap gap-1.5">
            <StatusBadge tone={kill === true ? "warn" : kill === false ? "good" : "neutral"}>Kill switch {kill === true ? "on" : kill === false ? "off" : "unknown"}</StatusBadge>
            <StatusBadge tone={alerts === 0 ? "good" : "warn"}>{alerts === 0 ? "No alerts" : `${alerts} alert${alerts === 1 ? "" : "s"}`}</StatusBadge>
          </span>
          <ChevronDown aria-hidden className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-5 grid gap-5">
          <AlertsPanel s={s} />
          <KillPanel s={s} />
          <AlertHistoryPanel s={s} />
          <WindowsPanel s={s} now={now} />
        </div>
      </details>
    </>
  );
}

function KillPanel({ s }: { s: Snapshot }) {
  const k = s.kill;
  const rows = deskKills(s);
  const on = killOverall(rows);
  const word = (v: boolean | null) => (v === true ? "On: no new entries" : v === false ? "Off" : "Not sent");
  return (
    <Panel
      title="Kill switches"
      icon={Power}
      means="The root kill file is the master switch: every desk reads it. Each desk also has its own file, which stops that desk alone. The options clone's own file is not sent to this site (make status on the host shows every file). A desk whose file is on opens no new trades but keeps managing open ones. They are switched on the host, never from this page."
      action={
        on === true ? (
          <StatusBadge tone="warn">On</StatusBadge>
        ) : on === false ? (
          <StatusBadge tone="good">Off</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Unknown</StatusBadge>
        )
      }
    >
      <KeyValues
        className="sm:grid-cols-1"
        items={[
          ...rows.map((r) => ({ label: r.label, value: word(r.on) })),
          ...(k?.on ? [{ label: "Root KILL since", value: `${sydney(k.since)} Sydney` }] : []),
        ]}
      />
    </Panel>
  );
}

function AlertsPanel({ s }: { s: Snapshot }) {
  const alerts = list(s.alerts?.firing);
  return (
    <Panel
      title="Firing alerts"
      icon={BellRing}
      means="Alerts raised on the host that have not cleared. Position alerts are the most serious; job alerts usually clear on the next good run."
      action={<StatusBadge tone={alerts.length === 0 ? "good" : "warn"}>{alerts.length === 0 ? "None" : `${alerts.length} firing`}</StatusBadge>}
    >
      {alerts.length === 0 ? (
        <Empty icon={BellRing} title="No alerts are firing" />
      ) : (
        <ul className="divide-border grid divide-y">
          {alerts.map((a, i) => {
            const serious = isRedAlert(a.key);
            return (
              <li key={`${a.key}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                <StatusBadge tone={serious ? "bad" : "warn"}>{serious ? "Urgent" : "Check"}</StatusBadge>
                <span className="text-sm font-medium">{alertTitle(a.key, a.title)}</span>
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

function WindowsPanel({ s, now }: { s: Snapshot; now: Date }) {
  const windows = list(s.expected_windows);
  const active = activeWindow(windows, now.getTime());
  return (
    <Panel
      title="Expected activity windows"
      icon={CalendarClock}
      means="When the trading host is expected to be awake and publishing. Outside these windows silence is normal and nobody is paged. If the host stays silent past the last window it published, the watchdog assumes a window on every US weekday (07:30–18:00 New York) and pages then."
    >
      {windows.length === 0 ? (
        <Empty title="No trading window published ahead" />
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
