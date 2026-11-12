"use client";

// Whether the Options page's cockpit is on (cockpit.tsx), kept in this browser. Apart from cockpit.tsx so the board
// (trade-now.tsx) can read it: cockpit.tsx imports the board, and the board importing it back would be a cycle.
import { useSyncExternalStore } from "react";

const KEY = "options-cockpit";
const EVENT = "options-cockpit";
let fallback = "";
function read(): string {
  try {
    return window.localStorage.getItem(KEY) ?? fallback;
  } catch {
    return fallback;
  }
}
/** Turn the cockpit on or off, here and in every other part of the page that reads it. */
export function setCockpit(on: boolean) {
  fallback = on ? "on" : "";
  try {
    if (on) window.localStorage.setItem(KEY, "on");
    else window.localStorage.removeItem(KEY);
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
/** Whether the cockpit is on; always off in the server render and on hydration, so the two never differ. */
export function useCockpit(): boolean {
  return useSyncExternalStore(subscribe, read, () => "") === "on";
}

