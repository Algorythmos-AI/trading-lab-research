"use client";

import { usePathname } from "next/navigation";
import { deskOfPath, type DeskName } from "@/lib/desk";

export interface FooterSnapshot {
  runId: string | null;
  schemaVersion: number | null;
  /** Left out for a desk whose contract has no redaction level: it publishes ids, states and numbers only. */
  redaction?: string | null;
  withheld: number | null;
}

/** Which snapshot the page was drawn from: the one of the desk the page belongs to. */
export function SnapshotFooter({ desks }: { desks: Record<DeskName, FooterSnapshot | null> }) {
  const s = desks[deskOfPath(usePathname())];
  if (!s) return null;
  return (
    <>
      {" "}
      Snapshot <span className="font-mono">{s.runId ?? "—"}</span>, schema v{s.schemaVersion ?? "—"}
      {s.redaction === undefined ? "" : `, ${s.redaction ?? "—"} redaction`}
      {typeof s.withheld === "number" && s.withheld > 0 ? `, ${s.withheld} fields withheld` : ""}.
    </>
  );
}
