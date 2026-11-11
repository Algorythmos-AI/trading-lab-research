"use client";

import {
  Ban,
  Bell,
  BellOff,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Clock,
  Eye,
  GitBranch,
  FlaskConical,
  Hand,
  Hourglass,
  type LucideIcon,
  OctagonX,
  Pause,
  SkipForward,
  TriangleAlert,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StatusBadge } from "@/components/status";
import { newYork } from "@/lib/format";
import { isHalfDay, type Options, type OptionsTicker } from "@/lib/options";
import {
  barsInUse,
  boardMode,
  type BoardMode,
  type BoardRow,
  boardNotices,
  boardRows,
  DONE_ROW_VIEW,
  type DoneMask,
  doneMask,
  IN_TRADE_ROW_VIEW,
  type NoticeBook,
  noticeKey,
  noticeTitle,
  rowView,
  type RowView,
  spokenChanges,
} from "@/lib/trade-now";
import { pausedAgeS } from "@/lib/level-ladder";
import { type NameState, type NameStateName, serverNow } from "@/lib/trade-state";
import { cn } from "@/lib/utils";
import { useDeskShadow } from "./desk-shadow";
import { useDone } from "./done-today";
import { FeedFacts, FeedRetry, useLive } from "./live-layer";
import { useBars } from "./use-bars";
import type { PolledRead } from "@/lib/feed-watch";
import { useTradeManage } from "./trade-manage";
import type { Lot, Trade } from "@/lib/journal";
import type { DayFacts } from "@/lib/session-timeline";

const STATE_ICON: Record<NameStateName, LucideIcon> = {
  no_trade: Ban,
  watch: Eye,
  get_ready: Hourglass,
  enter_zone: CircleCheck,
  plan_off: OctagonX,
  missed: SkipForward,
  paused: Pause,
};

/** The event the desk listens for, to select a name the board opened. */
export const OPEN_NAME_EVENT = "options-open-name";

/** Bring a name's focus card into view and select the name on the desk. */
export function openFocusCard(symbol: string) {
  window.dispatchEvent(new CustomEvent(OPEN_NAME_EVENT, { detail: symbol }));
  const card = document.getElementById(`focus-card-${symbol}`);
  if (!card) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "nearest", inline: "start" });
  card.focus({ preventScroll: true });
}

// ---- the owner's alert choices, kept in this browser ---------------------------------------------------------------
const ALERTS_KEY = "trade-now-alerts";
const ALERTS_EVENT = "trade-now-alerts";
type Alerts = { sound: boolean; notify: boolean };
let alertsFallback = "";
function readAlerts(): string {
  try {
    return window.localStorage.getItem(ALERTS_KEY) ?? alertsFallback;
  } catch {
    return alertsFallback;
  }
}
function parseAlerts(raw: string): Alerts {
  try {
    const v = JSON.parse(raw) as Partial<Alerts>;
    return { sound: v.sound === true, notify: v.notify === true };
  } catch {
    return { sound: false, notify: false };
  }
}
function writeAlerts(a: Alerts) {
  alertsFallback = JSON.stringify(a);
  try {
    window.localStorage.setItem(ALERTS_KEY, alertsFallback);
  } catch {
    // kept in alertsFallback for this page
  }
  window.dispatchEvent(new Event(ALERTS_EVENT));
}
function subscribeAlerts(onChange: () => void) {
  window.addEventListener(ALERTS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(ALERTS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
function useAlerts(): Alerts {
  const raw = useSyncExternalStore(subscribeAlerts, readAlerts, () => "");
  return parseAlerts(raw);
}

/** One audio context, made on the owner's click (a browser plays sound only after one). */
let audio: AudioContext | null = null;
function unlockSound() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    void audio.resume();
  } catch {
    audio = null;
  }
}
function beep() {
  try {
    const ctx = audio;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.06;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  } catch {
    // no sound in this browser
  }
}

function systemNotice(s: NameState) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const v = rowView(s);
    new Notification(noticeTitle(s), { body: `${v.headline}${v.testing ? " Under test." : ""} Confirm on your chart.`, tag: `trade-now-${s.symbol}` });
  } catch {
    // notifications unavailable
  }
}

/** The two opt-in switches. Both start off; permission is asked for only on the owner's click. */
export function AlertButtons({ className }: { className?: string }) {
  const alerts = useAlerts();
  const [blocked, setBlocked] = useState(false);
  const toggleNotify = async () => {
    if (alerts.notify) return writeAlerts({ ...alerts, notify: false });
    if (typeof Notification === "undefined") return setBlocked(true);
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") return setBlocked(true);
    setBlocked(false);
    writeAlerts({ ...alerts, notify: true });
  };
  // On a phone (the bell's menu) each switch is 44 px tall at 14 px.
  const btn = "text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.6875rem] whitespace-nowrap aria-pressed:text-foreground aria-pressed:bg-muted max-sm:min-h-11 max-sm:px-3 max-sm:text-sm";
  return (
    <span className={cn("flex items-center gap-1.5", className)}>
      <button
        type="button"
        className={btn}
        aria-pressed={alerts.sound}
        onClick={() => {
          if (!alerts.sound) unlockSound();
          writeAlerts({ ...alerts, sound: !alerts.sound });
        }}
      >
        {alerts.sound ? <Volume2 aria-hidden className="size-3.5" /> : <VolumeX aria-hidden className="size-3.5" />}
        Sound
      </button>
      <button type="button" className={btn} aria-pressed={alerts.notify} onClick={() => void toggleNotify()}>
        {alerts.notify ? <Bell aria-hidden className="size-3.5" /> : <BellOff aria-hidden className="size-3.5" />}
        Browser notification
      </button>
      {blocked ? <span className="text-warn text-[0.6875rem] max-sm:text-xs">Blocked in this browser</span> : null}
    </span>
  );
}

