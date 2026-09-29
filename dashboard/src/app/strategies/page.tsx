import { ChartSpline, ListChecks, ScrollText, Wallet } from "lucide-react";
import { EquityChart } from "@/components/charts/equity-chart";
import { ForwardMini, type ForwardPointRow } from "@/components/charts/forward-chart";
import { DataDetails } from "@/components/data-details";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { newYork, num, pct, rMult, shortDate, sydney, txt } from "@/lib/format";
import { humanize, isStrategyB, type Tone } from "@/lib/labels";
import { loadSnapshot } from "@/lib/snapshot";
import { entries, list, type ForwardPoint, type Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Strategies" };

const B_NOTICE = "Strategy B is under re-evaluation (DEC-0011).";

export default async function StrategiesPage() {
  const result = await loadSnapshot();
  return (
    <>
      <PageHeading
        title="Strategies"
        intro="How each strategy is doing in the forward test (signals recorded live, no orders) and in the paper account (simulated orders at the broker)."
      />
      {result.status !== "ok" ? (
        <NoSnapshot status={result.status} />
      ) : (
        <>
          <ForwardTable s={result.snapshot} />
          <ForwardCharts s={result.snapshot} />
          <div className="grid gap-5 lg:grid-cols-2">
            <PaperAccount s={result.snapshot} />
            <PaperEvents s={result.snapshot} />
          </div>
        </>
      )}
    </>
  );
}

function BNotice() {
  return (
    <StatusBadge tone="warn" className="whitespace-normal">
      {B_NOTICE}
    </StatusBadge>
  );
}

function ForwardTable({ s }: { s: Snapshot }) {
  const f = s.ops?.forward;
  const rows = list(f?.strategies);
  const sessions = `${num(f?.sessions)} session${f?.sessions === 1 ? "" : "s"}`;
  return (
    <Panel
      title="Forward test scorecard"
      icon={ListChecks}
      means="Each strategy's live-recorded results so far, in R (1R is the planned risk of one trade). Small samples swing a lot; judge only after many trades."
      action={<span className="text-muted-foreground text-xs">{sessions}</span>}
    >
      {rows.length === 0 ? (
        <Empty title="No strategy has a forward-test score yet">
          The forward test has recorded {sessions}
          {f?.first ? ` (${shortDate(f.first)} to ${shortDate(f.last)})` : ""} but no scored trades. Scores appear here
          once trades close.
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Strategy</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">Mean R</TableHead>
              <TableHead className="text-right">Total R</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={`${r.strategy}-${i}`}>
                <TableCell className="whitespace-normal">
                  <div className="font-mono text-xs">{txt(r.strategy)}</div>
                  {isStrategyB(r.strategy) ? (
                    <div className="mt-1">
                      <BNotice />
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">{num(r.n)}</TableCell>
                <TableCell className="text-right">{rMult(r.mean_r)}</TableCell>
                <TableCell className="text-right font-medium">{rMult(r.total_r, 2)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {f?.latest_scorecard ? (
        <p className="text-muted-foreground mt-3 text-xs">
          Latest weekly scorecard: <span className="font-mono">{f.latest_scorecard}</span>
        </p>
      ) : null}
    </Panel>
  );
}

function groupForward(points: ForwardPoint[]): { name: string; rows: ForwardPointRow[] }[] {
  // First-appearance order keeps each strategy in the same place as new ones are added; B leads.
  const order: string[] = [];
  const by = new Map<string, ForwardPointRow[]>();
  const sorted = [...points].sort((a, b) => String(a.session).localeCompare(String(b.session)));
  for (const p of sorted) {
    if (!p.strategy || !p.session || typeof p.cum_r !== "number" || !Number.isFinite(p.cum_r)) continue;
    let rows = by.get(p.strategy);
    if (!rows) {
      rows = [];
      by.set(p.strategy, rows);
      order.push(p.strategy);
    }
    rows.push({ session: p.session, cum_r: p.cum_r, n: p.n ?? null });
  }
  order.sort((a, b) => Number(isStrategyB(b)) - Number(isStrategyB(a)));
  return order.map((name) => ({ name, rows: by.get(name) ?? [] }));
}

/** About five round tick values covering [lo, hi], always including 0. */
function niceTicks(lo: number, hi: number): number[] {
  const span = Math.max(hi - lo, 1);
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 1000; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function ForwardCharts({ s }: { s: Snapshot }) {
  const groups = groupForward(list(s.series?.forward));
  const values = groups.flatMap((g) => g.rows.map((r) => r.cum_r));
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const ticks = niceTicks(lo, hi);
  return (
    <Panel
      title="Cumulative R by strategy"
      icon={ChartSpline}
      means="Running total of R for each strategy, one small chart each on the same scale. Above the zero line means the strategy is ahead so far."
    >
      {groups.length === 0 ? (
        <Empty title="No forward-test sessions to chart yet">
          Each strategy gets a chart after its first scored session.
        </Empty>
      ) : (
        <>
          <ul className="grid gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((g) => {
              const lastRow = g.rows.at(-1);
              return (
                <li key={g.name} className="grid min-w-0 content-start gap-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-xs font-medium" title={g.name}>
                      {g.name}
                    </span>
                    <span className="text-sm font-semibold">{rMult(lastRow?.cum_r, 2)}</span>
                  </div>
                  {isStrategyB(g.name) ? <BNotice /> : null}
                  <ForwardMini name={g.name} points={g.rows} ticks={ticks} />
                </li>
              );
            })}
          </ul>
          <DataDetails>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Strategy</TableHead>
                  <TableHead>Session</TableHead>
                  <TableHead className="text-right">Trades</TableHead>
                  <TableHead className="text-right">Cumulative</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.flatMap((g) =>
                  g.rows.map((r) => (
                    <TableRow key={`${g.name}-${r.session}`}>
                      <TableCell className="font-mono text-xs">{g.name}</TableCell>
                      <TableCell>{shortDate(r.session)}</TableCell>
                      <TableCell className="text-right">{num(r.n)}</TableCell>
                      <TableCell className="text-right">{rMult(r.cum_r, 2)}</TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          </DataDetails>
        </>
      )}
    </Panel>
  );
}

function PaperAccount({ s }: { s: Snapshot }) {
  const p = s.ops?.paper;
  const v = p?.virtual;
  const change =
    typeof v?.equity === "number" && typeof v?.start === "number" && v.start !== 0
      ? ((v.equity - v.start) / v.start) * 100
      : null;
  const points = list(s.series?.paper).flatMap((x) =>
    typeof x.date === "string" && typeof x.equity === "number" ? [{ date: x.date, equity: x.equity }] : [],
  );
  return (
    <Panel
      title="Paper B virtual account"
      icon={Wallet}
      means="A pretend account that sizes paper B's trades as if real money were at stake. Paper money only; nothing here is real."
      action={
        v?.latched === true ? (
          <StatusBadge tone="bad">Latched</StatusBadge>
        ) : v?.latched === false ? (
          <StatusBadge tone="good">Not latched</StatusBadge>
        ) : null
      }
    >
      <KeyValues
        items={[
          { label: "Virtual equity", value: num(v?.equity, 2) },
          { label: "Started at", value: num(v?.start, 2) },
          { label: "Change", value: change === null ? "—" : `${change > 0 ? "+" : ""}${pct(change, 2)}` },
          { label: "Trades", value: num(p?.trades) },
          { label: "Total R", value: rMult(p?.total_r, 2) },
          { label: "Mean R", value: rMult(p?.mean_r) },
          { label: "Armed sessions", value: num(p?.armed_sessions) },
          { label: "Last armed", value: shortDate(p?.last_armed) },
          { label: "Unreadable log lines", value: num(p?.bad_lines) },
        ]}
      />
      {v?.latched && v.latch_reason ? <p className="text-bad mt-3 text-sm">Latched because: {v.latch_reason}</p> : null}
      <div className="mt-4">
        {points.length >= 2 ? (
          <>
            <EquityChart points={points} start={typeof v?.start === "number" ? v.start : null} />
            <DataDetails>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    <TableHead className="text-right">Equity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {points.map((pt) => (
                    <TableRow key={pt.date}>
                      <TableCell>{shortDate(pt.date)}</TableCell>
                      <TableCell className="text-right">{num(pt.equity, 2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataDetails>
          </>
        ) : (
          <Empty title="Not enough days for a chart yet">The equity line appears after two sessions have ended.</Empty>
        )}
      </div>
    </Panel>
  );
}

function eventTone(event: string | null | undefined): Tone {
  const e = String(event ?? "");
  if (/error|fail|reject/.test(e)) return "bad";
  if (/blocked|latch|skip|stale/.test(e)) return "warn";
  if (/armed|entry|filled|open/.test(e)) return "info";
  if (/end|closed|flat/.test(e)) return "good";
  return "neutral";
}

function PaperEvents({ s }: { s: Snapshot }) {
  const recent = [...list(s.ops?.paper?.recent)].reverse();
  const counts = entries(s.ops?.paper?.events);
  return (
    <Panel
      title="Recent paper events"
      icon={ScrollText}
      means="The latest things the paper runner logged, newest first. Single errors are usually network hiccups; repeated ones are worth a look."
    >
      {counts.length > 0 ? (
        <ul className="mb-3 flex flex-wrap gap-1.5" aria-label="Event counts">
          {counts.map(([k, n]) => (
            <li key={k}>
              <StatusBadge tone={eventTone(k)}>
                {humanize(k)}: {num(n)}
              </StatusBadge>
            </li>
          ))}
        </ul>
      ) : null}
      {recent.length === 0 ? (
        <Empty title="No paper events recorded">Events appear once paper B runs.</Empty>
      ) : (
        <ol className="divide-border grid divide-y">
          {recent.map((e, i) => (
            <li key={`${e.ts}-${i}`} className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <StatusBadge tone={eventTone(e.event)}>{humanize(e.event)}</StatusBadge>
                <span>{sydney(e.ts)} Sydney</span>
                <span className="text-muted-foreground">{newYork(e.ts, false)} NY</span>
              </div>
              {e.detail ? <p className="text-muted-foreground font-mono text-xs break-all">{e.detail}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
