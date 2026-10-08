// The crypto desk's model (DEC-0016) as the pages read it, from the crypto snapshot's `learning`. Pure helpers.
import { items, type Crypto } from "./crypto";
import { sleeveLabel } from "./tournament";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const n = (v: unknown): number | null => (isNum(v) ? v : null);

const MODEL: Record<string, string> = {
  m0: "Take every signal",
  m1: "Logistic regression",
  m2: "Gradient-boosted trees",
  m3: "Boosted trees with forecast inputs",
};
export const modelLabel = (name: string | null | undefined): string => MODEL[name ?? ""] ?? name ?? "—";

/** Parts named in the configuration that no code fits yet. An unknown one is shown by its own name. */
const PLANNED: Record<string, string> = {
  m3: "Boosted trees with forecast inputs",
  forecaster: "A price forecaster, to feed the model above",
  regime: "A market-regime model (three states)",
};

const KIND: Record<string, string> = { logistic: "Logistic regression", lightgbm: "Gradient-boosted trees" };
export const kindLabel = (kind: string | null | undefined): string => KIND[kind ?? ""] ?? kind ?? "—";

/** What the learning job records about a model, in plain words. An unknown event is shown by its own name. */
const EVENT: Record<string, { label: string; tone: "good" | "warn" | "bad" | "info" | "neutral" }> = {
  lineage: { label: "A new model entered shadow", tone: "info" },
  returned: { label: "An earlier model was chosen again and carried on", tone: "info" },
  retrained: { label: "Retrained on newer data", tone: "neutral" },
  resumed: { label: "Suspension ended by a retraining", tone: "good" },
  checkpoint: { label: "Tested: not passed", tone: "neutral" },
  promoted: { label: "Tested: passed, and promoted to acting", tone: "good" },
  held: { label: "Checked while acting: kept", tone: "good" },
  demoted: { label: "Checked while acting: demoted", tone: "bad" },
  suspended: { label: "Suspended: the market drifted from its training data", tone: "warn" },
  none: { label: "No model in force after a retraining", tone: "neutral" },
};

/** An input of the model, in plain words. An unknown one is shown by its own name. */
const INPUT: Record<string, string> = {
  stop_pct: "how far away the stop is",
  atr_pct: "how much the price has been moving",
  dist_ema20_pct: "distance above the 20-bar average",
  dist_ema50_pct: "distance above the 50-bar average",
  volume_ratio: "volume against its average",
  rsi: "RSI",
  ret_30: "the pair's return over 30 bars",
  btc_above_sma50: "Bitcoin above its 50-day average",
  btc_ret_1d: "Bitcoin's last daily return",
  breadth: "how many pairs signalled together",
  held_elsewhere: "another sleeve already holds the pair",
  spread_pct: "the spread",
  hour_utc: "the hour of the day",
  day_of_week: "the day of the week",
  is_trend: "the signal is from Trend",
  is_break: "the signal is from Breakout",
  is_dip: "the signal is from Dip",
};
export const inputLabel = (name: string | null | undefined): string => INPUT[name ?? ""] ?? name ?? "—";

const STATE: Record<string, { tone: "good" | "warn" | "bad" | "info" | "neutral"; label: string; means: string }> = {
  shadow: { tone: "info", label: "In shadow", means: "It scores every signal and changes nothing. It acts only after passing a checkpoint test." },
  acting: { tone: "good", label: "Acting", means: "It skips weak signals and halves borderline ones. It cannot add or enlarge a trade." },
  demoted: { tone: "bad", label: "Demoted", means: "It stopped separating good signals from bad ones, so it no longer acts." },
  suspended: { tone: "warn", label: "Suspended", means: "Recent signals no longer look like its training data. It acts again after the next retraining." },
};

export interface ModelLine {
  name: string;
  label: string;
  settings: string | null;
  logLoss: number | null;
  /** How uncertain the forecast error is across the validation folds. Null from an older host. */
  logLossSe: number | null;
  /** Its log-loss minus the baseline's: below zero is a better forecast. Null for the baseline itself. */
  logLossDelta: number | null;
  kept: number | null;
  keptMeanR: number | null;
  skipped: number | null;
  skippedMeanR: number | null;
  spread: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  chosen: boolean;
  /** Its log-loss is below the baseline's: the first condition for being chosen. */
  beatsBaseline: boolean;
}

export interface Look {
  checkpoint: number | null;
  signals: number | null;
  spread: number | null;
  lower: number | null;
  brier: number | null;
  brierBase: number | null;
  passed: boolean;
  at: string | null;
}

