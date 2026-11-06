"use client";

// The status rail: one strip under the site header, sticky while the page scrolls, that says where the day stands at a
// glance. The day's limits ("Clear · 0/5 trades · $0 of $100") and what one more stop would leave, the New York clock with the next boundary ("First
// entries in 3:12"), the session as a thin bar with its no-entry windows shaded and a "now" tick, the Today log of the
// board's changes, the Cockpit switch and the alert switches. Before the open it also carries the "Trade now" board's
// line, since the board folds away until its first entries.
//
// Every time is New York, on the board's (server) clock. Nothing is read from the clock or from storage in the server
// render. Read only: nothing here places an order.
import { History, Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TONE_TEXT } from "@/components/status";
import { newYork } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import { type RailDay, sessionClock, sessionTimeline, type Timeline } from "@/lib/session-timeline";
import { cn } from "@/lib/utils";
import { CockpitSwitch } from "./cockpit";
import { AlertButtons, AlertMenu, type BoardLogEntry, boardCollapsed, useBoard } from "./trade-now";

const DAY_TONE: Record<Tone, string> = {
  good: "border-good-fill/50 bg-good-soft",
  warn: "border-warn-fill/60 bg-warn-soft",
  bad: "border-bad-fill/60 bg-bad-soft",
  info: "border-info-fill/50 bg-info-soft",
  neutral: "border-neutral-fill/50 bg-neutral-soft",
};

const WINDOW_WORD = { opening: "opening range", lunch: "lunch block", flat: "be flat" } as const;

/** The session bar: the no-entry windows hatched, the hours as light ticks, and the now tick. */
export function SessionBar({ t }: { t: Timeline }) {
  const label = `Session ${hhmmOf(t.open)} to ${hhmmOf(t.close)} New York. No new entries ${t.windows.map((w) => `${w.label} (${WINDOW_WORD[w.kind]})`).join(", ")}.${t.now !== null ? ` Now ${Math.round(t.now)}% through the session.` : ""}`;
  return (
    <div role="img" aria-label={label} data-session-bar className="relative h-6 min-w-0">
      <div className="bg-muted absolute inset-x-0 top-2 h-2 overflow-hidden rounded-full border">
        {t.windows.map((w) => (
          <span
            key={w.kind}
            data-window={w.kind}
            className="bg-neutral-soft absolute inset-y-0"
            style={{
              left: `${w.left}%`,
              width: `${Math.max(w.width, 0.8)}%`,
              backgroundImage: "repeating-linear-gradient(135deg, var(--neutral-fill) 0 2px, transparent 2px 5px)",
            }}
          />
        ))}
      </div>
      {t.hours.map((h) => (
        <span key={h.minute} aria-hidden className="bg-border absolute top-4.5 h-1.5 w-px" style={{ left: `${h.at}%` }} />
      ))}
      {t.now !== null ? (
        <span
          data-now-tick
          aria-hidden
          className="bg-foreground ring-card absolute top-0.5 h-5 w-1 -translate-x-1/2 rounded-full ring-2"
          style={{ left: `${t.now}%` }}
        />
      ) : null}
    </div>
  );
}
const hhmmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** One log line: "10:14 QQQ ENTER ZONE · CALL". */
export function logLine(e: BoardLogEntry): string {
  return `${newYork(new Date(e.at).toISOString(), false)} ${e.symbol} ${e.word}${e.side ? ` · ${e.side.toUpperCase()}` : ""}`;
}

/**
 * "Today · N": a button that opens the board's change log, newest first. Esc (with the focus in it) or a click
 * outside closes it and gives the focus back to the button.
 */
