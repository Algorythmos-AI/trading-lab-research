"use client";

import { usePathname } from "next/navigation";
import { deskOfPath } from "@/lib/desk";

export interface FooterSnapshot {
  runId: string | null;
  schemaVersion: number | null;
  redaction: string | null;
  withheld: number | null;
}

/** Which snapshot the page was drawn from: the one of the desk the page belongs to. */
export function SnapshotFooter({ stocks, crypto }: { stocks: FooterSnapshot | null; crypto: FooterSnapshot | null }) {
  const s = deskOfPath(usePathname()) === "crypto" ? crypto : stocks;
  if (!s) return null;
  return (
    <>
      {" "}
      Snapshot <span className="font-mono">{s.runId ?? "—"}</span>, schema v{s.schemaVersion ?? "—"}, {s.redaction ?? "—"}{" "}
      redaction
      {typeof s.withheld === "number" && s.withheld > 0 ? `, ${s.withheld} fields withheld` : ""}.
    </>
  );
}