export interface Learning {
  /** False until the host publishes the section. */
  available: boolean;
  switchOn: boolean;
  /** How many different models have been put in shadow so far: each one is another chance for luck. */
  lineagesStarted: number;
  model: {
    version: string;
    lineage: string;
    state: string;
    tone: "good" | "warn" | "bad" | "info" | "neutral";
    stateLabel: string;
    stateMeans: string;
    trainedAt: string | null;
    finished: number;
    nextCheckpoint: number | null;
    checkpoints: number;
    maxCheckpoints: number | null;
    checkpointSignals: number | null;
    scorePsi: number | null;
    drifted: boolean;
    driftInputs: string[];
    looks: Look[];
    /** The model's card. Every field is null (or empty) from a host that does not publish it yet. */
    kind: string | null;
    sha: string | null;
    features: string | null;
    inputs: number | null;
    cutoff: number | null;
    halfBelow: number | null;
    calibA: number | null;
    calibB: number | null;
    ageDays: number | null;
    since: string | null;
    /** Inputs measured beyond the drift limit, worst first. */
    driftPsi: { input: string; label: string; psi: number }[];
    bySleeve: { name: string; label: string; n: number | null; meanR: number | null }[];
    /** Every input of the model in force with its weight, strongest first. */
    leansOn: { input: string; label: string; weight: number | null }[];
  } | null;
  training: {
    at: string | null;
    chosen: string | null;
    decision: string | null;
    examples: number | null;
    pairs: number | null;
    effectiveN: number | null;
    winRate: number | null;
    meanR: number | null;
    attempt: number | null;
    start: string | null;
    end: string | null;
    dataHash: string | null;
    lines: ModelLine[];
    leansOn: { input: string; label: string; weight: number | null }[];
  } | null;
  signals: {
    recorded: number;
    finished: number;
    open: number;
    winRate: number | null;
    meanR: number | null;
    scored: number;
    kept: number;
    keptMeanR: number | null;
    skipped: number;
    skippedMeanR: number | null;
  };
  limits: { driftPsi: number | null; driftInputs: number | null; maxAgeDays: number | null; demotionWindow: number | null };
  /** How the lineage in force has scored the desk's signals, by score band. Null until the host publishes it. */
  scores: { cutoff: number | null; halfBelow: number | null; total: number; bins: ScoreBin[] } | null;
  /** Running total R of liked and of disliked signals, in the order their trades ended. */
  series: { at: string; n: number; kept: number; skipped: number }[];
  events: { at: string | null; event: string; label: string; tone: "good" | "warn" | "bad" | "info" | "neutral"; lineage: string | null; version: string | null }[];
  lineages: { lineage: string; label: string; state: string; stateLabel: string; tone: "good" | "warn" | "bad" | "info" | "neutral"; checkpoints: number; finished: number | null; since: string | null; inForce: boolean }[];
  registry: { version: string; kind: string | null; lineage: string | null; trainedAt: string | null; examples: number | null; inForce: boolean }[];
  planned: { name: string; label: string }[];
  /** True when the host publishes the fuller section (the model's card, scores and history). */
  detailed: boolean;
}

export interface ScoreBin {
  lo: number;
  hi: number;
  kept: number;
  halved: number;
  skipped: number;
}

const leans = (list: readonly ({ input?: string | null; weight?: number | null } | null)[] | null | undefined) =>
  items(list)
    .filter((x) => typeof x.input === "string")
    .map((x) => ({ input: x.input as string, label: inputLabel(x.input), weight: n(x.weight) }));

/** "m1:C=0.1" as "Logistic regression (C=0.1)". */
export function lineageLabel(lineage: string | null | undefined): string {
  if (!lineage) return "—";
  const [kind, ...rest] = lineage.split(":");
  const settings = rest.join(":").replace(/,/g, ", ");
  return settings ? `${modelLabel(kind)} (${settings})` : modelLabel(kind);
}

