// Desks (ADR 0005): the stocks desk and the crypto desk share this site and nothing else. Pure constants, safe
// to import from server and browser code.

export type DeskName = "stocks" | "crypto";

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
};

export const DESK_LABEL: Record<DeskName, string> = { stocks: "Stocks", crypto: "Crypto" };

/** The desk a page belongs to, from its path. Pages outside /crypto are the stocks desk's or global. */
export function deskOfPath(pathname: string): DeskName {
  return pathname === "/crypto" || pathname.startsWith("/crypto/") ? "crypto" : "stocks";
}

/** The pre-market radar's editions: the newest one, and one copy per edition date (a same-day refresh replaces it). */
export const RADAR_PATHS = {
  latest: "radar/latest.json",
  history: "radar/editions/",
} as const;
