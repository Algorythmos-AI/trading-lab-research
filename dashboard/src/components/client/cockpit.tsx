"use client";

// Cockpit: the Options page as one full-screen board for a second monitor or an iPad. The status rail, the Now hero
// and the four focus names' ladders, large, and nothing else (no desk, no review, no rules). A switch in the rail turns
// it on; the switch again, or Esc, turns it off. The choice is kept in this browser.
//
// Implemented as a data attribute on the page's wrapper plus one CSS rule: everything the cockpit hides carries
// `data-cockpit-hide`. The large ladders are the page's own server-drawn LevelLadders, passed in as children of
// CockpitLadders and drawn only while the cockpit is on. While it is on and the board is live, the screen is kept awake
// (the Wake Lock API, where the browser allows it), and released when it goes off or the tab is hidden.
//
// Read only: it changes what is on the screen, nothing else.
import { MonitorUp, X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { screenKeeper, type WakeLockApi } from "@/lib/wake-lock";
import { useBoard } from "./trade-now";

// ---- the choice, kept in this browser (the alert switches' pattern) -------------------------------------------------
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

// ---- the screen kept awake ------------------------------------------------------------------------------------------
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (!api) return;
    // The keeper holds at most one lock and releases one that arrives too late (lib/wake-lock.ts).
    const keeper = screenKeeper(api, () => document.visibilityState === "visible");
    // The browser lets go of the lock when the tab is hidden; take it again when it comes back.
    const onVisible = () => (document.visibilityState === "visible" ? keeper.take() : keeper.drop());
    keeper.take();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      keeper.stop();
    };
  }, [active]);
}

// What the cockpit hides, and the room it takes: the site's header and footer go too, and the page uses the screen's
// whole width. Unlayered, so it wins over the utilities on the wrappers it hides.
const RULES = `
[data-cockpit="on"] [data-cockpit-hide] { display: none; }
html[data-cockpit="on"] body > header, html[data-cockpit="on"] body > footer { display: none; }
html[data-cockpit="on"] main { max-width: none; }
`;

/**
 * The page's wrapper: carries `data-cockpit`, keeps the screen awake while the cockpit is on and the board live, and
 * leaves the cockpit on Esc (unless a menu or the log took that Escape first).
 */
export function CockpitShell({ children }: { children: React.ReactNode }) {
  const b = useBoard();
  // Only for the live edition, where the rail has its switch: an older edition never opens as a cockpit it cannot leave.
  const on = useCockpit() && !!b?.on;
  useWakeLock(on && !!b?.on && b.mode.kind === "live");
  useEffect(() => {
    const root = document.documentElement;
    if (on) root.dataset.cockpit = "on";
    else delete root.dataset.cockpit;
    return () => {
      delete root.dataset.cockpit;
    };
  }, [on]);
  useEffect(() => {
    if (!on) return;
    // On the window, so the menus' own Escape (on the document, which runs first) can claim it with preventDefault.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented) return;
      const t = ev.target instanceof HTMLElement ? ev.target : null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      setCockpit(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on]);
  return (
    <div data-cockpit={on ? "on" : "off"} className="contents">
      <style>{RULES}</style>
      {children}
    </div>
  );
}

/** The rail's switch: a button that says whether the cockpit is on. */
export function CockpitSwitch({ className }: { className?: string }) {
  const on = useCockpit();
  return (
    <button
      type="button"
      aria-pressed={on}
      data-cockpit-switch
      onClick={() => setCockpit(!on)}
      title={on ? "Leave the cockpit (Esc)" : "Full-screen board for a second screen"}
      className={cn(
        "hover:text-foreground aria-pressed:bg-foreground aria-pressed:text-background inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 text-sm font-medium whitespace-nowrap",
        !on && "text-muted-foreground",
        className,
      )}
    >
      {on ? <X aria-hidden className="size-4" /> : <MonitorUp aria-hidden className="size-4" />}
      Cockpit
    </button>
  );
}

/** The four large ladders, drawn only while the cockpit is on: side by side on a wide screen, two by two on a tablet. */
export function CockpitLadders({ children }: { children: React.ReactNode }) {
  const b = useBoard();
  const on = useCockpit() && !!b?.on;
  if (!on) return null;
  return (
    <section aria-label="Focus ladders" data-cockpit-ladders className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
      {children}
    </section>
  );
}
