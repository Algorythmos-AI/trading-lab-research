"use client";

// The owner's alert choices (sound, the browser's notification, the volume), kept in this browser under the same key
// as before, so a saved choice carries over. Apart from the board (trade-now.tsx) so the live prices (live-layer.tsx)
// can read whether an alert is on without importing the board.
import { useSyncExternalStore } from "react";
import type { AlertVolume } from "@/lib/alert-sound";

const KEY = "trade-now-alerts";
const EVENT = "trade-now-alerts";

export type Alerts = { sound: boolean; notify: boolean; volume: AlertVolume };
export const NO_ALERTS: Alerts = { sound: false, notify: false, volume: "normal" };

let fallback = "";
function read(): string {
  try {
    return window.localStorage.getItem(KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The saved text, checked field by field: anything else in it reads as off. An older save has no volume: normal. */
export function parseAlerts(raw: string): Alerts {
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof Alerts, unknown>>;
    const volume = v.volume === "quiet" || v.volume === "loud" ? v.volume : "normal";
    return { sound: v.sound === true, notify: v.notify === true, volume };
  } catch {
    return NO_ALERTS;
  }
}

export function writeAlerts(a: Alerts) {
  fallback = JSON.stringify(a);
  try {
    window.localStorage.setItem(KEY, fallback);
  } catch {
    // kept in `fallback` for this page
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The choices; all off in the server render and on hydration, so the two never differ. */
export function useAlerts(): Alerts {
  return parseAlerts(useSyncExternalStore(subscribe, read, () => ""));
}

/** True while either alert is chosen: the live prices then keep reading, slowly, while the tab is hidden. */
export function useAlertsChosen(): boolean {
  const a = useAlerts();
  return a.sound || a.notify;
}
