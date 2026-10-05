import { Activity, Filter, FlaskConical, Hourglass, ListOrdered, PlayCircle, Power } from "lucide-react";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { duration, newYork, num, rMult, shortDate, sydney } from "@/lib/format";
import { humanize, jobName, jobTone } from "@/lib/labels";
import { loadSnapshot } from "@/lib/snapshot";
import { detailLabel, eventLabel, scan, sessionJobs, type Scan } from "@/lib/today";
import { list, type Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Today" };

export default async function TodayPage() {
  const result = await loadSnapshot();
  return (
    <>
      <PageHeading
        title="Today"
        intro="What the stocks desk did in its latest session, in the order it happened: the pre-market scan, the paper session and the forward test. Nothing on this page is a real order."
      />
      {result.status !== "ok" ? (
        <NoSnapshot status={result.status} />
      ) : (
        <>
          <NowPanel s={result.snapshot} />
          <FunnelPanel v={scan(result.snapshot)} tradingDay={result.snapshot.market?.trading_day_et ?? null} />
          <CandidatesPanel v={scan(result.snapshot)} />
          <PaperPanel s={result.snapshot} />
          <ForwardPanel s={result.snapshot} />
          <ComingPanel />
        </>
      )}
    </>
  );
}

function NowPanel({ s }: { s: Snapshot }) {
  const jobs = sessionJobs(s);
  return (
    <Panel
      title="Now"
      icon={PlayCircle}
      means="Where the session is, and the last run of each of its three jobs. Times are New York, with Sydney beside them."
      action={<StatusBadge tone="info">{humanize(s.market?.phase) || "Unknown phase"}</StatusBadge>}
    >
      <div className="grid gap-4">
        <KeyValues
          items={[
            { label: "Trading day (New York)", value: shortDate(s.market?.trading_day_et) },
            { label: "New York", value: s.market?.et ?? "—" },
            { label: "Sydney", value: s.market?.sydney ?? "—" },
          ]}
        />
        <ul className="divide-border grid divide-y">
          {jobs.map((j) => (
            <li key={j.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1 text-sm font-medium">{jobName(j.key)}</span>
              <span className="text-muted-foreground text-xs">
                {j.started ? `${newYork(j.started)} NY (${sydney(j.started, false)} Sydney)` : "no run yet"}
                {j.started && j.ended ? `, took ${duration(j.started, j.ended)}` : ""}
              </span>
              <StatusBadge tone={jobTone(j.status)}>{j.status === "running" ? "Running now" : humanize(j.status) || "No run yet"}</StatusBadge>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function FunnelPanel({ v, tradingDay }: { v: Scan; tradingDay: string | null }) {
  const scans = v.stages.filter((x) => x.key !== "signals");
  const signals = v.stages.find((x) => x.key === "signals");
  return (
    <Panel
      title="Pre-market scan"
      icon={Filter}
      means="Each stage re-scans the whole market and narrows it: every listed stock, those trading before the open, those gapping up, the ones that pass every filter, and the short list. It is a dry run: nothing here becomes an order."
      action={v.date ? <span className="text-muted-foreground text-xs">Session {shortDate(v.date)}</span> : undefined}
    >
      {scans.length === 0 ? (
        <Empty title="No scan has been published yet">The routine starts at 07:30 New York on trading days; its first scan lands just after 08:00.</Empty>
      ) : (
        <div className="grid gap-4">
          {!v.current ? (
            <Empty icon={Hourglass} title={`No scan yet for ${shortDate(tradingDay)}`}>
              Showing the latest one, from {shortDate(v.date)}. Today&apos;s first scan lands just after 08:00 New York.
            </Empty>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stage</TableHead>
                <TableHead>At (NY)</TableHead>
                <TableHead className="text-right">Universe</TableHead>
                <TableHead className="text-right">Trading pre-market</TableHead>
                <TableHead className="text-right">Gapping up</TableHead>
                <TableHead className="text-right">Candidates</TableHead>
                <TableHead className="text-right">Short list</TableHead>
                <TableHead className="text-right">Trade plans</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scans.map((x) => (
                <TableRow key={x.key}>
                  <TableCell>
                    <span className="font-medium">{x.label}</span>
                    <span className="text-muted-foreground block text-xs">{x.does}</span>
                  </TableCell>
                  <TableCell className="font-mono">{x.at ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono">{num(x.universe)}</TableCell>
                  <TableCell className="text-right font-mono">{num(x.traded)}</TableCell>
                  <TableCell className="text-right font-mono">{num(x.gapping)}</TableCell>
                  <TableCell className="text-right font-mono">{num(x.candidates)}</TableCell>
                  <TableCell className="text-right font-mono">{num(x.shortList)}</TableCell>
                  <TableCell className="text-right font-mono">{num(x.tickets)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {signals ? (
            <p className="text-muted-foreground text-[0.8125rem]">
              After the open (11:31 New York): {num(signals.signals)} of the short-listed plans would have triggered.
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function CandidatesPanel({ v }: { v: Scan }) {
  return (
    <Panel
      title="Candidates"
      icon={ListOrdered}
      means="The stocks that passed every filter in the newest scan, best score first. A candidate is something the routine would look at, not something it bought."
    >
      {v.candidates.length === 0 ? (
        <Empty title={v.stages.length > 0 ? "No stock passed every filter" : "No scan yet"}>
          {v.stages.length > 0 ? "That is a normal result on a quiet morning." : null}
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ticker</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead>Went further?</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {v.candidates.map((c) => (
              <TableRow key={c.symbol}>
                <TableCell className="font-mono font-medium">{c.symbol}</TableCell>
                <TableCell className="text-right font-mono">{num(c.score, 2)}</TableCell>
                <TableCell>
                  {c.primary ? (
                    <StatusBadge tone="info">Primary pick</StatusBadge>
                  ) : c.shortListed ? (
                    <StatusBadge tone="info">Short-listed</StatusBadge>
                  ) : (
                    <span className="text-muted-foreground text-[0.8125rem]">Candidate only</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function PaperPanel({ s }: { s: Snapshot }) {
  const p = s.ops?.paper;
  const recent = list(p?.recent).slice().reverse();
  const killed = s.kill?.on === true;
  return (
    <Panel
      title="Paper B session"
      icon={Activity}
      means="The one strategy that runs live against the paper broker: it watches QQQ and would trade QQQM. This is its own log of what it did, newest first."
      action={killed ? <StatusBadge tone="warn" icon={Power}>Kill switch on</StatusBadge> : <StatusBadge tone="good">Entries allowed</StatusBadge>}
    >
      <div className="grid gap-4">
        <p className="text-sm">
          {killed
            ? "The kill switch is on, so it records what it would do and places no order."
            : "The kill switch is off: it may place paper orders when its rules are met."}{" "}
          {num(p?.trades)} paper {p?.trades === 1 ? "trade has" : "trades have"} been closed so far.
        </p>
        {recent.length === 0 ? (
          <Empty title="No runner events yet" />
        ) : (
          <ul className="divide-border grid divide-y">
            {recent.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="grid gap-0.5 py-2 first:pt-0 last:pb-0 sm:grid-cols-[11rem_1fr] sm:gap-3">
                <span className="text-muted-foreground font-mono text-xs">
                  {newYork(e.ts)} NY
                </span>
                <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                  {eventLabel(e.event)}
                  {e.detail ? <span className="text-muted-foreground">: {detailLabel(e.detail)}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function ForwardPanel({ s }: { s: Snapshot }) {
  const f = s.ops?.forward;
  const rows = list(f?.strategies);
  return (
    <Panel
      title="Forward test"
      icon={FlaskConical}
      means="After the close, every frozen strategy is replayed on the day's real prices. These are simulated trades, counted since the test began; the per-day view comes with the next update."
      action={f?.last ? <span className="text-muted-foreground text-xs">Last session {shortDate(f.last)}</span> : undefined}
    >
      {rows.length === 0 ? (
        <Empty title="No forward results yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Strategy</TableHead>
              <TableHead className="text-right">Simulated trades</TableHead>
              <TableHead className="text-right">Average</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.strategy}>
                <TableCell className="font-mono text-xs">{r.strategy}</TableCell>
                <TableCell className="text-right font-mono">{num(r.n)}</TableCell>
                <TableCell className="text-right font-mono">{rMult(r.mean_r, 2)}</TableCell>
                <TableCell className="text-right font-mono">{rMult(r.total_r, 2)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function ComingPanel() {
  return (
    <Empty icon={Hourglass} title="More detail arrives with the next publisher update">
      Still to come on this page: why each stock was dropped, each candidate&apos;s chart checks and news, the dry-run
      trade plans, every moment Paper B would have traded, and the forward test&apos;s trades for the day.
    </Empty>
  );
}
