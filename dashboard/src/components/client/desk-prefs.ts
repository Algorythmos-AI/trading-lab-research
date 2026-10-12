"use client";

import { useSyncExternalStore } from "react";

/** How tall the monitor's rows are from a tablet's width up. A phone keeps the tall rows: they are touch targets. */
export type Density = "comfortable" | "compact";

const KEY = "options.density";
const CHANGED = "options-density";

function read(): Density {
  try {
    return window.localStorage.getItem(KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable"; // storage switched off: the choice lasts for the page only, which is to say not at all
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The reader's row density, remembered in this browser, and a way to flip it. Comfortable on the server. */
export function useDensity(): [Density, () => void] {
  const density = useSyncExternalStore<Density>(subscribe, read, () => "comfortable");
  return [
    density,
    () => {
      try {
        window.localStorage.setItem(KEY, density === "compact" ? "comfortable" : "compact");
      } catch {
        return;
      }
      window.dispatchEvent(new Event(CHANGED));
    },
  ];
}
