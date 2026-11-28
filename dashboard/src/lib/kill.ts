import { gapHunterBlock } from "./gap-hunter";
import type { Snapshot } from "./types";

/** Each desk's kill file the snapshot carries. The root file (`kill.on`) is the master switch: every desk reads it.
 *  Gap Hunter also reads its own (`gap_hunter.kill`), and the options clone its own `var/options/KILL`, which this
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
    { key: "root", label: "All desks (root KILL)", on: bool(s?.kill?.on) },
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
