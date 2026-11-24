// Desks (ADR 0005, ADR 0006): the stocks desk, the crypto desk and the HFT desk share this site and nothing else.
// Pure constants, safe to import from server and browser code. A new desk is one more entry in each record here.

export type DeskName = "stocks" | "crypto" | "hft";

export interface DeskPaths {
  latest: string;
  /** A non-primary host's latest snapshot. Never read by the pages or the watchdog. */
  shadow: string;
  history: string;
  alertState: string;
}

/** Where each desk's snapshots and watchdog state live. The stocks desk keeps the original paths. */
export const DESK_PATHS: Record<DeskName, DeskPaths> = {
  stocks: {
    latest: "snapshots/latest.json",
    shadow: "shadow/latest.json",
    history: "snapshots/history/",
    alertState: "alerts/state.json",
  },
  crypto: {
    latest: "snapshots/crypto/latest.json",
    shadow: "shadow/crypto/latest.json",
    history: "snapshots/crypto/history/",
    alertState: "alerts/crypto-state.json",
  },
  hft: {
    latest: "snapshots/hft/latest.json",
    shadow: "shadow/hft/latest.json",
    history: "snapshots/hft/history/",
    alertState: "alerts/hft-state.json",
  },
};

export const DESK_LABEL: Record<DeskName, string> = { stocks: "Stocks", crypto: "Crypto", hft: "HFT" };

/** Each desk's first page. The stocks desk keeps the site root; every other desk lives under its own prefix. */
export const DESK_HOME: Record<DeskName, string> = { stocks: "/", crypto: "/crypto", hft: "/hft" };

/** The desks in the order the header shows them. */
export const DESKS = Object.keys(DESK_HOME) as DeskName[];

/** The desk a page belongs to, from its path. Pages outside every other desk's prefix are the stocks desk's or global. */
export function deskOfPath(pathname: string): DeskName {
  for (const desk of DESKS) {
    const home = DESK_HOME[desk];
    if (home !== "/" && (pathname === home || pathname.startsWith(`${home}/`))) return desk;
  }
  return "stocks";
}

/** The pre-market radar's editions: the newest one, and one copy per edition date (a same-day refresh replaces it). */
export const RADAR_PATHS = {
  latest: "radar/latest.json",
  history: "radar/editions/",
  /**
   * Every radar edition that became latest, once, keyed by its edition_date, with the store's receipt time
   * (./edition-copy). Never replaced or deleted: DEC-0055 reads the first edition received before the open from here.
   */
  copies: "radar/copies/",
} as const;

/**
 * The options live document: open paper option positions and open interest. Latest only: it is a view of now, and
 * yesterday's positions are nobody's business to keep.
 */
export const OPTIONS_LIVE_PATHS = {
  latest: "options-live/latest.json",
} as const;

/**
 * The economic calendar (stocksdelta/calendar): the release dates the Calendar page shows. Latest only: each
 * document carries the whole range.
 */
export const CALENDAR_PATHS = {
  latest: "calendar/latest.json",
} as const;

/**
 * The owner's trade journal: every closed trade of their own brokerage account, re-sent whole after each session.
 * Latest only: each document carries the full history, so a dated copy would only repeat it.
 */
export const JOURNAL_PATHS = {
  latest: "journal/latest.json",
} as const;

/**
 * The options clone's document (DEC-0030): its session so far, re-sent after every trade event and at the close.
 * Latest only: each document carries the figures of every trade so far.
 */
export const OPTIONS_CLONE_PATHS = {
  latest: "options-clone/latest.json",
} as const;

/**
 * The paper options history (DEC-0057): every closed paper option trade, for the Paper options page. Latest only:
 * each document is rebuilt from the host's own records and carries the whole history.
 */
export const PAPER_OPTIONS_PATHS = {
  latest: "paper-options/latest.json",
} as const;

/**
 * Gap Hunter's live state (DEC-0078): the stocks snapshot's `gap_hunter` block on its own, sent every minute in
 * session by the trading host. Latest only: each document is the whole block.
 */
export const GAP_HUNTER_LIVE_PATHS = {
  latest: "gap-hunter-live/latest.json",
} as const;

/**
 * The focus card ledger's editions (stocksdelta/ledger): how the Top 4 Focus Card did, one per session it scored,
 * kept the same way as the radar's. Each carries the running record too, so the latest alone draws Card record.
 */
export const LEDGER_PATHS = {
  latest: "ledger/latest.json",
  history: "ledger/editions/",
} as const;

/**
 * The selection funnel's health documents (stocksdelta/funnel, from trading-options-funnel): one per session, kept
 * the same way as the ledger's.
 */
export const FUNNEL_PATHS = {
  latest: "funnel/latest.json",
  history: "funnel/editions/",
} as const;

/**
 * The Radar desk files (stocksdelta/radar-desk, from trading-options-funnel): one per session, kept the same way as
 * the funnel's. The Options page reads the session's dated copy, never the latest, so an old file is never today's.
 */
export const RADAR_DESK_PATHS = {
  latest: "radar-desk/latest.json",
  history: "radar-desk/editions/",
} as const;

/**
 * The Radar run beacons (stocksdelta/radar-run, from the pre-market Radar routine): the newest beacon of each stage
 * of each session at `<stages><session>/<stage>.json`, so a reader gets every stage of a session with one read per
 * stage. `latest` holds the newest beacon of any stage, for /api/health alone.
 */
export const RADAR_RUN_PATHS = {
  latest: "radar-run/latest.json",
  stages: "radar-run/",
} as const;

/** Where the newest beacon of one stage of one session is kept. Both parts come from a validated beacon. */
export function radarRunPath(session: string, stage: string): string {
  return `${RADAR_RUN_PATHS.stages}${session}/${stage}.json`;
}

/**
 * The after-close options levels editions, one per session they are built for, kept the same way as the radar's.
 * `copies` also keeps every edition that became latest, each once, with the store's receipt time
 * (./edition-copy, EXP-0033 `labeller_rules.edition`): `history` holds one file per session that a refresh replaces.
 */
export const OPTIONS_PATHS = {
  latest: "options/latest.json",
  history: "options/editions/",
  copies: "options/copies/",
} as const;
