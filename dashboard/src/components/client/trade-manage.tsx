"use client";

import { Activity, CircleCheck, Hand, type LucideIcon, NotebookPen, OctagonX, Shield, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { Lot, Trade } from "@/lib/journal";
import type { LiveQuote, Options, TrailPoint } from "@/lib/options";
import {
  ACTION_WORD,
  CARD_ENTRY,
  cardFeed,
  checkFill,
  checkFillTime,
  type FormCapture,
  formFromRow,
  formFromTrade,
  formMovedOn,
  type ManageAction,
  type ManageNotice,
  manageNotices,
  type ManageView,
  manageView,
  type ManualNote,
  mergeNotices,
  movedOnLine,
  NOTE_PREFIX,
  noteFromForm,
  noteId,
  noteKey,
  openTrades,
  parseNotes,
  retiredNotes,
  shownNotices,
} from "@/lib/trade-manage";
import type { BoardRow } from "@/lib/trade-now";
import { nyClock } from "@/lib/options";
import type { Bar2 } from "@/lib/trade-state";
import { cn } from "@/lib/utils";
import { bellMinute } from "@/lib/contract";
import { chainFresh, chainPx, chainStamp, entryStopDistance, fromEntryLabel, heldOrAtm, lossFromEntry, stopDistance } from "@/lib/what-if";
import { TestingTag } from "./trade-now";
import { useChain } from "./use-chain";
import { usePerfNow } from "./use-now";

type Item = NonNullable<Options["focus"]>["items"][number];

const ACTION_ICON: Record<ManageAction, LucideIcon> = {
  exit: OctagonX,
  sell_half: CircleCheck,
  trail: Activity,
  hold: Shield,
  check: TriangleAlert,
};

/** The action word's chip: the word in the page's text colour, the tone in the tint and the bar (as the hero's). */
const WORD_CHIP = {
  bad: "bg-bad-soft border-bad-fill",
  good: "bg-good-soft border-good-fill",
  warn: "bg-warn-soft border-warn-fill",
  info: "bg-info-soft border-info-fill",
  neutral: "bg-neutral-soft border-neutral-fill",
} as const;

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
/** One small figure: the trail, the flat-by time. */
function Small({ label, value, note, tone, data }: { label: string; value: string; note?: string; tone?: string; data?: string }) {
  return (
    <div className="min-w-0" data-manage-small={data}>
      <dt className="text-muted-foreground truncate text-[0.6875rem]">{label}</dt>
      <dd className={cn("text-explain font-mono font-semibold", tone)}>
        {value}
        {note ? <span className="text-muted-foreground ml-1 font-sans text-[0.6875rem] font-normal">{note}</span> : null}
      </dd>
    </div>
  );
}

/** One big figure: the stop, the distance to it, the countdown. */
function Big({ label, value, size, note, tone, data }: { label: string; value: string; size: "price" | "live"; note?: string; tone?: string; data?: string }) {
  return (
    <div className="min-w-0" data-manage-big={data}>
      <dt className="text-explain text-muted-foreground truncate font-medium">{label}</dt>
      <dd className={cn("font-mono tabular-nums", size === "price" ? "text-price" : "text-live", tone)}>{value}</dd>
      {note ? <dd className="text-muted-foreground text-[0.6875rem]">{note}</dd> : null}
    </div>
  );
}

/** What the card needs to read an option chain for its estimate: the name's close and the board's clock and session. */
export interface ChainContext {
  close: number | null;
  /** The board's (server) clock, ms. */
  now: number | null;
  session: string;
  halfDay: boolean;
}

/**
 * The option's estimated loss if the stop is hit: |delta| × |entry − stop| × 100 (what-if's lossFromEntry), measured
 * from the trade's entry and not from the live price, so it says what the stop costs the trade and agrees with the
 * hero's which-stop line, which measures the same way. The delta is the held contract's (the journal names it) or,
 * failing that, the at-the-money one on that side. One chain for this card's name, asked for only while the card has a
 * fresh price and is not a CHECK; shown only on this name's answer no older than STALE_SAME_DAY_MIN, labelled with
 * the chain's own time and delay. Nothing once the stop is the entry, or with a stop on the wrong side of it.
 */
function OptionAtStop({ v, ctx }: { v: ManageView; ctx: ChainContext }) {
  const perfNow = usePerfNow(1_000);
  const on = v.action !== "check" && v.price !== null && ctx.now !== null && entryStopDistance(v.side, v.entry, v.m.stop) !== null;
  const keep = v.contract ? `${v.contract.expiry}:${v.contract.strike}` : "";
  const { feed } = useChain(v.symbol, on ? chainPx(ctx.close, v.price) : null, on, keep);
  if (!on || feed.status !== "ok" || feed.chain.symbol !== v.symbol || !chainFresh(feed.chain, feed.receivedPerf, perfNow)) return null;
  const c = heldOrAtm(feed.chain, v.side, v.contract, v.price!, ctx.now!, (x) => bellMinute(x, ctx.session, ctx.halfDay));
  const est = lossFromEntry(v.side, v.entry, v.m.stop, c?.contract.delta);
  if (!c || est === null) return null;
  return (
    <div className="min-w-0" data-manage-big="option" data-manage-option={c.held ? "held" : "atm"}>
      <dt className="text-explain text-muted-foreground truncate font-medium">{fromEntryLabel(v.cardEntry)}</dt>
      <dd className="text-live font-mono tabular-nums">≈ −${Math.round(est)}</dd>
      <dd className="text-muted-foreground text-[0.6875rem]">
        on the option, a contract (est. from {c.held ? "your contract's" : "the at-the-money"} delta) · {chainStamp(feed.chain)}
      </dd>
    </div>
  );
}

/**
 * One open trade: the header, then big the action word, the stop, the live distance to it on the stock, the option's
 * estimated loss at the stop from the entry, and the "not working in" countdown while it runs; small the trail, the flat-by time and where the
 * card's numbers come from. No live option P&L: the option feed is 15 minutes behind, so the card says "P&L: see
 * Webull". A journal card adds a CHECK line (its fill is the card's entry) with "Set my fill"; `children` is the form
 * it opens.
 */
export function ManageCard({
  v,
  ctx,
  onClear,
  onSetFill,
  onUseTime,
  children,
}: {
  v: ManageView;
  /** For the option estimate; without it the card shows none. */
  ctx?: ChainContext;
  onClear?: () => void;
  onSetFill?: () => void;
  /** An unmatched note: take the journal lot's time offered in `v.hint`. */
  onUseTime?: () => void;
  children?: React.ReactNode;
}) {
  const Icon = ACTION_ICON[v.action];
  const exit = v.action === "exit";
  const counting = v.notWorkingText !== "working" && v.notWorkingText !== "done" && v.notWorkingText !== "–";
  // The distance to the stop: only from a fresh price, never on a CHECK card.
  const dist = v.action !== "check" && v.price !== null ? stopDistance(v.side, v.price, v.m.stop) : null;
  return (
    <article
      aria-label={`In a trade: ${v.symbol} ${v.side}`}
      data-manage={v.symbol}
      data-manage-side={v.side}
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
              {v.fillNote ? <span data-manage-fill-note>{v.fillNote}</span> : null}
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
      <p data-manage-line className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-base leading-snug font-semibold", TONE_LINE[v.tone])}>
        <span data-manage-word className={cn("text-decision text-foreground inline-flex items-center gap-2 rounded-md border border-l-[6px] px-2.5 py-0.5 whitespace-nowrap", WORD_CHIP[v.tone])}>
          <Icon aria-hidden className={cn("size-6 shrink-0", TONE_LINE[v.tone])} />
          {ACTION_WORD[v.action]}
        </span>
        <span>{v.line}</span>
      </p>
      {v.hint ? (
        <p data-manage-hint className="text-warn flex flex-wrap items-center gap-2 text-xs font-medium">
          <span>{v.hint.line}</span>
          {onUseTime ? (
            <button type="button" onClick={onUseTime} className="text-foreground hover:bg-muted rounded border px-2 py-0.5 font-medium">
              Use that time
            </button>
          ) : null}
        </p>
      ) : null}
      {v.fillLine ? (
        <p data-manage-fills className="text-warn flex flex-wrap items-center gap-2 text-xs font-medium">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          <span>{v.fillLine}</span>
          {onSetFill ? (
            <button type="button" onClick={onSetFill} className="text-foreground hover:bg-muted rounded border px-2 py-0.5 font-medium">
              Set my fill
            </button>
          ) : null}
        </p>
      ) : null}
      <dl className="grid max-w-2xl grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4" data-manage-grid>
        <Big label="Stop" value={v.m.stop !== null ? v.m.stop.toFixed(2) : "–"} size="price" note={v.cardEntry && v.stopAtEntry ? CARD_ENTRY : undefined} data="stop" />
        {dist !== null ? (
          <Big label={`${v.symbol} to the stop`} value={dist > 0 ? `$${dist.toFixed(2)}` : "at the stop"} size="live" tone={dist > 0 ? undefined : "text-bad"} data="distance" />
        ) : null}
        {ctx ? <OptionAtStop v={v} ctx={ctx} /> : null}
        {counting ? (
          <Big
            label="Not working in"
            value={v.notWorkingText}
            size="live"
            note={v.cardEntry ? CARD_ENTRY : undefined}
            tone={v.notWorkingText === "now" ? "text-bad" : undefined}
            data="not-working"
          />
        ) : null}
      </dl>
      <dl className="grid max-w-2xl grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4" data-manage-small-grid>
        <Small label="Trail (EMA9)" value={v.m.trail !== null ? v.trailText : "–"} note={v.m.trail !== null ? undefined : v.trailText} data="trail" />
        {counting ? null : <Small label="Not working in" value={v.notWorkingText} data="not-working" />}
        <Small label={`Flat by ${v.flatAt}`} value={v.flatText} data="flat" />
        <Small label="P&L" value="see Webull" data="pnl" />
      </dl>
      {children}
    </article>
  );
}

/**
 * The inline "I'm in" form: the side, trigger and levels as captured when it opened (`f`), the fill price (the live
 * price to start) and the fill time (HH:MM New York, the minute it opened to start). `movedOn` is the muted line for
 * a row that has changed since.
 */
export function ImInForm({
  f,
  live,
  now,
  session,
  halfDay,
  movedOn = null,
  onSave,
  onCancel,
}: {
  f: FormCapture;
  live: number | null;
  /** The feed's clock, ms. */
  now: number;
  session: string;
  halfDay: boolean;
  movedOn?: string | null;
  onSave: (note: ManualNote) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState(live !== null ? live.toFixed(2) : "");
  const [time, setTime] = useState(f.time);
  const [error, setError] = useState<{ field: "px" | "at"; text: string } | null>(null);
  const save = () => {
    const r = checkFill(typed, live);
    if (!r.ok) return setError({ field: "px", text: r.error });
    const t = checkFillTime(time, now, session, halfDay);
    if (!t.ok) return setError({ field: "at", text: t.error });
    setError(null);
    onSave(noteFromForm(f, r.price, t.at));
  };
  const input = "bg-background h-8 rounded border px-2 font-mono text-[0.8125rem]";
  return (
    <form
      data-im-in-form={f.symbol}
      data-im-in-side={f.side}
      aria-label={`Note your ${f.symbol} ${f.side} fill`}
      onSubmit={(ev) => {
        ev.preventDefault();
        save();
      }}
      className="bg-card grid gap-1.5 rounded border p-2 text-xs"
    >
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5">
        <span className="grid gap-0.5">
          <span className="text-muted-foreground text-[0.6875rem]">Side</span>
          <span className="flex items-center gap-1 font-semibold">
            {f.symbol} {f.side}
            {f.kind !== "plan" ? <TestingTag /> : null}
          </span>
        </span>
        <label className="grid gap-0.5" htmlFor={`${id}-px`}>
          <span className="text-muted-foreground text-[0.6875rem]">{f.symbol} price at your fill</span>
          <input
            id={`${id}-px`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={typed}
            aria-invalid={error?.field === "px" ? true : undefined}
            aria-describedby={error?.field === "px" ? `${id}-err` : undefined}
            onChange={(ev) => setTyped(ev.target.value)}
            className={cn(input, "w-28", error?.field === "px" && "border-bad-fill")}
          />
        </label>
        <label className="grid gap-0.5" htmlFor={`${id}-at`}>
          <span className="text-muted-foreground text-[0.6875rem]">Filled at (New York, to the minute)</span>
          <input
            id={`${id}-at`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="HH:MM"
            value={time}
            aria-invalid={error?.field === "at" ? true : undefined}
            aria-describedby={error?.field === "at" ? `${id}-err` : undefined}
            onChange={(ev) => setTime(ev.target.value)}
            className={cn(input, "w-20", error?.field === "at" && "border-bad-fill")}
          />
        </label>
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
          {error.text}
        </p>
      ) : null}
      {movedOn ? (
        <p data-im-in-moved className="text-muted-foreground text-[0.6875rem]">
          {movedOn}
        </p>
      ) : null}
      <p className="text-muted-foreground text-[0.6875rem]">Your own note in this browser, to manage the trade here. Nothing is sent anywhere.</p>
    </form>
  );
}

// ---- the board's hook-in --------------------------------------------------------------------------------------------
export interface TradeManageInput {
  items: readonly Item[];
  session: string;
  halfDay: boolean;
  /** The journal's open lots as it has them, one per fill (`doc.open`, not merged); empty without a journal. */
  lots: readonly Lot[];
  /** The journal's closed trades (`doc.trades`): a note whose own trade has closed is retired. */
  closed: readonly Trade[];
  /** When the journal was read (`doc.as_of`): a lot with no opening time counts only when that is today. */
  journalAsOf: string | null;
  /** The board's rows: each card reads its own name's state (paused or not). */
  rows: readonly BoardRow[];
  quotes: Readonly<Record<string, LiveQuote>>;
  trails: Readonly<Record<string, readonly TrailPoint[]>>;
  serverBars: Readonly<Record<string, readonly Bar2[]>>;
  /** When the server read each name's bars (ms, the server's clock); a name without one uses no server bar. */
  serverFetchedAt: Readonly<Record<string, number>>;
  /** The feed's (server) clock, ms; null before the browser has read it. */
  now: number | null;
  /** The board's mode (BoardMode["kind"]). */
  mode: string;
  /** The server's bars have not answered yet. */
  barsLoading: boolean;
}

/**
 * The manage card for the board: the cards to draw under its rows, the "I'm in" control for an entry row (or a live
 * alternative), and the notices for when a card's instruction changes. The cards show in the board's live mode, and
 * stay (saying CHECK) while the feed is off or reconnecting after it.
 */
export function useTradeManage(x: TradeManageInput): {
  cards: React.ReactNode;
  rowExtra: (row: BoardRow, paused: boolean) => React.ReactNode;
  notices: React.ReactNode;
  /** Each open trade's name, side and action, for the page's hero. */
  views: readonly ManageView[];
} {
  const day = x.now !== null ? (nyClock(new Date(x.now).toISOString())?.day ?? null) : null;
  const today = day === x.session ? day : null;
  const notes = useNotes(today);
  const [form, setForm] = useState<FormCapture | null>(null);
  const [last, setLast] = useState<Record<string, ManageAction>>({});
  const [notices, setNotices] = useState<ManageNotice[]>([]);
  const [wasLive, setWasLive] = useState(false);
  const [seq, setSeq] = useState(0);

  const feed = today && x.now !== null ? cardFeed(x.mode, x.barsLoading, wasLive) : null;
  if (feed === "live" && !wasLive) setWasLive(true);
  const rowOf = (symbol: string) => x.rows.find((r) => r.symbol === symbol);
  const trades = feed ? openTrades(x.items, x.lots, notes, x.session, x.closed, x.journalAsOf) : [];
  const views = trades.map((t) =>
    manageView(t, {
      session: x.session,
      halfDay: x.halfDay,
      quote: feed === "live" ? (x.quotes[t.symbol] ?? null) : null,
      trail: feed === "live" ? (x.trails[t.symbol] ?? []) : [],
      serverBars: x.serverBars[t.symbol] ?? [],
      serverFetchedAt: x.serverFetchedAt[t.symbol] ?? null,
      now: x.now!,
      rowState: rowOf(t.symbol)?.state?.state ?? null,
      feed: feed!,
    }),
  );

  // The notes the journal has closed out leave this browser (their cards are already gone).
  const retire = today ? retiredNotes(notes, x.lots, x.closed, x.session, x.journalAsOf) : [];
  const retireSig = retire.map(noteId).join(",");
  useEffect(() => {
    if (!today || !retireSig) return;
    const gone = new Set(retireSig.split(","));
    writeNotes(today, parseNotes(readNotes(today)).filter((n) => !gone.has(noteId(n))));
  }, [today, retireSig]);

  // A notice once a card's word changes (CHECK aside); worked out while rendering, as the board does its notices.
  const sig = views.map((v) => `${v.id}=${v.action}`).join(",");
  const [seenSig, setSeenSig] = useState("");
  if (sig !== seenSig) {
    setSeenSig(sig);
    const r = manageNotices(last, views, seq);
    setLast(r.last);
    if (r.fresh.length) {
      setSeq(seq + 1);
      setNotices(mergeNotices(notices, r.fresh));
    }
  }

  const save = (notesNow: ManualNote[]) => {
    if (today) writeNotes(today, notesNow);
  };
  const add = (note: ManualNote) => {
    save([...notes.filter((n) => noteId(n) !== noteId(note)), note]);
    setForm(null);
  };

  const formEl = (f: FormCapture, live: number | null, movedOn: string | null) => (
    <ImInForm
      key={`${f.symbol}|${f.side}|${f.origin}`}
      f={f}
      live={live}
      now={x.now!}
      session={x.session}
      halfDay={x.halfDay}
      movedOn={movedOn}
      onCancel={() => setForm(null)}
      onSave={add}
    />
  );

  const rowExtra = (row: BoardRow, paused: boolean): React.ReactNode => {
    if (!today || x.now === null) return null;
    const item = x.items.find((i) => i.symbol === row.symbol);
    // An open form stays as it was opened, whatever the row does next.
    if (form && form.origin === "row" && form.symbol === row.symbol) return formEl(form, row.price, formMovedOn(form, row.state, item) ? movedOnLine(form) : null);
    if (paused || feed !== "live") return null;
    const offer = formFromRow(row.symbol, row.state, item, x.now);
    if (!offer) return null;
    if (views.some((v) => v.symbol === row.symbol && v.side === offer.side && v.source === "manual"))
      return <p className="text-muted-foreground text-xs">Noted: see In a trade below.</p>;
    return (
      <button
        type="button"
        data-im-in={row.symbol}
        onClick={() => setForm(formFromRow(row.symbol, row.state, item, x.now!))}
        className="hover:bg-muted flex w-fit items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium"
      >
        <Hand aria-hidden className="size-3.5" />
        I&apos;m in
      </button>
    );
  };

  const cards = views.length ? (
    <div className="grid gap-2" data-manage-cards={views.length}>
      {views.map((v, i) => {
        const t = trades[i]!;
        const open = form && form.origin === "card" && form.symbol === v.symbol && form.side === v.side;
        return (
          <ManageCard
            key={v.id}
            v={v}
            ctx={{ close: x.items.find((it) => it.symbol === v.symbol)?.close ?? null, now: x.now, session: x.session, halfDay: x.halfDay }}
            onClear={t.note ? () => save(notes.filter((n) => noteId(n) !== noteId(t.note!))) : undefined}
            onSetFill={v.source === "journal" && x.now !== null ? () => setForm(formFromTrade(t, x.now!)) : undefined}
            onUseTime={t.note && v.hint ? () => save([...notes.filter((n) => noteId(n) !== noteId(t.note!)), { ...t.note!, at: v.hint!.at }]) : undefined}
          >
            {open ? formEl(form, feed === "live" ? (rowOf(v.symbol)?.price ?? null) : null, null) : null}
          </ManageCard>
        );
      })}
    </div>
  ) : null;

  const shown = shownNotices(notices, views);
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

  return { cards, rowExtra, notices: noticeEls, views };
}
