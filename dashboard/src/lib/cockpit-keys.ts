// The cockpit's keyboard shortcut, with no DOM in it, so every case can be tested: "C" turns the cockpit on or off.
//
// It never fires with a modifier held (so Cmd+C still copies), on a held-down key's repeats, while typing in a field
// or composing text, when another handler has already taken the key, or while one of the rail's menus is open (the
// menu has the keyboard then).

export interface KeyFacts {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  /** The focus is in an input, a text area, a select or editable text. */
  typing: boolean;
  /** One of the rail's menus (Alerts, Today, the Done confirm) is open. */
  menuOpen: boolean;
}

export function cockpitShortcut(k: KeyFacts): boolean {
  if (k.key !== "c" && k.key !== "C") return false;
  if (k.ctrlKey || k.metaKey || k.altKey || k.repeat || k.isComposing || k.defaultPrevented) return false;
  return !k.typing && !k.menuOpen;
}

/** Where the screen-awake lock stands, for the cockpit's dot. */
export type AwakeState = "off" | "asking" | "held" | "refused" | "unsupported";

/** The dot's words, also its accessible name. */
export const AWAKE_WORDS: Record<AwakeState, string> = {
  off: "",
  asking: "Asking to keep the screen awake",
  held: "Screen kept awake",
  refused: "This browser may let the screen sleep",
  unsupported: "This browser cannot keep the screen awake",
};
