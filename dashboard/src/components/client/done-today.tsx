"use client";

// "Done for today": the owner's own stop for the day, set on the laptop or the phone and shown on both. The server holds
// it (/api/desk/flags); this browser reads it with the page and once on mount, then, while the live board is on, again
// every 30 s and whenever the tab comes back. It never says it is set, or cleared, before the server has answered, and
// a read that failed says "Could not check", never that the day is open (lib/done-sync.ts has the rules). It hides
// entry prompts only: the manage cards, stops and exits keep working as before.
import { CircleAlert, CircleCheck, Undo2 } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { parseFlagsView, type FlagsView, UNDO_MS } from "@/lib/desk-flags";
import { type Answer, type DoneAction, type DoneRead, DoneSync } from "@/lib/done-sync";
import { newYork } from "@/lib/format";
import { DONE_TONE, DONE_WORDS, doneButtonState, undoLeft } from "@/lib/done-view";
import { railButton } from "./rail-button";
import { useNow } from "./use-now";
import { cn } from "@/lib/utils";

export { announceLine, failedLine, NOT_SAVED } from "@/lib/done-sync";
export type { DoneRead } from "@/lib/done-sync";

const URL_FLAGS = "/api/desk/flags";
/** How often both devices read the flag again while the live board is on. */
export const REREAD_MS = 30_000;

export const CONFIRM_LINE = "Stop for today? Entry prompts will be hidden on both devices.";
export const DONE_LINE = "You marked today done. Manage open trades only.";
export const COULD_NOT_CHECK = "Could not check";

export interface DoneToday {
  read: DoneRead;
  /** True only when the server said today is done. */
  done: boolean;
  /** The last read failed; a known done is kept beside "Could not check". */
  stale: boolean;
  /** A write is on its way: the controls wait. */
  busy: boolean;
  /** The last write's failure, shown until the next try. */
  failed: string | null;
  /** Undo shows (the server's window, counted down here). */
  canUndo: boolean;
  /** Until when Undo shows (this browser's clock, ms), for its countdown; null with none. */
  undoUntil?: number | null;
  mark: () => Promise<boolean>;
  undo: () => Promise<boolean>;
  clearFailed: () => void;
  /** The live board says whether to keep reading (every 30 s and on tab visible). */
  setPolling: (on: boolean) => void;
}

export const DoneTodayContext = createContext<DoneToday | null>(null);

/** The flag, or null outside a DoneTodayProvider. */
export function useDoneToday(): DoneToday | null {
  return useContext(DoneTodayContext);
}

/** True only when the server said today is done; false outside a provider. */
export function useDone(): boolean {
  return useContext(DoneTodayContext)?.done ?? false;
}

/** Keep reading the flag while `on` (the live board is drawn and its prices are not off). */
export function useDonePolling(on: boolean): void {
  const set = useContext(DoneTodayContext)?.setPolling;
  useEffect(() => {
    set?.(on);
    return () => set?.(false);
  }, [on, set]);
}

async function fetchFlags(init?: RequestInit): Promise<Answer> {
  try {
    const res = await fetch(URL_FLAGS, { cache: "no-store", credentials: "same-origin", ...init });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null;
      return { ok: false, reason };
    }
    const view = parseFlagsView(body);
    return view ? { ok: true, view } : { ok: false, reason: null };
  } catch {
    return { ok: false, reason: null };
  }
}

const post = (action: DoneAction) => fetchFlags({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });

