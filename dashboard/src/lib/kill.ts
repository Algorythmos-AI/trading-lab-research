import { gapHunterBlock } from "./gap-hunter";
import type { Snapshot } from "./types";

/** Each desk's kill file the snapshot carries. No single file stops every desk: Gap Hunter reads only its own
 *  (`gap_hunter.kill`); the options clone reads the root file (`kill.on`) and its own `var/options/KILL`, which this
 *  snapshot does not carry (`make status` on the host shows it). */
export interface DeskKill {
  key: "s" | "root";
  label: string;
  /** true = on (no new entries), false = off, null = the host did not say. */
  on: boolean | null;
}

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

export function deskKills(s: Snapshot | null | undefined): DeskKill[] {
  return [
    { key: "s", label: "Gap Hunter", on: bool(gapHunterBlock(s ?? null)?.kill) },
    { key: "root", label: "Options clone (root KILL)", on: bool(s?.kill?.on) },
  ];
}

/** The panel's badge: on if any file is on, off only when every file is known to be off. */
export function killOverall(rows: DeskKill[]): boolean | null {
  if (rows.some((r) => r.on === true)) return true;
  return rows.every((r) => r.on === false) ? false : null;
}

/** The Risk page's summary line and whether its section opens by itself: any desk's file on, read across them all. */
export function anyKillOn(s: Snapshot | null | undefined): boolean | null {
  return killOverall(deskKills(s));
}
