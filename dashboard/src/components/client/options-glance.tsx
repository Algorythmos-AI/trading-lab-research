"use client";

import { Gauge } from "lucide-react";
import { RoomBar } from "@/components/options-charts";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { fracPct, newYork, num, signed } from "@/lib/format";
import { CHIP_LABEL, LIVE_STATE_TONE, liveState, roomView, ROOM_REACH, type OptionsTicker } from "@/lib/options";
import { cn } from "@/lib/utils";
import { useNow } from "./use-now";
import { useQuotes } from "./use-quotes";

/** A last trade older than this, while the session is open, is flagged as delayed (IEX is a thin feed). */
const DELAYED_MS = 5 * 60_000;

const CHIP_DOT: Record<string, string> = { STRONG: "bg-good-fill", MID: "bg-neutral-fill", WEAK: "bg-bad-fill" };

/** IV percentile at or above this reads as rich, at or below the low mark as cheap. */
const RICH = 0.6;
const CHEAP = 0.25;

/**
 * Every name on one line: price against the nearest zones on a bar measured in ATRs, so all names read on one
 * scale, with the options market's one-day move and how pricey options are. On the newest edition it follows the
 * live price every 2 seconds; `children` is the same data as a table, folded away.
 */
export function OptionsGlance({
  tickers,
  session,
  live,
  children,
}: {
  tickers: OptionsTicker[];
  session: string;
  live: boolean;
  children?: React.ReactNode;
}) {
  const feed = useQuotes(tickers.map((t) => t.symbol).join(","), live);
  const now = useNow(5_000);
  const means = !live
    ? "Every name at its close for this edition: the bar is centred on the close and measured in ATRs."
    : feed.status === "ok"
      ? `Centred on the live price (Alpaca IEX, checked ${newYork(feed.asOf, false)} New York; IEX can lag the tape). The bar is measured in ATRs, so every name reads on one scale.`
      : feed.status === "off"
        ? "Live prices are off (no Alpaca keys in Vercel), so each bar is centred on the close."
        : feed.status === "error"
          ? "Live prices did not answer; each bar is centred on the close and retries every minute."
          : "Centred on the close until the first live price arrives. The bar is measured in ATRs.";

  return (
    <Panel title="At a glance" means={means} icon={Gauge}>
      <div className="grid gap-3">
        <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Key">
          <li className="flex items-center gap-1.5">
            <span className="bg-good-fill inline-block h-2 w-3.5 rounded-[2px]" />
            support zone
          </li>
          <li className="flex items-center gap-1.5">
            <span className="bg-bad-fill inline-block h-2 w-3.5 rounded-[2px]" />
            resistance zone
          </li>
          <li className="flex items-center gap-1.5">
            <span className="bg-info-fill/40 inline-block h-2 w-3.5 rounded-[2px]" />
            1-day expected move
          </li>
          <li className="flex items-center gap-1.5">
            <span className="bg-foreground inline-block size-2 rounded-full" />
            price · ticks every 1 ATR, ±{ROOM_REACH} shown
          </li>
        </ul>
        <div role="list" aria-label="Every name against its nearest zones">
          {tickers.map((t) => {
            const q = feed.status === "ok" ? feed.quotes[t.symbol] : undefined;
            const close = t.last?.close ?? null;
            const state = q ? liveState(t, q, session) : null;
            const inSession = state !== null && state !== "CLOSED" && state !== "NOT OPEN YET";
            const price = q && inSession ? q.price : close;
            const view = price !== null ? roomView(t, price) : null;
            const ref = close ?? q?.prev_close ?? null;
            const change = q && inSession && ref ? ((q.price - ref) / ref) * 100 : null;
            const delayed = q && inSession && now !== null && now - Date.parse(q.at) > DELAYED_MS;
            const chip = t.close_strength?.chip;
            const ivp = t.expected_move?.iv_pct_52w;
            const testing = state === "TESTING SUPPORT" || state === "TESTING RESISTANCE";
            return (
              <div
                key={t.symbol}
                role="listitem"
                className={cn(
                  "grid grid-cols-1 items-center gap-x-4 gap-y-1.5 border-b py-2.5 last:border-b-0 sm:grid-cols-[6.5rem_8rem_minmax(0,1fr)_7.5rem_4.5rem]",
                  testing && "bg-warn-soft -mx-2 rounded-md px-2",
                )}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 sm:contents">
                  <div className="flex items-baseline gap-2 sm:grid sm:gap-1">
                    <a href={`#o-${t.symbol}`} className="font-mono font-semibold">
                      {t.symbol}
                    </a>
                    {chip ? (
                      <span className="text-muted-foreground flex items-center gap-1 font-mono text-[0.6875rem]">
                        <span className={cn("inline-block size-2 rounded-[2px]", CHIP_DOT[chip])} />
                        {CHIP_LABEL[chip] ?? chip}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-baseline gap-2 font-mono text-sm sm:grid sm:gap-0.5">
                    <span>{num(price, 2)}</span>
                    <span className="text-muted-foreground text-[0.6875rem]">
                      {change !== null ? `${signed(change, 2)}%` : "close"}
                      {delayed ? <span className="text-warn"> · delayed</span> : null}
                    </span>
                    {state && inSession ? (
                      <Badge variant={LIVE_STATE_TONE[state]} className="w-fit px-1 font-sans text-[0.625rem]">
                        {state}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <div className="min-w-0">
                  {view ? (
                    <>
                      <RoomBar
                        view={view}
                        label={`${t.symbol}: ${view.downAtr === null ? "no support near" : `${num(view.downAtr, 1)} ATR down to support at ${num(view.down, 2)}`}, ${view.upAtr === null ? "no resistance near" : `${num(view.upAtr, 1)} ATR up to resistance at ${num(view.up, 2)}`}`}
                      />
                      <div className="flex justify-between gap-2 font-mono text-[0.6875rem]">
                        <span className="text-good">{view.down === null ? "↓ none near" : `↓ ${num(view.downAtr, 1)} ATR · ${num(view.down, 2)}`}</span>
                        <span className="text-bad text-right">{view.up === null ? "none near ↑" : `${num(view.up, 2)} · ${num(view.upAtr, 1)} ATR ↑`}</span>
                      </div>
                    </>
                  ) : (
                    <span className="text-muted-foreground text-xs">No ATR in this edition, so no bar.</span>
                  )}
                </div>
                <div className="hidden gap-1 font-mono text-[0.6875rem] sm:grid">
                  <span className="text-muted-foreground">IV pct {fracPct(ivp, 0)}</span>
                  <span className="bg-track relative h-1.5 overflow-hidden rounded-full">
                    {ivp != null ? (
                      <span
                        className={cn("absolute inset-y-0 left-0 rounded-full", ivp >= RICH ? "bg-warn-fill" : "bg-info-fill")}
                        style={{ width: `${Math.max(2, ivp * 100)}%` }}
                      />
                    ) : null}
                  </span>
                  <span className="text-muted-foreground">{ivp == null ? "" : ivp >= RICH ? "options rich" : ivp <= CHEAP ? "options cheap" : "middling"}</span>
                </div>
                <div className="hidden text-right font-mono text-sm sm:block">
                  {t.expected_move?.day != null ? `±${num(t.expected_move.day, 2)}` : "—"}
                  <span className="text-muted-foreground block text-[0.6875rem]">1-day move</span>
                </div>
              </div>
            );
          })}
        </div>
        {children ? (
          <details className="text-sm">
            <summary className="text-muted-foreground cursor-pointer text-xs">Show the numbers as a table</summary>
            <div className="mt-2">{children}</div>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}
