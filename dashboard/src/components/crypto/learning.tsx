import Link from "next/link";
import { ArrowRight, BrainCircuit, ClipboardCheck, Cog, FlaskConical, GraduationCap, Scale } from "lucide-react";
import { DivergingBars } from "@/components/charts/diverging-bars";
import { Forest } from "@/components/charts/forest";
import { Funnel } from "@/components/charts/funnel";
import { KeptSkippedChart } from "@/components/charts/kept-skipped-chart";
import { TestsChart } from "@/components/charts/tests-chart";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status";
import { StepRail } from "@/components/step-rail";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { items, type Crypto } from "@/lib/crypto";
import { duration, fracPct, num, rMult, shortSha, signed, sydney, zoned } from "@/lib/format";
import { jobTone } from "@/lib/labels";
import { LEARN_JOB, isLearningAlert, learningAlertLabel, learningLine, modelRoad, type Learning } from "@/lib/learning";
import { cn } from "@/lib/utils";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const utc = (iso: string | null | undefined) => (iso ? zoned(iso, "UTC") : "—");
const toneOf = (v: number | null | undefined) => (!isNum(v) || Math.abs(v) < 0.0005 ? "text-foreground" : v > 0 ? "text-good" : "text-bad");
const fixed = (v: number | null | undefined, d: number) => (isNum(v) ? v.toFixed(d) : "—");
const DRIFT_LIMIT = 0.25;