/**
 * The bell menu's Escape. While the menu is open it claims every Escape, wherever the focus is: it closes the menu (and
 * stops the cockpit from leaving on the same key), so an Escape never leaves the menu open with the cockpit gone. The
 * focus goes back to the bell only when it was in the menu or on the bell, so it is never pulled from elsewhere.
 */
export function alertMenuKey(key: string, focusInside: boolean): { close: boolean; refocus: boolean } {
  return key === "Escape" ? { close: true, refocus: focusInside } : { close: false, refocus: false };
}

/** A pointer down while the menu is open: outside it closes the menu, and the focus goes back to the bell unless the
 * click landed on another control (which takes the focus itself). */
export function alertMenuOutside(inside: boolean, onControl: boolean): { close: boolean; refocus: boolean } {
  return inside ? { close: false, refocus: false } : { close: true, refocus: !onControl };
}

const CONTROL = "a[href], button, input, select, textarea, summary, [tabindex]";

/**
 * On a phone the two switches fold into one bell with a small menu. Opening it moves the focus to its first switch;
 * Esc (wherever the focus is) or a click outside closes it, and gives the focus back to the bell when it was there.
 * The listeners are on only while it is open.
 */
export function AlertMenu() {
  const alerts = useAlerts();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (ev: KeyboardEvent) => {
      const k = alertMenuKey(ev.key, !!box.current && box.current.contains(document.activeElement));
      if (!k.close) return;
      ev.preventDefault(); // this Escape closes the menu only, not the cockpit too
      setOpen(false);
      if (k.refocus) button.current?.focus();
    };
    const onDown = (ev: PointerEvent) => {
      const target = ev.target instanceof Element ? ev.target : null;
      const r = alertMenuOutside(!!box.current && !!target && box.current.contains(target), !!target?.closest(CONTROL));
      if (!r.close) return;
      setOpen(false);
      if (r.refocus) button.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  const on = alerts.sound || alerts.notify;
  return (
    <span ref={box} className="relative sm:hidden">
      <button
        ref={button}
        type="button"
        aria-label="Alerts: sound and browser notification"
        aria-expanded={open}
        aria-controls="trade-now-alerts"
        onClick={() => setOpen((o) => !o)}
        className="text-muted-foreground hover:text-foreground flex size-11 items-center justify-center rounded-md border"
      >
        {on ? <Bell aria-hidden className="size-4" /> : <BellOff aria-hidden className="size-4" />}
      </button>
      {open ? (
        <span ref={menu} id="trade-now-alerts" className="bg-popover absolute top-12 right-0 z-30 rounded-md border p-2 shadow-md">
          <AlertButtons className="flex-col items-stretch" />
        </span>
      ) : null}
    </span>
  );
}

// ---- the board as drawn --------------------------------------------------------------------------------------------
const px = (v: number | null) => (v === null ? "–" : v.toFixed(2));

/** The one mark for an idea still under test. Never written into a sentence. */
export function TestingTag() {
  return (
    <span data-testing-tag className="text-muted-foreground bg-neutral-soft inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px text-[0.625rem] font-medium max-sm:text-xs">
      <FlaskConical aria-hidden className="size-3" />
      Testing
    </span>
  );
}

function Badge({ v, paused, state }: { v: RowView; paused: boolean; state: NameStateName }) {
  const icon = paused ? Pause : v.badge.alt ? GitBranch : STATE_ICON[state];
  return (
    <StatusBadge tone={paused ? "neutral" : v.badge.tone} icon={icon} className="font-sans text-[0.625rem] max-sm:text-xs">
      {v.badge.word}
      {v.badge.side && !paused ? ` · ${v.badge.side.toUpperCase()}` : ""}
    </StatusBadge>
  );
}

/** Entry, stop and first target as three cells: the label small and muted, the value in the mono font. */
function ValueGrid({ grid }: { grid: NonNullable<RowView["grid"]> }) {
  const cell = (label: string, value: string) => {
    // "752.01 or −25%": the price in the cell's own size, the option's stop as a small note beside it.
    const [price, ...rest] = value.split(" or ");
    return (
      <div className="min-w-0">
        <dt className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">{label}</dt>
        <dd className="font-mono text-sm font-semibold sm:text-base">
          {price}
          {rest.length ? <span className="text-muted-foreground ml-1 font-sans text-[0.6875rem] font-normal whitespace-nowrap max-sm:text-xs">or {rest.join(" or ")}</span> : null}
        </dd>
      </div>
    );
  };
  return (
    <dl className="grid max-w-md grid-cols-3 gap-x-4" data-board-grid>
      {cell("Enter", grid.enter)}
      {cell("Stop", grid.stop)}
      {grid.target !== null ? cell("Target 1", grid.target) : null}
    </dl>
  );
}

function Row({ row, mode, paused, onOpen, extra, mask = null }: { row: BoardRow; mode: BoardMode; paused: boolean; onOpen: (s: string) => void; extra?: React.ReactNode; mask?: DoneMask }) {
  const s = row.state;
  // 14 px on a phone: the row's price is something he acts on.
  const base = "hover:bg-muted/60 w-full rounded px-2 py-1.5 text-left text-[0.8125rem] max-sm:text-sm";
  const label = `Show the ${row.symbol} focus card`;
  if (!s) {
    // Outside the live mode: the two trigger prices only.
    return (
      <li data-board-row={row.symbol} data-board-state="plan">
        <button type="button" onClick={() => onOpen(row.symbol)} className={cn(base, "flex items-baseline gap-x-3")}>
          <span className="w-12 shrink-0 font-mono font-semibold">{row.symbol}</span>
          <span className="text-muted-foreground min-w-0 flex-1">{row.triggers}</span>
          <span className="text-muted-foreground shrink-0 font-mono">{mode.kind === "next" ? "" : px(row.price)}</span>
          <span className="sr-only">. {label}</span>
        </button>
        {extra ? <div className="px-2 pb-1.5">{extra}</div> : null}
      </li>
    );
  }
  // Today marked done: the entry prompt gives way to a neutral chip ("done", or "in a trade" for a managed name, whose
  // card below keeps everything); the row's own manage form (extra) stays. No entry sentence, no Enter figures.
  if (mask && !paused) {
    return (
      <li data-board-row={row.symbol} data-board-state={mask}>
        <button type="button" onClick={() => onOpen(row.symbol)} className={cn(base, "text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1")}>
          <span className="w-12 shrink-0 font-mono font-semibold">{row.symbol}</span>
          <StatusBadge tone="neutral" icon={mask === "in_trade" ? Hand : CircleCheck} className="font-sans text-[0.625rem] max-sm:text-xs">
            {(mask === "in_trade" ? IN_TRADE_ROW_VIEW : DONE_ROW_VIEW).badge.word}
          </StatusBadge>
          <span className="ml-auto shrink-0 font-mono sm:ml-0">{px(row.price)}</span>
          <span className="sr-only">. {label}</span>
        </button>
        {extra ? <div className="px-2 pb-1.5">{extra}</div> : null}
      </li>
    );
  }
  const v = rowView(s);
  const shownState: NameStateName = paused ? "paused" : s.state;
  const head = (
    <>
      <span className="w-12 shrink-0 font-mono font-semibold">{row.symbol}</span>
      <span className="flex shrink-0 items-center gap-1">
        <Badge v={v} paused={paused} state={s.state} />
        {v.testing && !paused ? <TestingTag /> : null}
      </span>
    </>
  );
  // An entry, or a live alternative: expanded, with its numbers. Not while prices are paused.
  if (v.grid && !paused) {
    const entry = s.state === "enter_zone";
    return (
      <li
        data-board-row={row.symbol}
        data-board-state={s.state}
        data-board-alt={v.badge.alt ?? undefined}
        data-expanded="true"
        className={cn("grid gap-1.5 rounded-md border px-1 pb-2", entry ? "bg-good-soft/60 border-good-fill/40" : "bg-warn-soft/40 border-warn-fill/40")}
      >
        <button type="button" onClick={() => onOpen(row.symbol)} className={cn(base, "grid gap-1 pt-2")}>
          <span className="flex items-start gap-x-3">
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">{head}</span>
            <span className="shrink-0 font-mono font-semibold">{px(row.price)}</span>
          </span>
          <span className="text-sm leading-snug font-medium">{v.headline}</span>
          <span className="sr-only">. {label}</span>
        </button>
        <div className="grid gap-1.5 px-2">
          <ValueGrid grid={v.grid} />
          {s.cautions.length ? (
            <span className="flex flex-wrap items-center gap-1" data-board-cautions={s.cautions.length + s.moreCautions}>
              {s.cautions.map((c) => (
                <StatusBadge key={c.id} tone="warn" icon={TriangleAlert} className="font-sans text-[0.625rem] max-sm:text-xs">
                  <span title={c.why}>{c.word}</span>
                </StatusBadge>
              ))}
              {s.moreCautions ? <span className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">+{s.moreCautions} more</span> : null}
            </span>
          ) : null}
          {row.runner ? (
            <details className="text-muted-foreground text-xs" data-board-runner>
              <summary className="hover:text-foreground flex w-fit cursor-pointer items-center gap-1.5 select-none">
                Runner plan <TestingTag />
              </summary>
              <p className="mt-1 leading-snug">{row.runner}</p>
            </details>
          ) : null}
          {extra}
        </div>
      </li>
    );
  }
  const quiet = paused || s.state === "no_trade";
  return (
    <li data-board-row={row.symbol} data-board-state={shownState}>
      <button
        type="button"
        onClick={() => onOpen(row.symbol)}
        className={cn(base, "flex flex-wrap items-center gap-x-3 gap-y-1", quiet && "text-muted-foreground")}
      >
        {head}
        <span className="order-last min-w-0 basis-full leading-snug sm:order-none sm:flex-1 sm:basis-0 sm:truncate" title={v.headline}>
          {v.headline}
        </span>
        <span className="ml-auto shrink-0 font-mono sm:ml-0">{px(row.price)}</span>
        <span className="sr-only">. {label}</span>
      </button>
      {/* an "I'm in" form opened while the row was an entry stays open as the row moves on */}
      {extra ? <div className="px-2 pb-1.5">{extra}</div> : null}
    </li>
  );
}

/**
 * A live row worth acting on: an entry, a get-ready or a live alternative (a row with numbers). Never a paused one:
 * the board shows no numbers on old prices.
 */
export function actionableRow(row: BoardRow): boolean {
  const s = row.state;
  if (!s || s.state === "paused") return false;
  return s.state === "get_ready" || rowView(s).grid !== null;
}

/**
 * Before the open (and while connecting) the board folds into the status rail, which carries its line: the trigger
 * prices are on the ladders and the cards. It stays while a manage card is open, so a trade is never out of sight.
 */
export function boardCollapsed(mode: BoardMode, manageCards: number): boolean {
  return (mode.kind === "next" || mode.kind === "opening" || mode.kind === "loading") && manageCards === 0;
}

/**
 * The board as drawn from what it was given: the header, the line for a mode without states, and, in the live mode,
 * only the rows worth acting on (an entry, a get-ready, a live alternative, or a row holding an open "I'm in" form);
 * the rest are counted in one line. Separate from the live wiring so it can be drawn in a test.
 */
export function TradeNowBoard({
  mode,
  rows,
  now,
  paused,
  barsDelayed = false,
  onOpen,
  switches,
  retry,
  facts,
  rowExtra,
  after,
  doneFor,
  maskFor,
}: {
  mode: BoardMode;
  rows: BoardRow[];
  /** The board's clock, ms; null before the browser has read it. */
  now: number | null;
  paused: boolean;
  /** The server's session bars are late or failing: the states use the page's own prices only. */
  barsDelayed?: boolean;
  onOpen: (symbol: string) => void;
  switches?: React.ReactNode;
  /** Laid over the header row while the live prices are being tried again after failing (live-layer's FeedRetry). */
  retry?: React.ReactNode;
  /** Under the header row, outside the retry line, so it is never covered: the feed's name and ages (FeedFacts). */
  facts?: React.ReactNode;
  /** Drawn inside a row (an expanded one under its numbers): the manage card's "I'm in" and its form (trade-manage.tsx). */
  rowExtra?: (row: BoardRow, paused: boolean) => React.ReactNode;
  /** Drawn under the rows, and kept while the live prices are off: the manage cards (trade-manage.tsx). */
  after?: React.ReactNode;
  /** True for a row whose entry prompt is hidden because today is marked done (the board's doneFor). */
  doneFor?: (symbol: string) => boolean;
  /** What today's "done" makes of a row (the board's maskFor); without it, doneFor alone. */
  maskFor?: (symbol: string) => DoneMask;
}) {
  const showRows = mode.kind !== "old" && mode.kind !== "off";
  // Live: only what is worth acting on, plus a row that holds an open form (it stays as it was opened).
  const drawn = rows.map((r) => ({ r, extra: rowExtra?.(r, paused) ?? null }));
  const listed = mode.kind === "live" ? drawn.filter(({ r, extra }) => actionableRow(r) || extra !== null) : drawn;
  // A name paused on its own (the others live) is never "watching": it is named apart, with what to do.
  const shown = new Set(listed.map(({ r }) => r.symbol));
  const pausedNames = mode.kind === "live" && !paused ? rows.filter((r) => r.state?.state === "paused" && !shown.has(r.symbol)).map((r) => r.symbol) : [];
  const watching = rows.length - listed.length - pausedNames.length;
  const status = mode.kind === "live" ? (paused ? "paused" : "live") : mode.kind === "loading" ? "connecting" : mode.kind === "off" ? "off" : "waiting";
  return (
    <section aria-labelledby="trade-now-title" data-trade-now={mode.kind} data-board-status={status} className="bg-card grid gap-2 rounded-lg border px-3 py-2.5">
      {/* relative: the retry line (FeedRetry) is laid over this row, so it never moves the rows below. At least 44 px
          tall on a phone, the height of its Retry now button, so the line never reaches past the row onto the feed line. */}
      <div data-board-header className="relative flex items-center justify-between gap-x-4 gap-y-1.5 max-sm:min-h-11">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="trade-now-title" className="flex items-center gap-2 text-sm font-semibold">
            <Zap aria-hidden className="text-muted-foreground size-4" />
            Trade now
          </h2>
          {now !== null ? (
            <span className="text-muted-foreground flex items-center gap-1 font-mono text-[0.6875rem] max-sm:text-xs">
              <Clock aria-hidden className="size-3" />
              {newYork(new Date(now).toISOString(), false)} New York
            </span>
          ) : null}
          {mode.kind === "live" ? (
            <span className={cn("flex items-center gap-1 text-[0.6875rem] font-medium max-sm:text-xs", paused ? "text-warn" : "text-good")}>
              {paused ? <CircleDashed aria-hidden className="size-3" /> : <span aria-hidden className="bg-good-fill inline-block size-2 rounded-full motion-safe:animate-pulse" />}
              {paused ? "paused" : "live"}
            </span>
          ) : null}
          <Link href="/strategies" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[0.6875rem] underline-offset-4 hover:underline max-sm:text-xs">
            <FlaskConical aria-hidden className="size-3" />
            Testing · not proven yet
            <ChevronRight aria-hidden className="size-3" />
          </Link>
        </div>
        {showRows ? switches : null}
        {retry}
      </div>
      {facts}
      {mode.kind !== "live" ? (
        <p data-board-line className={cn("text-[0.8125rem]", mode.kind === "off" || mode.kind === "old" ? "text-muted-foreground" : "font-medium")}>
          {mode.line}
        </p>
      ) : paused ? (
        <p data-board-line className="text-warn text-[0.8125rem] font-medium">
          Prices paused: no entry is shown on old prices. Check your platform.
        </p>
      ) : null}
      {mode.kind === "live" && barsDelayed ? (
        <p data-board-bars="delayed" className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">
          Session bars delayed: states use this page&apos;s prices only
        </p>
      ) : null}
      {showRows && listed.length ? (
        <ul className="grid gap-1" aria-label="Focus names worth acting on, most urgent first">
          {listed.map(({ r, extra }) => (
            <Row key={r.symbol} row={r} mode={mode} paused={paused} onOpen={onOpen} extra={extra} mask={maskFor ? maskFor(r.symbol) : doneFor?.(r.symbol) ? "done" : null} />
          ))}
        </ul>
      ) : null}
      {pausedNames.length ? (
        <p data-board-paused={pausedNames.length} className="text-warn text-[0.8125rem] font-medium">
          <Pause aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
          {pausedNames.join(", ")}: prices paused, check your platform
        </p>
      ) : null}
      {mode.kind === "live" && !paused && watching > 0 ? (
        listed.length === 0 ? (
          <p data-board-none className="text-explain font-medium">
            Nothing to act on: {watching} name{watching === 1 ? "" : "s"} watching
          </p>
        ) : (
          <p data-board-hidden={watching} className="text-muted-foreground text-xs">
            {watching} more name{watching === 1 ? "" : "s"} watching: see the glance above
          </p>
        )
      ) : null}
      {after}
      <p className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">Advisory states from the study under test; the 9 rules are unchanged. Read only: nothing here places an order.</p>
    </section>
  );
}

// ---- notices -------------------------------------------------------------------------------------------------------
/** At most this many notices at once on a wide screen; one on a phone. */
export const NOTICES_WIDE = 2;

function BoardNotices({ notices, onOpen, onDrop, extra }: { notices: NameState[]; onOpen: (s: string) => void; onDrop: (s: NameState) => void; extra?: React.ReactNode }) {
  const one = (s: NameState, i: number) => {
    const v = rowView(s);
    return (
      <div
        key={`${s.symbol}:${s.state}`}
        data-board-notice={s.symbol}
        className={cn("bg-popover text-popover-foreground pointer-events-auto rounded-md border p-2.5 shadow-md", i >= 1 && "hidden sm:block")}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-xs">
            <p className="flex flex-wrap items-center gap-1.5 text-[0.8125rem] font-medium">
              {noticeTitle(s)}
              {v.testing ? <TestingTag /> : null}
            </p>
            <p className="mt-0.5">{v.headline}</p>
            <p className="text-muted-foreground mt-0.5 text-[0.6875rem] max-sm:text-xs">Advisory: confirm on your chart.</p>
          </div>
          <button
            type="button"
            aria-label={`Dismiss the notice for ${s.symbol}`}
            onClick={() => onDrop(s)}
            className="text-muted-foreground hover:text-foreground -m-1 flex size-7 shrink-0 items-center justify-center rounded max-sm:size-11"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            onOpen(s.symbol);
            onDrop(s);
          }}
          className="text-foreground mt-1.5 rounded border px-2 py-1 text-xs font-medium max-sm:min-h-11 max-sm:px-3 max-sm:text-sm"
        >
          Show {s.symbol}
        </button>
      </div>
    );
  };
  const shown = notices.slice(0, NOTICES_WIDE);
  return (
    <div
      data-board-notices={notices.length}
      // On a phone the stack sits in the page's flow straight under the board, so it can never cover it. From sm up it is
      // fixed at the bottom right of the screen: always in view wherever the board is (it now sits below the hero and
      // the glance, often under the fold), and clear of the rail and the hero's prices at the top.
      className="z-40 mt-2 flex flex-col gap-2 sm:pointer-events-none sm:fixed sm:right-3 sm:bottom-3 sm:left-auto sm:mt-0 sm:w-[22rem]"
    >
      {extra}
      {shown.map(one)}
      {notices.length > 1 ? (
        <p className="bg-popover text-muted-foreground pointer-events-auto w-fit rounded-md border px-2.5 py-1 text-xs shadow-md sm:hidden" data-board-more>
          +{notices.length - 1} more
        </p>
      ) : null}
      {notices.length > NOTICES_WIDE ? (
        <p className="bg-popover text-muted-foreground pointer-events-auto hidden w-fit rounded-md border px-2.5 py-1 text-xs shadow-md sm:block">
          +{notices.length - NOTICES_WIDE} more
        </p>
      ) : null}
    </div>
  );
}

