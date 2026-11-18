// The Robot B page's body (DEC-0061 section 4). Server-rendered; reads the snapshot passed in and the committed
// evidence file through lib/robot-b.ts, which derives every state. Numbers only: no record's prose is shown.
import { Ban, BookOpenCheck, ChartNoAxesColumn, Crosshair, FlaskConical, Gauge, ListChecks, Scale, ShieldAlert, Signpost } from "lucide-react";
import { DataDetails } from "@/components/data-details";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { Panel } from "@/components/panel";
import { StatusBadge, TONE_TEXT } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BlotterPanel, PerformancePanel } from "@/components/v3/perf";
import { RiskLimitsPanel } from "@/components/v3/risk-limits";
import { newYork, num, pct, usd } from "@/lib/format";
import {
  axis,
  blockers,
  ciText,
  deskState,
  estimates,
  g1Lines,
  ladder,
  paperNow,
  rSigned,
  RUNG_TONE,
  RUNG_WORD,
  STALE_HOURS,
  type Estimate,
  type Evidence,
  type PaperNow,
} from "@/lib/robot-b";
import type { Snapshot } from "@/lib/types";
import { cn } from "@/lib/utils";

export function RobotBBody({ s, e, now }: { s: Snapshot | null; e: Evidence | null; now: Date }) {
  const p = paperNow(s, now);
  return (
    <div className="grid gap-5">
      <IdentityStrip p={p} e={e} />
      <VerdictPanel e={e} s={s} />
      <LadderPanel e={e} s={s} />
      <div className="grid gap-5 lg:grid-cols-2">
        <EstimatesPanel e={e} p={p} />
        <PaperMeters e={e} s={s} p={p} />
      </div>
      {e ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <BacktestPanel e={e} />
          <ExitsPanel e={e} />
        </div>
      ) : null}
      {s ? (
        <>
          <PerformancePanel s={s} />
          <BlotterPanel s={s} />
          <RiskLimitsPanel s={s} />
        </>
      ) : null}
      <TrailPanel e={e} />
    </div>
  );
}

// ---------------------------------------------------------------- identity

function IdentityStrip({ p, e }: { p: PaperNow; e: Evidence | null }) {
  const state = deskState(p);
  const stale = p.ageHours !== null && p.ageHours > STALE_HOURS;
  return (
    <section aria-label="Robot B at a glance" className="bg-card flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 shadow-sm">
      <StatusBadge tone="warn">Paper money only</StatusBadge>
      <StatusBadge tone="neutral">
        Rule {e?.rule.version ?? "v1"} frozen · {e?.rule.record ?? "DEC-0037"}
      </StatusBadge>
      <StatusBadge tone={state.tone}>{state.word}</StatusBadge>
      {/* When the kill switch is on, the state badge already says so. */}
      {p.killOn === true && state.word.includes("kill") ? null : (
        <StatusBadge tone={p.killOn === true ? "warn" : p.killOn === false ? "good" : "neutral"}>
          Kill switch {p.killOn === true ? "on" : p.killOn === false ? "off" : "unknown"}
        </StatusBadge>
      )}
      <StatusBadge tone={p.latched === true ? "bad" : p.latched === false ? "good" : "neutral"}>
        {p.latched === true ? "Latched" : p.latched === false ? "Not latched" : "Latch unknown"}
      </StatusBadge>
      <StatusBadge tone={p.job?.status === "ok" ? "good" : p.job ? "warn" : "neutral"}>
        Last run {p.job ? (p.job.status === "ok" ? "finished normally" : (p.job.status ?? "unknown")) : "not reported"}
      </StatusBadge>
      {e ? (
        <StatusBadge tone="bad" className="whitespace-normal">
          Provisional verdict {e.verdict.provisional} · {e.verdict.record} ({e.verdict.status})
        </StatusBadge>
      ) : null}
      <span className={cn("ml-auto text-xs", stale ? "text-warn font-medium" : "text-muted-foreground")}>
        {p.asOf ? `Desk data ${newYork(p.asOf)} New York${stale ? ` · stale (${Math.round(p.ageHours ?? 0)} h old)` : ""}` : "No desk data"}
      </span>
    </section>
  );
}

// ---------------------------------------------------------------- the verdict and what blocks it

