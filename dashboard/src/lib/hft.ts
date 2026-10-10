// The HFT desk's view helpers (ADR 0006). Pure: no I/O, no clock.
import { DASH, signed } from "./format";
import type { Freshness } from "./freshness";
import type { Health, HealthReason } from "./health";
import type { HftSnapshot } from "./hft.types";
import type { Tone } from "./labels";

export type Hft = HftSnapshot;
export type HftPhase = Hft["phases"][number];
export type HftPair = NonNullable<Hft["pairs"]>[number];
export type HftSleeve = NonNullable<Hft["sleeves"]>[number];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The rows of an optional list, without holes. A stored snapshot is read as it is, so nothing here trusts its shape. */
export function rows<T>(v: readonly (T | null | undefined)[] | null | undefined): T[] {
  return Array.isArray(v) ? v.filter((x): x is T => x !== null && x !== undefined) : [];
}

export interface Look {
  label: string;
  tone: Tone;
}

// Plain words for the ids the contract allows. An id this build does not know is shown as it is (see `look`).
export const MODE: Record<string, string> = { paper: "Paper" };
export const STAGE: Record<string, string> = { foundation: "Foundation", recording: "Recording", shadow: "Shadow", paper: "Paper" };
export const VENUE: Record<string, string> = { ibkr_paper: "IBKR paper", sim: "Simulator" };
export const FORM: Record<string, string> = { cash: "Cash", cfd: "CFD" };
export const SLEEVE: Record<string, string> = { control: "Control", directional_change: "Directional change", ml: "ML", dl: "DL" };
export const SLEEVE_STAGE: Record<string, Look> = {
  shadow: { label: "Shadow", tone: "info" },
  min_size: { label: "Minimum size", tone: "info" },
  normal: { label: "Normal size", tone: "good" },
  stepped_down: { label: "Stepped down", tone: "warn" },
  off: { label: "Off", tone: "neutral" },
};
export const RECORDER: Record<string, Look> = {
  running: { label: "Running", tone: "good" },
  stopped: { label: "Stopped", tone: "warn" },
  never: { label: "Never started", tone: "neutral" },
};

/** The words for a published id, or the id itself when this build has no words for it. */
export function words(map: Record<string, string>, id: string | null | undefined): string {
  if (typeof id !== "string" || !id) return DASH;
  return Object.hasOwn(map, id) ? map[id]! : id;
}

/** The label and tone for a published state, or the id in a neutral tone when this build does not know it. */
export function look(map: Record<string, Look>, id: string | null | undefined): Look {
  if (typeof id !== "string" || !id) return { label: DASH, tone: "neutral" };
  return Object.hasOwn(map, id) ? map[id]! : { label: id, tone: "neutral" };
}

/** A net result with its sign and its currency code: "+2.20 USD", "−3.20 USD". Only shown behind the owner's login. */
export function net(v: number | null | undefined, currency: string | null | undefined): string {
  if (!isNum(v)) return DASH;
  return currency ? `${signed(v, 2)} ${currency}` : signed(v, 2);
}

/** A median spread in price units. Three significant digits, so 0.00008 and 0.011 both read as numbers. */
export function spread(v: number | null | undefined): string {
  return isNum(v) ? v.toLocaleString("en-US", { maximumSignificantDigits: 3 }) : DASH;
}

/** Megabytes on disk: "1,844 MB". */
export function megabytes(v: number | null | undefined): string {
  return isNum(v) ? `${v.toLocaleString("en-US", { maximumFractionDigits: 0 })} MB` : DASH;
}

/** The build phases the desk reports, in F0 to F7 order. Only what was published: a phase it left out is not drawn. */
export function phases(s: Hft): HftPhase[] {
  return rows(s.phases)
    .filter((p) => typeof p.id === "string")
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** "3 of 8 phases are done. F3 is open." */
export function phaseLine(list: readonly HftPhase[]): string {
  const done = list.filter((p) => p.state === "done").length;
  const open = list.filter((p) => p.state === "open").map((p) => p.id);
  const head = `${done} of ${list.length} ${list.length === 1 ? "phase is" : "phases are"} done.`;
  if (open.length === 0) return head;
  return `${head} ${open.join(", ")} ${open.length === 1 ? "is" : "are"} open.`;
}

/**
 * Green / amber / red for the HFT desk. The level and the reason codes are the desk's own; the dashboard adds only
 * what it can see from outside: a snapshot that is late or has stopped, and the kill and flatten switches.
 */
export function hftHealth(s: Hft, freshness: Freshness): Health {
  const reasons: HealthReason[] = [];
  if (freshness.state === "stopped") reasons.push({ code: "stopped", level: "red", text: "The HFT desk has stopped publishing." });
  const level = s.health?.level;
  const own: HealthReason["level"] = level === "bad" ? "red" : "amber";
  const codes = [...new Set(rows(s.health?.reasons).filter((c) => typeof c === "string" && c))];
  for (const c of codes) reasons.push({ code: `desk:${c}`, level: own, text: `The desk reports: ${c}.` });
  if (codes.length === 0 && (level === "warn" || level === "bad")) {
    const text = level === "bad" ? "The desk reports a problem and gave no reason code." : "The desk reports a warning and gave no reason code.";
    reasons.push({ code: "desk", level: own, text });
  }
  if (freshness.state === "late") reasons.push({ code: "late", level: "amber", text: "The HFT desk's update is late." });
  if (s.desk?.kill === true) reasons.push({ code: "kill", level: "amber", text: "The HFT desk's kill switch is on." });
  if (s.desk?.flatten === true) reasons.push({ code: "flatten", level: "amber", text: "The HFT desk's flatten switch is on." });
  const overall = reasons.some((r) => r.level === "red") ? "red" : reasons.length > 0 ? "amber" : "green";
  reasons.sort((a, b) => (a.level === b.level ? 0 : a.level === "red" ? -1 : 1));
  return { level: overall, reasons, freshness };
}
