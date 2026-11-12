"use client";

// The trade ticket under each side's decision strip: type the option price you see in Webull, and it works out, from
// your own rules, how many contracts fit, the stop to place and the dollars at risk at that stop with fees. The
// arithmetic is all in lib/ticket.ts. What is typed stays in this browser tab (React state only, never stored, never
// sent): the option chain is asked for by the name and the live stock price alone, and its 15-minute-old ask is shown
// for orientation only, never used in a number. Arithmetic on your rules, not advice: nothing here places an order.
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { readQuote } from "@/lib/contract";
import type { SidePlan } from "@/lib/focus-plan";
import { MAX_PREMIUM, PREMIUM_STOP, RISK_PER_TRADE } from "@/lib/trade-rules";
import {
  expiryPick,
  failWords,
  maxLimitTable,
  minutesLeft,
  nickelStop,
  quoteAgeMin,
  readAmount,
  readPrice,
  resultLine,
  type Size,
  sizeTicket,
  slipPerCent,
  strikesByDistance,
  ticketEstimates,
  usd,
} from "@/lib/ticket";
import { chainFresh, chainPx } from "@/lib/what-if";
import { cn } from "@/lib/utils";
import type { LiveInputs } from "./focus-card-live";
import { useLadderLive } from "./ladder-live";
import { rememberTicketPrice } from "./ticket-memo";
import { openFocusCard } from "./trade-now";
import { useChain } from "./use-chain";
import { useNow, usePerfNow } from "./use-now";

export const OPEN_TICKET_EVENT = "options-open-ticket";

/** Bring a name's card into view and open the ticket for one side, its price box focused. */
export function openTicket(symbol: string, side: "call" | "put") {
  openFocusCard(symbol);
  window.dispatchEvent(new CustomEvent(OPEN_TICKET_EVENT, { detail: { symbol, side } }));
}

const stopPct = Math.round(PREMIUM_STOP * 100);
const SMALL = "text-explain text-muted-foreground";
/** 44 px tall, for a thumb. */
const FIELD =
  "bg-background text-foreground h-11 w-full min-w-0 rounded-md border px-3 font-mono text-base tabular-nums focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none";

export interface TicketProps {
  symbol: string;
  plan: SidePlan;
  live: LiveInputs;
}

/** What the reader has typed, held by the fold so closing it keeps the numbers. */
export interface TicketTyped {
  price: string;
  strike: string;
  expiry: string;
}

/** The fold: a one-line summary while closed (its height is fixed, so nothing below moves), the ticket when open. */
export function TradeTicket({ symbol, plan, live }: TicketProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState<TicketTyped>({ price: "", strike: "", expiry: "" });
  const ref = useRef<HTMLDetailsElement>(null);
  const word = plan.side === "call" ? "call" : "put";

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ symbol?: string; side?: string }>).detail;
      if (!d || d.symbol !== symbol || d.side !== plan.side) return;
      setOpen(true);
      // After the fold has opened and drawn its price box.
      window.requestAnimationFrame(() => ref.current?.querySelector<HTMLInputElement>("input[data-ticket-price]")?.focus());
    };
    window.addEventListener(OPEN_TICKET_EVENT, on);
    return () => window.removeEventListener(OPEN_TICKET_EVENT, on);
  }, [symbol, plan.side]);

  // While open with a price typed, the "I'm in" form in this tab may start from it (memory only, ticket-memo.ts).
  useEffect(() => {
    rememberTicketPrice(symbol, plan.side, open ? typed.price : null);
    return () => rememberTicketPrice(symbol, plan.side, null);
  }, [symbol, plan.side, open, typed.price]);

  return (
    <details
      ref={ref}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group/ticket text-explain"
      data-ticket={plan.side}
    >
      <summary className="text-muted-foreground hover:text-foreground flex min-h-11 w-fit cursor-pointer items-center gap-1.5 select-none">
        <ChevronRight aria-hidden className="size-4 transition-transform group-open/ticket:rotate-90 motion-reduce:transition-none" />
        Size this {word}
        <span className="sr-only"> on {symbol}: contracts, stop and dollars at risk from your price</span>
      </summary>
      {open ? <TicketBody symbol={symbol} plan={plan} live={live} typed={typed} onType={(t) => setTyped((x) => ({ ...x, ...t }))} /> : null}
    </details>
  );
}

