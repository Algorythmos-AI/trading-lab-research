"use client";

import { Activity, CircleCheck, Hand, type LucideIcon, NotebookPen, OctagonX, Shield, TriangleAlert, X } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import { StatusBadge } from "@/components/status";
import { newYork } from "@/lib/format";
import type { Lot } from "@/lib/journal";
import type { LiveQuote, Options, TrailPoint } from "@/lib/options";
import {
  ACTION_WORD,
  altPlan,
  checkFill,
  type ManageAction,
  type ManageView,
  manageView,
  type ManualNote,
  NOTE_PREFIX,
  noteKey,
  openTrades,
  parseNotes,
} from "@/lib/trade-manage";
import type { BoardRow } from "@/lib/trade-now";
import { focusPlan } from "@/lib/focus-plan";
import { nyClock } from "@/lib/options";
import type { Bar2 } from "@/lib/trade-state";
import { cn } from "@/lib/utils";
import { TestingTag } from "./trade-now";

type Item = NonNullable<Options["focus"]>["items"][number];

const ACTION_ICON: Record<ManageAction, LucideIcon> = {
  exit: OctagonX,
  sell_half: CircleCheck,
  trail: Activity,
  hold: Shield,
  check: TriangleAlert,
};

const TONE_LINE = {
  bad: "text-bad",
  good: "text-good",
  warn: "text-warn",
  info: "text-foreground",
  neutral: "text-foreground",
} as const;

// ---- the owner's notes, kept in this browser ------------------------------------------------------------------------
const NOTES_EVENT = "trade-now-in";
/** Used only when the browser's storage is off or throws: the notes then last as long as the page. */
const fallback = new Map<string, string>();

export function readNotes(day: string): string {
  try {
    return window.localStorage.getItem(noteKey(day)) ?? fallback.get(day) ?? "";
  } catch {
    return fallback.get(day) ?? "";
  }
}

/** Save a day's notes, and drop every other day's: a note never outlives its session. */
export function writeNotes(day: string, notes: readonly ManualNote[]) {
  const raw = JSON.stringify(notes);
  try {
    const ls = window.localStorage;
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k && k.startsWith(NOTE_PREFIX) && k !== noteKey(day)) ls.removeItem(k);
    }
    if (notes.length) ls.setItem(noteKey(day), raw);
    else ls.removeItem(noteKey(day));
    fallback.delete(day);
  } catch {
    if (notes.length) fallback.set(day, raw);
    else fallback.delete(day);
  }
  for (const k of [...fallback.keys()]) if (k !== day) fallback.delete(k);
  window.dispatchEvent(new Event(NOTES_EVENT));
}

