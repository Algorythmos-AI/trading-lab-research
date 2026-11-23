// The Radar → Options shadow selection (DEC-0070) for one session, as the Radar pipeline card draws it. Pure: the
// block is the trading host's (paper-options `select`, wt.options.select_status), the clock is passed in.
//
// A shadow: what it shows is not the published focus. The four names on the Options page are still the cloud routine's
// after-close pick until the switch (DEC-0048). The block carries codes, counts, times and flags only; no symbol.
// It never feeds the pipeline's headline, its stage rows or its on-time record (radar-pipeline.ts): a session the
// shadow did not run for reads "no record" here and nowhere else.
import { nyInstant } from "./options";
import type { PaperOptions, SelectSession } from "./paper-options.types";

export type SelectBlock = NonNullable<PaperOptions["select"]>;

/** The job's start, New York minutes after midnight (wt.ops.schedule `options-select`). */
export const SHADOW_START_NY = 6 * 60 + 45;
/** It reads the Radar until 07:45 and has written its run by about 07:55: after this it is overdue. */
export const SHADOW_DUE_NY = 8 * 60;

export type ShadowState = "ran" | "not_due" | "running" | "overdue" | "off" | "no_record";

export interface ShadowView {
  state: ShadowState;
  session: string;
  run: SelectSession | null;
  /** When the job starts for `session` (ms), or null when the day cannot be read. */
  startsAt: number | null;
}

/** The shadow's view of `session` at `nowMs`. `block` null: the host has sent no shadow status. */
export function shadowView(block: SelectBlock | null, session: string, nowMs: number): ShadowView {
  const run = block?.sessions.find((s) => s.session === session) ?? null;
  const startsAt = nyInstant(session, SHADOW_START_NY);
  const dueAt = nyInstant(session, SHADOW_DUE_NY);
  const state: ShadowState = run
    ? "ran"
    : block === null
      ? "no_record"
      : block.off
        ? "off"
        : startsAt !== null && nowMs < startsAt
          ? "not_due"
          : dueAt !== null && nowMs < dueAt
            ? "running"
            : startsAt === null
              ? "no_record"
              : "overdue";
  return { state, session, run, startsAt };
}

export const RADAR_STATUS_WORDS: Record<string, string> = {
  ok: "Radar edition read",
  radar_missing: "Radar missing: ran on the desk's 12",
  radar_stale: "Radar not fresh: ran on the desk's 12",
  radar_invalid: "Radar unreadable: ran on the desk's 12",
};

/** The largest reject codes first, at most `n`, as "code n". */
export function topRejects(rejected: Record<string, number | undefined> | undefined, n = 3): { code: string; count: number }[] {
  return Object.entries(rejected ?? {})
    .flatMap(([code, count]) => (typeof count === "number" ? [{ code, count }] : []))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, n);
}
