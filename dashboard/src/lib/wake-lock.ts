// The cockpit's screen kept awake (the Wake Lock API), as a small keeper with no React and no globals, so its one
// tricky part can be tested: a request is a promise, and the tab can be hidden, shown again or the cockpit turned off
// while it is pending. At most one request is in flight and at most one lock is held; a lock that arrives when it is
// no longer wanted (one is already held, the tab was hidden meanwhile, or the keeper was stopped) is released at once,
// so none is ever left holding the screen on.

export type WakeSentinel = { release: () => Promise<void> };
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

export function screenKeeper(api: WakeLockApi, visible: () => boolean): ScreenKeeper {
  let lock: WakeSentinel | null = null;
  let pending = false;
  let gone = false;
  const free = (l: WakeSentinel) => void l.release().catch(() => undefined);
  const take = () => {
    if (gone || pending || lock || !visible()) return;
    pending = true;
    api.request("screen").then(
      (l) => {
        pending = false;
        if (gone || lock || !visible()) free(l);
        else lock = l;
      },
      () => {
        pending = false; // refused (battery saver, a policy): the screen sleeps as usual
      },
    );
  };
  const drop = () => {
    const l = lock;
    lock = null;
    if (l) free(l);
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
