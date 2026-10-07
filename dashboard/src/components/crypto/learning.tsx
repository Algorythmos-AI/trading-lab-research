import { BrainCircuit, ClipboardCheck, GraduationCap } from "lucide-react";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fracPct, num, rMult, zoned } from "@/lib/format";
import { learningLine, type Learning } from "@/lib/learning";
import { cn } from "@/lib/utils";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const utc = (iso: string | null | undefined) => (iso ? zoned(iso, "UTC") : "—");
const toneOf = (v: number | null | undefined) => (!isNum(v) || Math.abs(v) < 0.0005 ? "text-foreground" : v > 0 ? "text-good" : "text-bad");
const fixed = (v: number | null | undefined, d: number) => (isNum(v) ? v.toFixed(d) : "—");

/** The model in force: its state, the progress to its next test, and every test it has faced. */
export function ModelPanel({ l }: { l: Learning }) {
  const m = l.model;
  return (
    <Panel
      title="The model"
      icon={BrainCircuit}
      means="A model that learns which of the three strategies' signals are worth taking. It starts in shadow: it scores every signal before the result is known and changes nothing. After every 60 finished signals it is tested, at most six times. Only if the signals it liked did better than the ones it disliked, by more than luck allows, may it act; and then it can only skip a trade or halve it."
      action={<span className="text-muted-foreground text-xs">{learningLine(l)}</span>}
    >
      <p className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge tone={l.switchOn ? "good" : "warn"}>{l.switchOn ? "Learning on" : "Learning switched off"}</StatusBadge>
        {m ? <StatusBadge tone={m.tone}>{m.stateLabel}</StatusBadge> : <StatusBadge tone="neutral">No model in force</StatusBadge>}
        {m?.drifted ? <StatusBadge tone="warn">Market has drifted from the training data</StatusBadge> : null}
      </p>
      {!m ? (
        <Empty title="No model is in force">
          {l.training
            ? "At the last training no model predicted results better than simply taking every signal, so none was registered. Every signal is traded as its rule says. The comparison is below; training runs again each week."
            : "The first weekly training has not run on this host yet. Every signal is traded as its rule says."}
        </Empty>
      ) : (
        <div className="grid gap-4">
          <p className="text-muted-foreground text-sm">{m.stateMeans}</p>
          <KeyValues
            items={[
              { label: "Model", value: m.lineage },
              { label: "Trained (UTC)", value: utc(m.trainedAt) },
              { label: "Tests used", value: `${num(m.checkpoints)} of ${num(m.maxCheckpoints)}` },
              { label: "Drift of its scores", value: isNum(m.scorePsi) ? `${m.scorePsi.toFixed(2)} (suspends above 0.25)` : "Not measured yet" },
            ]}
          />
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
          {m.looks.length === 0 ? (
            <Empty title="Not tested yet">The first test comes when {num(m.checkpointSignals)} of the signals it scored have finished.</Empty>
          ) : (
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
          )}
        </div>
      )}
    </Panel>
  );
}

/** The last weekly training: every model against taking every signal, on signals none of them saw. */
export function TrainingPanel({ l }: { l: Learning }) {
  const t = l.training;
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
        <div className="grid gap-4">
          <KeyValues
            items={[
              { label: "Signals learned from", value: `${num(t.examples)} from ${num(t.pairs)} pairs` },
              { label: "Worth, once overlap is counted", value: isNum(t.effectiveN) ? `about ${num(Math.round(t.effectiveN))} independent signals` : "—" },
              { label: "Win rate of all signals, after costs", value: fracPct(t.winRate) },
              { label: "Average result of all signals", value: rMult(t.meanR, 3) },
            ]}
          />
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
          {t.chosen && t.leansOn.length > 0 ? (
            <div>
              <p className="mb-1 text-sm font-medium">What the chosen model leans on, strongest first</p>
              <ul className="text-muted-foreground list-disc pl-5 text-sm">
                {t.leansOn.map((x) => (
                  <li key={x.input}>
                    {x.label}
                    {isNum(x.weight) ? <span className="font-mono"> ({x.weight > 0 ? "+" : ""}{x.weight.toFixed(2)})</span> : null}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground mt-1 text-xs">A positive number means more of it made a win more likely in the training data. It is a description of the model, not advice.</p>
            </div>
          ) : null}
        </div>
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
        <KeyValues
          items={[
            { label: "Recorded", value: num(g.recorded) },
            { label: "Finished / still open", value: `${num(g.finished)} / ${num(g.open)}` },
            { label: "Win rate of finished signals", value: fracPct(g.winRate) },
            { label: "Average result", value: rMult(g.meanR, 3) },
            { label: "Scored by the model in force", value: num(g.scored) },
            { label: "Liked by the model", value: g.kept > 0 ? `${num(g.kept)}, average ${rMult(g.keptMeanR, 3)}` : "None yet" },
            { label: "Disliked by the model", value: g.skipped > 0 ? `${num(g.skipped)}, average ${rMult(g.skippedMeanR, 3)}` : "None yet" },
          ]}
        />
      )}
    </Panel>
  );
}
