// The browser's own notification for the board's rings, with no React in it: the Notification API is passed in, so
// the rules can be tested with a fake one.
//
//  * What the switch shows is the owner's choice AND the browser's permission, read afresh, never a stored copy: a
//    permission taken away later reads "blocked", never "on".
//  * Where the browser has no page notifications (iPhone Safari outside a home-screen app, Android Chrome, which
//    throws on `new Notification`), it says "unsupported" rather than staying silent behind an "on" switch.
//  * A notice for the same name and side replaces the last one but alerts again (`renotify`); an exit stays until it
//    is dismissed. A click brings the page forward.
//  * Advisory and read only.

export type Permission = "granted" | "denied" | "default" | "unsupported";
/** What the switch says: on, off, blocked by the browser, permission to be asked again, or not available here. */
export type NotifyState = "on" | "off" | "blocked" | "ask" | "unsupported";

export function notifyState(chosen: boolean, permission: Permission, broken = false): NotifyState {
  if (permission === "unsupported" || broken) return "unsupported";
  if (permission === "denied") return "blocked";
  if (!chosen) return "off";
  return permission === "granted" ? "on" : "ask";
}

export interface NotificationCtor {
  readonly permission: string;
  requestPermission(): Promise<string>;
  new (title: string, options?: NotificationOptions & { renotify?: boolean }): { onclick: ((ev: Event) => unknown) | null; close(): void };
}

/** The permission as the browser holds it now; "unsupported" with no Notification API. */
export function readPermission(api: NotificationCtor | undefined): Permission {
  if (!api) return "unsupported";
  const p = api.permission;
  return p === "granted" || p === "denied" || p === "default" ? p : "unsupported";
}

export interface Notice {
  title: string;
  body: string;
  /** Same name and side: the new notice replaces the old one and alerts again (ringTag). */
  tag: string;
  /** An exit: stays on screen until dismissed. */
  sticky?: boolean;
  onClick?: () => void;
}

export type SendResult = "sent" | "blocked" | "unsupported";
export interface Shown {
  close(): void;
}

/** Show one notice. A constructor that throws a TypeError means the browser has no page notifications. */
export function sendNotice(api: NotificationCtor | undefined, n: Notice, shown?: (note: Shown) => void): SendResult {
  if (readPermission(api) === "unsupported" || !api) return "unsupported";
  if (api.permission !== "granted") return "blocked";
  try {
    const note = new api(n.title, { body: n.body, tag: n.tag, renotify: true, requireInteraction: n.sticky === true });
    note.onclick = () => {
      n.onClick?.();
      note.close();
    };
    shown?.(note);
    return "sent";
  } catch (e) {
    return e instanceof TypeError ? "unsupported" : "blocked";
  }
}

/**
 * The tag for a ring: one per name and side (an entry) or per trade (an exit), so a newer word replaces the older one
 * on the screen and alerts again, and an "enter" that is no longer live never sits beside its successor.
 */
export const ringTag = (kind: "entry" | "exit", key: string, side: string | null) => `trade-${kind}-${key}-${side ?? "any"}`;
