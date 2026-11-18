"use client";

// The rail's alerts: one "Alerts" button whose colour says whether the chosen alerts will really reach the owner, and
// a small menu with the two switches (sound, the browser's notification), the volume, and a test for each.
//
//  * Sound (lib/alert-sound.ts): a browser plays audio only after a click or key on the page. With sound chosen, the
//    first click or key anywhere turns it on (useSoundUnlock), so a choice kept from an earlier visit works again;
//    until then the button is amber and says "tap", never green.
//  * Notification (lib/alert-notify.ts): the switch shows the choice and the browser's permission, read afresh each
//    time the tab is shown, so a permission taken away reads "Blocked", not on.
//  * The tests sound and notify only: they never touch the board's notices, its log or what it says aloud.
//
// Every browser read is after mount: the server render and hydration show everything off. Read only.
import { Bell, BellOff, BellRing, Volume1, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type Notice, type NotificationCtor, notifyState, type NotifyState, type Permission, readPermission, sendNotice, type Shown } from "@/lib/alert-notify";
import { type AlertTone, type AlertVolume, soundEngine, type SoundEngine, type SoundState, VOLUMES } from "@/lib/alert-sound";
import { cn } from "@/lib/utils";
import { type Alerts, useAlerts, writeAlerts } from "./alert-prefs";
import { useDone } from "./done-today";
import { railButton } from "./rail-button";

// ---- the one sound engine and the notification API, for this page --------------------------------------------------
let engine: SoundEngine | null = null;
function sound(): SoundEngine {
  engine ??= soundEngine(() => {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return Ctx ? new Ctx() : null;
  });
  return engine;
}
const notificationApi = (): NotificationCtor | undefined =>
  typeof window !== "undefined" && typeof window.Notification === "function" ? (window.Notification as unknown as NotificationCtor) : undefined;

/** The browser said it has no page notifications (a send threw a TypeError): kept for this page. */
let notifyBroken = false;
const PERMISSION_EVENT = "trade-now-permission";
const permissionChanged = () => window.dispatchEvent(new Event(PERMISSION_EVENT));

function subscribePermission(onChange: () => void) {
  const onVisible = () => {
    if (document.visibilityState === "visible") onChange();
  };
  window.addEventListener(PERMISSION_EVENT, onChange);
  document.addEventListener("visibilitychange", onVisible);
  // Where the browser tells us of a change made in its settings, hear it at once.
  let status: PermissionStatus | null = null;
  let gone = false;
  try {
    void navigator.permissions
      ?.query({ name: "notifications" as PermissionName })
      .then((s) => {
        if (gone) return;
        status = s;
        s.addEventListener("change", onChange);
      })
      .catch(() => undefined);
  } catch {
    // no permissions API: the tab being shown again is enough
  }
  return () => {
    gone = true;
    window.removeEventListener(PERMISSION_EVENT, onChange);
    document.removeEventListener("visibilitychange", onVisible);
    status?.removeEventListener("change", onChange);
  };
}
const permissionSnapshot = (): string => `${readPermission(notificationApi())}${notifyBroken ? ":broken" : ""}`;

/** The browser's notification permission, and whether it turned out to have none; "default" in the server render. */
function usePermission(): { permission: Permission; broken: boolean } {
  const raw = useSyncExternalStore(subscribePermission, permissionSnapshot, () => "default");
  const [p, b] = raw.split(":");
  return { permission: p as Permission, broken: b === "broken" };
}

const subscribeSound = (fn: () => void) => sound().subscribe(fn);
/** Whether a ring would sound now; "needs-tap" in the server render. */
function useSoundState(): SoundState {
  return useSyncExternalStore(subscribeSound, () => sound().state(), () => "needs-tap");
}

/**
 * With sound chosen: the first click or key anywhere on the page turns the audio on (a browser allows it only then),
 * and a tab shown again asks for it once more. Mounted once, by the board.
 */
export function useSoundUnlock(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const unlock = () => sound().unlock();
    const onVisible = () => {
      if (document.visibilityState === "visible") unlock();
    };
    // A touch screen counts a tap only once it ends (touchend, click), a mouse already on pointerdown: listen to all.
    const events = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;
    for (const t of events) document.addEventListener(t, unlock, true);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      for (const t of events) document.removeEventListener(t, unlock, true);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [on]);
}

/**
 * One ring of the board: one tone for the lot, and a notice for each. Called by the board for a new ring only (never
 * for a change of the switches); the tests below do not come through here.
 */
