// Evidence classes: where a number on the dashboard comes from. The owner trades real money by hand from the desk, so
// a paper, simulated or model figure must never be read as the owner's Webull money. Every money figure carries one of
// these classes (components/ui/money.tsx), and every figure that is not real sits inside a frame that names its class
// (components/ui/env-chip.tsx).
//
// Each class has its own text and its own border style, so colour is never the only signal:
//   real    REAL · WEBULL       solid ink, no frame: the owner's own account
//   paper   PAPER · ALPACA      dashed blue border: the Alpaca paper account
//   shadow  SHADOW · SIM        dotted amber border: simulated fills from the shadow evaluator
//   model   MODEL · BACKTEST    double grey border on a hatched ground: a backtest or model estimate
// The frame borders are at full strength: each passes 3:1 against the page in both themes (WCAG 1.4.11).
//
// The class strings are written out in full so Tailwind finds them in this file.

/** Where a figure comes from. */
export type Env = "real" | "paper" | "shadow" | "model";

/** Every class, real first. */
export const ENVS = ["real", "paper", "shadow", "model"] as const satisfies readonly Env[];

/** How a class is shown. */
export type EnvMeta = {
  /** The chip's text, upper case, the source after the dot. */
  chip: string;
  /** A short name for the class, for an accessible label: "Paper account (Alpaca)". */
  name: string;
  /** One sentence on what the class is, for a tooltip. */
  description: string;
  /** The border style the chip and the frame share: the signal that does not depend on colour. */
  border: "solid" | "dashed" | "dotted" | "double";
  /** The chip's classes, beside the shared chip base in env-chip.tsx. */
  chipClass: string;
  /** The frame's classes. Empty for real: the owner's own money is not framed. */
  frameClass: string;
};

export const ENV_META: Readonly<Record<Env, EnvMeta>> = {
  real: {
    chip: "REAL · WEBULL",
    name: "Real money (Webull)",
    description: "The owner's own Webull account: real money.",
    border: "solid",
    chipClass: "border-solid border-foreground bg-foreground text-background",
    frameClass: "",
  },
  paper: {
    chip: "PAPER · ALPACA",
    name: "Paper account (Alpaca)",
    description: "The Alpaca paper account: simulated money, not the owner's.",
    border: "dashed",
    chipClass: "border-dashed border-info bg-info-soft text-info",
    frameClass: "rounded-md border-2 border-dashed border-info",
  },
  shadow: {
    chip: "SHADOW · SIM",
    name: "Shadow simulation",
    description: "Simulated fills from the shadow evaluator: no account, no money.",
    border: "dotted",
    chipClass: "border-dotted border-warn bg-warn-soft text-warn",
    frameClass: "rounded-md border-2 border-dotted border-warn",
  },
  model: {
    chip: "MODEL · BACKTEST",
    name: "Model or backtest",
    description: "A backtest or model estimate: no account, no money.",
    border: "double",
    chipClass: "border-double border-[3px] border-neutral bg-neutral-soft text-neutral",
    frameClass:
      "rounded-md border-4 border-double border-neutral bg-[repeating-linear-gradient(135deg,var(--neutral-soft)_0_6px,transparent_6px_12px)]",
  },
};

/**
 * What a frame or a chip shows when its class is not one of the four (a cast let a bad value through): a red frame
 * that says the source is unknown, so the figure inside fails closed instead of passing for real money. The guard
 * test reports `data-env="unknown"` as a breach.
 */
export const UNKNOWN_META: EnvMeta = {
  chip: "SOURCE UNKNOWN",
  name: "Unknown source",
  description: "This figure's source is not known: do not rely on it.",
  border: "solid",
  chipClass: "border-solid border-bad bg-bad-soft text-bad",
  frameClass: "rounded-md border-2 border-solid border-bad",
};

/** The display for `env`, or UNKNOWN_META when it is not a class. */
export function envMeta(env: unknown): EnvMeta {
  return isEnv(env) ? ENV_META[env] : UNKNOWN_META;
}

/** True when `v` names a class. */
export function isEnv(v: unknown): v is Env {
  return typeof v === "string" && (ENVS as readonly string[]).includes(v);
}
