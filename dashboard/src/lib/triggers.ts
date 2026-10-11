// Where each probation rule stands in today's session, from the options live document. Pure: no I/O.
//
// The trading host replays the rules during the session on market data a quarter of an hour behind. What it says
// is provisional: another feed's bars than the record's. The after-close edition is the record; this is the
// in-session read of it. Descriptive only: a rule on probation is not a signal to trade.
import type { Options } from "./options";
import type { OptionsLive } from "./options-live.types";
import { POSITIONS_GONE_MIN } from "./positions";

export type RuleState = "waiting" | "open" | "stopped" | "target" | "closed";

export interface Trigger {
  symbol: string;
  rule: string;
  /** The rule's label from the edition. A rule the edition does not name is "A rule": an id is never drawn. */
  label: string;
  state: Exclude<RuleState, "waiting">;
  /** New York time of the hourly close it triggered on, or null when the host did not say. */
  bar: string | null;
  side: "call" | "put" | null;
  /** R on the stock so far, before any option cost. */
  r: number | null;
}

export interface RulesToday {
  session: string;
  asOf: string;
  delayMin: number | null;
  /** True once the session's last hourly bar is in. */
  complete: boolean;
  /** Names the host worked the rules out for. */
  names: number;
  /** Rules that have triggered, latest first, then by name. */
  triggers: Trigger[];
  /** Every rule's state by name and rule id, for the name's own rule list. */
  bySymbol: Record<string, Record<string, { state: RuleState; bar: string | null; r: number | null }>>;
}

export const STATE_LABEL: Record<RuleState, string> = { waiting: "Waiting", open: "Open", stopped: "Stopped", target: "Target reached", closed: "Closed at the bell" };
export const OTHER_RULE = "A rule";

/**
 * Today's rule states for the desk, or null when there is nothing to show: no document, no rules in it, rules
 * for another session than the edition's (yesterday's states under today's levels would be wrong, not old), or
 * a document as old as positions that are no longer shown.
 */
export function rulesToday(doc: OptionsLive | null, e: Options, now: number): RulesToday | null {
  const block = doc?.rules;
  if (!doc || !block || block.session !== e.session) return null;
  const at = Date.parse(doc.as_of);
  if (!Number.isFinite(at) || (now - at) / 60_000 > POSITIONS_GONE_MIN) return null;
  const labels = new Map((e.rules ?? []).map((r) => [r.id, r.label ?? OTHER_RULE]));
  const carried = new Set(e.tickers.map((t) => t.symbol));
  const triggers: Trigger[] = [];
  const bySymbol: RulesToday["bySymbol"] = {};
  let names = 0;
  for (const n of block.names ?? []) {
    if (!n || !carried.has(n.symbol) || !Array.isArray(n.states)) continue;
    names++;
    const mine: RulesToday["bySymbol"][string] = {};
    for (const s of n.states) {
      if (!s || typeof s.rule !== "string" || !(s.state in STATE_LABEL)) continue;
      const bar = typeof s.bar === "string" ? s.bar : null;
      const r = typeof s.r === "number" && Number.isFinite(s.r) ? s.r : null;
      mine[s.rule] = { state: s.state, bar, r };
      if (s.state !== "waiting") triggers.push({ symbol: n.symbol, rule: s.rule, label: labels.get(s.rule) ?? OTHER_RULE, state: s.state, bar, side: s.side ?? null, r });
    }
    bySymbol[n.symbol] = mine;
  }
  triggers.sort((a, b) => (b.bar ?? "").localeCompare(a.bar ?? "") || a.symbol.localeCompare(b.symbol) || a.rule.localeCompare(b.rule));
  return { session: block.session, asOf: block.as_of, delayMin: block.delay_min ?? null, complete: block.complete === true, names, triggers, bySymbol };
}
