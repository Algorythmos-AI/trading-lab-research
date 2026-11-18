// How the rail's "Done for today" control looks in each state, with no React in it, so every state can be tested:
// the colour says where the day stands at a glance.
//
//  * open: an outline, as the other rail buttons;
//  * the day is over (the day pill is red: trades used up, the loss limit with what is open, or a rule broken): amber,
//    and it asks "Day over: mark done?" - a suggestion only, it never sets anything by itself;
//  * the flag could not be read: amber, "Could not check";
//  * the last save failed: red;
//  * done: the pill takes the day pill's place, solid blue.
// The Undo window is the server's (lib/done-sync.ts); here it is only counted down for the eye.
import type { Tone } from "./labels";

export type DoneButtonState = "open" | "limit" | "unchecked" | "failed";

export function doneButtonState(o: { unchecked: boolean; failed: boolean; limitReached: boolean }): DoneButtonState {
  if (o.failed) return "failed";
  if (o.unchecked) return "unchecked";
  return o.limitReached ? "limit" : "open";
}

/** The button's tone per state: neutral is the plain outline. */
export const DONE_TONE: Record<DoneButtonState, Tone> = { open: "neutral", limit: "warn", unchecked: "warn", failed: "bad" };

/** The words on the button from sm up; the phone shows "Done" with the icon. */
export const DONE_WORDS: Record<DoneButtonState, string> = {
  open: "Done for today",
  limit: "Day over: mark done?",
  unchecked: "Could not check · Done for today",
  failed: "Not saved · Done for today",
};

/** Whole seconds of the Undo window left and the share of it left (0 to 1), at `now`; null with no window. */
export function undoLeft(undoUntil: number | null, now: number | null, windowMs: number): { s: number; share: number } | null {
  if (undoUntil === null || now === null) return null;
  const ms = Math.min(windowMs, Math.max(0, undoUntil - now));
  return { s: Math.ceil(ms / 1000), share: ms / windowMs };
}