// ---- the board, live -----------------------------------------------------------------------------------------------
/** One line of the "Today" change log: a name's state word changed, at the board's (server) clock. */
export interface BoardLogEntry {
  at: number;
  symbol: string;
  word: string;
  side: "call" | "put" | null;
  tone: RowView["badge"]["tone"];
}
/** The log keeps this many lines; the newest first. */
export const BOARD_LOG_MAX = 30;
const LOG_KEY = (session: string) => `trade-now-log:${session}`;

// The tones a log line may carry (labels.ts Tone): a line with any other is dropped, never drawn in a guessed colour.
const LOG_TONES: ReadonlySet<string> = new Set<BoardLogEntry["tone"]>(["good", "warn", "bad", "neutral", "info"]);

/** One saved line, checked field by field: the storage is the browser's, and anything may be in it. */
function isLogEntry(x: unknown): x is BoardLogEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.at === "number" &&
    Number.isFinite(e.at) &&
    typeof e.symbol === "string" &&
    typeof e.word === "string" &&
    (e.side === "call" || e.side === "put" || e.side === null) &&
    typeof e.tone === "string" &&
    LOG_TONES.has(e.tone)
  );
}

/** The log saved in this browser for the session, if any; [] when storage is off or the text is not a log. */
export function parseBoardLog(raw: string | null): BoardLogEntry[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(isLogEntry).slice(0, BOARD_LOG_MAX);
  } catch {
    return [];
  }
}

