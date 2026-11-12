// The Options desk signal's numbers (DEC-0051 section 2, EXP-0034's config.yaml `parameters`): the gates' thresholds
// and the expiry rule, in one place, with a stable hash of them.
//
// NOT FROZEN. These are the plan's candidates of 2026-11-12 (`status: "candidate"`). DEC-0051's Amendment 1 freezes
// them once, from the `dry` log's fail shares, with no outcome read; until then the hash below is not the hash any
// signal is checked against, and signal.ts reads every input as not usable (section 1). A changed number is a changed
// hash, which a test pins, so no number can move without a visible diff.
//
// Pure: no I/O and no clock. Nothing imports this outside signal.ts, contract-pick.ts and their tests. The hashes a
// signal is checked against live apart, in signal-freeze.ts: this file is part of the signal code's own hash.
import { createHash } from "node:crypto";

/** The expiry rule (the owner's decision of 2026-11-13): the nearest listed expiry from 1 to 5 sessions out. */
export interface ExpiryRule {
  /** Sessions out, counted by the market calendar from the session after today: the same day is never one. */
  min_sessions: number;
  max_sessions: number;
  /** The rule in the record's own words, as EXP-0034's config.yaml gives it. Wording: not in the hash. */
  words: string;
}

export interface SignalParams {
  /** "candidate" until DEC-0051 Amendment 1. Not part of the hash: freezing the same numbers keeps the hash. */
  status: "candidate" | "frozen";
  expiry_rule: ExpiryRule;
  /** Volume gate: the break bar's volume over its slot's median, at least this. */
  volume_min_ratio: number;
  /** Stock bid–ask gate: (ask − bid) ÷ mid × 10,000, at most this many basis points. */
  stock_spread_max_bps: number;
  /** Shock gate: no one of the last three completed bars with a range above this many times its slot's median range. */
  shock_range_multiple: number;
  /** Shock gate: no listed release from this many minutes before the slot's end to this many after it. */
  event_window_before_min: number;
  event_window_after_min: number;
  /** Contract: ask − bid at most this share of the distance from the mid to the premium stop. Whole hundredths. */
  contract_spread_share_of_stop: number;
  /** Contract: the chain answer's checked age, at most this many seconds. */
  contract_quote_max_age_s: number;
  /**
   * Contract: the quote's own stamp, at most this many seconds before the answer's server time. CANDIDATE, NOT IN THE
   * RECORD YET: to be added to DEC-0051 section 2.5 (and EXP-0034's config.yaml) before acceptance. Without it a
   * quote stamped at 09:31 would still pass at 15:59 on a fresh check.
   */
  contract_quote_stamp_max_age_s: number;
  /** Contract: contracts traded today, at least this many. */
  contract_min_volume: number;
}

export const SIGNAL_PARAMS: Readonly<SignalParams> = Object.freeze({
  status: "candidate",
  expiry_rule: Object.freeze({
    min_sessions: 1,
    max_sessions: 5,
    words: "the nearest listed expiry from 1 to 5 sessions out; the same day is excluded; none listed in that range is no contract",
  }),
  volume_min_ratio: 1.5,
  stock_spread_max_bps: 5,
  shock_range_multiple: 3,
  event_window_before_min: 30,
  event_window_after_min: 30,
  contract_spread_share_of_stop: 0.2,
  contract_quote_max_age_s: 10,
  contract_quote_stamp_max_age_s: 60,
  contract_min_volume: 100,
} as const);

/** JSON with every object's keys sorted, so the same numbers always give the same text, whatever the key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** The parameters as hashed: numbers and rule identifiers only; `status` and wording (`words`) left out. */
export function hashedParams(p: Readonly<SignalParams> = SIGNAL_PARAMS): Record<string, unknown> {
  const { min_sessions, max_sessions } = p.expiry_rule;
  const out: Record<string, unknown> = { ...p, expiry_rule: { min_sessions, max_sessions } };
  delete out.status;
  return out;
}

/** SHA-256 (hex) of hashedParams' canonical JSON. */
export function paramsHash(p: Readonly<SignalParams> = SIGNAL_PARAMS): string {
  return createHash("sha256").update(canonicalJson(hashedParams(p)), "utf8").digest("hex");
}
