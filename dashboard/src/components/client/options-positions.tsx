"use client";

import { TriangleAlert } from "lucide-react";
import { newYork, num, weekDate } from "@/lib/format";
import type { OptionsLive } from "@/lib/options-live.types";
import { pickFor, positionRows, positionsAge, positionsTotal, type PositionRow } from "@/lib/positions";
import { cn } from "@/lib/utils";
import { useLive } from "./live-layer";

/** Dollars for a whole position, signed: "+$125", "−$40". */
function dollars(v: number | null): string {
  if (v === null) return "—";
  const whole = Math.round(v);
  return `${whole < 0 ? "−" : whole > 0 ? "+" : ""}$${num(Math.abs(whole))}`;
}
const tone = (v: number | null) => (v === null || Math.round(v) === 0 ? "text-muted-foreground" : v > 0 ? "text-good" : "text-bad");

function Line({ r }: { r: PositionRow }) {
  return (
    <>
      <span className="min-w-0">
        <span className="font-mono font-semibold">{r.symbol}</span>{" "}
        <span className="font-mono">
          {num(r.strike, r.strike % 1 === 0 ? 0 : 2)} {r.kind}
        </span>
        <span className="text-muted-foreground block truncate text-[0.6875rem]">
          {weekDate(r.expiry)}
          {r.expired ? ", expired" : r.days === 0 ? ", today" : r.days === 1 ? ", 1 day" : r.days !== null ? `, ${r.days} days` : ""} ·{" "}
          {r.qty < 0 ? `short ${Math.abs(r.qty)}` : `${r.qty} ${r.qty === 1 ? "contract" : "contracts"}`}
        </span>
      </span>
      <span className="text-right font-mono">
        {num(r.price, 2)}
        <span className="text-muted-foreground block text-[0.6875rem]">paid {num(r.avgPrice, 2)}</span>
      </span>
      <span className={cn("min-w-14 text-right font-mono", tone(r.unrealized))}>{dollars(r.unrealized)}</span>
    </>
  );
}

const ROW = "grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 py-1.5 text-left text-[0.8125rem]";

/**
 * The open option positions of the paper account kept for manual option trades, as the trading host last published
 * them. A position on one of the desk's names opens that name with its contract loaded into the contract pane.
 *
 * Read only: the desk shows what is held and never places, changes or closes anything. A document older than a
 * day and a half says nothing about now and is not shown; in session, one that has not been renewed for half an
 * hour is shown with a warning. "In session" is the clock's word or the document's own: a host that stopped before
 * the bell left a document saying the market was shut, and the clock still catches it.
 */
export function OptionsPositions({
  doc,
  names,
  marketOpen,
  onOpen,
}: {
  doc: OptionsLive;
  names: readonly string[];
  /** Whether the session is open by the clock, right now. */
  marketOpen: boolean;
  onOpen: (row: PositionRow) => void;
}) {
  const { now } = useLive();
  // Until the browser's clock is read, the document's own time stands in: the server and the first draw agree.
  const asOf = Date.parse(doc.as_of);
  const clock = now ?? (Number.isFinite(asOf) ? asOf : 0);
  // The document's own "open" stands only until the close it names: the last one sent before the bell must not
  // read as a stopped host all evening.
  const close = Date.parse(doc.market?.next_close ?? "");
  const openByDoc = doc.market?.is_open === true && (!Number.isFinite(close) || clock < close);
  const age = positionsAge(doc.as_of, clock, marketOpen || openByDoc);
  if (age.state === "gone") return null;
  const rows = positionRows(doc, new Set(names), clock);
  const total = positionsTotal(rows);
  return (
    <section aria-label="Paper option positions" data-positions={rows.length === 0 ? "empty" : age.state} className="border-t px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-[0.8125rem] font-medium">Paper positions</h3>
        <span className="text-muted-foreground text-[0.6875rem]">
          {rows.length > 0 && total !== null ? (
            <>
              open result <span className={cn("font-mono", tone(total))}>{dollars(total)}</span> ·{" "}
            </>
          ) : null}
          as of {newYork(doc.as_of, false)} ET
        </span>
      </div>
      {age.state === "old" ? (
        <p role="status" className="text-warn mt-1 flex items-start gap-1.5 text-xs">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          These are {num(age.minutes, 0)} minutes old: the host has stopped sending them. Check the broker before relying on them.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-xs">No open option positions in the paper account.</p>
      ) : (
        <ul className="divide-border/60 mt-1 divide-y">
          {rows.map((r, i) => (
            <li key={`${r.contract}:${i}`}>
              {r.onDesk && pickFor(r) ? (
                <button type="button" onClick={() => onOpen(r)} title={`Open ${r.symbol} with this contract in the contract pane`} className={cn(ROW, "hover:bg-muted/60 rounded")}>
                  <Line r={r} />
                </button>
              ) : (
                <div className={ROW}>
                  <Line r={r} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground mt-1.5 text-[0.6875rem]">Paper account, read only. Marks and results are the broker&apos;s.</p>
    </section>
  );
}
