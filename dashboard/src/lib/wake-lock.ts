// The cockpit's screen kept awake (the Wake Lock API), as a small keeper with no React and no globals, so its one
// tricky part can be tested: a request is a promise, and the tab can be hidden, shown again or the cockpit turned off
// while it is pending. At most one request is in flight and at most one lock is held; a lock that arrives when it is
// no longer wanted (one is already held, the tab was hidden meanwhile, or the keeper was stopped) is released at once,
// so none is ever left holding the screen on.

export type WakeSentinel = {
  release: () => Promise<void>;
  /** The browser's own release (the system took the lock back): the keeper hears it, where the browser says so. */
  addEventListener?: (type: "release", fn: () => void) => void;
};
/** What the keeper tells its owner: asking, holding, refused (by the browser), or let go. */
export type KeeperState = "asking" | "held" | "refused" | "off";
export type WakeLockApi = { request: (type: "screen") => Promise<WakeSentinel> };

export interface ScreenKeeper {
  /** Ask for the lock, if the tab is visible and none is held or pending. */
  take: () => void;
  /** Let the lock go (the tab was hidden); a pending one is released when it arrives. */
  drop: () => void;
  /** For good: the cockpit has turned off or the page is leaving. */
  stop: () => void;
  /** For a test: whether a lock is held. */
  held: () => boolean;
}

export function screenKeeper(api: WakeLockApi, visible: () => boolean, onChange?: (s: KeeperState) => void): ScreenKeeper {
  let lock: WakeSentinel | null = null;
  let pending = false;
  let gone = false;
  /** Asks again after a refusal or a lock the browser took back, once in a row, while the tab is shown. */
  let retried = false;
  const tell = (s: KeeperState) => {
    if (!gone) onChange?.(s);
  };
  const free = (l: WakeSentinel) => void l.release().catch(() => undefined);
  const take = () => {
    if (gone || pending || lock || !visible()) return;
    pending = true;
    tell("asking");
    api.request("screen").then(
      (l) => {
        pending = false;
        if (gone || lock || !visible()) {
          free(l);
          if (!lock) tell("off");
          return;
        }
        lock = l;
        retried = false;
        // The browser may take it back by itself (power saver, a policy). With the tab shown that is a lock lost, not
        // let go: it says so (amber) and asks once more; with the tab hidden it is the usual release.
        l.addEventListener?.("release", () => {
          if (lock !== l) return;
          lock = null;
          if (gone || !visible()) return tell("off");
          tell("refused");
          again();
        });
        tell("held");
      },
      () => {
        pending = false; // refused (battery saver, a policy): the screen sleeps as usual
        tell("refused");
        again();
      },
    );
  };
  const again = () => {
    if (retried || gone || !visible()) return;
    retried = true;
    take();
  };
  const drop = () => {
    const l = lock;
    lock = null;
    if (l) free(l);
    tell("off");
  };
  return {
    take,
    drop,
    stop: () => {
      gone = true;
      drop();
    },
    held: () => lock !== null,
  };
}
