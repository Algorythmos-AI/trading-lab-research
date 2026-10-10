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
} as const;

/**
 * The options live document: open paper option positions and open interest. Latest only: it is a view of now, and
 * yesterday's positions are nobody's business to keep.
 */
export const OPTIONS_LIVE_PATHS = {
  latest: "options-live/latest.json",
} as const;

/** The after-close options levels editions, one per session they are built for, kept the same way as the radar's. */
export const OPTIONS_PATHS = {
  latest: "options/latest.json",
  history: "options/editions/",
} as const;
