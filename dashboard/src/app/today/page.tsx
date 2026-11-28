import { Filter, FlaskConical, Hourglass, ListOrdered, PlayCircle } from "lucide-react";
import { Funnel } from "@/components/charts/funnel";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { Empty } from "@/components/empty";
import { SessionClock } from "@/components/today/session-clock";
import { KeyValues } from "@/components/kv";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { RobotsRow } from "@/components/robots-row";
import { StatusBadge } from "@/components/status";
import { EnvFrame } from "@/components/ui/env-chip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { duration, newYork, num, rMult, shortDate, sydney } from "@/lib/format";
import { humanize, jobTone } from "@/lib/labels";
import { jobName } from "@/lib/robots";
import { loadGapHunterLive, loadJournal, loadLedger, loadOptions, loadOptionsClone, loadRadar, loadSnapshot, pageTime } from "@/lib/snapshot";
import { robotLines } from "@/lib/programme";
import { LedgerLine } from "@/components/ledger";
import { NoJournal } from "@/components/journal";
import { NextSessionPanel } from "@/components/overview/home";
import { SafetyTiles } from "@/components/today/safety-tiles";
import { YourDay } from "@/components/today/your-day";
import { near, ofRecord, scan, sessionClock, sessionJobs, type Near, type Scan, type Why } from "@/lib/today";
import { list, type Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Today" };

export default async function TodayPage() {
  const [result, journal, options, radar, now, ledger, clone, gapLive] = await Promise.all([loadSnapshot(), loadJournal(), loadOptions(), loadRadar(), pageTime(), loadLedger(), loadOptionsClone(), loadGapHunterLive()]);
  return (
    <>
      <PageHeading
        title="Today"
        intro="Your trading day as it happens: first the safety switches, then every trade on the New York clock, the day's running result and how much room the day rules leave, then the names to watch. Below, the three paper robots in a line each, the session's jobs and the morning's pre-market scan. Nothing on this page can place an order."
      />
      <PaneBoundary name="Safety switches">
        <SafetyTiles s={result.status === "ok" ? result.snapshot : null} clone={clone.status === "ok" ? clone.doc : null} gapLive={gapLive} nowMs={now.getTime()} />
      </PaneBoundary>
      {journal.status === "ok" ? (
        <PaneBoundary name="Your day">
          <YourDay doc={journal.doc} now={now} />
        </PaneBoundary>
      ) : (
        <NoJournal status={journal.status} />
      )}
      {ledger.status === "ok" ? (
        <PaneBoundary name="Card scored">
          <LedgerLine e={ledger.edition} />
        </PaneBoundary>
      ) : null}
      <PaneBoundary name="Next session">
        <NextSessionPanel options={options.status === "ok" ? options.edition : null} radar={radar.status === "ok" ? radar.edition : null} />
      </PaneBoundary>
      {/* The robots in a line each, then the session's jobs on the New York clock. The forward test replays frozen
          strategies and is a model (a model frame). The pre-market scan is the routine's dry-run scan of gapping
          stocks: counts only, no money, so unframed. */}
      {result.status !== "ok" ? (
        <NoSnapshot status={result.status} />
      ) : (
        <>
          <PaneBoundary name="The robots">
            <RobotsRow lines={robotLines(result.snapshot, clone.status === "ok" ? clone.doc : null)} note="Each robot's detail is on its own page. All three use paper or simulated money, never your Webull account." />
          </PaneBoundary>
          <PaneBoundary name="Now">
            <NowPanel s={result.snapshot} />
          </PaneBoundary>
          <details className="group grid gap-5" data-testid="forward-detail">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm font-medium">The forward test (model): every frozen strategy replayed after the close</summary>
            <div className="mt-5 grid gap-5">
              <EnvFrame env="model" label="Forward test" className="grid gap-5">
                <PaneBoundary name="Forward test">
                  <ForwardPanel s={result.snapshot} />
                </PaneBoundary>
                <PaneBoundary name="Of record">
                  <OfRecordPanel s={result.snapshot} />
                </PaneBoundary>
              </EnvFrame>
            </div>
          </details>
          <h2 className="text-muted-foreground mt-2 flex items-center gap-2 text-sm font-semibold">
            <Filter aria-hidden className="size-4" />
            Pre-market scan
          </h2>
          <PaneBoundary name="Scanner funnel">
            <FunnelFrom s={result.snapshot} />
          </PaneBoundary>
          <details className="group grid gap-5" data-testid="scan-detail">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm font-medium">
              More from the scan: why names went no further, near misses and the candidates
            </summary>
            <div className="mt-5 grid gap-5">
              <PaneBoundary name="Why no trade">
                <WhyFrom s={result.snapshot} />
              </PaneBoundary>
              <PaneBoundary name="Near misses">
                <NearFrom s={result.snapshot} />
              </PaneBoundary>
              <PaneBoundary name="Candidates">
                <CandidatesFrom s={result.snapshot} />
              </PaneBoundary>
              <ComingPanel />
            </div>
          </details>
        </>
      )}
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
      means="Where the session is, and the last run of each of its jobs. Dashed tick: when a job is due. Bar: when it ran that day. Times are New York."
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

// The snapshot is read inside each pane, so a malformed scan or near-miss record fails its own pane, not the page.
function FunnelFrom({ s }: { s: Snapshot }) {
  return <FunnelPanel v={scan(s)} tradingDay={s.market?.trading_day_et ?? null} />;
}
function WhyFrom({ s }: { s: Snapshot }) {
  return <WhyPanel w={scan(s).why} />;
}
function NearFrom({ s }: { s: Snapshot }) {
  return <NearPanel n={near(s)} />;
}
function CandidatesFrom({ s }: { s: Snapshot }) {
  return <CandidatesPanel v={scan(s)} />;
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
          <Table label="Pre-market scan stages">
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
              <Table label="Why names went no further">
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
              Priced $2 to $20 a share: {w.band.map((x) => `${num(x.count)} ${x.label.toLowerCase()}`).join(", ")}. A count beside the scan&apos;s own price
              band; it selects nothing.
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function NearPanel({ n }: { n: Near | null }) {
  if (!n) return null;
  return (
    <Panel
      title="Near misses"
      icon={Filter}
      means="Gapping names that failed exactly one filter in the newest scan, and which one. A list to look at, not a watch list: no result is measured on these names."
      action={<span className="text-muted-foreground text-xs">{n.total > n.rows.length ? `${num(n.rows.length)} of ${num(n.total)}` : `${num(n.total)}`}</span>}
    >
      {n.rows.length === 0 ? (
        <Empty title="No name failed just one filter" />
      ) : (
        <Table label="Near misses">
          <TableHeader>
            <TableRow>
              <TableHead>Ticker</TableHead>
              {/* A share price, not money held: written without US$, which on these pages means the paper account. */}
              <TableHead className="text-right">Share price</TableHead>
              <TableHead>The one filter it failed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {n.rows.map((r) => (
              <TableRow key={r.symbol}>
                <TableCell className="font-mono text-xs">{r.symbol}</TableCell>
                <TableCell className="text-right font-mono">{num(r.price, 2)}</TableCell>
                <TableCell>{r.label}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

/** The forward test's own funnel. Kept in its own panel: it reads the after-close pool, the scan above read the
 * morning as it happened, and the two are never added together. */
function OfRecordPanel({ s }: { s: Snapshot }) {
  const r = ofRecord(s);
  if (!r) return null;
  return (
    <Panel
      title="Funnel of record"
      icon={FlaskConical}
      means="The same steps as the morning scan, counted again after the close on the complete data the forward test's trials read. This is the record the trials are judged on; the morning scan is what could be seen at the time."
      action={r.session ? <span className="text-muted-foreground text-xs">Session {shortDate(r.session)}</span> : undefined}
    >
      <div className="grid gap-3">
        <Funnel label="Names at each step of the funnel of record" rows={r.why.steps.map((x) => ({ key: x.code, label: x.label, count: x.count }))} />
        {r.why.reasons.length > 0 ? (
          <p className="text-muted-foreground text-[0.8125rem]">
            Failed a filter (a name can fail several): {r.why.reasons.map((x) => `${x.label.toLowerCase()} ${num(x.count)}`).join(", ")}.
          </p>
        ) : null}
        {r.universe !== null ? <p className="text-muted-foreground text-xs">Scanned {num(r.universe)} stocks.</p> : null}
      </div>
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
        <Table label="Candidates">
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
        <Table label="Forward test results">
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
