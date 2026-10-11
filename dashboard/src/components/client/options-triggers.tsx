"use client";

import { newYork, rMult } from "@/lib/format";
import { STATE_LABEL, type RulesToday, type Trigger } from "@/lib/triggers";
import { cn } from "@/lib/utils";

const tone = (t: Trigger) => (t.state === "target" ? "text-good" : t.state === "stopped" ? "text-bad" : t.r === null || t.r === 0 ? "text-muted-foreground" : t.r > 0 ? "text-good" : "text-bad");

/**
 * The probation rules that have triggered in today's session, as the trading host last worked them out. A row
 * opens its name.
 *
 * It says what happened to a paper rule and nothing about what to do: every rule here is on probation, the data
 * runs behind the market, and the after-close edition is the record.
 */
export function OptionsTriggers({ rules, onOpen }: { rules: RulesToday; onOpen: (symbol: string) => void }) {
  return (
    <section aria-label="Rules today" data-triggers={rules.triggers.length} className="border-t px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-[0.8125rem] font-medium">Rules today</h3>
        <span className="text-muted-foreground text-[0.6875rem]">
          {rules.complete ? "session over · " : ""}as of {newYork(rules.asOf, false)} ET
          {rules.delayMin ? ` · ${rules.delayMin} min behind` : ""}
        </span>
      </div>
      {rules.triggers.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-xs">
          {rules.names === 0 ? "The host could not work the rules out for any name today." : `No rule has triggered${rules.complete ? " today" : " so far"}.`}
        </p>
      ) : (
        <ul className="divide-border/60 mt-1 divide-y">
          {rules.triggers.map((t) => (
            <li key={`${t.symbol}:${t.rule}`}>
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
