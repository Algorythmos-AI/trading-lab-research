// Where each probation rule stands in today's session, from the options live document. Pure: no I/O.
//
// The trading host replays the rules during the session on market data a quarter of an hour behind. What it says
// is provisional: another feed's bars than the record's. The after-close edition is the record; this is the
// in-session read of it. Descriptive only: a rule on probation is not a signal to trade.
import type { Options } from "./options";
import type { OptionsLive } from "./options-live.types";
import { POSITIONS_GONE_MIN, POSITIONS_OLD_MIN } from "./positions";

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
  /** Names the host worked the rules out for, and how many the desk carries: fewer means some were left out. */
  names: number;
  desk: number;
  /** Minutes since the host sent the document these states came in. */
  ageMin: number;
  /** The host's own word, when it last sent, that the market was open and has not yet closed. */
  openByDoc: boolean;
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
  const close = Date.parse(doc.market?.next_close ?? "");
  const openByDoc = doc.market?.is_open === true && (!Number.isFinite(close) || now < close);
  const labels = new Map((e.rules ?? []).map((r) => [r.id, r.label ?? OTHER_RULE]));
  const carried = new Set(e.tickers.map((t) => t.symbol));
  const triggers: Trigger[] = [];
  const bySymbol: RulesToday["bySymbol"] = {};
  let names = 0;
  for (const n of block.names ?? []) {
    if (!n || !carried.has(n.symbol) || !Array.isArray(n.states) || Object.hasOwn(bySymbol, n.symbol)) continue;
    names++;
    const mine: RulesToday["bySymbol"][string] = {};
    for (const s of n.states) {
      if (!s || typeof s.rule !== "string" || !Object.hasOwn(STATE_LABEL, s.state) || Object.hasOwn(mine, s.rule)) continue;
      const bar = typeof s.bar === "string" ? s.bar : null;
      const r = typeof s.r === "number" && Number.isFinite(s.r) ? s.r : null;
      mine[s.rule] = { state: s.state, bar, r };
      if (s.state !== "waiting") triggers.push({ symbol: n.symbol, rule: s.rule, label: labels.get(s.rule) ?? OTHER_RULE, state: s.state, bar, side: s.side ?? null, r });
    }
    bySymbol[n.symbol] = mine;
  }
  triggers.sort((a, b) => (b.bar ?? "").localeCompare(a.bar ?? "") || a.symbol.localeCompare(b.symbol) || a.rule.localeCompare(b.rule));
  return { session: block.session, asOf: block.as_of, delayMin: block.delay_min ?? null, complete: block.complete === true, names, desk: carried.size, ageMin: Math.max(0, (now - at) / 60_000), openByDoc, triggers, bySymbol };
}

/**
 * True when the states should not be read as current: the session is still running by the clock, the host's last
 * word did not say it was over, and nothing has arrived for half an hour.
 */
export function rulesAreOld(r: RulesToday, marketOpen: boolean): boolean {
  return (marketOpen || r.openByDoc) && !r.complete && r.ageMin > POSITIONS_OLD_MIN;
}
