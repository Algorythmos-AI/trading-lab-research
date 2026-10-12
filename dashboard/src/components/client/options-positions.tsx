"use client";

import { useEffect, useState } from "react";
import type { ChainResponse } from "@/lib/chain";
import { newYork, num, weekDate } from "@/lib/format";
import type { OptionsLive } from "@/lib/options-live.types";
import { liveRead, type OptionsTicker } from "@/lib/options";
import { GREEKS_MAX, pickFor, positionGreeks, positionRows, positionsAge, positionsTotal, type PositionGreeks, type PositionRow } from "@/lib/positions";
import { cn } from "@/lib/utils";
import { useLive } from "./live-layer";
import { Notice } from "@/components/ui/notice";
import { Pane } from "@/components/ui/pane";

/** Dollars for a whole position, signed: "+$125", "−$40". */
function dollars(v: number | null): string {
  if (v === null) return "—";
  const whole = Math.round(v);
  return `${whole < 0 ? "−" : whole > 0 ? "+" : ""}$${num(Math.abs(whole))}`;
}
const tone = (v: number | null) => (v === null || Math.round(v) === 0 ? "text-muted-foreground" : v > 0 ? "text-good" : "text-bad");

function Line({ r, g }: { r: PositionRow; g: PositionGreeks | null }) {
  return (
    <>
      <span className="min-w-0">
        <span className="font-mono font-semibold">{r.symbol}</span>{" "}
        <span className="font-mono">
          {num(r.strike, r.strike % 1 === 0 ? 0 : 2)} {r.kind}
        </span>
        <span className="text-muted-foreground block text-[0.6875rem]">
          {weekDate(r.expiry)}
          {r.expired ? ", expired" : r.days === 0 ? ", today" : r.days === 1 ? ", 1 day" : r.days !== null ? `, ${r.days} days` : ""} ·{" "}
          {r.qty < 0 ? `short ${Math.abs(r.qty)}` : `${r.qty} ${r.qty === 1 ? "contract" : "contracts"}`}
          {g ? (
            <span data-greeks className="font-mono">
              {g.delta !== null ? ` · Δ ${Math.abs(g.delta) < 0.005 ? "0.00" : `${g.delta < 0 ? "−" : ""}${num(Math.abs(g.delta), 2)}`}` : ""}
              {g.decay !== null && Math.abs(g.decay) >= 0.5 ? ` · ${g.decay < 0 ? "−" : "+"}$${num(Math.abs(g.decay), 0)}${g.toExpiry ? " to expiry" : "/day"}` : ""}
            </span>
          ) : null}
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
  tickers,
  marketOpen,
  onOpen,
}: {
  doc: OptionsLive;
  /** The desk's names: a position on one of them can be opened, and is priced from the option feed. */
  tickers: readonly OptionsTicker[];
  /** Whether the session is open by the clock, right now. */
  marketOpen: boolean;
  onOpen: (row: PositionRow) => void;
}) {
  const { now, feed, session } = useLive();
  const names = tickers.map((t) => t.symbol);
  // One request a position for its contract's quote, asked again when the host sends a new document. Only long
  // positions on the desk's names that have not expired, and only a handful: the rest show without greeks.
  const [chains, setChains] = useState<Record<string, ChainResponse>>({});
  const wanted = (doc.positions ?? [])
    .map((p) => p.contract)
    .sort()
    .join(",");
  useEffect(() => {
    let stopped = false;
    const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));
    const todo = positionRows(doc, new Set(bySymbol.keys()), Date.now())
      .filter((r) => r.onDesk && pickFor(r) !== null)
      .slice(0, GREEKS_MAX);
    void (async () => {
      for (const r of todo) {
        const close = bySymbol.get(r.symbol)?.last?.close;
        if (stopped || typeof close !== "number" || !(close > 0)) continue;
        try {
          const res = await fetch(`/api/chain?s=${encodeURIComponent(r.symbol)}&px=${close.toFixed(2)}&x=${r.expiry}&k=${r.strike}`, { cache: "no-store" });
          if (res.status === 503) return; // no option feed on this site: the rows stand without greeks
          if (!res.ok || stopped) continue;
          const chain = (await res.json()) as ChainResponse;
          if (!stopped) setChains((c) => ({ ...c, [r.contract]: chain }));
        } catch {
          // one position without greeks is not worth a message
        }
      }
    })();
    return () => {
      stopped = true;
    };
    // The document's time is what says "ask again"; the tickers are the same names from one render to the next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, doc.as_of]);
  const greeksOf = (r: PositionRow): PositionGreeks | null => {
    const t = tickers.find((x) => x.symbol === r.symbol);
    const chain = chains[r.contract];
    if (!t || !chain || now === null) return null;
    const read = liveRead(t, feed.status === "ok" ? feed.quotes[t.symbol] : undefined, session, now, feed.status === "ok" ? feed.receivedAt : null);
    return read.price !== null ? positionGreeks(r, chain, t, read.price, now, session, { marketOpen, priceIsLive: read.inSession }) : null;
  };
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
    <Pane
      label="Paper option positions"
      title="Paper positions"
      data-positions={rows.length === 0 ? "empty" : age.state}
      meta={
        <>
          {rows.length > 0 && total !== null ? (
            <>
              open result <span className={cn("font-mono", tone(total))}>{dollars(total)}</span> ·{" "}
      
        </>
            ) : null}
            as of {newYork(doc.as_of, false)} ET
        </>
      }
    >
      {age.state === "old" ? (
        <Notice role="status" className="mt-1">
          These are {num(age.minutes, 0)} minutes old: the host has stopped sending them. Check the broker before relying on them.
        </Notice>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-xs">No open option positions in the paper account.</p>
      ) : (
        <ul className="divide-border/60 mt-1 divide-y">
          {rows.map((r, i) => (
            <li key={`${r.contract}:${i}`}>
              {r.onDesk && pickFor(r) ? (
                <button type="button" onClick={() => onOpen(r)} title={`Open ${r.symbol} with this contract in the contract pane`} className={cn(ROW, "hover:bg-muted/60 rounded")}>
                  <Line r={r} g={greeksOf(r)} />
                </button>
              ) : (
                <div className={ROW}>
                  <Line r={r} g={null} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground mt-1.5 text-[0.6875rem]">
        Paper account, read only. Marks and results are the broker&apos;s. Δ and what a day of waiting costs (to expiry, in a contract&apos;s last day) are estimates from option quotes 15 minutes behind the market.
      </p>
    </Pane>
  );
}