type Item = NonNullable<Options["focus"]>["items"][number];

/** What the whole page reads of the board: one computation, so the hero, the glance, the ladders, the cards and the rows always agree. */
export interface Board {
  /** The board is drawn at all: a live edition with focus names. */
  on: boolean;
  session: string;
  halfDay: boolean;
  /** The focus names in the card's rank order, and each one's row on the edition, for the hero's plan and price. */
  items: readonly Item[];
  ticker: (symbol: string) => OptionsTicker | undefined;
  /** The pre-market price on the focus card per name, if any. */
  premarket: Readonly<Record<string, number | null>>;
  /** The day the edition's close is from (its built_from). */
  closeDate: string | null;
  /** Per focus name: the older of the feed's and the last trade's age, whole seconds, on the board's clock; null when
   * not known. What "Prices paused N s" says. */
  ageS: Readonly<Record<string, number | null>>;
  mode: BoardMode;
  /** The board's (server) clock, ms; null before the browser has read it. */
  now: number | null;
  rows: BoardRow[];
  states: NameState[];
  paused: boolean;
  barsDelayed: boolean;
  /** The session bars' poll as the feed health strip reads it (feed-strip.tsx): its status and when it last answered. */
  barsRead?: PolledRead;
  /** The manage card's pieces (trade-manage.tsx), and each open trade's action word for the hero. */
  manage: ReturnType<typeof useTradeManage>;
  /** The notices to show now, and how to drop one. */
  notices: NameState[];
  dropNotice: (s: NameState) => void;
  /** The last state changes this session, newest first (kept in this browser). */
  log: BoardLogEntry[];
  /** The screen-reader line for the latest changes. */
  spoken: string;
  /** True for a name whose entry prompt is hidden: today is marked done and the name is not in a managed trade. */
  doneFor: (symbol: string) => boolean;
  /** What today's "done" makes of a name: "done", "in_trade" (a managed trade), or null (doneMask). */
  maskFor?: (symbol: string) => DoneMask;
}

