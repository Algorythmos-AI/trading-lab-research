// The crypto desk's model (DEC-0016) as the pages read it, from the crypto snapshot's `learning`. Pure helpers.
import { items, type Crypto } from "./crypto";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const n = (v: unknown): number | null => (isNum(v) ? v : null);

const MODEL: Record<string, string> = {
  m0: "Take every signal",
  m1: "Logistic regression",
  m2: "Gradient-boosted trees",
  m3: "Boosted trees with forecast inputs",
};
export const modelLabel = (name: string | null | undefined): string => MODEL[name ?? ""] ?? name ?? "—";

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
          lines: items(t.models)
            .filter((x) => typeof x.name === "string")
            .map((x) => ({
              name: x.name as string,
              label: modelLabel(x.name),
              settings: x.settings ?? null,
              logLoss: n(x.log_loss),
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
          leansOn: items(t.leans_on)
            .filter((x) => typeof x.input === "string")
            .map((x) => ({ input: x.input as string, label: inputLabel(x.input), weight: n(x.weight) })),
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
  };
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
