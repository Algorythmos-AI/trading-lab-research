"use client";

// Cockpit: the Options page as one full-screen board for a second monitor or an iPad. The status rail, the Now hero
// and the four focus names' ladders, large, and nothing else (no desk, no review, no rules). A switch in the rail turns
// it on; the switch again, Esc, or the C key turns it off (C also turns it on). The choice is kept in this browser.
// Inside the cockpit a separate Full screen button asks the browser for the whole screen; leaving full screen (the
// browser's own Esc) leaves the cockpit as it was.
//
// Implemented as a data attribute on the page's wrapper plus one CSS rule: everything the cockpit hides carries
// `data-cockpit-hide`. The large ladders are the page's own server-drawn LevelLadders, passed in as children of
// CockpitLadders and drawn only while the cockpit is on. While it is on and the board is live, the screen is kept awake
// (the Wake Lock API, where the browser allows it), and released when it goes off or the tab is hidden.
//
// Read only: it changes what is on the screen, nothing else.
import { Maximize, Minimize, MonitorUp, X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { AWAKE_WORDS, type AwakeState, cockpitShortcut } from "@/lib/cockpit-keys";
import { cn } from "@/lib/utils";
import { railButton } from "./rail-button";
import { screenKeeper, type WakeLockApi } from "@/lib/wake-lock";
import { setCockpit, useCockpit } from "./cockpit-state";
import { useBoard } from "./trade-now";

// ---- the choice, kept in this browser: cockpit-state.ts (apart, so the board can read it without importing this file)
export { setCockpit, useCockpit } from "./cockpit-state";

// ---- the screen kept awake ------------------------------------------------------------------------------------------
// Where the lock stands, for the switch's dot: one value for the page, told by the keeper.
let awake: AwakeState = "off";
const awakeListeners = new Set<() => void>();
function setAwake(s: AwakeState) {
  if (s === awake) return;
  awake = s;
  awakeListeners.forEach((f) => f());
}
function subscribeAwake(fn: () => void) {
  awakeListeners.add(fn);
  return () => {
    awakeListeners.delete(fn);
  };
}
/** Whether the screen is kept awake now; "off" in the server render. */
export function useAwake(): AwakeState {
  return useSyncExternalStore(subscribeAwake, () => awake, () => "off");
}

function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (!api) {
      setAwake("unsupported");
      return () => setAwake("off");
    }
    // The keeper holds at most one lock and releases one that arrives too late (lib/wake-lock.ts).
    const keeper = screenKeeper(api, () => document.visibilityState === "visible", setAwake);
    // The browser lets go of the lock when the tab is hidden; take it again when it comes back.
    const onVisible = () => (document.visibilityState === "visible" ? keeper.take() : keeper.drop());
    keeper.take();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      keeper.stop();
      setAwake("off");
    };
  }, [active]);
}

/** One of the rail's menus is open: it has the keyboard, so C is not the cockpit's. */
const MENUS = "#trade-now-alerts, #today-log, [data-done-confirm]";

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
  // Leaving the cockpit leaves full screen too: its button goes with the cockpit, so nothing would be left to undo it.
  useEffect(() => {
    if (on) return;
    if (document.fullscreenElement != null) void document.exitFullscreen?.().catch(() => undefined);
  }, [on]);
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
      // Full screen's own Esc belongs to the browser (Safari lets the page hear it too): it never leaves the cockpit.
      if (document.fullscreenElement != null) return;
      const t = ev.target instanceof HTMLElement ? ev.target : null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      setCockpit(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on]);
  // C turns the cockpit on or off, wherever the board is live (lib/cockpit-keys.ts says when it does not).
  const live = !!b?.on;
  useEffect(() => {
    if (!live) return;
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target instanceof HTMLElement ? ev.target : null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      const fire = cockpitShortcut({
        key: ev.key,
        ctrlKey: ev.ctrlKey,
        metaKey: ev.metaKey,
        altKey: ev.altKey,
        repeat: ev.repeat,
        isComposing: ev.isComposing,
        defaultPrevented: ev.defaultPrevented,
        typing,
        menuOpen: document.querySelector(MENUS) !== null,
      });
      if (!fire) return;
      ev.preventDefault();
      setCockpit(!on);
      // The focused control may be hidden (or drawn) by the switch: the keyboard lands on the switch, not the page.
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-cockpit-switch]")?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, on]);
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
  const a = useAwake();
  // On, the dot says whether the screen is kept awake: green held, amber not (refused, or no such thing here).
  const dot = on && a !== "off" ? (a === "held" ? "bg-good-fill" : a === "asking" ? "bg-neutral-fill" : "bg-warn-fill") : null;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-keyshortcuts="C"
      aria-describedby={dot ? "cockpit-awake" : undefined}
      data-cockpit-switch
      data-awake={on ? a : undefined}
      onClick={() => setCockpit(!on)}
      title={on ? `Leave the cockpit (Esc or C)${AWAKE_WORDS[a] ? `. ${AWAKE_WORDS[a]}` : ""}` : "Full-screen board for a second screen (C)"}
      // On, it reads green like a switch that works; off, the plain outline of the rail's other buttons.
      className={railButton(on ? "good" : "neutral", className)}
    >
      {on ? <X aria-hidden className="size-4" /> : <MonitorUp aria-hidden className="size-4" />}
      {/* An icon on a phone's rail; "Cockpit" is still the button's name. */}
      <span className="max-sm:sr-only">Cockpit</span>
      {dot ? (
        <span data-awake-dot className={cn("size-1.5 rounded-full max-sm:absolute max-sm:top-1.5 max-sm:right-1.5", dot)}>
          <span id="cockpit-awake" className="sr-only">
            {AWAKE_WORDS[a]}
          </span>
        </span>
      ) : null}
    </button>
  );
}

// ---- full screen, apart from the cockpit ----------------------------------------------------------------------------
function subscribeFullscreen(fn: () => void) {
  document.addEventListener("fullscreenchange", fn);
  return () => document.removeEventListener("fullscreenchange", fn);
}
/** Whether the page is full screen now, and whether this browser allows it at all; neither in the server render. */
function useFullscreen(): { on: boolean; can: boolean } {
  const on = useSyncExternalStore(subscribeFullscreen, () => document.fullscreenElement != null, () => false);
  const can = useSyncExternalStore(subscribeFullscreen, () => document.fullscreenEnabled === true, () => false);
  return { on, can };
}

/**
 * Inside the cockpit only: asks the browser for the whole screen, or gives it back. Apart from the cockpit on purpose:
 * the browser takes Esc to leave full screen before the page hears it, and a reload drops it, so full screen never
 * decides whether the cockpit is on. Not drawn where the browser has no full screen (an iPhone).
 */
export function FullscreenButton({ className }: { className?: string }) {
  const cockpit = useCockpit();
  const fs = useFullscreen();
  if (!cockpit || !fs.can) return null;
  const toggle = () => {
    const p = fs.on ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    void p?.catch(() => undefined); // refused: the screen stays as it is
  };
  return (
    <button type="button" aria-pressed={fs.on} data-fullscreen onClick={toggle} title={fs.on ? "Leave full screen (Esc)" : "Use the whole screen"} className={railButton(fs.on ? "info" : "neutral", className)}>
      {fs.on ? <Minimize aria-hidden className="size-4" /> : <Maximize aria-hidden className="size-4" />}
      <span className="max-sm:sr-only">Full screen</span>
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