/** Exported for the render tests only; the page reads it through useBoard. */
export const BoardContext = createContext<Board | null>(null);

/** The page's board; null outside a BoardProvider. */
export function useBoard(): Board | null {
  return useContext(BoardContext);
}

/** One name's live row on the board, or null (no board, not live, or the name is not on it). */
export function useBoardRow(symbol: string): { row: BoardRow; view: RowView | null; paused: boolean; done?: boolean; mask?: DoneMask } | null {
  const b = useBoard();
  const row = b?.rows.find((r) => r.symbol === symbol);
  if (!b || !row) return null;
  // Today marked done: the name's entry prompt reads as the neutral done view everywhere it is drawn, and a name in a
  // managed trade as the neutral "In a trade" one (its manage card is drawn apart and keeps everything).
  const mask: DoneMask = b.paused ? null : (b.maskFor?.(symbol) ?? (b.doneFor(symbol) ? "done" : null));
  const done = mask === "done";
  const view = row.state ? (mask === "done" ? DONE_ROW_VIEW : mask === "in_trade" ? IN_TRADE_ROW_VIEW : rowView(row.state)) : null;
  return { row, view, paused: b.paused, done, mask };
}

/**
 * The side the board points at for a name, for the ladder and the card's strips: the side of an entry or a get-ready
 * only. None while prices are paused, and none for a live alternative: its numbers are its own, not the plan strip's
 * on that side, so emphasising that strip (or dimming the far side of the ladder, where an alternative at the ceiling
 * sits) would put the wrong numbers in front of the owner. The lit alternative chip and the ladder's marker are its cue.
 */