function VerdictPanel({ e, s }: { e: Evidence | null; s: Snapshot | null }) {
  const list = blockers(e, s);
  return (
    <Panel
      title="Is Robot B proven?"
      icon={Scale}
      means="Whether the evidence shows a real, repeatable edge. A backtest that made money is not the same thing: it has to clear every gate below on clean data."
      action={<StatusBadge tone={list.length ? "bad" : "good"}>{list.length ? "Not proven" : "Every gate passed"}</StatusBadge>}
    >
      {list.length ? (
        <ul className="grid gap-2 text-sm">
          {list.map((b) => (
            <li key={b} className="flex gap-2">
              <Ban aria-hidden className="text-bad mt-0.5 size-4 shrink-0" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm">Nothing blocks the promotion review. The owner decides it.</p>
      )}
    </Panel>
  );
}

function LadderPanel({ e, s }: { e: Evidence | null; s: Snapshot | null }) {
  const rungs = ladder(e, s);
  return (
    <Panel
      title="The evidence ladder"
      icon={Signpost}
      means="Each step must pass, in order, before the next can count. Done is not the same as passed: a step that ran and failed is red."
    >
      <ol className="grid gap-2">
        {rungs.map((r, i) => (
          <li
            key={r.key}
            data-rung={r.key}
            data-state={r.state}
            className={cn("grid grid-cols-[1.75rem_1fr] items-start gap-3 rounded-lg border px-3 py-2.5 sm:grid-cols-[1.75rem_1fr_auto]", r.state === "failed" && "border-bad/40", r.state === "passed" && "border-good/40")}
          >
            <span className={cn("bg-muted grid size-7 place-items-center rounded-full font-mono text-xs font-semibold", TONE_TEXT[RUNG_TONE[r.state]])}>{i + 1}</span>
            <span className="grid min-w-0 gap-0.5">
              <span className="font-medium">{r.name}</span>
              <span className="text-muted-foreground text-xs">
                {r.detail} · {r.record}
              </span>
            </span>
            <StatusBadge tone={RUNG_TONE[r.state]} className="col-start-2 justify-self-start sm:col-start-3">
              {RUNG_WORD[r.state]}
            </StatusBadge>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

// ---------------------------------------------------------------- every estimate on one axis

function EstimatesPanel({ e, p }: { e: Evidence | null; p: PaperNow }) {
  const rows = estimates(e, p);
  const ax = axis(rows);
  const W = 520;
  const L = 150;
  const R = 16;
  const rowH = 34;
  const H = rows.length * rowH + 30;
  const x = (v: number) => L + ((v - ax.min) / (ax.max - ax.min)) * (W - L - R);
  const ticks: number[] = [];
  for (let t = ax.min; t <= ax.max + 1e-9; t += ax.max - ax.min > 1.2 ? 0.5 : 0.2) ticks.push(Math.round(t * 10) / 10);
  return (
    <Panel
      title="Average result per trade, with 95% range"
      icon={Crosshair}
      means="Each line is one body of evidence. If a range crosses the zero line, that evidence cannot tell Robot B from no edge at all. The paper range uses the backtest's spread because paper has too few trades for its own."
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No estimate to draw.</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Average R per trade with 95% ranges for the backtest, walk-forward, holdout and paper">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={8} y2={H - 20} className={t === 0 ? "stroke-foreground" : "stroke-border"} strokeWidth={t === 0 ? 1.5 : 1} />
                <text x={x(t)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {t === 0 ? "0" : `${t > 0 ? "+" : "−"}${Math.abs(t).toFixed(1)}`}
                </text>
              </g>
            ))}
            {rows.map((r, i) => {
              const y = 20 + i * rowH;
              const cross = r.lo !== null && r.hi !== null && r.lo <= 0 && r.hi >= 0;
              const tone = r.mean === null ? "neutral" : cross ? "warn" : r.mean > 0 ? "good" : "bad";
              return (
                <g key={r.key} className={TONE_TEXT[tone]}>
                  <text x={0} y={y + 4} className="fill-foreground text-[11px]">
                    {r.label}
                  </text>
                  <text x={0} y={y + 17} className="fill-muted-foreground text-[10px]">
                    {num(r.trades)} trades
                  </text>
                  {r.lo !== null && r.hi !== null ? <line x1={x(r.lo)} x2={x(r.hi)} y1={y} y2={y} stroke="currentColor" strokeWidth={3} strokeLinecap="round" /> : null}
                  {r.mean !== null ? <circle cx={x(r.mean)} cy={y} r={5} fill="currentColor" /> : null}
                </g>
              );
            })}
          </svg>
          <DataDetails>
            <EstimateTable rows={rows} />
          </DataDetails>
        </>
      )}
    </Panel>
  );
}

function EstimateTable({ rows }: { rows: Estimate[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Evidence</TableHead>
          <TableHead className="text-right">Trades</TableHead>
          <TableHead className="text-right">Average</TableHead>
          <TableHead className="text-right">95% range</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell>{r.label}</TableCell>
            <TableCell className="text-right font-mono">{num(r.trades)}</TableCell>
            <TableCell className="text-right font-mono">{rSigned(r.mean)}</TableCell>
            <TableCell className="text-right font-mono">{ciText([r.lo, r.hi])}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------- the paper desk against its lines

function PaperMeters({ e, s, p }: { e: Evidence | null; s: Snapshot | null; p: PaperNow }) {
  const g = s?.ops?.paper?.g2 ?? null;
  const used = p.stopUsed;
  const needed = e?.power.full_edge.trades ?? null;
  return (
    <Panel
      title="Paper desk against its lines"
      icon={Gauge}
      means="How far the paper record has come, how close it is to the loss line that stops it, and how many trades it would take to know whether the edge is real."
    >
      <div className="grid gap-4">
        {p.stopLine !== null ? (
          <Meter
            label={`Stop line used (${rSigned(p.cumR, 2)} of ${rSigned(p.stopLine, 2)})`}
            value={used}
            max={1}
            tone={used !== null && used >= 0.75 ? "bad" : used !== null && used >= 0.5 ? "warn" : "info"}
            valueText={used === null ? "—" : pct(used * 100, 0)}
          />
        ) : (
          <p className="text-muted-foreground text-sm">Stop rule: not in this snapshot.</p>
        )}
        <Meter
          label="Clean sessions (G2a)"
          value={g?.sessions}
          max={g?.sessions_needed}
          tone="info"
          valueText={`${num(g?.sessions)} of ${num(g?.sessions_needed)}`}
        />
        <Meter
          label="Incident-free in a row (G2a)"
          value={g?.incident_free_streak}
          max={g?.incident_free_needed}
          tone="info"
          valueText={`${num(g?.incident_free_streak)} of ${num(g?.incident_free_needed)}`}
        />
        <Meter label="Trades (G2b)" value={g?.trades} max={g?.trades_needed} tone="info" valueText={`${num(g?.trades)} of ${num(g?.trades_needed)}`} />
        {e && needed ? (
          <>
            <Meter
              label="Trades for a statistical answer"
              value={p.trades}
              max={needed}
              tone="warn"
              threshold={e.power.g2b_trades}
              thresholdLabel="G2b"
              valueText={`${num(p.trades)} of about ${num(needed)}`}
            />
            <p className="text-muted-foreground text-xs">
              One-sided test at 5%, 80% power, the backtest&apos;s spread. At {num(e.power.trades_per_session, 2)} trades a session (95% range{" "}
              {num(e.power.rate_95[0], 2)}–{num(e.power.rate_95[1], 2)}) that is about {num(e.power.full_edge.years, 1)} years if the backtest edge is real,
              about {num(e.power.half_edge.years, 0)} if it is half that. Read as that test, {num(e.power.g2b_trades)} trades would catch a real edge of{" "}
              {rSigned(e.power.full_edge.edge_r)} {pct(e.power.full_edge.power_at_g2b * 100, 0)} of the time.
            </p>
          </>
        ) : null}
        <KeyValues
          items={[
            { label: "Paper trades", value: num(p.trades) },
            { label: "Average per trade", value: rSigned(p.meanR) },
            { label: "Total", value: rSigned(p.cumR, 2) },
            { label: "Virtual equity", value: p.equity === null ? "—" : usd(p.equity) },
            { label: "Review at", value: p.reviewAt === null ? "—" : `${num(p.reviewAt)} trades` },
            { label: "Rule ends", value: p.stopDate ?? "—" },
          ]}
        />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- the backtest, taken apart

function BacktestPanel({ e }: { e: Evidence }) {
  const b = e.backtest;
  const max = Math.max(...b.years.map((y) => Math.abs(y.expectancy_r)), 0.05);
  return (
    <Panel
      title="The backtest, as recorded"
      icon={FlaskConical}
      means={`The frozen rule over ${b.span[0]} to ${b.span[1]}, in sample: its exit was chosen on this same data. Recorded before the data fix, so every number here may still move.`}
      action={<StatusBadge tone="warn">{e.evidence.label}</StatusBadge>}
    >
      <KeyValues
        items={[
          { label: "Trades", value: num(b.trades) },
          { label: "Average", value: rSigned(b.expectancy_r) },
          { label: "95% range", value: ciText(b.ci95) },
          { label: "Win rate", value: pct(b.win_rate * 100, 1) },
          { label: "Profit factor", value: num(b.profit_factor, 2) },
          { label: "Worst fall", value: rSigned(b.max_drawdown_r, 1) },
          { label: "Longest losing run", value: `${num(b.longest_losing_run)} trades` },
          { label: "Without its 10 best trades", value: rSigned(b.expectancy_without_top10) },
        ]}
      />
      <div className="mt-4 grid gap-1.5" role="list" aria-label="Average result per trade by year">
        {b.years.map((y) => {
          const w = (Math.abs(y.expectancy_r) / max) * 50;
          const tone = y.expectancy_r > 0 ? "bg-good" : "bg-bad";
          return (
            <div key={y.year} role="listitem" className="grid grid-cols-[3rem_1fr_6.5rem] items-center gap-2 text-xs">
              <span className="font-mono">{y.year}</span>
              <span className="bg-muted relative h-3 rounded">
                <span className="bg-foreground/40 absolute top-0 left-1/2 h-3 w-px" aria-hidden />
                <span
                  className={cn("absolute top-0.5 h-2 rounded", tone)}
                  style={y.expectancy_r >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
                  aria-hidden
                />
              </span>
              <span className="text-right font-mono">
                {rSigned(y.expectancy_r)} · {y.trades}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4">
        <h3 className="mb-2 text-sm font-medium">Backtest gate (G1): walk-forward, out of sample, at {num(e.g1.trials)} trials</h3>
        <ul className="grid gap-1.5 text-sm">
          {g1Lines(e).map((l) => (
            <li key={l.text} className="flex items-start gap-2">
              <StatusBadge tone={l.pass ? "good" : "bad"}>{l.pass ? "Pass" : "Fail"}</StatusBadge>
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

const EXIT_WORD: Record<string, string> = { eod_flatten: "Closed before the bell", stop: "Stopped out", target: "Hit the 2R target" };

function ExitsPanel({ e }: { e: Evidence }) {
  const total = e.exits.reduce((a, x) => a + x.trades, 0) || 1;
  return (
    <Panel
      title="Where the result comes from"
      icon={ChartNoAxesColumn}
      means="How backtest trades ended. Stops and closes before the bell roughly cancel out; the few trades that reach the 2R target carry most of the profit, so the edge rests on a thin tail."
    >
      <div className="grid gap-3">
        {e.exits.map((x) => (
          <Meter
            key={x.kind}
            label={`${EXIT_WORD[x.kind] ?? x.kind} · average ${rSigned(x.expectancy_r)}`}
            value={x.trades}
            max={total}
            tone={x.expectancy_r > 0 ? "good" : "bad"}
            valueText={`${num(x.trades)} (${pct((x.trades / total) * 100, 0)})`}
          />
        ))}
      </div>
      <KeyValues
        className="mt-4"
        items={[
          { label: "Entries the paper desk cannot take (at or after 15:30)", value: `${num(e.runner_parity.untradable_trades)} · ${rSigned(e.runner_parity.untradable_expectancy_r)}` },
          { label: "Average of the entries it can take", value: rSigned(e.runner_parity.tradable_expectancy_r) },
          { label: "Walk-forward (the G1 series)", value: `${num(e.walk_forward.trades)} · ${rSigned(e.walk_forward.expectancy_r)}` },
          { label: "G1 deflated Sharpe, 65 trials → 87", value: `${num(e.g1.dsr_at_65, 3)} → ${num(e.g1.items.find((i) => i.id === "dsr")?.value, 3)}` },
          { label: "Trades G1 would need at this Sharpe", value: e.power.dsr_needs_trades ? `about ${num(e.power.dsr_needs_trades)}` : "—" },
          { label: "Track record needed (Sharpe test)", value: `${num(e.power.min_track_record_trades)} trades` },
        ]}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------- the research trail

function TrailPanel({ e }: { e: Evidence | null }) {
  return (
    <Panel
      title="Research trail"
      icon={BookOpenCheck}
      means="The records behind Robot B and the work still owed. Each record is in the repository; this page shows only its id, status and date."
      action={e ? <StatusBadge tone="warn">{e.owed.length} owed</StatusBadge> : null}
    >
      {!e ? (
        <p className="text-muted-foreground text-sm">The evidence file is missing.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
              <ListChecks aria-hidden className="size-4" /> On record
            </h3>
            <ul className="grid gap-1.5 text-sm">
              {e.trail.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{t.id}</span>
                  <StatusBadge tone={t.status === "proposed" ? "info" : "neutral"}>{t.status}</StatusBadge>
                  {t.date ? <span className="text-muted-foreground text-xs">{t.date}</span> : null}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
              <ShieldAlert aria-hidden className="size-4" /> Owed, in order
            </h3>
            <ul className="grid gap-1.5 text-sm">
              {e.owed.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <span className="font-mono">{t.id}</span>
                  <StatusBadge tone="warn">{t.status}</StatusBadge>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Panel>
  );
}
