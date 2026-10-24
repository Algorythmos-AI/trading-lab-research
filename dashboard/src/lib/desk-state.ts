import desks from "@/lib/desks.json";

/**
 * What the lab says about a desk beside what the desk publishes. A desk that is parked or closed publishes
 * nothing, and "missing" is not the truth about it: the state is a decision, recorded in the desk's own
 * repository, and written here with the record that holds it. SAFE class only: a state word, a date, an id.
 */
export type DeskState = "running" | "parked" | "closed";

export type DeskNote = {
  state: DeskState;
  /** The day the state began, when it is not "running". */
  since?: string;
  /** The decision record that holds it (an id, never its text). */
  record?: string;
};

const NOTES = desks as Record<string, DeskNote>;

export function deskNote(desk: "crypto" | "hft"): DeskNote {
  return NOTES[desk] ?? { state: "running" };
}

/** "14 October 2026" for a note's date, in words a reader does not have to parse. */
export function sinceWords(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}