function subscribeNotes(onChange: () => void) {
  window.addEventListener(NOTES_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(NOTES_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function useNotes(day: string | null): ManualNote[] {
  const raw = useSyncExternalStore(
    subscribeNotes,
    () => (day ? readNotes(day) : ""),
    () => "",
  );
  return parseNotes(raw);
}

// ---- the card as drawn ----------------------------------------------------------------------------------------------
function Cell({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground truncate text-[0.6875rem]">{label}</dt>
      <dd className={cn("font-mono text-sm font-semibold sm:text-base", tone)}>
        {value}
        {note ? <span className="text-muted-foreground ml-1 font-sans text-[0.6875rem] font-normal">{note}</span> : null}
      </dd>
    </div>
  );
}

/** One open trade: the header, one instruction line, then the stop, the trail, the 5-minute check and the flat time. */
export function ManageCard({ v, onClear }: { v: ManageView; onClear?: () => void }) {
  const Icon = ACTION_ICON[v.action];
  const exit = v.action === "exit";
  return (
    <article
      aria-label={`In a trade: ${v.symbol} ${v.side}`}
      data-manage={v.symbol}
      data-manage-action={v.action}
      data-manage-source={v.source}
      className={cn("grid gap-2 rounded-md border px-3 py-2", exit ? "bg-bad-soft border-bad-fill/60" : "bg-muted/40")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold">
          <Hand aria-hidden className="text-muted-foreground size-3.5" />
          In a trade · {v.symbol} {v.side}
          {v.kind !== "plan" ? <TestingTag /> : null}
        </h3>
        <span className="text-muted-foreground flex items-center gap-2 text-[0.6875rem]">
          {v.source === "journal" ? (
            <span>From your Webull fills, up to 2 min behind; price levels from the card</span>
          ) : (
            <>
              <span className="flex items-center gap-1">
                <NotebookPen aria-hidden className="size-3" />
                Your own note in this browser
              </span>
              {onClear ? (
                <button type="button" onClick={onClear} className="hover:text-foreground flex items-center gap-1 rounded border px-1.5 py-0.5">
                  <X aria-hidden className="size-3" />
                  Clear
                </button>
              ) : null}
            </>
          )}
        </span>
      </div>
      <p data-manage-line className={cn("flex flex-wrap items-center gap-2 text-base leading-snug font-semibold", TONE_LINE[v.tone])}>
        <StatusBadge tone={v.tone} icon={Icon} className="font-sans text-[0.625rem]">
          {ACTION_WORD[v.action]}
        </StatusBadge>
        <span>{v.line}</span>
      </p>
      <dl className="grid max-w-xl grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4" data-manage-grid>
        <Cell label="Stop" value={v.m.stop !== null ? v.m.stop.toFixed(2) : "–"} />
        <Cell label="Trail (EMA9)" value={v.m.trail !== null ? v.trailText : "–"} note={v.m.trail !== null ? undefined : v.trailText} />
        <Cell label="Not working in" value={v.notWorkingText} tone={v.notWorkingText === "now" ? "text-bad" : undefined} />
        <Cell label={`Flat by ${v.flatAt}`} value={v.flatText} />
      </dl>
    </article>
  );
}

/** The inline "I'm in" form: the side as given, the fill price (the live price to start), the time now. */
export function ImInForm({
  symbol,
  side,
  live,
  now,
  onSave,
  onCancel,
}: {
  symbol: string;
  side: "call" | "put";
  live: number | null;
  /** The feed's clock, ms. */
  now: number;
  onSave: (price: number) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState(live !== null ? live.toFixed(2) : "");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const r = checkFill(typed, live);
    if (!r.ok) return setError(r.error);
    setError(null);
    onSave(r.price);
  };
  return (
    <form
      data-im-in-form={symbol}
      aria-label={`Note your ${symbol} ${side} fill`}
      onSubmit={(ev) => {
        ev.preventDefault();
        save();
      }}
      className="bg-card grid gap-1.5 rounded border p-2 text-xs"
    >
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5">
        <span className="grid gap-0.5">
          <span className="text-muted-foreground text-[0.6875rem]">Side</span>
          <span className="font-semibold">
            {symbol} {side}
          </span>
        </span>
        <label className="grid gap-0.5" htmlFor={`${id}-px`}>
          <span className="text-muted-foreground text-[0.6875rem]">{symbol} price at your fill</span>
          <input
            id={`${id}-px`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={typed}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-err` : undefined}
            onChange={(ev) => setTyped(ev.target.value)}
            className={cn("bg-background h-8 w-28 rounded border px-2 font-mono text-[0.8125rem]", error && "border-bad-fill")}
          />
        </label>
        <span className="grid gap-0.5">
          <span className="text-muted-foreground text-[0.6875rem]">Time</span>
          <span className="font-mono">{newYork(new Date(now).toISOString(), false)} New York</span>
        </span>
        <span className="flex gap-1.5">
          <button type="submit" className="bg-primary text-primary-foreground rounded px-2.5 py-1 font-medium">
            Save note
          </button>
          <button type="button" onClick={onCancel} className="rounded border px-2.5 py-1">
            Cancel
          </button>
        </span>
      </div>
      {error ? (
        <p id={`${id}-err`} role="alert" className="text-bad flex items-center gap-1">
          <TriangleAlert aria-hidden className="size-3.5" />
          {error}
        </p>
      ) : null}
      <p className="text-muted-foreground text-[0.6875rem]">Your own note in this browser, to manage the trade here. Nothing is sent anywhere.</p>
    </form>
  );
}

// ---- the board's hook-in --------------------------------------------------------------------------------------------
export interface ManageNotice {
  id: string;
  symbol: string;
  title: string;
  line: string;
  tone: ManageView["tone"];
}

export interface TradeManageInput {
  items: readonly Item[];
  session: string;
  halfDay: boolean;
  /** The journal's open lots (`sessionView(journal).open`); empty without a journal. */
  lots: readonly Lot[];
  quotes: Readonly<Record<string, LiveQuote>>;
  trails: Readonly<Record<string, readonly TrailPoint[]>>;
  serverBars: Readonly<Record<string, readonly Bar2[]>>;
  /** When the server read each name's bars (ms, the server's clock); a name without one uses no server bar. */
  serverFetchedAt: Readonly<Record<string, number>>;
  /** The feed's (server) clock, ms; null before the browser has read it. */
  now: number | null;
  /** The board is in its live mode. */
  live: boolean;
  paused: boolean;
}

/**
 * The manage card for the board: the cards to draw under its rows, the "I'm in" control for an entry row (or a live
 * alternative), and the notices for when a card's instruction changes. Shown only in the board's live mode.
 */
export function useTradeManage(x: TradeManageInput): {
  cards: React.ReactNode;
  rowExtra: (row: BoardRow, paused: boolean) => React.ReactNode;
  notices: React.ReactNode;
} {
  const day = x.now !== null ? (nyClock(new Date(x.now).toISOString())?.day ?? null) : null;
  const today = day === x.session ? day : null;
  const notes = useNotes(today);
  const [formFor, setFormFor] = useState<string | null>(null);
  const [last, setLast] = useState<Record<string, ManageAction>>({});
  const [notices, setNotices] = useState<ManageNotice[]>([]);

  const views =
    x.live && x.now !== null && today
      ? openTrades(x.items, x.lots, notes, x.session).map((t) =>
          manageView(t, {
            session: x.session,
            halfDay: x.halfDay,
            quote: x.quotes[t.symbol] ?? null,
            trail: x.trails[t.symbol] ?? [],
            serverBars: x.serverBars[t.symbol] ?? [],
            serverFetchedAt: x.serverFetchedAt[t.symbol] ?? null,
            now: x.now!,
            paused: x.paused,
          }),
        )
      : [];

  // A notice once a card's instruction changes to another word; the first one seen is not announced.
  const sig = views.map((v) => `${v.key}=${v.action}`).join(",");
  // Worked out while rendering, as the board does its notices (a state from the last render, not an effect).
  const [seenSig, setSeenSig] = useState("");
  if (sig !== seenSig) {
    setSeenSig(sig);
    const next: Record<string, ManageAction> = {};
    const fresh: ManageNotice[] = [];
    for (const v of views) {
      next[v.key] = v.action;
      if (last[v.key] !== undefined && last[v.key] !== v.action)
        fresh.push({ id: `${v.key}:${v.action}:${sig}`, symbol: v.symbol, title: `${v.symbol} ${v.side}: ${ACTION_WORD[v.action]}`, line: v.line, tone: v.tone });
    }
    setLast(next);
    if (fresh.length) setNotices([...fresh, ...notices.filter((n) => !fresh.some((f) => f.symbol === n.symbol))]);
  }

  const save = (notesNow: ManualNote[]) => {
    if (today) writeNotes(today, notesNow);
  };
  const clear = (symbol: string) => save(notes.filter((n) => n.symbol !== symbol));

  const rowExtra = (row: BoardRow, paused: boolean): React.ReactNode => {
    const s = row.state;
    if (!s || paused || !today || x.now === null) return null;
    const alt = s.alt && (s.state === "plan_off" || s.state === "watch" || s.state === "missed") ? s.alt : null;
    const entry = s.state === "enter_zone" && s.side ? s.side : null;
    if (!entry && !alt) return null;
    if (notes.some((n) => n.symbol === row.symbol)) return <p className="text-muted-foreground text-xs">Noted: see In a trade below.</p>;
    const side = entry ?? alt!.side;
    if (formFor !== row.symbol)
      return (
        <button
          type="button"
          data-im-in={row.symbol}
          onClick={() => setFormFor(row.symbol)}
          className="hover:bg-muted flex w-fit items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium"
        >
          <Hand aria-hidden className="size-3.5" />
          I&apos;m in
        </button>
      );
    const item = x.items.find((i) => i.symbol === row.symbol);
    const plan = alt ? altPlan(alt) : item ? focusPlan(item)[side] : null;
    if (!plan) return null;
    return (
      <ImInForm
        symbol={row.symbol}
        side={side}
        live={row.price}
        now={x.now}
        onCancel={() => setFormFor(null)}
        onSave={(price) => {
          const note: ManualNote = { symbol: row.symbol, side, price, at: new Date(x.now!).toISOString(), kind: alt ? alt.kind : "plan", plan };
          save([...notes.filter((n) => n.symbol !== row.symbol), note]);
          setFormFor(null);
        }}
      />
    );
  };

  const cards = views.length ? (
    <div className="grid gap-2" data-manage-cards={views.length}>
      {views.map((v) => (
        <ManageCard key={v.key} v={v} onClear={v.source === "manual" ? () => clear(v.symbol) : undefined} />
      ))}
    </div>
  ) : null;

  const live = new Set(views.map((v) => v.symbol));
  const shown = notices.filter((n) => live.has(n.symbol));
  const noticeEls = shown.length
    ? shown.slice(0, 1).map((n) => (
        <div key={n.id} data-manage-notice={n.symbol} role="status" className="bg-popover text-popover-foreground pointer-events-auto rounded-md border p-2.5 text-xs shadow-md">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className={cn("text-[0.8125rem] font-medium", TONE_LINE[n.tone])}>{n.title}</p>
              <p className="mt-0.5">{n.line}</p>
              <p className="text-muted-foreground mt-0.5 text-[0.6875rem]">Advisory: confirm on your chart.</p>
            </div>
            <button
              type="button"
              aria-label={`Dismiss the ${n.symbol} trade notice`}
              onClick={() => setNotices((all) => all.filter((y) => y.id !== n.id))}
              className="text-muted-foreground hover:text-foreground -m-1 flex size-7 shrink-0 items-center justify-center rounded"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      ))
    : null;

  return { cards, rowExtra, notices: noticeEls };
}
