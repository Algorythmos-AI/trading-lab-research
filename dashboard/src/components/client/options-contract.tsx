"use client";

import { Calculator, RotateCw, TriangleAlert, X } from "lucide-react";
import { useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Empty } from "@/components/empty";
import { fracPct, newYork, num, signed, weekDate } from "@/lib/format";
import { bellMinute, contractView, daysToExpiry, defaultPick, MAX_CONTRACTS, minutesToExpiry, parsePick, pickKey, type Pick, type VolSource } from "@/lib/contract";
import type { ChainResponse } from "@/lib/chain";
import { MULTIPLIER } from "@/lib/longopt";
import { sessionClock, type OptionsTicker } from "@/lib/options";
import { cn } from "@/lib/utils";
import { useLive, useLiveRead } from "./live-layer";
import { useChain } from "./use-chain";

// The chosen contract lives in the browser's own storage and nowhere else. Storage can be switched off (private
// windows, strict settings); only then does the choice live in this map, for as long as the page. While storage
// works the map stays empty, so a contract cleared in another tab is cleared here too.
const memory = new Map<string, string>();
const CHANGED = "tl-options-contract";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The contract chosen for a name, and a way to change or clear it. Null on the server and until one is chosen. */
function usePick(symbol: string): [Pick | null, (pick: Pick | null) => void] {
  const key = pickKey(symbol);
  const raw = useSyncExternalStore(
    subscribe,
    () => readStored(key),
    () => null,
  );
  const pick = useMemo(() => parsePick(raw), [raw]);
  return [pick, (next) => writeStored(key, next === null ? null : JSON.stringify(next))];
}

const VOL_FROM: Record<VolSource, string> = {
  quote: "the volatility that came with this contract's quote",
  mid: "the volatility this contract's mid price implies",
  name: "the name's own 30-day implied volatility; this contract's quote gave none",
};

/** Dollars for a whole position, signed: "+$125", "−$40". */
function money(v: number | null): string {
  if (v === null) return "—";
  const whole = Math.round(v);
  return `${whole < 0 ? "−" : whole > 0 ? "+" : ""}$${num(Math.abs(whole))}`;
}
const tone = (v: number | null) => (v === null || Math.round(v) === 0 ? "text-muted-foreground" : v > 0 ? "text-good" : "text-bad");

function Figure({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-muted-foreground truncate text-[0.6875rem]">{label}</dt>
      <dd className="font-mono text-[0.8125rem]">{children}</dd>
    </div>
  );
}

const FIELD = "bg-background h-8 rounded border px-2 font-mono text-[0.8125rem]";

/**
 * One call or put for the selected name: what it costs, where it breaks even, and what the model says it would be
 * worth if the stock were at each nearby level, now, at the close and at expiry. It stays shut, and asks the option
 * feed for nothing, until the reader opens it or has a contract remembered for this name.
 *
 * Read only and descriptive: it prices a contract the reader names; it does not suggest one.
 */
