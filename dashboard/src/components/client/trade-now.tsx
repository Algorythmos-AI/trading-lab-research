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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StatusBadge } from "@/components/status";
import { newYork } from "@/lib/format";
import { isHalfDay, type Options } from "@/lib/options";
import {
  boardAnnounce,
  boardMode,
  type BoardMode,
  type BoardRow,
  boardRows,
  noticeKey,
  noticeTitle,
  rowView,
  type RowView,
  type SeenStates,
} from "@/lib/trade-now";
import { type NameState, type NameStateName, serverNow } from "@/lib/trade-state";
import { cn } from "@/lib/utils";
import { useLive } from "./live-layer";
import { useBars } from "./use-bars";

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
function openFocusCard(symbol: string) {
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
function AlertButtons({ className }: { className?: string }) {
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
  const btn = "text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.6875rem] whitespace-nowrap aria-pressed:text-foreground aria-pressed:bg-muted";
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
      {blocked ? <span className="text-warn text-[0.6875rem]">Blocked in this browser</span> : null}
    </span>
  );
}

/** On a phone the two switches fold into one bell with a small menu; Esc or a click outside closes it. */
function AlertMenu() {
  const alerts = useAlerts();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (ev: PointerEvent) => {
      if (box.current && !box.current.contains(ev.target as Node)) setOpen(false);
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
        className="text-muted-foreground hover:text-foreground flex size-8 items-center justify-center rounded border"
      >
        {on ? <Bell aria-hidden className="size-4" /> : <BellOff aria-hidden className="size-4" />}
      </button>
      {open ? (
        <span id="trade-now-alerts" className="bg-popover absolute top-9 right-0 z-30 rounded-md border p-2 shadow-md">
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
    <span data-testing-tag className="text-muted-foreground bg-neutral-soft inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px text-[0.625rem] font-medium">
      <FlaskConical aria-hidden className="size-3" />
      Testing
    </span>
  );
}

function Badge({ v, paused, state }: { v: RowView; paused: boolean; state: NameStateName }) {
  const icon = paused ? Pause : v.badge.alt ? GitBranch : STATE_ICON[state];
  return (
    <StatusBadge tone={paused ? "neutral" : v.badge.tone} icon={icon} className="font-sans text-[0.625rem]">
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
        <dt className="text-muted-foreground text-[0.6875rem]">{label}</dt>
        <dd className="font-mono text-sm font-semibold sm:text-base">
          {price}
          {rest.length ? <span className="text-muted-foreground ml-1 font-sans text-[0.6875rem] font-normal whitespace-nowrap">or {rest.join(" or ")}</span> : null}
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

function Row({ row, mode, paused, onOpen }: { row: BoardRow; mode: BoardMode; paused: boolean; onOpen: (s: string) => void }) {
  const s = row.state;
  const base = "hover:bg-muted/60 w-full rounded px-2 py-1.5 text-left text-[0.8125rem]";
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
                <StatusBadge key={c.id} tone="warn" icon={TriangleAlert} className="font-sans text-[0.625rem]">
                  <span title={c.why}>{c.word}</span>
                </StatusBadge>
              ))}
              {s.moreCautions ? <span className="text-muted-foreground text-[0.6875rem]">+{s.moreCautions} more</span> : null}
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
    </li>
  );
}

/**
 * The board as drawn from what it was given: the header, the line for a mode without states, and one row per name.
 * Separate from the live wiring so it can be drawn in a test.
 */