export function ringAlerts(alerts: Alerts, tone: AlertTone, notices: readonly Notice[]) {
  if (alerts.sound) sound().play(tone, alerts.volume);
  if (alerts.notify) {
    for (const n of notices) {
      const r = sendNotice(notificationApi(), n, (note) => {
        if (tone === "entry") openEntries.set(n.tag, note);
      });
      if (r === "unsupported" && !notifyBroken) {
        notifyBroken = true;
        permissionChanged();
      }
    }
  }
}

/** The entry notices this page has put on the screen, by tag, so one whose state has left can be taken down. */
const openEntries = new Map<string, Shown>();

/**
 * Take down every entry notice whose tag is not in `live`: the screen never keeps saying "enter" for a state that has
 * left the board (or once today is marked done). Exit notices are never taken down here: they stay until dismissed.
 */
export function closeEntryNotices(live: ReadonlySet<string>) {
  for (const [tag, note] of openEntries) {
    if (live.has(tag)) continue;
    try {
      note.close();
    } catch {
      // already gone
    }
    openEntries.delete(tag);
  }
}

/** A notice's click: bring this page forward and its name's card into view. */
export function focusPage(then?: () => void) {
  try {
    window.focus();
  } catch {
    // some browsers refuse; the notice still closes
  }
  then?.();
}

// ---- what the button and the menu say --------------------------------------------------------------------------------
type SoundView = "off" | SoundState;
export type AlertsTone = "good" | "warn" | "neutral";

/** The button's colour: amber when a chosen alert would not reach the owner now, green when every chosen one would. */
export function alertsTone(chosen: { sound: boolean; notify: boolean }, s: SoundView, n: NotifyState): AlertsTone {
  const soundBad = chosen.sound && s !== "ready";
  const notifyBad = chosen.notify && n !== "on";
  if (soundBad || notifyBad) return "warn";
  return chosen.sound || chosen.notify ? "good" : "neutral";
}

export const SOUND_LINE: Record<SoundView, string> = {
  off: "Off",
  ready: "Ready: rings on a new entry or exit",
  "needs-tap": "Tap or click anywhere on the page to turn sound on",
  unsupported: "No sound in this browser",
};
export const NOTIFY_LINE: Record<NotifyState, string> = {
  on: "On: shows even when this tab is in the background",
  off: "Off",
  blocked: "Blocked in this browser: allow notifications for this site in its settings",
  ask: "Needs your permission again: turn it on to ask",
  unsupported: "Not supported in this browser (on an iPhone, only from a home-screen app)",
};

/** The button's name: what each chosen alert will do now. */
export function alertsLabel(chosen: { sound: boolean; notify: boolean }, s: SoundView, n: NotifyState): string {
  const parts = [
    chosen.sound ? (s === "ready" ? "sound on" : s === "needs-tap" ? "sound needs a tap" : "no sound here") : "sound off",
    chosen.notify ? (n === "on" ? "notification on" : `notification ${n === "ask" ? "needs permission" : n}`) : n === "blocked" || n === "unsupported" ? `notification ${n}` : "notification off",
  ];
  return `Alerts: ${parts.join(", ")}`;
}

const STATUS_CLASS = (bad: boolean, good: boolean) => (bad ? "text-warn" : good ? "text-good" : "text-muted-foreground");

/**
 * The menu's Escape. While the menu is open it claims every Escape, wherever the focus is: it closes the menu (and
 * stops the cockpit from leaving on the same key). The focus goes back to the button only when it was in the menu.
 */
export function alertMenuKey(key: string, focusInside: boolean): { close: boolean; refocus: boolean } {
  return key === "Escape" ? { close: true, refocus: focusInside } : { close: false, refocus: false };
}

/** A pointer down while the menu is open: outside it closes the menu, and the focus goes back to the button unless the
 * click landed on another control (which takes the focus itself). */
export function alertMenuOutside(inside: boolean, onControl: boolean): { close: boolean; refocus: boolean } {
  return inside ? { close: false, refocus: false } : { close: true, refocus: !onControl };
}

const CONTROL = "a[href], button, input, select, textarea, summary, [tabindex]";
const SWITCH =
  "inline-flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 text-sm font-semibold whitespace-nowrap aria-pressed:border-good-fill/60 aria-pressed:bg-good-soft aria-pressed:text-good max-sm:min-h-11";
