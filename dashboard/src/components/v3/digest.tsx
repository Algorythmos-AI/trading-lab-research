import { History } from "lucide-react";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { shortDate, txt } from "@/lib/format";
import { list, type Snapshot } from "@/lib/types";
import { hasV3 } from "@/lib/v3";
import { V3Pending } from "./pending";

/** What moved since the previous US trading day: the brief a morning reader wants first. */
export function DigestPanel({ s }: { s: Snapshot }) {
  const d = s.digest;
  const items = list(d?.items);
  const changed = items.filter((i) => i.changed === true);
  return (
    <Panel
      id="digest"
      title="Since the last trading day"
      icon={History}
      means="What changed compared with the first snapshot of the previous US trading day. Unchanged items are counted, not listed."
    >
      {!hasV3(s) ? (
        <V3Pending what="The daily digest" />
      ) : !d?.since ? (
        <Empty title="No earlier day to compare with yet">The first comparison appears after one full US trading day.</Empty>
      ) : changed.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing changed since {shortDate(d.since)} (ET).</p>
      ) : (
        <div className="grid gap-2">
          <ul className="grid gap-1.5">
            {changed.map((i) => (
              <li key={i.key} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span>{txt(i.label)}</span>
                <span className="font-medium tabular-nums">
                  <span className="text-muted-foreground">{txt(i.prev)}</span> → {txt(i.now)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            Compared with {shortDate(d.since)} (ET). {items.length - changed.length} other item
            {items.length - changed.length === 1 ? "" : "s"} unchanged.
          </p>
        </div>
      )}
    </Panel>
  );
}
