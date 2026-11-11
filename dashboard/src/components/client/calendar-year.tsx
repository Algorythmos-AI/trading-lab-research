"use client";

import { Clock } from "lucide-react";
import { useState } from "react";
import { GROUP_DOT, longDay, shortDay, type DayCell, type MonthView } from "@/lib/market-calendar";
import { DAY_LOSS_LIMIT, MAX_TRADES_PER_DAY, money } from "@/lib/trade-rules";
import { cn } from "@/lib/utils";

// Every figure arrives worked out on the server; this only keeps which day is open, so nothing here reads a clock.

/** The shade of a day's result, in three steps up to the day loss limit, so one big day cannot wash out the rest. */
function shade(pnl: number): { bg: string; ink: string | null } {
  const s = Math.min(1, Math.abs(pnl) / DAY_LOSS_LIMIT);
  const step = s > 0.66 ? 3 : s > 0.33 ? 2 : 1;
  if (pnl === 0) return { bg: "bg-neutral-soft", ink: null };
  const bg = pnl > 0 ? ["", "bg-good-fill/30", "bg-good-fill/60", "bg-good-fill"][step]! : ["", "bg-bad-fill/30", "bg-bad-fill/60", "bg-bad-fill"][step]!;
  // On the full fills, the ink that clears 4.5:1 in both themes: near-black on the green, white on the red.
  return { bg, ink: step === 3 ? (pnl > 0 ? "text-neutral-950" : "text-white") : null };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function brokeText(b: "loss" | "count" | "both"): string {
  if (b === "loss") return `lost $${DAY_LOSS_LIMIT} or more`;
  if (b === "count") return `more than ${MAX_TRADES_PER_DAY} trades`;
  return `lost $${DAY_LOSS_LIMIT} or more, and more than ${MAX_TRADES_PER_DAY} trades`;
}

function dayLabel(c: DayCell): string {
  const parts = [shortDay(c.day)];
  if (c.kind === "closed") parts.push(`market closed, ${c.name}`);
  else if (c.kind === "half") parts.push(`${c.name}, closes 1 pm New York`);
  if (c.isToday) parts.push("today");
  if (c.you && c.you.trades > 0) {
    parts.push(`${money(c.you.pnl)}, ${plural(c.you.trades, "trade")}`);
    if (c.you.broke) parts.push(`day rule broken: ${brokeText(c.you.broke)}`);
  }
  if (c.events.length) parts.push(c.events.map((e) => `${e.label}${e.expected ? " (expected)" : ""}`).join(", "));
  if (c.move) parts.push(`the open moves to ${c.move.to} Sydney`);
  return parts.join(". ");
}

export function CalendarYear({ months, initial, results }: { months: MonthView[]; initial: string | null; results: boolean }) {
  const [selected, setSelected] = useState<string | null>(initial);
  return (
    <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {months.map((m) => {
        const open = m.weeks.flat().find((c) => c?.day === selected) ?? null;
        return <Month key={m.key} month={m} selected={open} onPick={setSelected} results={results} />;
      })}
    </div>
  );
}

function Month({ month, selected, onPick, results }: { month: MonthView; selected: DayCell | null; onPick: (day: string) => void; results: boolean }) {
  return (
    <section id={`m-${month.key}`} aria-labelledby={`m-${month.key}-title`} className="bg-card grid scroll-mt-24 gap-2 rounded-xl border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id={`m-${month.key}-title`} className="text-sm font-semibold">
          {month.label}
        </h3>
        {results && month.started && month.daysTraded > 0 ? (
          <span className={cn("font-mono text-sm font-semibold", month.pnl > 0 ? "text-good" : month.pnl < 0 ? "text-bad" : "text-muted-foreground")}>{money(month.pnl)}</span>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        {plural(month.marketDays, "market day")}
        {results && month.started ? (
          <>
            {" · "}
            {month.daysTraded} traded{" · "}
            <span className={month.ruleDays ? "text-bad font-medium" : undefined}>{plural(month.ruleDays, "rule-break day")}</span>
          </>
        ) : null}
      </p>
      <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_repeat(2,minmax(0,0.55fr))] gap-1" role="presentation">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i} aria-hidden className="text-muted-foreground text-center text-[0.625rem] max-sm:text-xs">
            {d}
          </span>
        ))}
        {month.weeks.flat().map((c, i) => (c ? <Day key={c.day} cell={c} selected={selected?.day === c.day} onPick={onPick} /> : <span key={`pad-${i}`} />))}
      </div>
      {selected ? <Detail cell={selected} results={results} /> : null}
      {month.notes.length ? (
        <ul className="text-muted-foreground grid gap-0.5 text-[0.6875rem] leading-snug max-sm:text-xs">
          {month.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Day({ cell: c, selected, onPick }: { cell: DayCell; selected: boolean; onPick: (day: string) => void }) {
  const d = Number(c.day.slice(8));
  if (c.kind === "weekend" || c.kind === "out_of_range") {
    return (
      <span className="text-muted-foreground relative flex h-9 items-start justify-center pt-1 text-[0.625rem] max-sm:text-xs" aria-hidden={!c.clocks}>
        {d}
        {c.clocks ? (
          <>
            <Clock aria-hidden className="text-info absolute bottom-1 size-3" />
            <span className="sr-only">{`${shortDay(c.day)}: ${c.clocks.where} clocks go ${c.clocks.direction}`}</span>
          </>
        ) : null}
      </span>
    );
  }
  const traded = c.you && c.you.trades > 0 ? c.you : null;
  const tone = traded ? shade(traded.pnl) : null;
  const base =
    c.kind === "closed" ? "bg-warn-soft text-warn border-warn/40" : c.kind === "half" && !tone ? "bg-info-soft text-info border-info/40" : tone ? cn(tone.bg, "border-transparent") : "bg-muted/40 border-transparent";
  return (
    <button
      type="button"
      onClick={() => onPick(c.day)}
      aria-pressed={selected}
      aria-label={dayLabel(c)}
      className={cn(
        "relative flex h-9 min-w-0 items-start justify-start rounded-[5px] border px-1 pt-0.5 text-[0.6875rem] leading-none max-sm:text-xs",
        "focus-visible:ring-ring outline-none focus-visible:ring-2",
        base,
        tone?.ink ?? (c.kind === "closed" || c.kind === "half" ? undefined : "text-foreground"),
        c.kind === "half" && tone ? "border-info border-dashed" : null,
        c.isToday && "ring-foreground ring-2 ring-offset-1 ring-offset-[var(--card)]",
        selected && !c.isToday && "ring-info ring-2",
      )}
    >
      <span aria-hidden>{Number(c.day.slice(8))}</span>
      {traded?.broke ? (
        <span aria-hidden className={cn("absolute top-0 right-1 text-[0.6875rem] font-bold max-sm:text-xs", tone?.ink ?? "text-bad")}>
          !
        </span>
      ) : null}
      {c.move ? <Clock aria-hidden className="text-info absolute right-0.5 bottom-0.5 size-2.5" /> : null}
      {c.events.length ? (
        <span aria-hidden className="absolute bottom-1 left-1 flex items-center gap-0.5">
          {c.events.slice(0, 3).map((e, i) => (
            <span key={i} className={cn("ring-card size-1.5 rounded-full ring-1", GROUP_DOT[e.group])} />
          ))}
          {c.events.length > 3 ? <span className="text-[0.5rem] leading-none">+{c.events.length - 3}</span> : null}
        </span>
      ) : null}
    </button>
  );
}

function Detail({ cell: c, results }: { cell: DayCell; results: boolean }) {
  const trading = c.kind === "open" || c.kind === "half";
  const you = c.you;
  return (
    <div className="bg-background grid gap-2 rounded-lg border p-3 text-sm" aria-live="polite" data-testid="day-detail">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="font-semibold">{longDay(c.day)}</p>
        <p className={cn("text-xs", c.kind === "closed" ? "text-warn" : c.kind === "half" ? "text-info" : "text-muted-foreground")}>
          {c.kind === "closed" ? `Market closed · ${c.name}` : c.kind === "half" ? `${c.name} · New York ${c.nyHours}` : `New York ${c.nyHours}`}
        </p>
      </div>
      {trading && c.sydney ? (
        <p className="text-xs">
          <span className="text-muted-foreground">Sydney </span>
          <span className="font-mono font-medium">
            {c.sydney.open.weekday} {c.sydney.open.time} → {c.sydney.close.weekday} {c.sydney.close.time}
          </span>
          {c.move ? <span className="text-info"> · open moves from {c.move.from} today</span> : null}
        </p>
      ) : null}
      {results && trading && (c.isPast || c.isToday) ? (
        you && you.trades > 0 ? (
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Closed{c.isToday ? " so far" : ""}</dt>
              <dd className={cn("font-mono text-sm font-semibold", you.pnl > 0 ? "text-good" : you.pnl < 0 ? "text-bad" : undefined)}>{money(you.pnl)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Trades</dt>
              <dd className="font-mono text-sm font-semibold">
                {you.trades} · {you.wins} won
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Day rules</dt>
              <dd className={cn("text-sm font-semibold", you.broke ? "text-bad" : "text-good")}>{you.broke ? "Broken" : "Kept"}</dd>
            </div>
            {you.broke ? <dd className="text-bad col-span-3">{`The day ${brokeText(you.broke)}.`}</dd> : null}
            <dd className={cn("col-span-3", you.rules.length ? "text-bad" : "text-muted-foreground")}>
              {you.rules.length ? `Trades opened this day broke ${you.rules.length > 1 ? "rules" : "rule"} ${you.rules.join(", ")}.` : "Trades opened this day broke no numbered rule."}
            </dd>
          </dl>
        ) : (
          <p className="text-muted-foreground text-xs">No trades closed this day.</p>
        )
      ) : null}
      {c.clocks ? <p className="text-info text-xs">{`${c.clocks.where} clocks go ${c.clocks.direction} today.`}</p> : null}
      {c.events.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {c.events.map((e, i) => (
            <li key={i} className="flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs">
              <span aria-hidden className={cn("size-2 rounded-full", GROUP_DOT[e.group])} />
              {e.label}
              {e.timeEt ? (
                <span className="text-muted-foreground font-mono">
                  {e.timeEt} NY{e.timeSyd ? ` · ${e.timeSyd} Syd` : ""}
                </span>
              ) : null}
              {e.expected ? <span className="text-muted-foreground">(expected)</span> : null}
              {e.source ? (
                <span className="text-muted-foreground">
                  · {e.source}
                  {e.checkedBy.length ? `, checked by ${e.checkedBy.join(" and ")}` : ""}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