export function TradeNowBoard({
  mode,
  rows,
  now,
  paused,
  onOpen,
  switches,
}: {
  mode: BoardMode;
  rows: BoardRow[];
  /** The board's clock, ms; null before the browser has read it. */
  now: number | null;
  paused: boolean;
  onOpen: (symbol: string) => void;
  switches?: React.ReactNode;
}) {
  const showRows = mode.kind !== "old" && mode.kind !== "off";
  const status = mode.kind === "live" ? (paused ? "paused" : "live") : mode.kind === "loading" ? "connecting" : mode.kind === "off" ? "off" : "waiting";
  return (
    <section aria-labelledby="trade-now-title" data-trade-now={mode.kind} data-board-status={status} className="bg-card grid gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="trade-now-title" className="flex items-center gap-2 text-sm font-semibold">
            <Zap aria-hidden className="text-muted-foreground size-4" />
            Trade now
          </h2>
          {now !== null ? (
            <span className="text-muted-foreground flex items-center gap-1 font-mono text-[0.6875rem]">
              <Clock aria-hidden className="size-3" />
              {newYork(new Date(now).toISOString(), false)} New York
            </span>
          ) : null}
          {mode.kind === "live" ? (
            <span className={cn("flex items-center gap-1 text-[0.6875rem] font-medium", paused ? "text-warn" : "text-good")}>
              {paused ? <CircleDashed aria-hidden className="size-3" /> : <span aria-hidden className="bg-good-fill inline-block size-2 rounded-full motion-safe:animate-pulse" />}
              {paused ? "paused" : "live"}
            </span>
          ) : null}
          <Link href="/strategies" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[0.6875rem] underline-offset-4 hover:underline">
            <FlaskConical aria-hidden className="size-3" />
            Testing · not proven yet
            <ChevronRight aria-hidden className="size-3" />
          </Link>
        </div>
        {showRows ? switches : null}
      </div>
      {mode.kind !== "live" ? (
        <p data-board-line className={cn("text-[0.8125rem]", mode.kind === "off" || mode.kind === "old" ? "text-muted-foreground" : "font-medium")}>
          {mode.line}
        </p>
      ) : paused ? (
        <p data-board-line className="text-warn text-[0.8125rem] font-medium">
          Prices paused: no entry is shown on old prices. Check your platform.
        </p>
      ) : null}
      {showRows && rows.length ? (
        <ul className="grid gap-1" aria-label="Focus names, most urgent first">
          {rows.map((r) => (
            <Row key={r.symbol} row={r} mode={mode} paused={paused} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
      <p className="text-muted-foreground text-[0.6875rem]">Advisory states from the study under test; the 9 rules are unchanged. Read only: nothing here places an order.</p>
    </section>
  );
}

// ---- notices -------------------------------------------------------------------------------------------------------
/** At most this many notices at once on a wide screen; one on a phone. */
export const NOTICES_WIDE = 2;

/**
 * Where the notices sit: the top of the screen under the sticky header, but never over the board. While the board is
 * on screen they sit just below it. Read on scroll and resize.
 */
function useNoticeTop(): number {
  const [top, setTop] = useState(12);
  useEffect(() => {
    const read = () => {
      const header = document.querySelector("header");
      const hb = header && getComputedStyle(header).position === "sticky" ? header.getBoundingClientRect().bottom : 0;
      const board = document.querySelector("[data-trade-now]")?.getBoundingClientRect();
      const below = board && board.bottom > 0 ? board.bottom : 0;
      setTop(Math.round(Math.max(hb, below, 0) + 12));
    };
    read();
    window.addEventListener("scroll", read, { passive: true });
    window.addEventListener("resize", read);
    const id = window.setInterval(read, 1_000); // the board grows and shrinks as states change
    return () => {
      window.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
      window.clearInterval(id);
    };
  }, []);
  return top;
}

function BoardNotices({ notices, onOpen, onDrop }: { notices: NameState[]; onOpen: (s: string) => void; onDrop: (s: NameState) => void }) {
  const top = useNoticeTop();
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
            <p className="text-muted-foreground mt-0.5 text-[0.6875rem]">Advisory: confirm on your chart.</p>
          </div>
          <button
            type="button"
            aria-label={`Dismiss the notice for ${s.symbol}`}
            onClick={() => onDrop(s)}
            className="text-muted-foreground hover:text-foreground -m-1 flex size-7 shrink-0 items-center justify-center rounded"
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
          className="text-foreground mt-1.5 rounded border px-2 py-1 text-xs font-medium"
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
      // On a phone the stack sits in the page's flow straight under the board, so it can never cover it; from sm up it is
      // fixed at the top right, under the sticky header and clear of the board (useNoticeTop).
      style={{ ["--notice-top" as string]: `${top}px` }}
      className="z-40 mt-2 flex flex-col gap-2 sm:pointer-events-none sm:fixed sm:top-[var(--notice-top)] sm:right-3 sm:left-auto sm:mt-0 sm:w-[22rem]"
    >
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
/**
 * "Trade now" at the top of the Options desk: one state, one sentence and one next action per focus name, worked out
 * in the browser from the focus card's levels, the live quotes and the session's 2-minute bars. Advisory and read
 * only. Nothing is drawn for an older edition or an edition without a focus card.
 */
export function TradeNow({ e, live, dayLimitUsed, wonToday }: { e: Options; live: boolean; dayLimitUsed: boolean; wonToday: boolean | null }) {
  const { feed, now: browserNow } = useLive();
  const items = e.focus?.items ?? [];
  const symbols = [...items].sort((a, b) => a.rank - b.rank).map((i) => i.symbol).join(",");
  const halfDay = isHalfDay(e);
  const ok = feed.status === "ok";
  // Every time on the board is the feed's (server) clock; the browser's only until the feed has answered.
  const now = browserNow === null ? null : serverNow(ok ? feed.asOf : null, ok ? feed.receivedAt : null, browserNow).getTime();
  const answeredAt = ok && Number.isFinite(Date.parse(feed.asOf)) ? Date.parse(feed.asOf) : null;
  const mode: BoardMode = now === null ? { kind: "loading", line: "Connecting to live prices" } : boardMode(e.session, halfDay, feed.status, now);
  const newest = ok ? Math.max(0, ...items.map((i) => Date.parse(feed.quotes[i.symbol]?.at ?? "") || 0)) : 0;
  const bars = useBars(symbols, live && items.length > 0 && (mode.kind === "live" || mode.kind === "opening"), newest > 0 ? Math.floor(newest / 120_000) : null);
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
            serverBars: bars.status === "ok" ? bars.bars : {},
            now,
            receivedAt: answeredAt,
            dayLimitUsed,
            wonToday,
          },
          mode.kind === "live",
        );
  const states = rows.map((r) => r.state).filter((s): s is NameState => s !== null);
  const paused = mode.kind === "live" && states.length > 0 && states.every((s) => s.state === "paused");

  // Notices: states seen once the bars have answered; what was there when the page opened is not announced.
  const alerts = useAlerts();
  const [seen, setSeen] = useState<SeenStates | null>(null);
  const [kept, setKept] = useState<NameState[]>([]);
  const [spoken, setSpoken] = useState("");
  const [last, setLast] = useState<Record<string, string>>({});
  const [ring, setRing] = useState<{ n: number; fresh: NameState[] }>({ n: 0, fresh: [] });
  useEffect(() => {
    if (ring.n === 0) return;
    if (alerts.sound) beep();
    if (alerts.notify) ring.fresh.forEach(systemNotice);
    // Only a new ring sounds: a change of the switches alone must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ring.n]);
  const settled = mode.kind === "live" && bars.status !== "loading";
  if (settled) {
    const next = boardAnnounce(seen, e.session, states);
    if (next.seen !== seen) {
      setSeen(next.seen);
      if (next.fresh.length) {
        setKept([...next.fresh, ...kept.filter((k) => !next.fresh.some((f) => f.symbol === k.symbol))]);
        setRing({ n: ring.n + 1, fresh: next.fresh });
      }
    }
    const words = Object.fromEntries(states.map((s) => [s.symbol, rowView(s).badge.word]));
    const changed = states.filter((s) => last[s.symbol] !== undefined && last[s.symbol] !== words[s.symbol]);
    if (Object.keys(words).some((k) => words[k] !== last[k]) || Object.keys(last).length !== Object.keys(words).length) {
      setLast(words);
      if (changed.length) setSpoken(changed.map((s) => `${s.symbol} ${words[s.symbol]!.toLowerCase()}`).join("; "));
    }
  }
  // A notice goes with its state: once the name has left the zone (or its alternative has ended), it is withdrawn.
  const liveKeys = new Set(states.map(noticeKey));
  const shown = mode.kind === "live" ? kept.filter((k) => liveKeys.has(noticeKey(k))) : [];

  if (!live || items.length === 0) return null;
  return (
    <>
      <TradeNowBoard
        mode={mode}
        rows={rows}
        now={now}
        paused={paused}
        onOpen={openFocusCard}
        switches={
          <>
            <AlertButtons className="hidden sm:flex" />
            <AlertMenu />
          </>
        }
      />
      <p aria-live="polite" role="status" className="sr-only">
        {spoken}
      </p>
      <BoardNotices notices={shown} onOpen={openFocusCard} onDrop={(s) => setKept((all) => all.filter((x) => x !== s))} />
    </>
  );
}
