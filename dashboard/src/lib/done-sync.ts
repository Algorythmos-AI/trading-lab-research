// The browser's copy of the owner's "done for today" flag (desk-flags.ts), kept in step with the server. No React and
// no DOM: the reads, the writes and the clock are passed in, so the rules below can be tested on fake timers.
//
//  * Answers land in order. Every read and write takes a number; a read's answer is dropped when a write started after
//    it, while a write is on its way, or when a newer answer has already been applied. A slow read can never undo
//    what the owner's tap just saved.
//  * A known "done today" is sticky: a read that fails keeps it, while its day is still New York's day, and only adds
//    "could not check". A failed read never turns done into not done; a not-done view that cannot be read again
//    becomes "could not check", never an all-clear.
//  * Nothing is claimed before the server answers. A write whose answer is lost or refused is checked with one more
//    read, and the page shows what that read says. An undo answered "not done" has landed.
import { nyDay, type FlagsView } from "./desk-flags";

export type DoneRead = { status: "ok"; view: FlagsView } | { status: "error" };
export type Answer = { ok: true; view: FlagsView } | { ok: false; reason: string | null };
export type DoneAction = "done" | "undo";

export interface DoneState {
  read: DoneRead;
  /** The last read failed and a known done view was kept: "could not check" beside it. */
  stale: boolean;
  /** A write is on its way. */
  busy: boolean;
  /** The last write's failure, in plain words, until the next try. */
  failed: string | null;
  /** Until when (this browser's clock, ms) the Undo button shows; null for none. */
  undoUntil: number | null;
  /** What the live region says: set once per change seen. */
  spoken: string;
}

export interface SyncDeps {
  get(): Promise<Answer>;
  post(action: DoneAction): Promise<Answer>;
  now(): number;
}

export const NOT_SAVED = "Did not save. Try again.";
export const NOT_DONE_VIEW: FlagsView = { done: false, day: null, at: null, canUndo: false, undoLeftS: 0 };

/** The line after a refused write, in plain words; nothing from the server is shown as it came. */
export function failedLine(reason: string | null): string {
  if (reason === "undo-closed") return "Undo time has passed. Today stays done.";
  return NOT_SAVED;
}

/** What the live region says once a change is seen; null when nothing changed that it should say. */
export function announceLine(before: DoneRead | null, after: DoneRead): string | null {
  if (after.status !== "ok") return null;
  const was = before?.status === "ok" ? before.view.done : null;
  if (was === null || was === after.view.done) return null;
  return after.view.done ? "Today is marked done." : "Today is open again.";
}

export class DoneSync {
  private seq = 0;
  private applied = 0;
  private lastWrite = 0;
  private writing = false;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedFor: number | null = null;
  state: DoneState;

  constructor(
    initial: FlagsView | null,
    private deps: SyncDeps,
  ) {
    this.state = {
      read: initial ? { status: "ok", view: initial } : { status: "error" },
      stale: false,
      busy: false,
      failed: null,
      undoUntil: initial?.canUndo ? deps.now() + initial.undoLeftS * 1000 : null,
      spoken: "",
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    this.armUndo();
    return () => {
      this.listeners.delete(fn);
    };
  };

  getState = (): DoneState => this.state;

  /** True only when the server said today is done. */
  get done(): boolean {
    return this.state.read.status === "ok" && this.state.read.view.done;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.armedFor = null;
  }

  clearFailed = (): void => {
    if (this.state.failed !== null) this.set({ failed: null });
  };

  private set(patch: Partial<DoneState>): void {
    this.state = { ...this.state, ...patch };
    this.armUndo();
    for (const f of this.listeners) f();
  }

  /** Hide Undo when its window closes, then read again so both devices agree. */
  private armUndo(): void {
    const until = this.state.undoUntil;
    if (until === this.armedFor) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.armedFor = until;
    if (until === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.armedFor = null;
        this.set({ undoUntil: null });
        void this.reread();
      },
      Math.max(0, until - this.deps.now()),
    );
  }

  private take(view: FlagsView): void {
    const line = announceLine(this.state.read, { status: "ok", view });
    this.set({
      read: { status: "ok", view },
      stale: false,
      undoUntil: view.canUndo ? this.deps.now() + view.undoLeftS * 1000 : null,
      ...(line ? { spoken: line } : {}),
    });
  }

  private failedRead(): void {
    const r = this.state.read;
    if (r.status === "ok" && r.view.done && r.view.day === nyDay(new Date(this.deps.now()))) {
      this.set({ stale: true });
      return;
    }
    this.set({ read: { status: "error" }, stale: false, undoUntil: null });
  }

  /** One read. Its answer is used only if nothing newer has been, and no write started since it began. */
  async reread(): Promise<void> {
    const id = ++this.seq;
    const a = await this.deps.get();
    if (this.writing || id < this.lastWrite || id < this.applied) return;
    this.applied = id;
    if (a.ok) this.take(a.view);
    else this.failedRead();
  }

  /** One write; true once the server's answer (or the read after it) says it holds. */
  async send(action: DoneAction): Promise<boolean> {
    if (this.writing) return false;
    this.writing = true;
    this.lastWrite = ++this.seq;
    this.set({ busy: true, failed: null });
    const a = await this.deps.post(action);
    let landed: FlagsView | null = a.ok ? a.view : null;
    let truth: FlagsView | null = null;
    if (!a.ok) {
      if (action === "undo" && a.reason === "not-done") landed = NOT_DONE_VIEW; // there is no mark: the undo landed
      else {
        const r = await this.deps.get();
        if (r.ok) {
          if (action === "done" ? r.view.done : !r.view.done) landed = r.view;
          else truth = r.view;
        }
      }
    }
    this.writing = false;
    // Every read that began before this point is older than this answer.
    this.applied = ++this.seq;
    if (landed) {
      this.take(landed);
      this.set({ busy: false });
      return true;
    }
    if (truth) this.take(truth);
    this.set({ busy: false, failed: failedLine(a.ok ? null : a.reason) });
    return false;
  }
}