const SMALL =
  "hover:bg-muted inline-flex min-h-8 items-center justify-center rounded-md border px-2 text-xs font-medium whitespace-nowrap max-sm:min-h-11 max-sm:text-sm aria-pressed:bg-foreground aria-pressed:text-background";

const VOLUME_WORD: Record<AlertVolume, string> = { quiet: "Quiet", normal: "Normal", loud: "Loud" };

/** The menu's body: the two switches, the volume, the tests and what each will do now. */
export function AlertsPanel() {
  const alerts = useAlerts();
  const done = useDone();
  const s = useSoundState();
  const { permission, broken } = usePermission();
  const soundView: SoundView = alerts.sound ? s : "off";
  const n = notifyState(alerts.notify, permission, broken);

  const toggleSound = () => {
    if (!alerts.sound) sound().unlock(); // this click is the browser's go-ahead
    writeAlerts({ ...alerts, sound: !alerts.sound });
  };
  const ask = async (): Promise<boolean> => {
    const api = notificationApi();
    if (!api) return false;
    if (api.permission === "default") {
      try {
        await api.requestPermission();
      } catch {
        // refused or unavailable: the permission says which
      }
      permissionChanged();
    }
    return api.permission === "granted";
  };
  /** One notice now; false (and the browser marked as having none) when it cannot show one. */
  const probe = (title: string, body: string): boolean => {
    const r = sendNotice(notificationApi(), { title, body, tag: "trade-test", onClick: () => focusPage() });
    if (r === "unsupported") {
      notifyBroken = true;
      permissionChanged();
    }
    return r === "sent";
  };
  const toggleNotify = async () => {
    if (n === "on") return writeAlerts({ ...alerts, notify: false });
    if (n === "unsupported" || n === "blocked") return;
    if (!(await ask())) return;
    // Turned on only once a notice has really shown: a browser that refuses (Android Chrome) never reads "On".
    if (probe("Alerts on", "The Options board will notify you here.")) writeAlerts({ ...alerts, notify: true });
  };
  const [tested, setTested] = useState<string | null>(null);
  const testSound = async () => {
    const e = sound();
    await e.unlock();
    // Both tones, a moment apart: what an entry and an exit sound like at this volume.
    const r = e.play("entry", alerts.volume);
    setTested(r === "played" ? "Played: entry, then exit" : r === "needs-tap" ? "No sound yet: tap the page, then try again" : "No sound in this browser");
    if (r === "played") window.setTimeout(() => e.play("exit", alerts.volume), 900);
  };
  const testNotify = async () => {
    if (!(await ask())) return;
    probe("Test alert from the Options board", "Notifications work in this browser.");
  };

  return (
    <div className="grid gap-3">
      <section aria-label="Sound" className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <button type="button" aria-pressed={alerts.sound} aria-describedby="alert-status-sound" onClick={toggleSound} className={SWITCH}>
            {alerts.sound ? <Volume2 aria-hidden className="size-4" /> : <VolumeX aria-hidden className="size-4" />}
            Sound
          </button>
          <button type="button" onClick={() => void testSound()} disabled={s === "unsupported"} className={SMALL}>
            Test sound
          </button>
        </div>
        <p id="alert-status-sound" aria-live="polite" data-alert-status="sound" className={cn("text-xs font-medium", STATUS_CLASS(alerts.sound && s !== "ready", alerts.sound && s === "ready"))}>
          {SOUND_LINE[soundView]}
          {done && alerts.sound ? " (entries quiet: today is marked done)" : ""}
        </p>
        {tested ? (
          <p data-alert-tested className="text-muted-foreground text-xs">
            {tested}
          </p>
        ) : null}
        <div role="group" aria-label="Volume" className="flex items-center gap-1">
          <Volume1 aria-hidden className="text-muted-foreground mr-0.5 size-3.5" />
          {VOLUMES.map((v) => (
            <button key={v} type="button" aria-pressed={alerts.volume === v} onClick={() => writeAlerts({ ...alerts, volume: v })} className={cn(SMALL, "flex-1")}>
              {VOLUME_WORD[v]}
            </button>
          ))}
        </div>
      </section>
      <section aria-label="Browser notification" className="grid gap-1.5 border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            aria-pressed={n === "on"}
            aria-describedby="alert-status-notify"
            onClick={() => void toggleNotify()}
            disabled={n === "unsupported" || (n === "blocked" && !alerts.notify)}
            className={cn(SWITCH, "disabled:opacity-60")}
          >
            {n === "on" ? <Bell aria-hidden className="size-4" /> : <BellOff aria-hidden className="size-4" />}
            Browser notification
          </button>
          <button type="button" onClick={() => void testNotify()} disabled={n === "unsupported" || n === "blocked"} className={cn(SMALL, "disabled:opacity-50")}>
            Test notification
          </button>
        </div>
        <p id="alert-status-notify" aria-live="polite" data-alert-status="notify" className={cn("text-xs font-medium", STATUS_CLASS(alerts.notify ? n !== "on" : n === "blocked" || n === "unsupported", n === "on"))}>
          {NOTIFY_LINE[n]}
        </p>
      </section>
      <p className="text-muted-foreground border-t pt-2 text-xs">
        While an alert is on and the market is open, the board keeps checking prices every 10 s with this tab in the background. The browser can slow that to once a minute, and a tab it puts to sleep sends nothing: keep the tab open. Advisory: confirm on your chart.
      </p>
    </div>
  );
}