export function boardSide(r: ReturnType<typeof useBoardRow>): "call" | "put" | null {
  if (!r || r.paused || r.done || r.mask || !r.row.state) return null;
  const s = r.row.state;
  return s.state === "enter_zone" || s.state === "get_ready" ? (s.side ?? null) : null;
}

/** The alternative trigger the board shows live for a name, if any (never while prices are paused). */
export function boardAlt(r: ReturnType<typeof useBoardRow>): { kind: NonNullable<RowView["badge"]["alt"]>; side: "call" | "put" } | null {
  if (!r || r.paused || r.done || r.mask || !r.row.state || r.row.state.state === "paused") return null;
  const b = r.view?.badge;
  return b?.alt && b.side ? { kind: b.alt, side: b.side } : null;
}

// Fixed empty lists: a default written as `[]` would be a new array on every render, and the manage card keeps its
// journal work only while its inputs are the same values (journalDayCache).
const NO_LOTS: readonly Lot[] = [];
const NO_TRADES: readonly Trade[] = [];
const NO_ITEMS: NonNullable<Options["focus"]>["items"] = [];

/**
 * Works the board out once for the page, from the focus card's levels, the live quotes and the session's 2-minute
 * bars, and shares it (useBoard). It also rings the notices and keeps the "Today" log. Advisory and read only.
 */
