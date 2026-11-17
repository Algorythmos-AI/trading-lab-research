// What the Options page's Radar desk panel shows, from a stored Radar desk file (stocksdelta/radar-desk). Pure: no I/O.
//
// Display only (trading-options-funnel funnel plan Phase 1): the flags inform the owner and change no pick, no board
// state and no checklist. Only the session's focus names are shown, each on its own; the other desk names never reach
// the page, and nothing here compares a focus name with them or shows any outcome (the blind rule, DEC-0047 section 8).
// Nothing in signal.ts's or desk-eval.ts's import closure imports this file.
import type { Tone } from "./labels";
import type { Name, RadarDeskDoc } from "./radar-desk.types";

export type RadarDeskFlag = Name["flags"][number];

/** Each flag's chip: a short word and its colour. Colour first; the word is always there too. */
export const FLAG_CHIP: Record<RadarDeskFlag, { label: string; tone: Tone }> = {
  EARNINGS_BEFORE_OPEN: { label: "Earnings before open", tone: "bad" },
  EARNINGS_IN_HOLD: { label: "Earnings in hold", tone: "bad" },
  MACRO_HIGH_IN_HOLD: { label: "High-impact macro in hold", tone: "warn" },
  EARNINGS_SOURCES_DISAGREE: { label: "Earnings sources disagree", tone: "warn" },
  RADAR_RISK_TAG: { label: "Radar risk tag", tone: "warn" },
  LEVELS_DISAGREE: { label: "Levels disagree", tone: "info" },
  RADAR_NOT_COVERED: { label: "Not on the Radar", tone: "neutral" },
};

const WHEN_WORDS: Record<NonNullable<Name["earnings"]["next"]>["when"], string> = {
  bmo: "before the open",
  during: "during the session",
  amc: "after the close",
};

export interface FocusDeskRow {
  symbol: string;
  flags: { code: RadarDeskFlag; label: string; tone: Tone }[];
  /** The next earnings date and when in the day, or null when none is on file. */
  earnings: { date: string; when: string } | null;
}

export type RadarDeskView =
  | { status: "none" }
  | { status: "unreadable" }
  | { status: "ok"; session: string; coverage: string; focusMissing: boolean; rows: FocusDeskRow[] };

/** The coverage line: how many desk names the file built rows for, or that the focus file is missing. */
export function coverageLine(doc: RadarDeskDoc): string {
  const built = `${doc.names.length} of ${doc.coverage.desk_names} built`;
  return doc.coverage.focus_names === null ? `${built} · focus file missing` : built;
}

/** The focus names' rows only (`focus: true`), in the file's order. Every other name is dropped here. */
export function focusRows(doc: RadarDeskDoc): FocusDeskRow[] {
  return doc.names
    .filter((n) => n.focus === true)
    .map((n) => ({
      symbol: n.symbol,
      flags: n.flags.map((code) => ({ code, ...FLAG_CHIP[code] })),
      earnings: n.earnings.next ? { date: n.earnings.next.date, when: WHEN_WORDS[n.earnings.next.when] } : null,
    }));
}

/** The panel's view of a validated document for `session`; a file for any other session is not today's. */
export function radarDeskView(doc: RadarDeskDoc | null, session: string, readable = true): RadarDeskView {
  if (!readable) return { status: "unreadable" };
  if (!doc || doc.session !== session) return { status: "none" };
  return { status: "ok", session: doc.session, coverage: coverageLine(doc), focusMissing: doc.coverage.focus_names === null, rows: focusRows(doc) };
}