/** The table shown before a price is typed: the most a share for 1 to 5 contracts. */
function LimitTable() {
  const rows = maxLimitTable(5);
  return (
    <div className="grid gap-1" data-ticket-table>
      <table className="w-full max-w-sm border-collapse text-left tabular-nums">
        <caption className={cn(SMALL, "pb-1 text-left")}>The most a share you may pay, on a $0.01 tick</caption>
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="py-1 pr-2 font-medium">
              Contracts
            </th>
            <th scope="col" className="py-1 pr-2 font-medium">
              ${MAX_PREMIUM} cap
            </th>
            <th scope="col" className="py-1 font-medium">
              With the ${RISK_PER_TRADE} stop
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.contracts} className="border-t">
              <th scope="row" className="py-1 pr-2 font-mono font-semibold">
                {r.contracts}
              </th>
              <td className="py-1 pr-2 font-mono">{usd(r.capCents)}</td>
              <td className="py-1 font-mono font-semibold">{r.bothCents === null ? "none" : usd(r.bothCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={SMALL}>
        The last column also keeps the loss at the −{stopPct}% stop, with fees, within ${RISK_PER_TRADE}.
      </p>
    </div>
  );
}

function Row({ label, value, data, strong }: { label: string; value: string; data: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t py-1 first:border-t-0" {...{ [`data-ticket-${data}`]: "" }}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("shrink-0 text-right font-mono whitespace-nowrap tabular-nums", strong ? "text-foreground text-lg font-semibold" : "text-foreground")}>{value}</dd>
    </div>
  );
}

/**
 * The open ticket. Exported for its render test: with no price typed it shows the limit table and no size, no stop and
 * no estimate.
 */
export function TicketBody({ symbol, plan, live, typed, onType }: TicketProps & { typed: TicketTyped; onType: (t: Partial<TicketTyped>) => void }) {
  const ids = useId();
  const priceId = `${ids}-price`;
  const noteId = `${ids}-note`;
  const read = readPrice(typed.price);
  const size = read.kind === "ok" ? sizeTicket(read.cents) : null;

  return (
    <div className="mt-1 grid max-w-md gap-3 pl-5" data-ticket-body>
      <div className="grid gap-1">
        <label htmlFor={priceId} className="text-foreground font-medium">
          Option price in Webull, a share
        </label>
        <input
          id={priceId}
          data-ticket-price
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="1.25"
          value={typed.price}
          onChange={(e) => onType({ price: e.target.value })}
          aria-describedby={noteId}
          aria-invalid={read.kind === "bad" ? true : undefined}
          className={cn(FIELD, "max-w-[12rem]")}
        />
        <p id={noteId} className={SMALL}>
          {read.kind === "bad" ? <span className="text-bad font-medium">{read.text}</span> : null}
          {read.kind === "ok" && read.reread ? (
            <span className="text-foreground font-medium" data-ticket-read>
              Read as {usd(read.cents)}.{" "}
            </span>
          ) : null}
          {read.kind !== "bad" ? "Type the price you see, not the one on this site." : null}
        </p>
      </div>

      {size === null ? <LimitTable /> : <SizeBlock size={size} />}

      {size !== null && size.contracts > 0 ? <EstimateBlock symbol={symbol} plan={plan} live={live} typed={typed} onType={onType} paidCents={size.priceCents} contracts={size.contracts} /> : null}

      <p className={SMALL}>
        Your rules worked out, not advice: ${MAX_PREMIUM} premium cap, ${RISK_PER_TRADE} at the stop with fees, stop at −{stopPct}%. Nothing here
        places an order.
      </p>
    </div>
  );
}

function SizeBlock({ size }: { size: Size }) {
  const nickel = nickelStop(size);
  const status = (
    <p role="status" className="sr-only" data-ticket-said>
      {resultLine(size)}
    </p>
  );
  if (size.contracts === 0)
    return (
      <div className="bg-bad-soft border-bad-fill grid gap-1 rounded-md border px-3 py-2" data-ticket-none>
        {status}
        <p className="text-foreground font-semibold">At {usd(size.priceCents)} this does not fit your rules.</p>
        {failWords(size).map((w) => (
          <p key={w}>{w}</p>
        ))}
      </div>
    );
  return (
    <div className="grid gap-1" data-ticket-size={size.contracts}>
      {status}
      <dl className="grid rounded-md border px-3 py-1">
        <Row label="Contracts" value={String(size.contracts)} data="contracts" strong />
        <div className="grid gap-0.5 border-t py-1" data-ticket-stop>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Stop to place (−{stopPct}%, rounded up)</dt>
            <dd className="text-foreground text-right font-mono text-lg font-semibold tabular-nums max-sm:shrink-0 max-sm:whitespace-nowrap">{usd(size.stopCents)}</dd>
          </div>
          <dd className={SMALL}>
            On a ${(size.tick / 100).toFixed(2)} tick: check the tick in Webull.
            {nickel ? (
              <span data-ticket-nickel>
                {" "}
                If it steps $0.05: stop {usd(nickel.stopCents)}, −{usd(nickel.riskCents)} there with fees.
              </span>
            ) : null}
          </dd>
        </div>
        <div className="grid gap-0.5 border-t py-1" data-ticket-risk>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Lost if filled at the stop, with fees</dt>
            <dd className="text-foreground shrink-0 text-right font-mono whitespace-nowrap tabular-nums">−{usd(size.riskCents)}</dd>
          </div>
          <dd className={SMALL} data-ticket-slip>
            Each cent worse on the fill costs {usd(slipPerCent(size))} more.
          </dd>
        </div>
        <Row label="Fees, in and out" value={usd(size.feesCents)} data="fees" />
        <Row label="Total premium" value={usd(size.premiumCents)} data="premium" />
      </dl>
      <p className={SMALL}>
        Most contracts by the premium cap: {size.byPremium}; by the ${RISK_PER_TRADE} stop rule: {Math.min(size.byRisk, 999)}.
      </p>
    </div>
  );
}

/**
 * Estimates at the chart stop and T1, shown only when a volatility solves from the typed price at the live stock
 * price, the strike and expiry picked here. The chain gives the lists to pick from and its old ask, labelled; none
 * of its numbers feed an estimate.
 */
function EstimateBlock({
  symbol,
  plan,
  live,
  typed,
  onType,
  paidCents,
  contracts,
}: TicketProps & { typed: TicketTyped; onType: (t: Partial<TicketTyped>) => void; paidCents: number; contracts: number }) {
  const ids = useId();
  const view = useLadderLive(live);
  const spot = view.dot?.kind === "live" ? view.dot.price : null;
  const now = useNow(15_000);
  const perfNow = usePerfNow(5_000);
  const { feed } = useChain(symbol, chainPx(live.close, spot), true);
  const chain = feed.status === "ok" && feed.chain.symbol === symbol ? feed.chain : null;
  const fresh = chain !== null && feed.status === "ok" && chainFresh(chain, feed.receivedPerf, perfNow);

  // An expiry is listed while it has not passed; a same-day one whose minutes cannot be trusted stays listed, and its
  // estimates are withheld below.
  const expiries = (chain?.expiries ?? []).filter((x) => x.contracts.some((c) => c.kind === plan.side) && ((m) => m === null || m > 0)(minutesLeft(x.date, now, live.session)));
  // No default: the estimates use only an expiry the reader picked, and drop it once it passes or leaves the chain.
  const pickedMinutes = typed.expiry ? minutesLeft(typed.expiry, now, live.session) : null;
  const pick = expiryPick(typed.expiry, chain ? expiries.map((x) => x.date) : null, pickedMinutes);
  const expiry = pick.expiry ?? "";
  const listed = expiries.find((x) => x.date === expiry)?.contracts.filter((c) => c.kind === plan.side) ?? [];
  const strikes = strikesByDistance(
    listed.map((c) => c.strike),
    spot,
  );
  const strike = readAmount(typed.strike);
  const minutes = expiry ? pickedMinutes : null;
  const est = ticketEstimates({
    kind: plan.side,
    paidCents,
    spot,
    strike,
    minutes,
    contracts,
    levels: [
      { key: "stop", label: "At the chart stop", price: plan.stop },
      { key: "t1", label: "At T1", price: plan.target1 },
    ],
  });
  const quoted = fresh && strike !== null ? listed.find((c) => c.strike === strike) : undefined;
  const q = quoted ? readQuote(quoted) : null;
  const oldAsk = quoted && q && (q.state === "ok" || q.state === "no-bid") && quoted.ask !== null ? quoted.ask : null;
  // That contract's own quote time, rounded up; with none, no age and so no ask is shown.
  const age = quoted && chain && feed.status === "ok" ? quoteAgeMin(quoted.at, chain.served_at ?? chain.as_of, feed.receivedPerf, perfNow) : null;

  const missing =
    spot === null
      ? "a live stock price"
      : strike === null
        ? "a strike"
        : !expiry
          ? "an expiry picked"
          : minutes === null
            ? "today's session on this page (same-day estimates need today's edition)"
            : null;

  return (
    <div className="grid gap-2" data-ticket-estimates>
      <p className="text-foreground font-medium">What it may be worth at the chart stop and T1</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid min-w-0 gap-1">
          <label htmlFor={`${ids}-strike`} className="text-muted-foreground">
            Strike
          </label>
          <input
            id={`${ids}-strike`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="Strike"
            value={typed.strike}
            onChange={(e) => onType({ strike: e.target.value })}
            className={FIELD}
          />
        </div>
        <div className="grid min-w-0 gap-1">
          <label htmlFor={`${ids}-expiry`} className="text-muted-foreground">
            Expiry
          </label>
          {expiries.length ? (
            <select id={`${ids}-expiry`} value={expiry} onChange={(e) => onType({ expiry: e.target.value })} className={FIELD}>
              <option value="">Pick one</option>
              {expiries.map((x) => (
                <option key={x.date} value={x.date}>
                  {x.date}
                </option>
              ))}
            </select>
          ) : (
            <input id={`${ids}-expiry`} type="date" value={expiry} onChange={(e) => onType({ expiry: e.target.value })} className={FIELD} />
          )}
        </div>
      </div>
      {pick.note ? (
        <p className="text-warn text-explain font-medium" data-ticket-expiry-note>
          {pick.note}
        </p>
      ) : null}
      {strikes.length ? (
        <div className="grid gap-1">
          <p className={SMALL} id={`${ids}-near`}>
            Strikes nearest the stock, nearest first
          </p>
          <ul aria-labelledby={`${ids}-near`} className="flex flex-wrap gap-1.5">
            {strikes.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  aria-pressed={strike === k}
                  onClick={() => onType({ strike: String(k) })}
                  className={cn("min-h-11 min-w-11 rounded-md border px-3 font-mono tabular-nums", strike === k ? "bg-muted text-foreground font-semibold" : "text-muted-foreground hover:text-foreground")}
                >
                  {k}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {oldAsk !== null && age !== null ? (
        <p className={SMALL} data-ticket-old-ask>
          Site chain ask {usd(Math.round(oldAsk * 100))} · {age} min ago. Not used here.
        </p>
      ) : null}
      {est ? (
        <div className="grid gap-1" data-ticket-estimate>
          <dl className="grid rounded-md border px-3 py-1">
            {est.rows.map((r) => (
              <div key={r.key} className="flex items-baseline justify-between gap-3 border-t py-1 first:border-t-0" data-ticket-est={r.key}>
                <dt className="text-muted-foreground">
                  {r.label} {r.stockPrice.toFixed(2)}
                </dt>
                <dd className="text-foreground text-right font-mono tabular-nums">
                  {/* On a phone neither part breaks inside itself: "≈ $1.40" and "(+$15.00 on 3)" stay whole. */}
                  <span className="max-sm:whitespace-nowrap">≈ {usd(r.valueCents)}</span>{" "}
                  <span className="text-muted-foreground max-sm:whitespace-nowrap">
                    ({r.pnlCents >= 0 ? "+" : ""}
                    {usd(r.pnlCents)} on {contracts})
                  </span>
                </dd>
              </div>
            ))}
          </dl>
          <p className={SMALL}>
            Estimates, if the stock got there now, from the volatility your price implies ({Math.round(est.iv * 100)}% a year), fees in. Real fills differ.
          </p>
        </div>
      ) : (
        <p className={SMALL} data-ticket-no-estimate>
          {missing ? `No estimate without ${missing}.` : "No estimate: your price does not give a usable volatility here."}
        </p>
      )}
    </div>
  );
}
