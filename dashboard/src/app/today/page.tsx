import { Activity, Filter, FlaskConical, Hourglass, ListOrdered, PlayCircle, Power } from "lucide-react";
import { Funnel } from "@/components/charts/funnel";
import { Empty } from "@/components/empty";
import { SessionClock } from "@/components/today/session-clock";
import { OutcomePanel, PnlPanel, TradesPanel } from "@/components/today/trading";
import { KeyValues } from "@/components/kv";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { duration, newYork, num, rMult, shortDate, sydney } from "@/lib/format";
import { humanize, jobName, jobTone } from "@/lib/labels";
import { loadSnapshot } from "@/lib/snapshot";
import { detailLabel, eventLabel, scan, sessionClock, sessionJobs, type Scan, type Why } from "@/lib/today";
import { trading } from "@/lib/trading";
import { list, type Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Today" };

export default async function TodayPage() {
  const result = await loadSnapshot();
  return (
    <>
      <PageHeading
        title="Today"
        intro="What the stocks desk did in its latest session: whether Paper B traded and what it made or lost, then the pre-market scan, the paper session log and the forward test. Paper money only: nothing on this page is a real order."
      />
      {result.status !== "ok" ? (
        <NoSnapshot status={result.status} />
      ) : (
        <>
          <NowPanel s={result.snapshot} />
          <TradingPanels s={result.snapshot} />
          <FunnelPanel v={scan(result.snapshot)} tradingDay={result.snapshot.market?.trading_day_et ?? null} />
          <WhyPanel w={scan(result.snapshot).why} />
          <CandidatesPanel v={scan(result.snapshot)} />
          <PaperPanel s={result.snapshot} />
          <ForwardPanel s={result.snapshot} />
          <ComingPanel />
        </>
      )}
    </>
  );
}

/** Paper B's outcome, profit and loss and trades. Shown once the host publishes the `today` section. */
function TradingPanels({ s }: { s: Snapshot }) {
  const v = trading(s);
  if (!v.available) return null;
  return (
    <>
      <OutcomePanel v={v} asOf={s.as_of} />
      <PnlPanel v={v} />
      <TradesPanel v={v} />
    </>
  );
}

function NowPanel({ s }: { s: Snapshot }) {
  const jobs = sessionJobs(s);
  const clock = sessionClock(s);
  return (
    <Panel
      title="Now"
      icon={PlayCircle}
      means="Where the session is, and the last run of each of its three jobs. Dashed tick: when a job is due. Bar: when it ran that day. Times are New York."
      action={<StatusBadge tone="info">{humanize(s.market?.phase) || "Unknown phase"}</StatusBadge>}
    >
      <div className="grid gap-4">
        <SessionClock day={clock.day} runs={clock.runs} />
        <details>
          <summary className="text-muted-foreground cursor-pointer text-xs">Times, with Sydney</summary>
          <div className="mt-3 grid gap-4">
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
        </details>
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

/** Why the gapping names went no further, from the newest scan. Nothing is drawn until a host publishes the counts. */
function WhyPanel({ w }: { w: Why | null }) {
  if (!w) return null;
  const kept = w.steps[0]?.count ?? 0;
  const dropped = kept - (w.steps[1]?.count ?? 0);
  return (
    <Panel
      title="Why names went no further"
      icon={Filter}
      means="The newest scan, step by step: how many gapping names passed every filter, became candidates, passed the chart checks and made the short list, and which rule stopped the rest. This is the scan as it saw the market at that minute; the after-close record can differ."
      action={w.at ? <span className="text-muted-foreground text-xs">Scan at {w.at} New York</span> : undefined}
    >
      {w.failed && w.steps.length === 0 ? (
        <Empty title="The scan could not build this record">The stage itself ran; only its explanation is missing.</Empty>
      ) : (
        <div className="grid gap-5">
          <Funnel label="Names at each step of the newest scan" rows={w.steps.map((x) => ({ key: x.code, label: x.label, count: x.count }))} />
          {w.reasons.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-[0.8125rem]">
                {num(dropped)} of {num(kept)} gapping names failed a filter. A name can fail more than one; &ldquo;only this&rdquo; counts the names that
                failed nothing else.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Filter</TableHead>
                    <TableHead className="text-right">Failed it</TableHead>
                    <TableHead className="text-right">Only this</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {w.reasons.map((r) => (
                    <TableRow key={r.code}>
                      <TableCell>{r.label}</TableCell>
                      <TableCell className="text-right font-mono">{num(r.count)}</TableCell>
                      <TableCell className="text-right font-mono">{num(r.only)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          {w.chart.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-[0.8125rem]">Candidates the chart checks stopped, by check:</p>
              <Funnel label="Candidates stopped by each chart check" rows={w.chart.map((x) => ({ key: x.code, label: x.label, count: x.count, fill: "bg-chart-2" }))} />
            </div>
          ) : null}
          {w.band.length > 0 ? (
            <p className="text-muted-foreground text-[0.8125rem]">
              Priced US$2 to US$20: {w.band.map((x) => `${num(x.count)} ${x.label.toLowerCase()}`).join(", ")}. A count beside the scan&apos;s own price
              band; it selects nothing.
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
      trade plans, and the forward test&apos;s trades for the day.
    </Empty>
  );
}
