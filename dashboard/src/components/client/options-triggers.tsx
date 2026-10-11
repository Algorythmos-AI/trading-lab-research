"use client";

import { TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { newYork, num, rMult, weekDate } from "@/lib/format";
import { clockSpan } from "@/lib/options";
import { announce, rulesAreOld, STATE_LABEL, type RulesToday, type SeenTriggers, type Trigger } from "@/lib/triggers";
import { cn } from "@/lib/utils";

/** A target is a gain and a stop a loss whatever the figure; otherwise the colour follows the figure as it is printed. */
function tone(t: Trigger): string {
  if (t.state === "target") return "text-good";
  if (t.state === "stopped") return "text-bad";
  const shown = t.r === null ? 0 : Math.round(t.r * 100);
  return shown === 0 ? "text-muted-foreground" : shown > 0 ? "text-good" : "text-bad";
}

/**
 * The probation rules that have triggered in today's session, as the trading host last worked them out. A row
 * opens its name.
 *
 * It says what happened to a paper rule and nothing about what to do: every rule here is on probation, the data
 * runs behind the market, and the after-close edition is the record.
 */
export function OptionsTriggers({
  rules,
  marketOpen,
  nextClose = null,
  onOpen,
}: {
  rules: RulesToday;
  marketOpen: boolean;
  /** The next close of an hourly bar, which is when the rules are next read; null outside the session. */
  nextClose?: { label: string; ms: number } | null;
  onOpen: (symbol: string) => void;
}) {
  const old = rulesAreOld(rules, marketOpen);
  const partial = rules.names > 0 && rules.names < rules.desk;
  return (
    <section aria-label="Rules today" data-triggers={rules.triggers.length} data-rules-age={old ? "old" : "fresh"} className="border-t px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-[0.8125rem] font-medium">Rules today</h3>
        <span className="text-muted-foreground text-[0.6875rem]">
          {weekDate(rules.session)} · {rules.complete ? "session over · " : ""}as of {newYork(rules.asOf, false)} ET
          {rules.delayMin ? ` · ${rules.delayMin} min behind` : ""}
        </span>
      </div>
      {nextClose && !rules.complete ? (
        <p data-next-hourly={nextClose.label} className="text-muted-foreground text-[0.6875rem]">
          Next hourly close {nextClose.label} ET in <span className="text-foreground font-mono">{clockSpan(nextClose.ms)}</span>
          {rules.delayMin ? `; its states follow about ${rules.delayMin} min later` : ""}
        </p>
      ) : null}
      {old ? (
        <p role="status" className="text-warn mt-1 flex items-start gap-1.5 text-xs">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Nothing has come from the host for {num(rules.ageMin, 0)} minutes, so these may be out of date.
        </p>
      ) : null}
      {partial ? (
        <p className="text-muted-foreground mt-1 text-xs">
          Worked out for {rules.names} of the desk&apos;s {rules.desk} names: the others&apos; bars could not be used today.
        </p>
      ) : null}
      {rules.triggers.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-xs">
          {rules.names === 0
            ? "The host could not work the rules out for any name today."
            : `No rule has triggered${rules.complete ? " today" : " so far"}${partial ? " on those names" : ""}.`}
        </p>
      ) : (
        <ul className="divide-border/60 mt-1 divide-y">
          {rules.triggers.map((t) => (
            <li key={`${t.symbol}:${t.rule}`} data-trigger={t.symbol}>
              <button
                type="button"
                onClick={() => onOpen(t.symbol)}
                title={`Open ${t.symbol}`}
                className="hover:bg-muted/60 grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 rounded py-1.5 text-left text-[0.8125rem]"
              >
                <span className="min-w-0">
                  <span className="font-mono font-semibold">{t.symbol}</span> <span>{t.label}</span>
                  <span className="text-muted-foreground block text-[0.6875rem]">
                    {t.bar ? `on the ${t.bar} ET hourly close` : "time not given"}
                    {t.side ? ` · ${t.side === "call" ? "calls" : "puts"}` : ""}
                  </span>
                </span>
                <span className={cn("text-right font-mono", tone(t))}>
                  {STATE_LABEL[t.state]}
                  <span className="block text-[0.6875rem]">{t.r === null ? "—" : rMult(t.r, 2)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground mt-1.5 text-[0.6875rem]">
        Paper rules on probation, replayed on delayed data: provisional, and not a signal to trade. R is on the stock, before any option cost. The after-close edition is the
        record.
      </p>
    </section>
  );
}

const NOTICES_KEPT = 4;

/**
 * A notice when a probation rule triggers while the page is open: the name, the rule and the hourly close, with
 * a way to open the name and a way to dismiss it. Triggers that were already there when the page opened are not
 * announced. It sits over the page's corner, so nothing on the desk moves when one arrives.
 *
 * Like the board, it says what happened to a paper rule and nothing about what to do.
 */
export function TriggerNotices({
  session,
  rules,
  onOpen,
  onDismissed,
}: {
  /** The edition's session, or null where nothing is live. */
  session: string | null;
  rules: RulesToday | null;
  onOpen: (symbol: string) => void;
  /** Called after a notice is dismissed, so the keyboard is not left on a button that has gone. */
  onDismissed: () => void;
}) {
  // A page that opens before the host has sent any states has seen none: what arrives later is new to it. One
  // that opens with states takes them as already there (`announce` with nothing seen).
  const [seen, setSeen] = useState<SeenTriggers | null>(session === null || rules ? null : { session, keys: new Set() });
  const [kept, setKept] = useState<Trigger[]>([]);
  /** What a screen reader hears: set when notices arrive and never by a dismissal, so nothing is said twice. */
  const [spoken, setSpoken] = useState("");
  const when = (t: Trigger) => (t.bar ? `on the ${t.bar} ET hourly close` : "today");
  if (rules) {
    const next = announce(seen, rules);
    if (next.seen !== seen) {
      // New states arrived with this render: note them before drawing, so each trigger is announced once.
      setSeen(next.seen);
      // Nothing fresh here means another session: there is nothing to keep showing.
      setKept(next.fresh.length > 0 ? [...next.fresh, ...kept] : []);
      if (next.fresh.length > 0) {
        const each = next.fresh.map((t) => `${t.symbol} ${when(t)}, ${t.label}`).join("; ");
        setSpoken(`${next.fresh.length === 1 ? "A paper rule" : `${next.fresh.length} paper rules`} triggered: ${each}. Provisional, and not a signal to trade.`);
      }
    }
  }
  // A provisional trigger the host has since withdrawn takes its notice with it.
  const current = rules ? new Set(rules.triggers.map((t) => `${t.symbol}|${t.rule}`)) : null;
  const live = current ? kept.filter((t) => current.has(`${t.symbol}|${t.rule}`)) : kept;
  const shown = live.slice(0, NOTICES_KEPT);
  const drop = (t: Trigger) => setKept((all) => all.filter((x) => x.symbol !== t.symbol || x.rule !== t.rule));
  return (
    <div data-trigger-notices={shown.length} className="pointer-events-none fixed right-3 bottom-16 z-40 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 md:bottom-3">
      {/* Always on the page, so a screen reader hears a notice arrive. */}
      <p role="status" className="sr-only">
        {spoken}
      </p>
      {shown.map((t) => (
        <div key={`${t.symbol}:${t.rule}`} data-trigger-notice={t.symbol} className="bg-popover text-popover-foreground pointer-events-auto rounded-md border p-2.5 shadow-md">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-xs">
              <span className="text-[0.8125rem] font-medium">{t.symbol}</span> <span className="text-muted-foreground">paper rule triggered {when(t)}</span>
              <span className="mt-0.5 block">{t.label}</span>
              <span className="text-muted-foreground mt-0.5 block text-[0.6875rem]">Provisional, on delayed bars, and not a signal to trade.</span>
            </p>
            <button
              type="button"
              aria-label={`Dismiss the notice for ${t.symbol}`}
              onClick={() => {
                drop(t);
                onDismissed();
              }}
              className="text-muted-foreground hover:text-foreground -m-1 flex size-7 shrink-0 items-center justify-center rounded"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              onOpen(t.symbol);
              drop(t);
            }}
            className="text-foreground mt-1.5 rounded border px-2 py-1 text-xs font-medium"
          >
            Show {t.symbol}
          </button>
        </div>
      ))}
      {live.length > shown.length ? (
        <p className="bg-popover text-muted-foreground pointer-events-auto rounded-md border px-2.5 py-1.5 text-xs shadow-md">
          and {live.length - shown.length} more, in Rules today
        </p>
      ) : null}
    </div>
  );
}