export function OptionsContract({ t, live }: { t: OptionsTicker; live: boolean }) {
  const { now, session } = useLive();
  const read = useLiveRead(t);
  const [stored, setStored] = usePick(t.symbol);
  const [opened, setOpened] = useState(false);
  /**
   * What is in a number box while it is being typed in. A box has to be allowed to hold "", "0" or "0." for a
   * moment: writing the number in use back over each of those would garble what the reader is typing.
   */
  const [typed, setTyped] = useState<{ count?: string; paid?: string }>({});
  const ids = useId();
  const section = useRef<HTMLElement>(null);
  const close = t.last?.close ?? null;
  const spot = read.price;
  const left = (expiry: string, at: number) => minutesToExpiry(expiry, at, bellMinute(expiry, session, t.half_day)) ?? 0;
  // A remembered contract that has expired is not shown: there is nothing left to price.
  const kept = stored && now !== null && left(stored.expiry, now) <= 0 ? null : stored;
  const active = live && (opened || kept !== null);
  // The strikes are asked for around the stock's price, in steps of half a percent of the close: near enough to
  // follow a move, coarse enough that a ticking price does not ask again every two seconds.
  const step = close !== null ? close * 0.005 : null;
  const px = close === null || step === null || spot === null ? close : Math.round((Math.round(spot / step) * step) * 100) / 100;
  const { feed, retry, reset } = useChain(t.symbol, px, active, kept ? `${kept.expiry}:${kept.strike}` : "");
  // An expiry whose bell has rung can linger in the feed for the rest of that day. It is not offered.
  const chain: ChainResponse | null = useMemo(() => {
    if (feed.status !== "ok" || now === null) return null;
    const ahead = (x: string) => (minutesToExpiry(x, now, bellMinute(x, session, t.half_day)) ?? 0) > 0;
    return { ...feed.chain, expiries: feed.chain.expiries.filter((x) => ahead(x.date)) };
  }, [feed, now, session, t.half_day]);

  if (!live || close === null) return null;

  const heading = (
    <h3 className="flex items-center gap-1.5 text-[0.8125rem] font-medium">
      <Calculator aria-hidden className="text-muted-foreground size-3.5" />
      Contract
    </h3>
  );
  // Each of these removes the button that was pressed. The keyboard goes somewhere sensible instead of to the page,
  // where the desk's shortcuts would stop hearing keys: to the pane when it opens, to its button when it shuts.
  const toPane = () => window.setTimeout(() => section.current?.focus(), 0);
  const open = () => {
    // An expired contract left in storage is cleared now that the reader is starting afresh.
    if (stored && !kept) setStored(null);
    setOpened(true);
    toPane();
  };
  const shut = () => {
    setStored(null);
    setOpened(false);
    setTyped({});
    reset();
    window.setTimeout(() => section.current?.querySelector("button")?.focus(), 0);
  };

  if (!active) {
    return (
      <section ref={section} aria-label={`${t.symbol} contract`} data-contract="closed" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3">
        {heading}
        <button type="button" onClick={open} className="hover:bg-accent rounded border px-2.5 py-1 text-xs font-medium">
          Price a call or put
        </button>
      </section>
    );
  }

  // The default is the strike nearest the close, which holds still; nearest the live price, it would flip between
  // two strikes with every tick of a stock sitting between them.
  const pick = kept ?? (chain ? defaultPick(chain, close) : null);
  const expiry = chain?.expiries.find((x) => x.date === pick?.expiry) ?? null;
  const strikes = expiry ? expiry.contracts.filter((c) => c.kind === pick?.kind).map((c) => c.strike) : [];
  const state =
    feed.status === "off" ? "off" : feed.status === "error" ? "error" : feed.status !== "ok" || now === null ? "loading" : pick === null || spot === null ? "empty" : "ready";
  // Open by the clock, not by a quote: a last trade stamped before the bell would read as "in session" all evening.
  const marketOpen = now !== null && sessionClock(session, Boolean(t.half_day), new Date(now))?.phase === "open";
  const view = state === "ready" ? contractView(pick!, chain, t, spot!, now!, session, { marketOpen, priceIsLive: read.inSession }) : null;

  /** Change part of the pick. A new kind or expiry keeps the strike when it exists there, else takes the nearest. */
  const change = (part: Partial<Pick>) => {
    if (!pick) return;
    const next = { ...pick, ...part };
    const offered = chain?.expiries.find((x) => x.date === next.expiry)?.contracts.filter((c) => c.kind === next.kind).map((c) => c.strike) ?? [];
    if (offered.length > 0 && !offered.includes(next.strike)) next.strike = offered.reduce((best, k) => (Math.abs(k - next.strike) < Math.abs(best - next.strike) ? k : best));
    setStored(next);
  };

  return (
    <section ref={section} tabIndex={-1} aria-label={`${t.symbol} contract`} data-contract={state} className="grid gap-3 border-t pt-3 outline-none">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {heading}
        <span className="text-muted-foreground flex items-center gap-3 text-[0.6875rem]">
          {chain ? <span>Option quotes run {chain.delay_min} minutes behind the market</span> : null}
          <button type="button" onClick={shut} className="hover:text-foreground flex items-center gap-1 rounded px-1">
            <X aria-hidden className="size-3" />
            {kept ? "Clear" : "Close"}
          </button>
        </span>
      </div>

      {state === "loading" ? (
        <div role="status" aria-busy="true" className="grid gap-2">
          <span className="sr-only">Loading option quotes</span>
          <span className="bg-muted h-8 rounded motion-safe:animate-pulse" />
          <span className="bg-muted h-24 rounded motion-safe:animate-pulse" />
        </div>
      ) : state === "off" ? (
        <Empty title="Option quotes are not set up on this site">The contract pane needs the market-data keys the live prices use.</Empty>
      ) : state === "error" ? (
        <div role="alert" className="text-bad flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          Option quotes could not be read.
          <button
            type="button"
            onClick={() => {
              retry();
              toPane();
            }}
            className="text-foreground hover:bg-accent flex items-center gap-1 rounded border px-2 py-0.5 text-xs"
          >
            <RotateCw aria-hidden className="size-3" />
            Try again
          </button>
        </div>
      ) : state === "empty" || !pick || !view ? (
        <Empty title={`No option quotes for ${t.symbol}`}>The feed returned no standard contracts near its price for the coming weeks.</Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            <div role="group" aria-label="Call or put" className="bg-muted inline-flex rounded-md p-0.5">
              {(["call", "put"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={pick.kind === k}
                  onClick={() => change({ kind: k })}
                  className={cn("rounded px-2.5 py-1 text-xs font-medium", pick.kind === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  {k === "call" ? "Call" : "Put"}
                </button>
              ))}
            </div>
            <label className="grid gap-0.5 text-[0.6875rem]" htmlFor={`${ids}-expiry`}>
              <span className="text-muted-foreground">Expiry</span>
              <select id={`${ids}-expiry`} value={pick.expiry} onChange={(ev) => change({ expiry: ev.target.value })} className={FIELD}>
                {/* A remembered expiry the feed no longer offers still has to be the selected option. */}
                {chain && !chain.expiries.some((x) => x.date === pick.expiry) ? <option value={pick.expiry}>{weekDate(pick.expiry)}</option> : null}
                {(chain?.expiries ?? []).map((x) => {
                  const d = daysToExpiry(x.date, now!);
                  return (
                    <option key={x.date} value={x.date}>
                      {weekDate(x.date)}
                      {d === 0 ? ", today" : d === 1 ? ", 1 day" : d !== null ? `, ${d} days` : ""}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="grid gap-0.5 text-[0.6875rem]" htmlFor={`${ids}-strike`}>
              <span className="text-muted-foreground">Strike</span>
              <select id={`${ids}-strike`} value={String(pick.strike)} onChange={(ev) => change({ strike: Number(ev.target.value) })} className={FIELD}>
                {!strikes.includes(pick.strike) ? <option value={String(pick.strike)}>{num(pick.strike, 2)}</option> : null}
                {strikes.map((k) => (
                  <option key={k} value={String(k)}>
                    {num(k, 2)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-0.5 text-[0.6875rem]" htmlFor={`${ids}-count`}>
              <span className="text-muted-foreground">Contracts</span>
              <input
                id={`${ids}-count`}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_CONTRACTS}
                step={1}
                value={typed.count ?? pick.contracts}
                onChange={(ev) => {
                  setTyped((cur) => ({ ...cur, count: ev.target.value }));
                  const n = Number(ev.target.value);
                  if (Number.isInteger(n) && n >= 1 && n <= MAX_CONTRACTS) change({ contracts: n });
                }}
                // Leaving the box puts back the number in use, whatever was left half typed.
                onBlur={() => setTyped((cur) => ({ ...cur, count: undefined }))}
                className={cn(FIELD, "w-16")}
              />
            </label>
            <label className="grid gap-0.5 text-[0.6875rem]" htmlFor={`${ids}-paid`}>
              <span className="text-muted-foreground">Paid, per share</span>
              <input
                id={`${ids}-paid`}
                type="number"
                inputMode="decimal"
                min={0.01}
                step={0.01}
                placeholder={view.contract?.ask != null && view.contract.ask > 0 ? `${num(view.contract.ask, 2)} ask` : "ask"}
                value={typed.paid ?? pick.paid ?? ""}
                onChange={(ev) => {
                  const raw = ev.target.value;
                  setTyped((cur) => ({ ...cur, paid: raw }));
                  const v = Number(raw);
                  // An empty box means "price it at the ask". Anything else counts only once it is a price:
                  // "0" and "0." on the way to "0.05" change nothing.
                  if (raw === "") change({ paid: null });
                  else if (Number.isFinite(v) && v >= 0.01 && v <= 100_000) change({ paid: Math.round(v * 100) / 100 });
                }}
                onBlur={() => setTyped((cur) => ({ ...cur, paid: undefined }))}
                className={cn(FIELD, "w-24")}
              />
            </label>
          </div>

          {view.expired ? (
            <Empty title="This contract has expired">Choose another expiry, or clear it.</Empty>
          ) : view.stale ? (
            <p role="status" className="text-warn flex items-start gap-2 text-sm">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              The newest option quote is {num(view.ageMin, 0)} minutes old, too old to price this contract from while the market is open. The numbers
              are withheld until newer quotes arrive.
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
                <Figure label="Bid × ask" title="The contract's last quote, per share, and the gap between the two as a share of their middle">
                  {view.quote === null ? (
                    <span className="text-muted-foreground">not quoted</span>
                  ) : view.quote.state === "no-market" ? (
                    <span className="text-muted-foreground">no market</span>
                  ) : view.quote.state === "crossed" ? (
                    <span className="text-warn">crossed quote</span>
                  ) : (
                    <>
                      {view.quote.state === "no-bid" ? "no bid" : num(view.contract?.bid, 2)} × {num(view.contract?.ask, 2)}
                      {view.quote.state === "ok" && view.quote.spreadPct !== null ? <span className="text-muted-foreground"> · {num(view.quote.spreadPct, 0)}%</span> : null}
                    </>
                  )}
                </Figure>
                <Figure label="Volatility" title={view.volFrom ? `Annualised. Priced with ${VOL_FROM[view.volFrom]}.` : "No volatility is available for this contract."}>
                  {view.sigma !== null ? fracPct(view.sigma, 1) : "—"}
                  {view.volFrom === "name" ? <span className="text-muted-foreground"> · name</span> : null}
                </Figure>
                <Figure label="Cost, most it can lose" title={`${pick.contracts} × ${MULTIPLIER} shares × the price paid`}>
                  {view.cost !== null ? `$${num(view.cost)}` : "—"}
                  {view.paidFrom && view.paidFrom !== "entered" ? <span className="text-muted-foreground"> · at the {view.paidFrom === "model" ? "model's value" : view.paidFrom}</span> : null}
                </Figure>
                <Figure label="Breakeven at expiry" title="The stock price at expiry at which the option is worth what was paid, and how many expected day's moves away that is">
                  {num(view.breakeven, 2)}
                  {view.breakevenMoves !== null ? (
                    <span className="text-muted-foreground"> · {view.breakevenMoves <= 0 ? "already past" : `${num(view.breakevenMoves, 2)} day moves away`}</span>
                  ) : null}
                </Figure>
                <Figure label={view.here === "Now" ? "Value now, estimate" : "Value at the last close, estimate"} title="The model's value per share at the stock's price shown in the table below">
                  {num(view.value, 2)}
                  {view.paidFrom === "entered" && view.pnlNow !== null ? <span className={tone(view.pnlNow)}> · {money(view.pnlNow)}</span> : null}
                </Figure>
                <Figure label="Delta · decay" title="How much the option moves per $1 of stock, and what an hour of waiting costs the whole position with the stock unchanged">
                  {view.delta !== null ? signed(view.delta, 2) : "—"}
                  {view.decayHour !== null ? <span className="text-muted-foreground"> · ${num(Math.round(view.decayHour * MULTIPLIER * pick.contracts))} an hour</span> : null}
                </Figure>
              </dl>

              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`${t.symbol} contract scenarios`}>
                <table className="w-full border-collapse text-[0.8125rem]">
                  <caption className="sr-only">
                    What the {num(pick.strike, 2)} {pick.kind} would be worth per share, and the position&apos;s profit or loss, if {t.symbol} were at each price at each
                    time. Estimates.
                  </caption>
                  <thead>
                    <tr className="border-b">
                      <th scope="col" className="text-muted-foreground py-1.5 pr-2 text-left text-[0.6875rem] font-medium">
                        If {t.symbol} is at
                      </th>
                      {view.times.map((time) => (
                        <th key={time.label} scope="col" className="text-muted-foreground px-2 py-1.5 text-right text-[0.6875rem] font-medium">
                          {time.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map((row) => (
                      <tr key={row.level.label} className={cn("border-b last:border-b-0", row.level.label === view.here && "shadow-[inset_2px_0_0_var(--primary)]")}>
                        <th scope="row" className={cn("py-1.5 pr-2 text-left font-normal", row.level.label === view.here && "pl-2")}>
                          <span className="font-mono">{num(row.level.price, 2)}</span>
                          <span className="text-muted-foreground ml-1.5 text-[0.6875rem]">{row.level.label}</span>
                        </th>
                        {row.cells.map((cell, i) => (
                          <td key={view.times[i]!.label} className="px-2 py-1.5 text-right font-mono">
                            {num(cell.value, 2)}
                            <span className={cn("ml-2 inline-block min-w-14 text-[0.6875rem]", tone(cell.pnl))}>{money(cell.pnl)}</span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p className="text-muted-foreground text-[0.6875rem]">
            {view.contract?.at ? `This contract's last quote: ${newYork(view.contract.at, false)} New York. ` : ""}
            {read.inSession && read.stale ? "The stock's own price has stopped updating; these numbers use its last one. " : ""}
            {view.sigma === null && !view.expired && !view.stale ? "No volatility is available for this contract, so only its value at expiry is shown. " : ""}
            Estimates from a flat-volatility model; an American option can be worth a little more. They describe this contract and are not advice. The
            contract is remembered in this browser only.
          </p>
        </>
      )}
    </section>
  );
}