/** The model in force: where it is on the road from training to acting, and how close its next test is. */
export function ModelPanel({ l }: { l: Learning }) {
  const m = l.model;
  return (
    <Panel
      title="The model"
      icon={BrainCircuit}
      means="A model that learns which of the three strategies' signals are worth taking. It starts in shadow: it scores every signal before the result is known and changes nothing. After every 60 finished signals it is tested, at most six times. Only if the signals it liked did better than the ones it disliked, by more than luck allows, may it act; and then it can only skip a trade or halve it."
    >
      <div className="grid gap-4">
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <StatusBadge tone={l.switchOn ? "good" : "warn"}>{l.switchOn ? "Learning on" : "Learning switched off"}</StatusBadge>
          {m ? <StatusBadge tone={m.tone}>{m.stateLabel}</StatusBadge> : <StatusBadge tone="neutral">No model in force</StatusBadge>}
          {m?.drifted ? <StatusBadge tone="warn">Market has drifted from the training data</StatusBadge> : null}
          <span className="text-muted-foreground text-[0.8125rem]">{learningLine(l)}</span>
        </p>
        <div className="bg-muted/40 rounded-md border px-2 py-3 sm:px-4">
          <StepRail steps={modelRoad(l)} label="The road from training to acting" />
        </div>
        {!m ? (
          <Empty title="No model is in force">
            {l.training
              ? "At the last training no model predicted results better than simply taking every signal, so none was registered. Every signal is traded as its rule says. The comparison is below; training runs again each week."
              : "The first weekly training has not run on this host yet. Every signal is traded as its rule says."}
          </Empty>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">{m.stateMeans}</p>
            <StatTiles>
              <StatTile label="Model" value={<span className="text-base">{m.lineage}</span>} hint={`Trained ${utc(m.trainedAt)} UTC`} tone={m.tone} />
              <StatTile
                label="Tests used"
                value={`${num(m.checkpoints)} of ${num(m.maxCheckpoints)}`}
                hint="Each test is one more chance to pass by luck, so they are limited."
              />
              <StatTile
                label="Models tried in shadow"
                value={num(l.lineagesStarted)}
                hint="Every new model is another chance for luck; the bar rises with each."
              />
              <StatTile
                label="Drift of its scores"
                value={isNum(m.scorePsi) ? m.scorePsi.toFixed(2) : "—"}
                hint={isNum(m.scorePsi) ? `Suspends above ${DRIFT_LIMIT}` : "Not measured yet"}
                tone={!isNum(m.scorePsi) ? "neutral" : m.scorePsi > DRIFT_LIMIT ? "warn" : "good"}
              />
            </StatTiles>
            <div className="grid gap-4 sm:grid-cols-2">
              {isNum(m.nextCheckpoint) ? (
                <Meter
                  label="Finished signals towards the next test"
                  value={m.finished}
                  max={m.nextCheckpoint}
                  threshold={m.nextCheckpoint}
                  thresholdLabel={`Test at ${num(m.nextCheckpoint)}`}
                  valueText={`${num(m.finished)} of ${num(m.nextCheckpoint)}`}
                />
              ) : null}
              {isNum(m.scorePsi) ? (
                <Meter
                  label="Score drift against its limit"
                  value={m.scorePsi}
                  max={DRIFT_LIMIT * 2}
                  threshold={DRIFT_LIMIT}
                  thresholdLabel={`Limit ${DRIFT_LIMIT}`}
                  tone={m.scorePsi > DRIFT_LIMIT ? "warn" : "good"}
                  valueText={m.scorePsi.toFixed(3)}
                />
              ) : null}
            </div>
            {m.driftInputs.length > 0 ? (
              <p className="text-muted-foreground text-xs">Inputs that have moved away from the training data: {m.driftInputs.join(", ")}.</p>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

/** Every test the model in force has faced, drawn on the full row of tests it is allowed. */
export function TestsPanel({ l }: { l: Learning }) {
  const m = l.model;
  if (!m) return null;
  const slots = Math.max(m.maxCheckpoints ?? 0, m.looks.length);
  const points = Array.from({ length: slots }, (_, i) => {
    const k = m.looks.find((x) => x.checkpoint === i + 1);
    return { test: i + 1, spread: k?.spread ?? null, lower: k?.lower ?? null };
  });
  return (
    <Panel
      title="Tests the model has faced"
      icon={FlaskConical}
      means="At each test the signals the model liked are compared with the ones it disliked. 'Worst case allowed by luck' is the low end of that difference; the model passes only when even that is above zero, and its forecast error is below the plain win rate's."
    >
      {m.looks.length === 0 ? (
        <Empty title="Not tested yet">The first test comes when {num(m.checkpointSignals)} of the signals it scored have finished.</Empty>
      ) : (
        <div className="grid gap-4">
          <TestsChart points={points} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Test</TableHead>
                <TableHead>When (UTC)</TableHead>
                <TableHead className="text-right">Signals</TableHead>
                <TableHead className="text-right">Liked minus disliked</TableHead>
                <TableHead className="text-right">Worst case allowed by luck</TableHead>
                <TableHead className="text-right">Forecast error (model / plain win rate)</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {m.looks.map((k) => (
                <TableRow key={k.checkpoint ?? k.at}>
                  <TableCell className="font-medium">{num(k.checkpoint)}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{utc(k.at)}</TableCell>
                  <TableCell className="text-right font-mono">{num(k.signals)}</TableCell>
                  <TableCell className={cn("text-right font-mono", toneOf(k.spread))}>{rMult(k.spread, 3)}</TableCell>
                  <TableCell className={cn("text-right font-mono", toneOf(k.lower))}>{rMult(k.lower, 3)}</TableCell>
                  <TableCell className="text-right font-mono">
                    {fixed(k.brier, 4)} / {fixed(k.brierBase, 4)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={k.passed ? "good" : "neutral"}>{k.passed ? "Passed" : "Not passed"}</StatusBadge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}

/** The last weekly training: every model against taking every signal, on signals none of them saw. */
export function TrainingPanel({ l }: { l: Learning }) {
  const t = l.training;
  const models = t?.lines.filter((x) => x.name !== "m0") ?? [];
  return (
    <Panel
      title="Last training: the models compared"
      icon={GraduationCap}
      means="Once a week the models are trained on two years of the three strategies' signals and scored on signals they never saw. A model is used only if it predicts results better than simply taking every signal. Lower forecast error is better. 'Liked minus disliked' is how much better the signals a model would keep did than the ones it would skip; a range that includes zero means the difference may be luck."
      action={t ? <span className="text-muted-foreground text-xs">Trained {utc(t.at)} UTC</span> : null}
    >
      {!t ? (
        <Empty title="No training has run yet">The learning job trains the models once a week. Its first run on this host has not finished.</Empty>
      ) : (
        <div className="grid gap-5">
          <StatTiles>
            <StatTile label="Signals learned from" value={num(t.examples)} hint={`From ${num(t.pairs)} pairs`} />
            <StatTile
              label="Worth, once overlap is counted"
              value={isNum(t.effectiveN) ? num(Math.round(t.effectiveN)) : "—"}
              hint="Independent signals: overlapping trades count for less."
            />
            <StatTile label="Win rate of all signals" value={fracPct(t.winRate)} hint="After costs" />
            <StatTile
              label="Average result of all signals"
              value={rMult(t.meanR, 3)}
              hint="What taking every signal earned"
              tone={!isNum(t.meanR) ? "neutral" : t.meanR > 0 ? "good" : "bad"}
            />
          </StatTiles>
          {models.length > 0 ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <section className="grid content-start gap-2">
                <h3 className="text-sm font-medium">Liked minus disliked, with its range</h3>
                <Forest
                  label="Liked minus disliked per model, with the range luck allows"
                  format={(v) => rMult(v, 2)}
                  rows={models.map((x) => ({ key: x.name, label: x.label, sub: x.settings, value: x.spread, low: x.ciLow, high: x.ciHigh }))}
                />
                <p className="text-muted-foreground text-xs">Green: the whole range is above zero. Grey: the range includes zero, so the difference may be luck.</p>
              </section>
              <section className="grid content-start gap-2">
                <h3 className="text-sm font-medium">Forecast error against taking every signal</h3>
                <DivergingBars
                  label="Forecast error of each model minus the baseline's"
                  better="negative"
                  format={(v) => signed(v, 4)}
                  rows={models.map((x) => ({ key: x.name, label: x.label, value: x.logLossDelta }))}
                />
                <p className="text-muted-foreground text-xs">Left of the line is a better forecast than the baseline; right is worse.</p>
              </section>
              <section className="grid content-start gap-2 lg:col-span-2">
                <h3 className="text-sm font-medium">Average result: signals kept beside signals skipped</h3>
                <KeptSkippedChart points={models.map((x) => ({ name: x.label, kept: x.keptMeanR, skipped: x.skippedMeanR }))} />
              </section>
            </div>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Forecast error</TableHead>
                <TableHead className="text-right">Would keep</TableHead>
                <TableHead className="text-right">Avg R kept</TableHead>
                <TableHead className="text-right">Would skip</TableHead>
                <TableHead className="text-right">Avg R skipped</TableHead>
                <TableHead className="text-right">Liked minus disliked</TableHead>
                <TableHead>Verdict</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {t.lines.map((x) => (
                <TableRow key={x.name}>
                  <TableCell className="max-w-xs min-w-44 whitespace-normal">
                    <span className="font-medium">{x.label}</span>
                    {x.settings ? <span className="text-muted-foreground block text-xs">{x.settings}</span> : null}
                  </TableCell>
                  <TableCell className="text-right font-mono">{fixed(x.logLoss, 4)}</TableCell>
                  <TableCell className="text-right font-mono">{num(x.kept)}</TableCell>
                  <TableCell className={cn("text-right font-mono", toneOf(x.keptMeanR))}>{rMult(x.keptMeanR, 3)}</TableCell>
                  <TableCell className="text-right font-mono">{x.name === "m0" ? "—" : num(x.skipped)}</TableCell>
                  <TableCell className={cn("text-right font-mono", toneOf(x.skippedMeanR))}>{rMult(x.skippedMeanR, 3)}</TableCell>
                  <TableCell className="text-right font-mono whitespace-nowrap">
                    {isNum(x.spread) ? `${rMult(x.spread, 3)} (${rMult(x.ciLow, 2)} to ${rMult(x.ciHigh, 2)})` : "—"}
                  </TableCell>
                  <TableCell>
                    {x.name === "m0" ? (
                      <StatusBadge tone="neutral">The baseline</StatusBadge>
                    ) : x.chosen ? (
                      <StatusBadge tone="good">Chosen</StatusBadge>
                    ) : x.beatsBaseline ? (
                      <StatusBadge tone="info">Beats the baseline, not chosen</StatusBadge>
                    ) : (
                      <StatusBadge tone="bad">No better than the baseline</StatusBadge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-muted-foreground text-xs">
            Method {t.decision ?? "—"}, attempt {num(t.attempt)}. Every change of method after a result was seen counts as a further attempt.
          </p>
        </div>
      )}
    </Panel>
  );
}

/** What the chosen model weighs, strongest first, on one scale. */
export function LeansOnPanel({ l }: { l: Learning }) {
  const t = l.training;
  if (!t) return null;
  const shown = t.chosen != null && t.leansOn.length > 0;
  return (
    <Panel
      title="What the chosen model leans on"
      icon={Scale}
      means="The inputs that move the model's score most, strongest first. A bar to the right means more of that input made a win more likely in the training data; to the left, less likely. It describes the model; it is not advice."
    >
      {shown ? (
        <DivergingBars
          label="Weight of each input in the chosen model"
          format={(v) => signed(v, 2)}
          rows={t.leansOn.map((x) => ({ key: x.input, label: <span className="first-letter:uppercase inline-block">{x.label}</span>, value: x.weight }))}
        />
      ) : (
        <Empty title="No model was chosen">Nothing to show: at the last training no model beat taking every signal.</Empty>
      )}
    </Panel>
  );
}

/** What the desk's own recorded signals say so far, and how the model's picks have done. */
export function SignalsScorecard({ l }: { l: Learning }) {
  const g = l.signals;
  return (
    <Panel
      title="Signals recorded on the desk"
      icon={ClipboardCheck}
      means="Every time a strategy's rule is met the desk records the signal, then follows it to its result with that strategy's own exits and costs, whether or not it was bought. These are the signals a model is tested on. 'Liked' means the model scored it at or above its cut-off."
    >
      {g.recorded === 0 ? (
        <Empty title="No signal has been recorded yet">Signals are recorded from the next 4-hour bar on which a rule is met.</Empty>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="grid content-start gap-2">
            <h3 className="text-sm font-medium">From recorded to scored</h3>
            <Funnel
              label="Signals recorded, finished, scored, liked and disliked"
              rows={[
                { key: "recorded", label: "Recorded", count: g.recorded },
                { key: "finished", label: "Finished", count: g.finished },
                { key: "scored", label: "Scored by the model", count: g.scored },
                { key: "kept", label: "Liked", count: g.kept, inner: true, fill: "bg-chart-3" },
                { key: "skipped", label: "Disliked", count: g.skipped, inner: true, fill: "bg-chart-2" },
              ]}
            />
            <p className="text-muted-foreground text-xs">{num(g.open)} still open. Win rate of finished signals: {fracPct(g.winRate)}.</p>
          </section>
          <section className="grid content-start gap-2">
            <h3 className="text-sm font-medium">Average result so far</h3>
            <DivergingBars
              label="Average result of all, liked and disliked signals"
              better="positive"
              format={(v) => rMult(v, 3)}
              rows={[
                { key: "all", label: "All finished signals", value: g.meanR },
                { key: "kept", label: "Liked by the model", value: g.kept > 0 ? g.keptMeanR : null },
                { key: "skipped", label: "Disliked by the model", value: g.skipped > 0 ? g.skippedMeanR : null },
              ]}
            />
            <p className="text-muted-foreground text-xs">A handful of signals proves nothing either way; the tests above decide.</p>
          </section>
        </div>
      )}
    </Panel>
  );
}

/** Whether the learning job itself is running: its last runs and any alert that belongs to the model. */
export function PipelinePanel({ s }: { s: Crypto }) {
  const last = s.jobs?.last?.[LEARN_JOB];
  const runs = items(s.jobs?.runs).filter((r) => r.job === LEARN_JOB).slice(-14);
  const firing = items(s.alerts?.firing).filter((a) => isLearningAlert(a.key));
  return (
    <Panel
      title="The learning job"
      icon={Cog}
      means="Once a day the host follows finished signals to their results, runs any test that is due, and once a week retrains the models. If scoring ever fails, signals are simply traded as their rules say."
      action={last ? <StatusBadge tone={jobTone(last.status)}>{last.status ?? "unknown"}</StatusBadge> : null}
    >
      <div className="grid gap-4">
        {firing.length > 0 ? (
          <ul className="grid gap-1.5">
            {firing.map((a) => (
              <li key={a.key} className="flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge tone="warn">Alert</StatusBadge>
                <span>{learningAlertLabel(a.key as string)}</span>
                <span className="text-muted-foreground text-xs">since {sydney(a.since)} Sydney</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-sm">
            <StatusBadge tone="good">No model alert is firing</StatusBadge>
          </p>
        )}
        {!last && runs.length === 0 ? (
          <Empty title="The learning job has not reported a run yet">Its runs appear here after the next daily run on the host.</Empty>
        ) : (
          <>
            <KeyValues
              items={[
                { label: "Last run started (Sydney)", value: sydney(last?.started) },
                { label: "Took", value: duration(last?.started, last?.ended) },
                { label: "Code", value: shortSha(last?.sha), mono: true },
              ]}
            />
            {runs.length > 0 ? (
              <div className="grid gap-1.5">
                <p className="text-muted-foreground text-xs">Last {num(runs.length)} runs, oldest first</p>
                <ol className="flex flex-wrap gap-1">
                  {runs.map((r, i) => (
                    <li key={`${r.started}-${i}`}>
                      <StatusBadge tone={jobTone(r.status)} className="px-1">
                        <span className="sr-only">{sydney(r.started)}: </span>
                        {r.status ?? "unknown"}
                      </StatusBadge>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

/** The model in one card, for pages that only point at the Machine learning page. */
export function LearningCard({ l }: { l: Learning }) {
  const m = l.model;
  return (
    <Panel
      title="Machine learning"
      icon={BrainCircuit}
      means="A model that scores the three strategies' signals. It may only skip or halve a trade, and only after passing a test."
      action={
        <Link href="/crypto/learning" className="text-primary inline-flex items-center gap-1 text-xs font-medium hover:underline">
          Open the page
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      }
    >
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge tone={l.switchOn ? "good" : "warn"}>{l.switchOn ? "Learning on" : "Learning switched off"}</StatusBadge>
        {m ? <StatusBadge tone={m.tone}>{m.stateLabel}</StatusBadge> : <StatusBadge tone="neutral">No model in force</StatusBadge>}
        <span className="text-muted-foreground">{learningLine(l)}</span>
      </p>
    </Panel>
  );
}
