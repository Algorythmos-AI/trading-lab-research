// The programme in one table: each desk, what decides it, where it stands, and the record that holds it. Pure: no
// I/O. Every figure comes from the published snapshot, the options clone's own document or desks.json; nothing here
// is typed by hand except the clone's verdict thresholds, which test/programme.test.ts holds equal to
// src/wt/options/review.py.
import { deskNote, sinceWords } from "./desk-state";
import { records, runWords, sessionJob, standing } from "./gap-hunter";
import type { OptionsClone } from "./options-clone.types";
import { GAP_HUNTER, RETIRED_RULE, ROBOTS } from "./robots";
import type { Snapshot } from "./types";

/** wt.options.review: a hypothesis gets its verdict at this many trades and sessions (DEC-0030). */
export const CLONE_MIN_TRADES = 30;
export const CLONE_MIN_SESSIONS = 20;

export type ProgrammeTone = "good" | "warn" | "bad" | "neutral" | "info";

export interface ProgrammeRow {
  desk: string;
  state: string;
  tone: ProgrammeTone;
  /** One line per measure: what decides the desk, against its line. */
  lines: string[];
  record: string;
}

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r2 = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`;
const of = (a: number | null, b: number | null, unit: string) => (a === null || b === null ? null : `${a} of ${b} ${unit}`);

/**
 * Gap Hunter, the stock robot: where it stands, its last session and the records that register its rule, each as the
 * snapshot has it. Nothing here is typed by hand but the two record ids.
 */
export function gapHunterRow(s: Snapshot | null): ProgrammeRow {
  const st = standing(s);
  const r = records(s);
  const word = (x: { id: string; status: string | null }) => `${x.id}: ${x.status ?? "not in this snapshot's registry"}`;
  return {
    desk: GAP_HUNTER.name,
    state: st.word,
    tone: st.tone,
    lines: [`${runWords(sessionJob(s))}`, `Rule ${word(r.decision)}`, `Hypothesis ${word(r.hypothesis)}`],
    record: GAP_HUNTER.decision,
  };
}

/**
 * The stock rule that ran before Gap Hunter, as its paper desk last stood: G2a (the desk runs the rule), G2b (the
 * rule earns) and the stop rule (DEC-0037). Shown only in the retired section of the Strategies page.
 */
export function retiredRuleRow(s: Snapshot | null): ProgrammeRow {
  const g = s?.ops?.paper?.g2 ?? null;
  const rule = s?.ops?.paper?.stop_rule ?? null;
  const lines: string[] = [];
  if (g) {
    const g2a = [of(n(g.sessions), n(g.sessions_needed), "clean sessions"), of(n(g.incident_free_streak), n(g.incident_free_needed), "incident-free in a row")].filter(Boolean);
    const agree =
      g.agreement_level === "bar" && n(g.agreement_days)
        ? `agreement at the bar ${n(g.agreement_agree) ?? 0} of ${n(g.agreement_days)} (90% needed)`
        : "agreement at the bar not readable yet";
    lines.push(`G2a, the desk runs the rule: ${[...g2a, agree].join(" · ")}`);
    const t = of(n(g.trades), n(g.trades_needed), "trades");
    if (t) lines.push(`G2b, the rule earns: ${t}`);
  } else {
    lines.push("G2: not in this snapshot");
  }
  let tone: ProgrammeTone = "neutral";
  let state = "Retired";
  if (!rule) {
    lines.push("Stop rule: not in this snapshot");
  } else if (rule.present === false) {
    lines.push("Stop rule: none in the configuration, so nothing stops the rule");
    tone = "bad";
  } else {
    const cum = n(rule.cum_r);
    const line = n(rule.cum_r_max_loss);
    const parts = [
      cum !== null && line !== null ? `${r2(cum)} against the ${r2(line)} line` : null,
      of(n(rule.trades), n(rule.review_at_trades), "trades to the review"),
      rule.stop_date ? `ends ${sinceWords(rule.stop_date) ?? rule.stop_date}` : null,
    ].filter(Boolean);
    lines.push(`Stop rule: ${parts.join(" · ")}`);
    if (rule.fired) {
      lines.push(`The stop rule fired (${rule.fired}): the rule makes no new entry until a decision record resets it`);
      tone = "bad";
      state = "Stopped by its rule";
    }
  }
  return { desk: RETIRED_RULE.name, state, tone, lines, record: rule?.decision ?? "DEC-0037" };
}

/** The options clone on paper: each hypothesis gets its verdict at 30 trades and 20 sessions (DEC-0030). */
export function cloneRow(clone: OptionsClone | null): ProgrammeRow {
  const all = clone?.setups?.find((x) => x.hyp === "all") ?? null;
  const lines: string[] = [];
  let tone: ProgrammeTone = "info";
  let state = "Paper trading";
  if (!all) {
    lines.push("Its document has not published yet");
    tone = "neutral";
    state = "No document";
  } else {
    lines.push(`Toward the verdict: ${all.trades} of ${CLONE_MIN_TRADES} trades · ${all.sessions} of ${CLONE_MIN_SESSIONS} sessions`);
    for (const h of clone?.setups ?? []) {
      if (h.hyp !== "all" && h.verdict !== "none") lines.push(`${h.hyp}: ${h.verdict === "passes" ? "passes its test" : "falsified"}`);
    }
    if (all.verdict === "falsified") {
      tone = "bad";
      state = "Falsified";
    } else if (all.verdict === "passes") {
      tone = "good";
      state = "Passes its test";
    }
  }
  return { desk: "Options clone", state, tone, lines, record: "DEC-0030" };
}

/** A desk that stopped, as desks.json records it. */
export function stoppedRow(desk: "crypto" | "hft", label: string): ProgrammeRow {
  const note = deskNote(desk);
  const since = sinceWords(note.since);
  const word = note.state === "closed" ? "Closed" : note.state === "parked" ? "Parked" : "Running";
  return {
    desk: label,
    state: word,
    tone: note.state === "running" ? "info" : "neutral",
    lines: [note.state === "running" ? "Running" : `${word}${since ? ` since ${since}` : ""}: no trial runs and nothing is scheduled`],
    record: note.record ?? "—",
  };
}

export function programme(s: Snapshot | null, clone: OptionsClone | null): ProgrammeRow[] {
  return [cloneRow(clone), gapHunterRow(s), stoppedRow("crypto", "Crypto"), stoppedRow("hft", "HFT (forex)")];
}

/** The research arms stopped counting on this day; the Paper page holds what they booked. */
export const ARMS_STATE = "Counting ended 17 Nov 2026";

export interface RobotLine {
  key: string;
  name: string;
  what: string;
  href: string;
  state: string;
  tone: ProgrammeTone;
}

/** The three robots in one line each, for every page that sums them up: the options clone, Gap Hunter, the arms. */
export function robotLines(s: Snapshot | null, clone: OptionsClone | null): RobotLine[] {
  const c = cloneRow(clone);
  const g = standing(s);
  const state: Record<string, { state: string; tone: ProgrammeTone }> = {
    clone: { state: c.state, tone: c.tone },
    "gap-hunter": { state: g.word, tone: g.tone },
    arms: { state: ARMS_STATE, tone: "neutral" },
  };
  return ROBOTS.map((r) => ({ key: r.key, name: r.name, what: r.what, href: r.href, ...state[r.key]! }));
}
