"use client";

import { Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { newYork, num, signed } from "@/lib/format";
import { LIVE_STATE_TONE, liveNeighbours, liveState, type LiveQuote, type OptionsTicker } from "@/lib/options";
import { useNow } from "./use-now";

const POLL_MS = 15_000;
const RETRY_MS = 60_000;
/** A last trade older than this, while the session is open, is flagged as delayed (IEX is a thin feed). */
const DELAYED_MS = 5 * 60_000;

type Feed =
  | { status: "loading" }
  | { status: "off" }
  | { status: "error" }
  | { status: "ok"; asOf: string; quotes: Record<string, LiveQuote>; missing: string[] };

/**
 * The live layer: polls /api/quote (same origin, so the page's connect-src 'self' holds) every 15 seconds while
 * the tab is visible, and judges each live price against the edition's levels. Research only.
 */
export function OptionsLive({ tickers, session }: { tickers: OptionsTicker[]; session: string }) {
  const [feed, setFeed] = useState<Feed>({ status: "loading" });
  const now = useNow(5_000);
  const symbols = tickers.map((t) => t.symbol).join(",");

  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    const load = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        timer = window.setTimeout(load, POLL_MS);
        return;
      }
      let next = POLL_MS;
      try {
        const res = await fetch(`/api/quote?s=${encodeURIComponent(symbols)}`, { cache: "no-store" });
        if (res.status === 503) {
          if (!stopped) setFeed({ status: "off" });
          return; // not configured: no point polling until the page is reloaded
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { as_of: string; quotes: Record<string, LiveQuote>; missing?: string[] };
        if (!stopped) setFeed({ status: "ok", asOf: body.as_of, quotes: body.quotes ?? {}, missing: body.missing ?? [] });
      } catch {
        if (!stopped) setFeed((f) => (f.status === "ok" ? f : { status: "error" }));
        next = RETRY_MS;
      }
      if (!stopped) timer = window.setTimeout(load, next);
    };
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [symbols]);

  return (
    <Panel
      title="Live"
      icon={Radio}
      means={
        feed.status === "ok"
          ? `Alpaca IEX feed, checked ${newYork(feed.asOf, false)} New York. IEX carries a small share of volume, so prices can lag the tape.`
          : "Alpaca's free IEX feed, refreshed every 15 seconds while this page is open."
      }
    >
      {feed.status === "loading" ? (
        <p className="text-muted-foreground text-sm">Loading live prices…</p>
      ) : feed.status === "off" ? (
        <Empty title="Live prices are off">
          The dashboard has no Alpaca keys yet. Add ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in Vercel (production) and redeploy.
        </Empty>
      ) : feed.status === "error" ? (
        <Empty title="Live prices are unavailable right now">The feed did not answer; this panel retries every minute.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ticker</TableHead>
              <TableHead className="text-right">Now</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Next zone up</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Next zone down</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tickers.map((t) => {
              const q = feed.quotes[t.symbol];
              if (!q) {
                return (
                  <TableRow key={t.symbol}>
                    <TableCell className="font-mono font-semibold">{t.symbol}</TableCell>
                    <TableCell colSpan={4} className="text-muted-foreground text-xs">
                      No IEX trade
                    </TableCell>
                  </TableRow>
                );
              }
              const state = liveState(t, q, session);
              const n = liveNeighbours(t, q.price);
              const ref = t.last?.close ?? q.prev_close;
              const change = ref ? ((q.price - ref) / ref) * 100 : null;
              const live = state !== "CLOSED" && state !== "NOT OPEN YET";
              const delayed = live && now !== null && now - Date.parse(q.at) > DELAYED_MS;
              return (
                <TableRow key={t.symbol}>
                  <TableCell className="align-top">
                    <a href={`#o-${t.symbol}`} className="font-mono font-semibold">
                      {t.symbol}
                    </a>
                  </TableCell>
                  <TableCell className="text-right align-top font-mono">
                    <span className="grid justify-items-end">
                      <span>{num(q.price, 2)}</span>
                      <span className="text-muted-foreground text-[0.6875rem]">{change === null ? "—" : `${signed(change, 2)}%`}</span>
                      {delayed ? <span className="text-warn text-[0.6875rem]">delayed</span> : null}
                    </span>
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant={LIVE_STATE_TONE[state]}>{state}</Badge>
                    <p className="text-muted-foreground mt-1 font-mono text-[0.6875rem] sm:hidden">
                      ↑ {n.up === null ? "none" : num(n.up, 2)} · ↓ {n.down === null ? "none" : num(n.down, 2)}
                    </p>
                  </TableCell>
                  <TableCell className="hidden text-right align-top font-mono sm:table-cell">
                    {n.up === null ? "none" : num(n.up, 2)}
                    {n.upAtr !== null ? <span className="text-muted-foreground block text-[0.6875rem]">{num(n.upAtr, 1)} ATR</span> : null}
                  </TableCell>
                  <TableCell className="hidden text-right align-top font-mono sm:table-cell">
                    {n.down === null ? "none" : num(n.down, 2)}
                    {n.downAtr !== null ? <span className="text-muted-foreground block text-[0.6875rem]">{num(n.downAtr, 1)} ATR</span> : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