export function learning(s: Crypto): Learning {
  const l = s.learning;
  const m = l?.model;
  const t = l?.training;
  const g = l?.signals;
  const base = n(items(t?.models).find((x) => x.name === "m0")?.log_loss);
  const st = STATE[m?.state ?? ""] ?? { tone: "neutral" as const, label: m?.state ?? "Unknown", means: "" };
  return {
    available: l != null,
    switchOn: l?.switch !== "off",
    lineagesStarted: n(l?.lineages_started) ?? 0,
    model:
      m && typeof m.version === "string"
        ? {
            version: m.version,
            lineage: m.lineage ?? m.version,
            state: m.state ?? "shadow",
            tone: st.tone,
            stateLabel: st.label,
            stateMeans: st.means,
            trainedAt: m.trained_at ?? null,
            finished: n(m.finished) ?? 0,
            nextCheckpoint: n(m.next_checkpoint),
            checkpoints: n(m.checkpoints) ?? 0,
            maxCheckpoints: n(m.max_checkpoints),
            checkpointSignals: n(m.checkpoint_signals),
            scorePsi: n(m.score_psi),
            drifted: m.drifted === true,
            driftInputs: items(m.drift_inputs).filter((x): x is string => typeof x === "string"),
            looks: items(m.looks).map((k) => ({
              checkpoint: n(k.checkpoint),
              signals: n(k.signals),
              spread: n(k.spread),
              lower: n(k.lower),
              brier: n(k.brier),
              brierBase: n(k.brier_base),
              passed: k.passed === true,
              at: k.t ?? null,
            })),
            kind: m.kind ?? null,
            sha: m.sha ?? null,
            features: m.features ?? null,
            inputs: n(m.inputs),
            cutoff: n(m.cutoff),
            halfBelow: n(m.half_below),
            calibA: n(m.calib_a),
            calibB: n(m.calib_b),
            ageDays: n(m.age_days),
            since: m.since ?? null,
            driftPsi: Object.entries(m.drift_psi ?? {})
              .filter((e): e is [string, number] => isNum(e[1]))
              .map(([input, psi]) => ({ input, label: inputLabel(input), psi }))
              .sort((a, b) => b.psi - a.psi),
            bySleeve: Object.entries(m.by_sleeve ?? {}).map(([name, v]) => ({ name, label: sleeveLabel(name), n: n(v?.n), meanR: n(v?.mean_r) })),
            leansOn: leans(m.leans_on),
          }
        : null,
    training: t
      ? {
          at: t.t ?? null,
          chosen: t.chosen ?? null,
          decision: t.decision ?? null,
          examples: n(t.examples),
          pairs: n(t.pairs),
          effectiveN: n(t.effective_n),
          winRate: n(t.win_rate),
          meanR: n(t.mean_r),
          attempt: n(t.attempt),
          start: t.start ?? null,
          end: t.end ?? null,
          dataHash: t.data_hash ?? null,
          lines: items(t.models)
            .filter((x) => typeof x.name === "string")
            .map((x) => ({
              name: x.name as string,
              label: modelLabel(x.name),
              settings: x.settings ?? null,
              logLoss: n(x.log_loss),
              logLossSe: n(x.log_loss_se),
              logLossDelta: x.name !== "m0" && isNum(base) && isNum(x.log_loss) ? x.log_loss - base : null,
              kept: n(x.kept),
              keptMeanR: n(x.kept_mean_r),
              skipped: n(x.dropped),
              skippedMeanR: n(x.dropped_mean_r),
              spread: n(x.spread),
              ciLow: n(x.ci_low),
              ciHigh: n(x.ci_high),
              chosen: x.name === t.chosen,
              beatsBaseline: x.name !== "m0" && isNum(base) && isNum(x.log_loss) && x.log_loss < base,
            })),
          leansOn: leans(t.leans_on),
        }
      : null,
    signals: {
      recorded: n(g?.recorded) ?? 0,
      finished: n(g?.finished) ?? 0,
      open: n(g?.open) ?? 0,
      winRate: n(g?.win_rate),
      meanR: n(g?.mean_r),
      scored: n(g?.scored) ?? 0,
      kept: n(g?.kept) ?? 0,
      keptMeanR: n(g?.kept_mean_r),
      skipped: n(g?.skipped) ?? 0,
      skippedMeanR: n(g?.skipped_mean_r),
    },
    limits: {
      driftPsi: n(l?.limits?.drift_psi),
      driftInputs: n(l?.limits?.drift_inputs),
      maxAgeDays: n(l?.limits?.max_model_age_days),
      demotionWindow: n(l?.limits?.demotion_window_signals),
    },
    scores: l?.scores ? scoresOf(l.scores) : null,
    series: items(l?.series)
      .filter((x) => typeof x.t === "string" && isNum(x.kept) && isNum(x.skipped))
      .map((x, i) => ({ at: x.t as string, n: n(x.n) ?? i + 1, kept: x.kept as number, skipped: x.skipped as number })),
    events: items(l?.events)
      .filter((x) => typeof x.event === "string")
      .map((x) => ({
        at: x.t ?? null,
        event: x.event as string,
        label: EVENT[x.event as string]?.label ?? (x.event as string),
        tone: EVENT[x.event as string]?.tone ?? ("neutral" as const),
        lineage: x.lineage ?? null,
        version: x.version ?? null,
      }))
      .reverse(),
    lineages: items(l?.lineages)
      .filter((x) => typeof x.lineage === "string")
      .map((x) => {
        const look = STATE[x.state ?? ""] ?? { tone: "neutral" as const, label: x.state ?? "Unknown" };
        return {
          lineage: x.lineage as string,
          label: lineageLabel(x.lineage),
          state: x.state ?? "shadow",
          stateLabel: look.label,
          tone: look.tone,
          checkpoints: n(x.checkpoints) ?? 0,
          finished: n(x.finished),
          since: x.since ?? null,
          inForce: x.in_force === true,
        };
      }),
    registry: items(l?.registry)
      .filter((x) => typeof x.version === "string")
      .map((x) => ({
        version: x.version as string,
        kind: x.kind ?? null,
        lineage: x.lineage ?? null,
        trainedAt: x.trained_at ?? null,
        examples: n(x.examples),
        inForce: x.in_force === true,
      }))
      .reverse(),
    planned: items(l?.planned)
      .filter((x): x is string => typeof x === "string")
      .map((name) => ({ name, label: PLANNED[name] ?? name })),
    detailed: l?.limits != null,
  };
}

