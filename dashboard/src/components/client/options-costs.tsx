"use client";

import { RotateCw } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { ChainResponse } from "@/lib/chain";
import { bellMinute } from "@/lib/contract";
import { costLines, type CostLine, type CostSide } from "@/lib/costs";
import { newYork, num, weekDate } from "@/lib/format";
import type { OptionsTicker } from "@/lib/options";
import { useLive } from "./live-layer";

type Got = { status: "loading" } | { status: "error" } | { status: "ok"; chain: ChainResponse };

function Side({ s }: { s: CostSide | null }) {
  if (!s || s.ask === null) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {num(s.ask, 2)}
      <span className="text-muted-foreground block text-[0.6875rem]">
        {s.moves === null ? "—" : s.moves <= 0 ? "past" : `${num(s.moves, 1)} mv`}
        {s.spreadPct !== null ? ` · ${num(s.spreadPct, 0)}%` : ""}
      </span>
    </>
  );
}

/**
 * What an at-the-money call and put cost on each name, for the Brief view. Shut until asked for: no option quote is
 * fetched for a reader who only wants the levels. Opened, it asks once for each name in turn; Refresh asks again.
 *
 * Descriptive only: the ask a buyer would pay, the distance to breakeven in expected day's moves from the last
 * close, and how wide the quote is.
 */
/** Quotes read this long ago are called old: the panel asks once and does not keep asking. */
export const COSTS_OLD_MIN = 30;

/** The strike a line is priced at; both, when the feed listed the call and the put at different ones. */
function strikes(l: CostLine): string {
  const s = (v: number) => num(v, v % 1 === 0 ? 0 : 2);
  if (l.call && l.put && l.call.strike !== l.put.strike) return ` · ${s(l.call.strike)} C / ${s(l.put.strike)} P`;
  const one = l.call ?? l.put;
  return one ? ` · ${s(one.strike)}` : "";
}

export function OptionsCosts({ tickers, session, halfDay }: { tickers: OptionsTicker[]; session: string; halfDay: boolean }) {
  const { now } = useLive();
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState(false);
  const [got, setGot] = useState<Record<string, Got>>({});
  /** When the last round of asking began: the quotes on show are at least this old. */
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const run = useRef(0);
  // Leaving the brief view stops the round in flight: the rest of the names are not asked for.
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );

  const load = useCallback(async () => {
    const mine = ++run.current;
    setOff(false);
    setAskedAt(Date.now());
    setGot(Object.fromEntries(tickers.map((t) => [t.symbol, { status: "loading" } as Got])));
    for (const t of tickers) {
      const close = t.last?.close;
      let next: Got = { status: "error" };
      if (typeof close === "number" && close > 0) {
        try {
          const res = await fetch(`/api/chain?s=${encodeURIComponent(t.symbol)}&px=${close.toFixed(2)}`, { cache: "no-store" });
          if (res.status === 503) {
            if (run.current === mine) {
              setOff(true);
              setGot({});
            }
            return; // the site has no keys for the option feed: no name will answer
          }
          if (res.ok) next = { status: "ok", chain: (await res.json()) as ChainResponse };
        } catch {
          // one name's failure leaves the others standing
        }
      }
      if (run.current !== mine) return;
      setGot((g) => ({ ...g, [t.symbol]: next }));
    }
  }, [tickers]);

  if (!open) {
    return (
      <section aria-label="Option costs" data-costs="closed" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t px-3 py-2.5">
        <h3 className="text-[0.8125rem] font-medium">What a call or put costs</h3>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            void load();
          }}
          className="hover:bg-accent rounded border px-2.5 py-1 text-xs font-medium"
        >
          Show at-the-money costs
        </button>
      </section>
    );
  }
  const busy = Object.values(got).some((g) => g.status === "loading");
  return (
    <section aria-label="Option costs" data-costs={off ? "off" : busy ? "loading" : "ready"} className="border-t px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-[0.8125rem] font-medium">What a call or put costs</h3>
        <button type="button" onClick={() => void load()} disabled={busy} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[0.6875rem] disabled:opacity-50">
          <RotateCw aria-hidden className="size-3" /> Refresh
        </button>
      </div>
      {off ? (
        <p className="text-muted-foreground mt-1 text-xs">Option quotes are not set up on this site.</p>
      ) : (
        <div className="mt-1 overflow-x-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="text-muted-foreground text-left text-[0.6875rem]">
                <th scope="col" className="py-1 pr-2 font-normal">
                  Name, expiry
                </th>
                <th scope="col" className="px-2 py-1 text-right font-normal">
                  Call ask
                </th>
                <th scope="col" className="py-1 pl-2 text-right font-normal">
                  Put ask
                </th>
              </tr>
            </thead>
            <tbody>
              {tickers.map((t) => {
                const g = got[t.symbol];
                const lines = g?.status === "ok" && now !== null && t.last?.close != null ? costLines(g.chain, t.last.close, t.expected_move?.day, now, (x) => bellMinute(x, session, halfDay)) : [];
                return (
                  <Fragment key={t.symbol}>
                    {lines.length === 0 ? (
                      <tr className="border-border/60 border-t" data-cost-row={t.symbol}>
                        <th scope="row" className="py-1.5 pr-2 text-left font-mono font-semibold">
                          {t.symbol}
                        </th>
                        <td colSpan={2} className="text-muted-foreground py-1.5 pl-2 text-right text-xs">
                          {!g ? "refresh to load" : g.status === "loading" ? "loading…" : g.status === "error" ? "no answer" : "no quotes"}
                        </td>
                      </tr>
                    ) : (
                      lines.map((l, i) => (
                        <tr key={l.expiry} className={i === 0 ? "border-border/60 border-t" : undefined} data-cost-row={t.symbol}>
                          <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                            {i === 0 ? <span className="font-mono font-semibold">{t.symbol} </span> : null}
                            <span className="text-muted-foreground text-[0.6875rem] whitespace-nowrap">
                              {weekDate(l.expiry)}
                              {l.days === 0 ? ", today" : l.days !== null ? `, ${l.days}d` : ""}
                              {strikes(l)}
                            </span>
                          </th>
                          <td className="px-2 py-1.5 text-right align-top font-mono">
                            <Side s={l.call} />
                          </td>
                          <td className="py-1.5 pl-2 text-right align-top font-mono">
                            <Side s={l.put} />
                          </td>
                        </tr>
                      ))
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!off && askedAt !== null ? (
        <p data-costs-age={now !== null && (now - askedAt) / 60_000 > COSTS_OLD_MIN ? "old" : "fresh"} className="mt-1.5 text-[0.6875rem]">
          {now !== null && (now - askedAt) / 60_000 > COSTS_OLD_MIN ? (
            <span className="text-warn">
              Read at {newYork(new Date(askedAt).toISOString(), false)} ET, {num((now - askedAt) / 60_000, 0)} minutes ago. Refresh before relying on these.
            </span>
          ) : (
            <span className="text-muted-foreground">Read at {newYork(new Date(askedAt).toISOString(), false)} ET.</span>
          )}
        </p>
      ) : null}
      <p className="text-muted-foreground mt-1 text-[0.6875rem]">
        At the strike nearest the last close. Under each ask: expected day&apos;s moves from the close to breakeven at expiry (mv), and the bid-ask spread. Quotes run 15 minutes
        behind the market.
      </p>
    </section>
  );
}