export function BoardProvider({
  e,
  live,
  dayLimitUsed,
  wonToday,
  openLots = NO_LOTS,
  closedTrades = NO_TRADES,
  journalAsOf = null,
  dayFacts = null,
  evalOn = false,
  children,
}: {
  e: Options;
  live: boolean;
  dayLimitUsed: boolean;
  wonToday: boolean | null;
  /** The journal's open lots as it has them, one per fill (`doc.open`, not merged), for the manage card. */
  openLots?: readonly Lot[];
  /**
   * The journal's closed pieces opened on the session's day (manage-stop's dayJournal), for the manage card: a note
   * whose trade has closed is retired. Never the whole history: the board renders every second.
   */
  closedTrades?: readonly Trade[];
  /** When the journal was read (`doc.as_of`), for the manage card. */
  journalAsOf?: string | null;
  /** The server's day check, for the room left after a note's stop (session-timeline's dayFacts). */
  dayFacts?: DayFacts | null;
  /** The server's shadow check is switched on (desk/eval.json, read by the server render); off by default. */
  evalOn?: boolean;
  children: React.ReactNode;
}) {
  const { feed, now: browserNow } = useLive();
  const items = e.focus?.items ?? NO_ITEMS;
  const symbols = [...items].sort((a, b) => a.rank - b.rank).map((i) => i.symbol).join(",");
  const halfDay = isHalfDay(e);
  const ok = feed.status === "ok";
  // Every time on the board is the feed's (server) clock; the browser's only until the feed has answered.
  const now = browserNow === null ? null : serverNow(ok ? feed.asOf : null, ok ? feed.receivedAt : null, browserNow).getTime();
  const answeredAt = ok && Number.isFinite(Date.parse(feed.asOf)) ? Date.parse(feed.asOf) : null;
  const mode: BoardMode = now === null ? { kind: "loading", line: "Connecting to live prices" } : boardMode(e.session, halfDay, feed.status, now);
  const newest = ok ? Math.max(0, ...items.map((i) => Date.parse(feed.quotes[i.symbol]?.at ?? "") || 0)) : 0;
  const bars = useBars(symbols, live && items.length > 0 && (mode.kind === "live" || mode.kind === "opening"), newest > 0 ? Math.floor(newest / 120_000) : null, halfDay);
  // Late or failing bars are not used: the states fall back to the page's own prices, and the header says so.
  const used = barsInUse(bars, browserNow);
  const rows =
    now === null
      ? []
      : boardRows(
          {
            session: e.session,
            halfDay,
            items,
            tickers: e.tickers,
            quotes: ok ? feed.quotes : {},
            trails: ok ? feed.trails : {},
            serverBars: used.bars,
            serverFetchedAt: used.fetchedAt,
            now,
            receivedAt: answeredAt,
            dayLimitUsed,
            wonToday,
          },
          mode.kind === "live",
        );
  const states = rows.map((r) => r.state).filter((s): s is NameState => s !== null);
  const paused = mode.kind === "live" && states.length > 0 && states.every((s) => s.state === "paused");
  // "Prices paused N s": the older of the feed's answer and the name's last trade, as the ladder's caption reads it, so
  // the hero and the ladder never give two ages for one pause.
  const ageS: Record<string, number | null> = {};
  for (const i of items) {
    ageS[i.symbol] = pausedAgeS(now, answeredAt, ok ? feed.quotes[i.symbol] : undefined, e.session);
  }

  // Notices: states seen once the bars have answered; what was there when the page opened is not announced.
  const alerts = useAlerts();
  // The owner marked today done (done-today.tsx): entry notices are neither shown nor rung. The manage card's own
  // notices (SELL HALF, EXIT) are not these and keep working.
  const done = useDone();
  const [book, setBook] = useState<NoticeBook>({ seen: null, kept: [] });
  const [spoken, setSpoken] = useState("");
  const [last, setLast] = useState<Record<string, string>>({});
  const [ring, setRing] = useState<{ n: number; fresh: NameState[] }>({ n: 0, fresh: [] });
  const [log, setLog] = useState<BoardLogEntry[]>([]);
  // The log saved for this session, read once in the browser: the browser's clock is null in the server render and on
  // hydration, so storage is never read before the page is the browser's own.
  const [logFor, setLogFor] = useState<string | null>(null);
  if (browserNow !== null && logFor !== e.session) {
    setLogFor(e.session);
    let saved: BoardLogEntry[] = [];
    try {
      saved = parseBoardLog(window.localStorage.getItem(LOG_KEY(e.session)));
    } catch {
      /* storage off: the log starts empty */
    }
    setLog(saved);
  }
  useEffect(() => {
    if (ring.n === 0 || done) return;
    if (alerts.sound) beep();
    if (alerts.notify) ring.fresh.forEach(systemNotice);
    // Only a new ring sounds: a change of the switches alone must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ring.n]);
  const settled = mode.kind === "live" && bars.status !== "loading";
  // The server's shadow check (DEC-0044): with its switch off, one status read and nothing else.
  useDeskShadow({
    enabled: evalOn,
    reading: live && items.length > 0 && (mode.kind === "live" || mode.kind === "opening"),
    live: settled,
    session: e.session,
    states,
    now,
    browserNow,
    barsDelayed: mode.kind === "live" && used.delayed,
  });
  if (settled) {
    // Announces what is new and withdraws, for good, every notice whose state has left the board.
    const next = boardNotices(book, e.session, states, now ?? undefined);
    if (next.book !== book) {
      setBook(next.book);
      if (next.fresh.length) setRing({ n: ring.n + 1, fresh: next.fresh });
    }
    const words = Object.fromEntries(states.map((s) => [s.symbol, rowView(s).badge.word]));
    const changed = states.filter((s) => last[s.symbol] !== undefined && last[s.symbol] !== words[s.symbol]);
    if (Object.keys(words).some((k) => words[k] !== last[k]) || Object.keys(last).length !== Object.keys(words).length) {
      setLast(words);
      if (changed.length) {
        // Today marked done: an entry's word is not spoken; the manage card's own notices still are.
        const said = spokenChanges(changed, words, done);
        if (said) setSpoken(said);
        const at = now ?? 0; // settled implies the live mode, which has a clock
        const add = changed.map((s): BoardLogEntry => {
          const v = rowView(s);
          return { at, symbol: s.symbol, word: v.badge.word, side: v.badge.side, tone: v.badge.tone };
        });
        const nextLog = [...add, ...log].slice(0, BOARD_LOG_MAX);
        setLog(nextLog);
        try {
          window.localStorage.setItem(LOG_KEY(e.session), JSON.stringify(nextLog));
        } catch {
          /* storage off: the log lives for this page only */
        }
      }
    }
  }
  // A notice goes with its state: once the name has left the zone (or its alternative has ended), it is withdrawn.
  // A notice whose state is off the board is kept for a moment (so a brief blip doesn't ring it again) but never
  // shown: the screen never says "enter" for a state that is not live.
  const liveKeys = new Set(states.map(noticeKey).filter((k): k is string => k !== null));
  const shown = mode.kind === "live" ? book.kept.filter((k) => liveKeys.has(noticeKey(k) ?? "")) : [];
  const manage = useTradeManage({
    items,
    session: e.session,
    halfDay,
    lots: openLots,
    closed: closedTrades,
    journalAsOf,
    // each card reads its own name's row: paused or not
    rows,
    quotes: ok ? feed.quotes : {},
    trails: ok ? feed.trails : {},
    // the same session bars the rows read: none once they are stale or a poll failed, each with its fetch time
    serverBars: used.bars,
    serverFetchedAt: used.fetchedAt,
    now,
    mode: mode.kind,
    // first shown once the bars have answered: a card read without them could flip its word, and announce it, a moment later
    barsLoading: bars.status === "loading",
    day: dayFacts,
  });

  const ranked = [...items].sort((a, b) => a.rank - b.rank);
  const managed = new Set(manage.views.map((m) => m.symbol));
  const maskFor = (symbol: string): DoneMask => {
    const row = rows.find((r) => r.symbol === symbol);
    return row ? doneMask(done, row, managed) : null;
  };
  const doneFor = (symbol: string) => maskFor(symbol) === "done";
  const board: Board = {
    on: live && items.length > 0,
    session: e.session,
    halfDay,
    items: ranked,
    ticker: (symbol) => e.tickers.find((t) => t.symbol === symbol),
    premarket: Object.fromEntries(items.map((i) => [i.symbol, e.focus?.premarket?.items.find((p) => p.symbol === i.symbol)?.price ?? null])),
    closeDate: e.built_from ?? null,
    ageS,
    mode,
    now,
    rows,
    states,
    paused,
    barsDelayed: mode.kind === "live" && used.delayed,
    barsRead: bars.status === "ok" ? { status: "ok", receivedAt: bars.receivedAt, failed: bars.failed } : { status: bars.status, receivedAt: null },
    manage,
    notices: done ? [] : shown,
    dropNotice: (s) => setBook((b) => ({ ...b, kept: b.kept.filter((x) => x !== s) })),
    log,
    spoken,
    doneFor,
    maskFor,
  };
  return <BoardContext.Provider value={board}>{children}</BoardContext.Provider>;
}

/**
 * "Trade now": one state, one sentence and one next action per focus name, from the page's board (BoardProvider).
 * Advisory and read only. Nothing is drawn for an older edition or an edition without a focus card. Its notices and
 * spoken line are TradeNowNotices, placed apart so the cockpit can hide the board and keep them.
 */
export function TradeNow() {
  const b = useBoard();
  if (!b || !b.on) return null;
  // Before the open the rail carries the board's line (status-rail.tsx).
  if (boardCollapsed(b.mode, b.manage.views.length)) return null;
  return (
    <TradeNowBoard
      mode={b.mode}
      rows={b.rows}
      now={b.now}
      paused={b.paused}
      barsDelayed={b.barsDelayed}
      onOpen={openFocusCard}
      retry={<FeedRetry />}
      facts={<FeedFacts where="board" symbols={b.items.map((i) => i.symbol)} />}
      rowExtra={b.manage.rowExtra}
      after={b.manage.cards}
      doneFor={b.doneFor}
      maskFor={b.maskFor}
    />
  );
}

/**
 * The board's notices (an entry, a live alternative, the manage card's SELL HALF and EXIT) and the screen-reader line
 * for each change. Rendered once on the page, outside anything the cockpit hides, and whether or not the board itself
 * is drawn (folded before the open, hidden in the cockpit).
 */
export function TradeNowNotices() {
  const b = useBoard();
  if (!b || !b.on) return null;
  return (
    <>
      <p aria-live="polite" role="status" className="sr-only">
        {b.spoken}
      </p>
      <BoardNotices notices={b.notices} onOpen={openFocusCard} onDrop={b.dropNotice} extra={b.manage.notices} />
    </>
  );
}