/**
 * The rail's Alerts button and its menu, on every screen: an icon on a phone, the icon and "Alerts" from sm up. Opening
 * it moves the focus to its first switch; Esc (wherever the focus is) or a click outside closes it.
 */
export function AlertsMenu({ className }: { className?: string }) {
  const alerts = useAlerts();
  const s = useSoundState();
  const { permission, broken } = usePermission();
  const n = notifyState(alerts.notify, permission, broken);
  const soundView: SoundView = alerts.sound ? s : "off";
  const tone = alertsTone(alerts, soundView, n);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented) return; // another open box took this Escape first
      const k = alertMenuKey(ev.key, !!box.current && box.current.contains(document.activeElement));
      if (!k.close) return;
      ev.preventDefault(); // this Escape closes the menu only, not the cockpit too
      setOpen(false);
      if (k.refocus) button.current?.focus();
    };
    const onDown = (ev: PointerEvent) => {
      const target = ev.target instanceof Element ? ev.target : null;
      const r = alertMenuOutside(!!box.current && !!target && box.current.contains(target), !!target?.closest(CONTROL));
      if (!r.close) return;
      setOpen(false);
      if (r.refocus) button.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  const Icon = tone === "warn" ? BellRing : alerts.sound || alerts.notify ? Bell : BellOff;
  return (
    <div ref={box} className={cn("relative max-sm:static", className)}>
      <button
        ref={button}
        type="button"
        aria-label={alertsLabel(alerts, soundView, n)}
        aria-expanded={open}
        aria-controls="trade-now-alerts"
        data-alerts-tone={tone}
        onClick={() => setOpen((o) => !o)}
        // The icon and the dots change the moment sound turns on, which can be in the middle of a tap: they take no
        // pointer events, so the tap always lands on the button itself and is never lost with a swapped icon.
        className={railButton(tone, "[&_*]:pointer-events-none aria-expanded:ring-ring/40 aria-expanded:ring-2 max-sm:size-11 max-sm:px-0")}
      >
        <Icon aria-hidden className={cn("size-4", tone === "warn" && "motion-safe:animate-pulse")} />
        <span aria-hidden className="max-sm:hidden">
          Alerts
        </span>
        {/* One dot per chosen alert, in its own state's colour: green works, amber needs you. */}
        {alerts.sound || alerts.notify ? (
          <span aria-hidden className="flex gap-0.5 max-sm:absolute max-sm:top-1.5 max-sm:right-1.5">
            {alerts.sound ? <span data-alert-dot="sound" className={cn("size-1.5 rounded-full", soundView === "ready" ? "bg-good-fill" : "bg-warn-fill")} /> : null}
            {alerts.notify ? <span data-alert-dot="notify" className={cn("size-1.5 rounded-full", n === "on" ? "bg-good-fill" : "bg-warn-fill")} /> : null}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={menu}
          id="trade-now-alerts"
          role="group"
          aria-label="Alerts"
          // On a phone the menu hangs from the whole rail (its wrapper is not positioned there, so the rail is), inside
          // the 16 px gutters. Not `fixed`: the rail's backdrop blur would make it fixed to the rail, not the screen.
          className="bg-popover text-popover-foreground absolute top-10 right-0 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-md border p-3 shadow-md max-sm:inset-x-4 max-sm:top-full max-sm:mt-1 max-sm:w-auto max-sm:max-w-none max-sm:shadow-lg"
        >
          <AlertsPanel />
        </div>
      ) : null}
    </div>
  );
}