export function DoneTodayProvider({ initial, children }: { initial: FlagsView | null; children: React.ReactNode }) {
  const [sync] = useState(() => new DoneSync(initial, { get: () => fetchFlags(), post, now: () => Date.now() }));
  const st = useSyncExternalStore(sync.subscribe, sync.getState, sync.getState);
  const [polling, setPolling] = useState(false);

  // One read on mount, wherever the page is.
  useEffect(() => {
    void sync.reread();
    return () => sync.dispose();
  }, [sync]);

  useEffect(() => {
    if (!polling) return;
    const id = window.setInterval(() => void sync.reread(), REREAD_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void sync.reread();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [polling, sync]);

  const done = st.read.status === "ok" && st.read.view.done;
  const value: DoneToday = {
    read: st.read,
    done,
    stale: st.stale,
    busy: st.busy,
    failed: st.failed,
    canUndo: done && st.undoUntil !== null,
    undoUntil: done ? st.undoUntil : null,
    mark: () => sync.send("done"),
    undo: () => sync.send("undo"),
    clearFailed: sync.clearFailed,
    setPolling,
  };
  return (
    <DoneTodayContext.Provider value={value}>
      {children}
      <p aria-live="polite" role="status" className="sr-only" data-done-spoken>
        {st.spoken}
      </p>
    </DoneTodayContext.Provider>
  );
}

/** "Done for today · set 10:42 NY", in the rail's day pill area; null unless the server said today is done. */
export function DonePill({ className }: { className?: string }) {
  const d = useDoneToday();
  if (!d?.done || d.read.status !== "ok") return null;
  const at = d.read.view.at;
  return (
    // Focusable from script only: where the focus goes when the Undo button it stood on goes away.
    <p tabIndex={-1} data-rail-done data-tone="info" className={cn("text-explain bg-info-soft border-info-fill/60 text-info inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-medium sm:whitespace-nowrap", className)}>
      <CircleCheck aria-hidden className="size-4 shrink-0" />
      <span className="font-semibold">Done for today</span>
      <span className="font-mono tabular-nums">· set {at ? newYork(at, false) : "–"} NY</span>
      {d.stale ? (
        <span data-rail-done-stale className="text-warn">
          · {COULD_NOT_CHECK}
        </span>
      ) : null}
    </p>
  );
}

/**
 * On a phone, where the rail's button is an icon: "Could not check" beside the day pill when the flag could not be read.
 * From sm up the button itself says it. Says nothing about the day being open.
 */
export function UncheckedNote() {
  const d = useDoneToday();
  if (!d || d.read.status === "ok") return null;
  return (
    <p data-rail-unchecked aria-hidden className="text-explain text-warn inline-flex items-center gap-1 font-medium sm:hidden">
      <CircleAlert className="size-4 shrink-0" />
      {COULD_NOT_CHECK}
    </p>
  );
}

/** The Undo window's ring: a circle that empties as the window runs out. */
function UndoRing({ share }: { share: number }) {
  const c = 2 * Math.PI * 6;
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4 -rotate-90">
      <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="stroke-border" />
      <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-info-fill" strokeDasharray={c} strokeDashoffset={c * (1 - share)} />
    </svg>
  );
}

/**
 * The rail's control: "Done for today" (one tap asks, inline), then "Undo" for 60 s once the server has saved it. A
 * failed read shows "Could not check" on the button; a failed write says it did not save. `id` keeps two copies (the
 * phone's and the wider screens') apart.
 */
export function DoneControl({ id = "done-today-confirm", className, limitReached = false }: { id?: string; className?: string; limitReached?: boolean }) {
  const d = useDoneToday();
  // The countdown's clock: null in the server render and on hydration, so the two never differ.
  const now = useNow(250);
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const undoFocused = useRef(false);
  const dismiss = d?.clearFailed;
  const canUndo = !!d?.canUndo;

  useEffect(() => {
    if (asking) confirm.current?.focus();
  }, [asking]);

  // The Undo window closed with the focus on Undo: give it to the done pill rather than drop it on the page.
  useEffect(() => {
    if (canUndo || !undoFocused.current) return;
    undoFocused.current = false;
    const pill = box.current?.closest("[data-status-rail]")?.querySelector<HTMLElement>("[data-rail-done]");
    (pill ?? trigger.current)?.focus();
  }, [canUndo]);

  const open = asking || !!d?.failed;
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault(); // closes this only, not the cockpit too
      setAsking(false);
      dismiss?.();
      trigger.current?.focus();
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.target instanceof Node && box.current?.contains(ev.target)) return;
      setAsking(false);
      dismiss?.();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, dismiss]);

  if (!d) return null;
  const unchecked = d.read.status !== "ok";
  const state = doneButtonState({ unchecked, failed: !!d.failed, limitReached });
  // The clock in quarter seconds (null before mount), and the count capped at the window: never "61 s", and at most a
  // quarter second off the server's own timer.
  const left = d.canUndo ? undoLeft(d.undoUntil ?? null, now, UNDO_MS) : null;

  const onUndo = async () => {
    if (await d.undo()) requestAnimationFrame(() => trigger.current?.focus());
  };
  const onConfirm = async () => {
    const ok = await d.mark();
    if (ok) {
      setAsking(false);
      // The Undo button takes this place once the answer is in; focus goes to it, or back to the rail's trigger.
      requestAnimationFrame(() => (undoButton.current ?? trigger.current)?.focus());
    }
  };
  const onCancel = () => {
    setAsking(false);
    trigger.current?.focus();
  };

  return (
    <div ref={box} className={cn("relative", className)} data-done-control={d.done ? "done" : unchecked ? "unchecked" : "open"} data-done-state={d.done ? "done" : state}>
      {d.done ? (
        d.canUndo ? (
          <button
            ref={undoButton}
            type="button"
            data-done-undo
            disabled={d.busy}
            onFocus={() => (undoFocused.current = true)}
            // A blur with nowhere to go is the button leaving the page, not the owner moving on: keep the note.
            onBlur={(ev) => {
              if (ev.relatedTarget !== null) undoFocused.current = false;
            }}
            onClick={() => void onUndo()}
            className={railButton("info")}
          >
            {left ? <UndoRing share={left.share} /> : <Undo2 aria-hidden className="size-4" />}
            <span aria-hidden className="sm:hidden">
              Undo
            </span>
            <span className="max-sm:sr-only">Undo</span>
            <span className="sr-only"> done for today</span>
            {/* How long Undo stays, counted down; read out only once, by the button's name, not every second. */}
            {left ? (
              <span aria-hidden data-undo-left className="font-mono text-xs tabular-nums max-sm:hidden">
                {left.s} s
              </span>
            ) : null}
          </button>
        ) : null
      ) : (
        <button
          ref={trigger}
          type="button"
          data-done-button
          aria-expanded={asking}
          aria-controls={id}
          disabled={d.busy}
          onClick={() => {
            d.clearFailed();
            setAsking((a) => !a);
          }}
          data-done-tone={DONE_TONE[state]}
          className={railButton(
            DONE_TONE[state],
            "aria-expanded:ring-ring/40 aria-expanded:ring-2",
            // the limit just reached: two slow pulses draw the eye, then it rests (never with reduced motion)
            state === "limit" && "motion-safe:animate-[pulse_1.2s_ease-in-out_2]",
          )}
        >
          {state === "unchecked" || state === "failed" ? <CircleAlert aria-hidden className="size-4" /> : <CircleCheck aria-hidden className="size-4" />}
          {/* On a phone the icon; the words are still the button's name. */}
          {unchecked ? (
            <span className="max-sm:sr-only" data-done-unchecked>
              {COULD_NOT_CHECK} ·{" "}
            </span>
          ) : null}
          <span aria-hidden className="sm:hidden">
            Done
          </span>
          <span className="max-sm:sr-only">{state === "limit" ? DONE_WORDS.limit : state === "failed" ? DONE_WORDS.failed : "Done for today"}</span>
        </button>
      )}
      {asking && !d.done ? (
        <div
          id={id}
          role="group"
          aria-label="Stop for today"
          data-done-confirm
          className="bg-popover text-popover-foreground absolute top-10 right-0 z-40 grid w-72 max-w-[calc(100vw-2rem)] gap-2 rounded-md border p-2.5 shadow-md max-sm:top-12"
        >
          {unchecked ? <p className="text-explain text-warn font-medium">{COULD_NOT_CHECK} whether today is marked done.</p> : null}
          <p className="text-explain font-medium">{CONFIRM_LINE}</p>
          <p data-done-keeps className="text-explain text-muted-foreground">
            Your open trades&apos; stops, exits and the manage cards keep working.
          </p>
          {d.failed ? (
            <p role="alert" data-done-failed className="text-explain text-bad font-medium">
              {d.failed}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button ref={confirm} type="button" data-done-confirm-yes disabled={d.busy} onClick={() => void onConfirm()} className="bg-foreground text-background inline-flex min-h-11 flex-1 items-center justify-center rounded-md px-3 text-sm font-semibold disabled:opacity-60 sm:min-h-9">
              {d.busy ? "Saving…" : "Confirm"}
            </button>
            <button type="button" data-done-confirm-no disabled={d.busy} onClick={onCancel} className="hover:bg-muted inline-flex min-h-11 flex-1 items-center justify-center rounded-md border px-3 text-sm font-medium sm:min-h-9">
              Cancel
            </button>
          </div>
        </div>
      ) : d.failed ? (
        <p role="alert" data-done-failed className="bg-popover text-bad text-explain absolute top-10 right-0 z-40 w-60 max-w-[calc(100vw-2rem)] rounded-md border p-2 font-medium shadow-md max-sm:top-12">
          {d.failed}
        </p>
      ) : null}
    </div>
  );
}