export function TodayLog({ log }: { log: readonly BoardLogEntry[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault(); // this Escape closes the log only, not the cockpit too
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.target instanceof Node && box.current?.contains(ev.target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls="today-log"
        data-today-log-button
        onClick={() => setOpen((o) => !o)}
        className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground aria-expanded:bg-muted inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 text-sm font-medium whitespace-nowrap"
      >
        <History aria-hidden className="size-4" />
        Today · {log.length}
      </button>
      {open ? (
        <div id="today-log" data-today-log={log.length} role="region" aria-label="Today's state changes, newest first" className="bg-popover text-popover-foreground absolute top-10 right-0 z-40 w-72 max-w-[calc(100vw-2rem)] rounded-md border p-2 shadow-md">
          {log.length ? (
            <ol className="grid max-h-80 gap-0.5 overflow-y-auto">
              {log.map((e, i) => (
                <li key={`${e.at}-${e.symbol}-${i}`} data-log-line={e.symbol} className="text-explain flex gap-2 font-mono tabular-nums">
                  <span className="text-muted-foreground">{newYork(new Date(e.at).toISOString(), false)}</span>
                  <span className="font-semibold">{e.symbol}</span>
                  <span className={cn("font-sans font-semibold", TONE_TEXT[e.tone])}>
                    {e.word}
                    {e.side ? ` · ${e.side.toUpperCase()}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-explain text-muted-foreground p-1">No state changes yet this session.</p>
          )}
          <p className="text-muted-foreground mt-1.5 border-t px-1 pt-1.5 text-xs">New York times. Kept in this browser for the session.</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where the rail sticks: straight under the site header while that header is sticky, else at the top. It sticks from
 * sm up only: on a phone it would hold a quarter of the screen, so there it sits at the top of the page, over the hero.
 */
function useRailTop(): number {
  const [top, setTop] = useState(0);
  useEffect(() => {
    const header = document.querySelector("body > header");
    const read = () => {
      const sticky = header && getComputedStyle(header).position === "sticky" && getComputedStyle(header).display !== "none";
      setTop(sticky ? Math.round(header.getBoundingClientRect().height) : 0);
    };
    read();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    if (header) ro?.observe(header);
    window.addEventListener("resize", read);
    // The cockpit hides the header: the attribute on <html> changes, so read again.
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-cockpit"] });
    return () => {
      ro?.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", read);
    };
  }, []);
  return top;
}

/**
 * The rail itself. `day` is the server's day check, shortened (session-timeline's railDay); the clock, the bar and the
 * log are the board's.
 */
export function StatusRail({ day }: { day: RailDay | null }) {
  const b = useBoard();
  const top = useRailTop();
  if (!b) return null;
  const clock = b.on && b.now !== null && b.mode.kind !== "loading" ? sessionClock(b.session, b.halfDay, b.now) : null;
  // The bar follows the clock's day: today's half day for an older card, the edition's otherwise.
  const t = sessionTimeline(clock?.halfDay ?? b.halfDay, clock?.minute ?? null);
  const collapsed = b.on && boardCollapsed(b.mode, b.manage.views.length);
  const switches = b.on && b.mode.kind !== "old" && b.mode.kind !== "off";
  return (
    <div
      data-status-rail
      style={{ top }}
      className="bg-background/95 supports-[backdrop-filter]:bg-background/85 relative z-20 sm:sticky -mx-4 grid gap-1.5 border-b px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {day ? (
          <p role="status" data-rail-day={day.tone} className={cn("text-explain rounded-md border px-2 py-0.5 font-medium sm:whitespace-nowrap", DAY_TONE[day.tone])}>
            <span className="font-semibold">{day.word}</span>
            <span className="font-mono tabular-nums">{day.line.slice(day.word.length)}</span>
          </p>
        ) : null}
        {/* Next to the day: what one more stop would leave. Only when the journal is current and nothing is open. */}
        {day?.room ? (
          <p data-rail-room className="text-explain text-muted-foreground">
            {day.room}
          </p>
        ) : null}
        {b.on ? (
          <p data-rail-clock className="text-explain flex min-w-0 items-center gap-1.5">
            <Clock aria-hidden className="text-muted-foreground size-4 shrink-0" />
            <span className="font-mono font-semibold tabular-nums">{b.now !== null ? newYork(new Date(b.now).toISOString(), false) : "–"}</span>
            <span className="text-muted-foreground">New York</span>
            <span aria-hidden className="text-muted-foreground">·</span>
            <span data-rail-countdown={clock?.phase ?? "loading"} className={cn("font-medium", clock && !clock.entries && clock.phase !== "closed" && clock.phase !== "next" && "text-warn")}>
              {clock?.line ?? "Reading the clock"}
            </span>
          </p>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {b.on ? <TodayLog log={b.log} /> : null}
          {switches ? (
            <>
              <AlertButtons className="hidden sm:flex" />
              <AlertMenu />
            </>
          ) : null}
          {b.on ? <CockpitSwitch /> : null}
        </div>
      </div>
      {b.on ? (
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-muted-foreground font-mono text-xs tabular-nums">
            {hhmmOf(t.open)}
          </span>
          <div className="min-w-0 flex-1">
            <SessionBar t={t} />
          </div>
          <span aria-hidden className="text-muted-foreground font-mono text-xs tabular-nums">
            {hhmmOf(t.close)}
          </span>
        </div>
      ) : null}
      {/* Before the open the board is folded into the rail: its line, with the board's own marks. */}
      {collapsed && b.mode.kind !== "live" ? (
        <p data-trade-now={b.mode.kind} data-board-status={b.mode.kind === "loading" ? "connecting" : "waiting"} data-board-line className="text-explain font-medium">
          {b.mode.line}
        </p>
      ) : null}
      {day?.open ? (
        <p data-day-open className="text-explain text-warn font-medium">
          {day.open}
        </p>
      ) : null}
    </div>
  );
}