function scoresOf(sc: NonNullable<NonNullable<Crypto["learning"]>["scores"]>): Learning["scores"] {
  const bins = items(sc.bins)
    .filter((b) => isNum(b.lo) && isNum(b.hi))
    .map((b) => ({ lo: b.lo as number, hi: b.hi as number, kept: n(b.kept) ?? 0, halved: n(b.halved) ?? 0, skipped: n(b.skipped) ?? 0 }));
  return { cutoff: n(sc.cutoff), halfBelow: n(sc.half_below), total: bins.reduce((a, b) => a + b.kept + b.halved + b.skipped, 0), bins };
}

/** One sentence for the panel's heading: what is in force and why. Statuses and counts only. */
export function learningLine(l: Learning): string {
  if (!l.available) return "The model has not published yet.";
  if (!l.switchOn) return "Learning is switched off: no model scores or acts.";
  if (l.model) {
    const left = isNum(l.model.nextCheckpoint) ? Math.max(0, l.model.nextCheckpoint - l.model.finished) : null;
    const next =
      l.model.state === "shadow" && isNum(l.model.maxCheckpoints) && l.model.checkpoints >= l.model.maxCheckpoints
        ? " It has used all its checkpoints."
        : isNum(left)
          ? ` Next test in ${left} finished ${left === 1 ? "signal" : "signals"}.`
          : "";
    return `${modelLabel(l.model.lineage.split(":")[0])} is ${l.model.stateLabel.toLowerCase()}.${next}`;
  }
  if (l.training) return "No model is in force: at the last training none beat taking every signal.";
  return "No model has been trained on this host yet.";
}

/** The learning job on the host, as the snapshot's `jobs` names it. */
export const LEARN_JOB = "crypto-learn";

/** The alerts that belong to the model. An unknown one under the same prefixes is shown by its key. */
const ALERT: Record<string, string> = {
  "crypto:scorer-failed": "The model did not score the last cycle's signals; they are traded as their rules say",
  "crypto:learn-train-failed": "The weekly training failed",
  "crypto:model-promoted": "The model was promoted today",
  "crypto:model-demoted": "The model was demoted today",
  "crypto:model-suspended": "The model was suspended today",
  "deploy-ml": "The machine-learning environment on the host is not in sync",
};
export const isLearningAlert = (key: string | null | undefined): key is string =>
  typeof key === "string" && (key in ALERT || /^crypto:(model-|scorer-|learn-)/.test(key));
export const learningAlertLabel = (key: string): string => ALERT[key] ?? key;

export type StepState = "done" | "current" | "failed" | "paused" | "todo";
export interface Step {
  key: string;
  label: string;
  state: StepState;
}

/** The road a model travels, and where this one is: trained, better than the baseline, in shadow, tested, acting. */
export function modelRoad(l: Learning): Step[] {
  const m = l.model;
  const trained = l.training != null || m != null;
  const chosen = m != null;
  const passed = m != null && (m.looks.some((k) => k.passed) || m.state === "acting" || m.state === "demoted" || m.state === "suspended");
  const after = (done: boolean, now: boolean): StepState => (done ? "done" : now ? "current" : "todo");
  return [
    { key: "trained", label: "Trained", state: after(trained, true) },
    { key: "chosen", label: "Beat the baseline", state: chosen ? "done" : trained ? "failed" : "todo" },
    { key: "shadow", label: "In shadow", state: after(passed, chosen) },
    { key: "passed", label: "Passed a test", state: passed ? "done" : "todo" },
    {
      key: "acting",
      label: m?.state === "demoted" ? "Demoted" : m?.state === "suspended" ? "Suspended" : "Acting",
      state: m?.state === "acting" ? "current" : m?.state === "demoted" ? "failed" : m?.state === "suspended" ? "paused" : "todo",
    },
  ];
}
