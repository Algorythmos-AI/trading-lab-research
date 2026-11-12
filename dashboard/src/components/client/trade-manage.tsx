"use client";

import { Activity, CircleCheck, Hand, type LucideIcon, NotebookPen, OctagonX, Shield, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
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
  type OptionFill,
  movedOnLine,
  NOTE_PREFIX,
  noteFromForm,
  noteId,
  noteKey,
  type OpenTrade,
  parseNotes,
  shownNotices,
} from "@/lib/trade-manage";
import type { BoardRow } from "@/lib/trade-now";
import { nyClock } from "@/lib/options";
import type { Bar2 } from "@/lib/trade-state";
import { cn } from "@/lib/utils";
import { bellMinute } from "@/lib/contract";
import { chainFresh, chainPx, chainStamp, contractQuoteTime, entryStopDistance, fromEntryLabel, heldOrAtm, lossFromEntry, type RoomAfterStop, roomAfterStop, stopDistance } from "@/lib/what-if";
import { checkOptionFill, type FillStop, fillStop, INVITE_LINE, journalDayCache, lossLine, nickelLine, prefillFrom, otherOpenPositions, STOP_OWN_TICK, STOP_PLACED, STOP_REMINDER, stopFromLine, tickLine } from "@/lib/manage-stop";
import { type DayFacts, journalLive } from "@/lib/session-timeline";
import { heldContract, heldLines, heldValue, judgeQuote, lotsContract, notAvailable, quoteLine } from "@/lib/option-value";
import { usd } from "@/lib/ticket";
import { ticketPrice } from "./ticket-memo";
import { TestingTag } from "./trade-now";
import { type ChainFeed, useChain } from "./use-chain";
import { useContractQuote } from "./use-contract-quote";
import { useNow, usePerfNow } from "./use-now";

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
  // Parsed once per change of what is stored: the board renders every second, and a new array each time would make
  // the journal's side of the card (journalDayCache) work itself out again on every tick.
  return useMemo(() => parseNotes(raw), [raw]);
}

// ---- the card as drawn ----------------------------------------------------------------------------------------------
/** One small figure: the trail, the flat-by time. */
function Small({ label, value, note, tone, data }: { label: string; value: string; note?: string; tone?: string; data?: string }) {
  return (
    <div className="min-w-0" data-manage-small={data}>
      <dt className="text-muted-foreground truncate text-[0.6875rem] max-sm:text-xs">{label}</dt>
      <dd className={cn("text-explain font-mono font-semibold", tone)}>
        {value}
        {note ? <span className="text-muted-foreground ml-1 font-sans text-[0.6875rem] font-normal max-sm:text-xs">{note}</span> : null}
      </dd>
    </div>
  );
}

/** One big figure: the stop, the distance to it, the countdown. */
function Big({ label, value, size, note, tone, data }: { label: string; value: string; size: "price" | "live"; note?: string; tone?: string; data?: string }) {
  return (
    <div className="min-w-0" data-manage-big={data}>
      {/* On a phone a label wraps rather than squeeze or cut the figure under it, and a figure never breaks. */}
      <dt className="text-explain text-muted-foreground truncate font-medium max-sm:overflow-visible max-sm:whitespace-normal">{label}</dt>
      <dd className={cn("font-mono tabular-nums max-sm:whitespace-nowrap", size === "price" ? "text-price" : "text-live", tone)}>{value}</dd>
      {note ? <dd className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">{note}</dd> : null}
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
 * fresh price and is not a CHECK (chainOn; the card's one chain feed, shared with the held value); shown only on this name's answer no older than its feed's same-day limit (staleLimits), labelled with
 * the chain's own time and delay. Nothing once the stop is the entry, or with a stop on the wrong side of it.
 */
function OptionAtStop({ v, ctx, feed }: { v: ManageView; ctx: ChainContext; feed: ChainFeed }) {
  const perfNow = usePerfNow(1_000);
  const on = chainOn(v, ctx) && entryStopDistance(v.side, v.entry, v.m.stop) !== null;
  if (!on || feed.status !== "ok" || feed.chain.symbol !== v.symbol || !chainFresh(feed.chain, feed.receivedPerf, perfNow)) return null;
  const c = heldOrAtm(feed.chain, v.side, v.contract, v.price!, ctx.now!, (x) => bellMinute(x, ctx.session, ctx.halfDay));
  const est = lossFromEntry(v.side, v.entry, v.m.stop, c?.contract.delta);
  if (!c || est === null) return null;
  return (
    <div className="min-w-0" data-manage-big="option" data-manage-option={c.held ? "held" : "atm"}>
      <dt className="text-explain text-muted-foreground truncate font-medium max-sm:overflow-visible max-sm:whitespace-normal">{fromEntryLabel(v.cardEntry)}</dt>
      <dd className="text-live font-mono tabular-nums max-sm:whitespace-nowrap">≈ −${Math.round(est)}</dd>
      <dd className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">
        on the option, a contract (est. from {c.held ? "your contract's" : "the at-the-money"} delta) · {chainStamp(feed.chain)}
        {contractQuoteTime(c.contract) ? ` · ${contractQuoteTime(c.contract)}` : ""}
      </dd>
    </div>
  );
}

/** The trade's own journal lots, for the live option value, and whether the journal is current enough for a position total. */
export interface CardHeld {
  lots: readonly Lot[];
  journalCurrent: boolean;
}

/** The held contract's live value, or why it is withheld; null when the journal names no one contract (no line at all). */
type HeldShown = { kind: "ok"; lines: ReturnType<typeof heldLines>; quote: string } | { kind: "withheld"; line: string } | null;

/**
 * The live value of the one contract a journal position names (option-value.ts): its OCC symbol built from the lots'
 * kind, strike and expiry, listed exactly once in this name's chain, quoted from /api/contract every 2 s. At the bid,
 * the mid second, fees in; withheld (with the reason) on anything but a fresh, sane OPRA quote in the regular session.
 * Never the at-the-money contract: a hand note without a contract, or lots naming two contracts, give nothing.
 */
function useHeldValue(v: ManageView, held: CardHeld | undefined, ctx: ChainContext | undefined, chain: ChainFeed): HeldShown {
  const perfNow = usePerfNow(1_000);
  // Rounded down to the second by useNow, so a second is added: the wall-clock age may read old, never young.
  const wall = useNow(1_000);
  const pre = held && ctx ? lotsContract(v.symbol, v.side, held.lots) : null;
  const named = pre?.ok ? pre.held : null;
  const r = named && chain.status === "ok" ? heldContract(v.symbol, v.side, held!.lots, chain.chain) : null;
  const occ = r?.ok ? r.held.occ : "";
  const { feed, shownPerf } = useContractQuote(occ, occ !== "");
  if (!r?.ok) return null;
  const j = judgeQuote({ feed, occ, perfNow, wallNow: wall === null ? null : wall + 1_000, shownPerf });
  if (!j.ok) return { kind: "withheld", line: notAvailable(j.why) };
  return { kind: "ok", lines: heldLines(heldValue(r.held, j.q, held!.journalCurrent)), quote: quoteLine(j.q) };
}

/**
 * Whether the card asks for its name's chain: only with a fresh price and the board's clock, never on a CHECK card.
 * One chain feed per card serves the estimate at the stop and the held contract's check alike.
 */
function chainOn(v: ManageView, ctx: ChainContext | undefined): ctx is ChainContext {
  return !!ctx && v.action !== "check" && v.price !== null && ctx.now !== null;
}

/**
 * Whether the card polls its one chain feed: chainOn, and either a stop to estimate from the entry (OptionAtStop) or
 * a contract the journal's lots name (the held value). Never on a CHECK card or one without a fresh price.
 */
export function cardAsksChain(v: ManageView, ctx: ChainContext | undefined, held: CardHeld | undefined): boolean {
  if (!chainOn(v, ctx)) return false;
  return entryStopDistance(v.side, v.entry, v.m.stop) !== null || (held ? lotsContract(v.symbol, v.side, held.lots).ok : false);
}

/** The held contract's value block: the value, the P&L (and the total when the journal is current), the stop room, the quote line. */
function HeldBlock({ shown }: { shown: NonNullable<HeldShown> }) {
  if (shown.kind === "withheld")
    return (
      <p data-manage-value="withheld" className="text-explain text-muted-foreground">
        {shown.line}
      </p>
    );
  const l = shown.lines;
  return (
    <div data-manage-value="live" className="text-explain grid gap-0.5">
      <p className="text-foreground font-medium">
        Live option value: <span className="font-mono tabular-nums">{l.value}</span>
      </p>
      <p data-manage-value-pnl className="text-foreground">
        P&amp;L <span className="font-mono tabular-nums">{l.pnl}</span>
        {l.total ? <span data-manage-value-total className="font-mono tabular-nums"> · {l.total}</span> : null}
      </p>
      {l.stop ? <p data-manage-value-stop className="text-muted-foreground">{l.stop}</p> : null}
      <p data-manage-value-quote className="text-muted-foreground font-mono text-[0.6875rem] tabular-nums max-sm:text-xs">
        {shown.quote}
      </p>
    </div>
  );
}

/**
 * One open trade: the header, then big the action word, the stop, the live distance to it on the stock, the option's
 * estimated loss at the stop from the entry, and the "not working in" countdown while it runs; small the trail, the flat-by time and where the
 * card's numbers come from. The option's P&L only for a contract the journal names exactly (`held`, useHeldValue),
 * from a live OPRA bid; otherwise "P&L: see Webull". A journal card adds a CHECK line (its fill is the card's entry) with "Set my fill"; `children` is the form
 * it opens.
 */
export function ManageCard({
  v,
  ctx,
  onClear,
  onSetFill,
  onUseTime,
  stop,
  held,
  children,
}: {
  v: ManageView;
  /** The trade's own journal lots, for the live option value; without them the card shows none. */
  held?: CardHeld;
  /** A note's option stop (or the invite to add the fill); none on a journal card. */
  stop?: CardStop;
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
  // The card's one chain feed, for the estimate at the stop and for the held contract's check: asked for while the
  // card has a fresh price and is not a CHECK, and either has a stop to measure or holds a contract the journal names.
  const asks = cardAsksChain(v, ctx, held);
  const keep = v.contract ? `${v.contract.expiry}:${v.contract.strike}` : "";
  const { feed: chain } = useChain(v.symbol, asks ? chainPx(ctx!.close, v.price) : null, asks, keep);
  const value = useHeldValue(v, held, ctx, chain);
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
        <span className="text-muted-foreground flex items-center gap-2 text-[0.6875rem] max-sm:text-xs">
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
                <button type="button" onClick={onClear} className="hover:text-foreground flex items-center gap-1 rounded border px-1.5 py-0.5 max-sm:min-h-11 max-sm:px-3 max-sm:text-sm">
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
            <button type="button" onClick={onUseTime} className="text-foreground hover:bg-muted rounded border px-2 py-0.5 font-medium max-sm:min-h-11 max-sm:px-3 max-sm:text-sm">
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
            <button type="button" onClick={onSetFill} className="text-foreground hover:bg-muted rounded border px-2 py-0.5 font-medium max-sm:min-h-11 max-sm:px-3 max-sm:text-sm">
              Set my fill
            </button>
          ) : null}
        </p>
      ) : null}
      {stop ? <StopBlock v={v} s={stop} /> : null}
      <dl className="grid max-w-2xl grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4" data-manage-grid>
        <Big label="Stop" value={v.m.stop !== null ? v.m.stop.toFixed(2) : "–"} size="price" note={v.cardEntry && v.stopAtEntry ? CARD_ENTRY : undefined} data="stop" />
        {dist !== null ? (
          <Big label={`${v.symbol} to the stop`} value={dist > 0 ? `$${dist.toFixed(2)}` : "at the stop"} size="live" tone={dist > 0 ? undefined : "text-bad"} data="distance" />
        ) : null}
        {ctx ? <OptionAtStop v={v} ctx={ctx} feed={chain} /> : null}
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
        <Small label="P&L" value={value?.kind === "ok" ? "at the bid, below" : "see Webull"} data="pnl" />
      </dl>
      {value ? <HeldBlock shown={value} /> : null}
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
  // Opened by a click, so this reads the tab's memory only in the browser: the ticket's price for this name and side.
  const [pre] = useState(() => prefillFrom(ticketPrice(f.symbol, f.side)));
  const [opt, setOpt] = useState(pre?.price ?? "");
  const [count, setCount] = useState(pre?.contracts ?? "");
  const [error, setError] = useState<{ field: "px" | "at" | "opt" | "n"; text: string } | null>(null);
  const save = () => {
    const r = checkFill(typed, live);
    if (!r.ok) return setError({ field: "px", text: r.error });
    const t = checkFillTime(time, now, session, halfDay);
    if (!t.ok) return setError({ field: "at", text: t.error });
    const o = checkOptionFill(opt, count);
    if (!o.ok) return setError({ field: o.field, text: o.error });
    setError(null);
    onSave(noteFromForm(f, r.price, t.at, o.fill));
  };
  // On a phone a field is 44 px tall at 16 px, so iOS Safari does not zoom the page into it when it takes the focus
  // (globals.css says the same for every field; the class keeps it true whatever the cascade does). 13 px from sm up.
  const input = "bg-background h-8 rounded border px-2 font-mono text-[0.8125rem] max-sm:h-11 max-sm:text-base";
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
          <span className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">Side</span>
          <span className="flex items-center gap-1 font-semibold">
            {f.symbol} {f.side}
            {f.kind !== "plan" ? <TestingTag /> : null}
          </span>
        </span>
        <label className="grid gap-0.5" htmlFor={`${id}-px`}>
          <span className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">{f.symbol} price at your fill</span>
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
          <span className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">Filled at (New York, to the minute)</span>
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
        <OptionFillFields
          id={id}
          price={opt}
          contracts={count}
          onPrice={setOpt}
          onContracts={setCount}
          bad={error?.field === "opt" ? "opt" : error?.field === "n" ? "n" : null}
          errId={`${id}-err`}
        />
        <span className="flex gap-1.5">
          <button type="submit" className="bg-primary text-primary-foreground rounded px-2.5 py-1 font-medium max-sm:min-h-11 max-sm:px-4 max-sm:text-sm">
            Save note
          </button>
          <button type="button" onClick={onCancel} className="rounded border px-2.5 py-1 max-sm:min-h-11 max-sm:px-4 max-sm:text-sm">
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
        <p data-im-in-moved className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">
          {movedOn}
        </p>
      ) : null}
      {pre ? (
        <p data-im-in-prefill className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">
          Option fill from your trade ticket in this tab: check it against Webull.
        </p>
      ) : null}
      <p className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">Your own note in this browser, to manage the trade here. Nothing is sent anywhere.</p>
    </form>
  );
}

/**
 * The two optional boxes for the option fill: the price a share paid in Webull and the contracts. Both are always
 * drawn, so nothing moves when they are filled in.
 */
function OptionFillFields({
  id,
  price,
  contracts,
  onPrice,
  onContracts,
  bad,
  errId,
}: {
  id: string;
  price: string;
  contracts: string;
  onPrice: (v: string) => void;
  onContracts: (v: string) => void;
  bad: "opt" | "n" | null;
  errId: string;
}) {
  const box = "bg-background text-foreground h-11 rounded-md border px-2 font-mono text-base tabular-nums";
  return (
    <>
      <label className="grid gap-0.5" htmlFor={`${id}-opt`}>
        <span className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">Option fill, a share (optional)</span>
        <input
          id={`${id}-opt`}
          data-im-in-option
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="1.25"
          value={price}
          aria-invalid={bad === "opt" ? true : undefined}
          aria-describedby={bad === "opt" ? errId : undefined}
          onChange={(ev) => onPrice(ev.target.value)}
          className={cn(box, "w-28", bad === "opt" && "border-bad-fill")}
        />
      </label>
      <label className="grid gap-0.5" htmlFor={`${id}-n`}>
        <span className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">Contracts</span>
        <input
          id={`${id}-n`}
          data-im-in-contracts
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="1"
          value={contracts}
          aria-invalid={bad === "n" ? true : undefined}
          aria-describedby={bad === "n" ? errId : undefined}
          onChange={(ev) => onContracts(ev.target.value)}
          className={cn(box, "w-20", bad === "n" && "border-bad-fill")}
        />
      </label>
    </>
  );
}

/** The card's own small form to add the option fill to a note, or to correct the one it has (`initial`). */
function FillForm({ v, initial = null, onSave, onCancel }: { v: ManageView; initial?: OptionFill | null; onSave: (fill: OptionFill) => void; onCancel: () => void }) {
  const id = useId();
  // Correcting a fill starts from it; adding one starts from the ticket's price in this tab (the price only).
  const [pre] = useState(() => (initial ? null : prefillFrom(ticketPrice(v.symbol, v.side))));
  const [opt, setOpt] = useState(initial ? usd(initial.priceCents).slice(1) : (pre?.price ?? ""));
  const [count, setCount] = useState(initial ? String(initial.contracts) : (pre?.contracts ?? ""));
  const [error, setError] = useState<{ field: "opt" | "n"; text: string } | null>(null);
  return (
    <form
      data-manage-fill-form={v.symbol}
      aria-label={`${initial ? "Edit" : "Add"} your ${v.symbol} ${v.side} option fill`}
      onSubmit={(ev) => {
        ev.preventDefault();
        const o = checkOptionFill(opt, count);
        if (!o.ok) return setError({ field: o.field, text: o.error });
        if (!o.fill) return setError({ field: "opt", text: "Type the option price a share you paid, like 1.25." });
        setError(null);
        onSave(o.fill);
      }}
      className="bg-card grid gap-1.5 rounded border p-2 text-xs"
    >
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5">
        <OptionFillFields id={id} price={opt} contracts={count} onPrice={setOpt} onContracts={setCount} bad={error?.field ?? null} errId={`${id}-err`} />
        <span className="flex gap-1.5">
          <button type="submit" className="bg-primary text-primary-foreground min-h-11 rounded px-3 font-medium">
            Save fill
          </button>
          <button type="button" onClick={onCancel} className="min-h-11 rounded border px-3">
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
      {pre ? <p className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">Price from your trade ticket in this tab: check it against Webull.</p> : null}
      <p className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">Kept with your note in this browser. Nothing is sent anywhere.</p>
    </form>
  );
}

/** What the card shows for a note's option stop: its fill's stop, or the line inviting the fill. */
export interface CardStop {
  stop: FillStop | null;
  placed: boolean;
  room: RoomAfterStop | null;
  /** "Fills read 10:21 New York", or null. */
  readLine: string | null;
  onPlaced?: (placed: boolean) => void;
  /** Adds the fill, or replaces it ("Edit fill"). */
  onAddFill?: (fill: OptionFill) => void;
}

const SMALL_BUTTON = "text-foreground hover:bg-muted min-h-11 rounded border px-3 font-medium";

/**
 * The stop to rest in Webull for a note with an option fill: big, from the ticket's arithmetic, with the tick caveat
 * and the nickel alternative, the dollars lost there with fees on his contracts, any rule 4 limit his fill is over (said
 * with the numbers; the stop is shown whatever), his own "Stop placed in Webull" tick, and the day's room after it.
 * A fill too cheap for a stop under it shows that line alone. Without a fill: one line inviting it, and a small form;
 * with one, "Edit fill" reopens its two boxes.
 */
export function StopBlock({ v, s }: { v: ManageView; s: CardStop }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const form =
    editing && s.onAddFill ? (
      <FillForm
        v={v}
        initial={s.stop?.fill ?? null}
        onCancel={() => setEditing(false)}
        onSave={(fill) => {
          setEditing(false);
          s.onAddFill!(fill);
        }}
      />
    ) : null;
  const editButton =
    s.onAddFill && !editing ? (
      <button type="button" data-manage-fill-edit onClick={() => setEditing(true)} className={SMALL_BUTTON}>
        {s.stop ? "Edit fill" : "Add option fill"}
      </button>
    ) : null;
  if (!s.stop) {
    return (
      <div data-manage-stop-invite className="grid gap-1.5">
        <p className="text-explain text-muted-foreground flex flex-wrap items-center gap-2">
          <span>{INVITE_LINE}</span>
          {editButton}
        </p>
        {form}
      </div>
    );
  }
  const f = s.stop;
  if (f.noStop) {
    return (
      <section aria-label="No stop to place" data-manage-stop-none className="bg-card grid gap-1.5 rounded-md border px-3 py-2">
        <p className="text-explain text-warn flex flex-wrap items-center gap-2 font-medium">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          <span>{f.noStop}</span>
          {editButton}
        </p>
        {form}
      </section>
    );
  }
  const nickel = nickelLine(f);
  return (
    <section aria-labelledby={`${id}-stop`} data-manage-stop={f.stopCents} data-manage-stop-placed={s.placed ? "yes" : "no"} className="bg-card grid gap-1.5 rounded-md border px-3 py-2">
      <p id={`${id}-stop`} className="text-foreground flex flex-wrap items-baseline gap-x-2 text-lg leading-snug font-semibold">
        <span>Stop to place in Webull:</span>
        <span className="text-price font-mono tabular-nums">{usd(f.stopCents)}</span>
      </p>
      <p className="text-explain text-muted-foreground">
        On the option, {stopFromLine(f)}. {tickLine(f)}
        {nickel ? <span data-manage-stop-nickel> {nickel}</span> : null}
      </p>
      <p data-manage-stop-loss className="text-explain text-foreground font-medium">
        {lossLine(f)}
      </p>
      {f.breaks.map((b) => (
        <p key={b} data-manage-stop-break className="text-explain text-warn flex items-start gap-1.5 font-medium">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{b}</span>
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label htmlFor={`${id}-placed`} className="text-foreground flex min-h-11 w-fit cursor-pointer items-center gap-3 font-medium">
          <input
            id={`${id}-placed`}
            data-manage-stop-check
            type="checkbox"
            checked={s.placed}
            onChange={(ev) => s.onPlaced?.(ev.target.checked)}
            className="accent-foreground size-5 shrink-0"
          />
          {STOP_PLACED}
        </label>
        {editButton}
      </div>
      {form}
      <p data-manage-stop-reminder={s.placed ? "own" : "unticked"} className="text-explain text-muted-foreground">
        {s.placed ? STOP_OWN_TICK : STOP_REMINDER}
      </p>
      {s.room ? (
        <p data-manage-room={s.room.kind} className={cn("text-explain", s.room.kind === "over" ? "text-warn font-medium" : s.room.kind === "withheld" ? "text-muted-foreground" : "text-foreground")}>
          {s.room.line}
          {s.room.kind !== "withheld" && s.readLine ? <span className="text-muted-foreground"> {s.readLine}.</span> : null}
        </p>
      ) : null}
    </section>
  );
}

const NO_TRADES: readonly OpenTrade[] = [];
const NO_NOTES: readonly ManualNote[] = [];

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
  /** The server's day check, for the room after a note's stop; null without a journal. */
  day?: DayFacts | null;
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
  /** Today's notes in this browser that the journal shows no fill for yet: the rail counts them. */
  provisional: number;
  /** The journal can still be judged, re-checked on this browser's clock: the room shows only while it is. */
  journalLive: boolean;
} {
  const day = x.now !== null ? (nyClock(new Date(x.now).toISOString())?.day ?? null) : null;
  const today = day === x.session ? day : null;
  const notes = useNotes(today);
  const [form, setForm] = useState<FormCapture | null>(null);
  const [last, setLast] = useState<Record<string, ManageAction>>({});
  const [notices, setNotices] = useState<ManageNotice[]>([]);
  const [wasLive, setWasLive] = useState(false);
  const [seq, setSeq] = useState(0);
  // The journal's side of the card, kept between renders: a tick of the clock with the same day's trades, lots, notes
  // and session reads no row of the journal.
  const [journal] = useState(() => journalDayCache());

  const feed = today && x.now !== null ? cardFeed(x.mode, x.barsLoading, wasLive) : null;
  if (feed === "live" && !wasLive) setWasLive(true);
  const rowOf = (symbol: string) => x.rows.find((r) => r.symbol === symbol);
  const trades = feed ? journal.openTrades(x.items, x.lots, notes, x.session, x.closed, x.journalAsOf) : NO_TRADES;
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
      ...(rowOf(t.symbol)?.state?.guards?.length ? { guards: rowOf(t.symbol)!.state!.guards } : {}),
      feed: feed!,
    }),
  );

  // The notes the journal has closed out leave this browser (their cards are already gone).
  const retire = today ? journal.retired(notes, x.lots, x.closed, x.session, x.journalAsOf) : NO_NOTES;
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
  /** One note changed in place (its fill, its stop tick), by its id. */
  const patch = (n: ManualNote, change: Partial<Pick<ManualNote, "fill" | "stopPlaced">>) => {
    const next: ManualNote = { ...n, ...change };
    if (!next.stopPlaced) delete next.stopPlaced;
    save(notes.map((x) => (noteId(x) === noteId(n) ? next : x)));
  };
  // The notes the journal shows no fill for yet: the rail adds them to the day's count.
  const match = today ? journal.match(notes, x.closed, x.lots, x.session) : null;
  const provisional = match?.provisional.length ?? 0;
  // The server judged the journal when it drew the page; this browser checks its age again every half minute.
  const liveNow = useNow(30_000);
  const live = journalLive(x.day, liveNow);
  const cardStop = (t: (typeof trades)[number]): CardStop | undefined => {
    const n = t.note;
    if (!n) return undefined;
    const st = n.fill ? fillStop(n.fill) : null;
    return {
      stop: st,
      placed: n.stopPlaced === true,
      // Never from an old journal, never beside another open trade or position whose loss is not priced here, never
      // for a fill already over rule 4, and none at all for a fill too cheap for a stop.
      room:
        st && !st.noStop
          ? roomAfterStop(
              x.day ? { current: live, net: x.day.net } : null,
              st.lossCents,
              Math.max(views.length - 1, otherOpenPositions(x.lots, match?.matched.get(noteId(n))), x.lots.length === 0 ? (x.day?.openLots ?? 0) : 0),
              st.breaks.length,
            )
          : null,
      readLine: x.day?.readLine ?? null,
      onPlaced: (placed) => patch(n, { stopPlaced: placed }),
      onAddFill: (fill) => patch(n, { fill }),
    };
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
        className="hover:bg-muted flex w-fit items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium max-sm:min-h-11 max-sm:px-3 max-sm:text-sm"
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
            stop={cardStop(t)}
            held={{ lots: t.lots ?? [], journalCurrent: live }}
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
              <p className="text-muted-foreground mt-0.5 text-[0.6875rem] max-sm:text-xs">Advisory: confirm on your chart.</p>
            </div>
            <button
              type="button"
              aria-label={`Dismiss the ${n.symbol} trade notice`}
              onClick={() => setNotices((all) => all.filter((y) => y.id !== n.id))}
              className="text-muted-foreground hover:text-foreground -m-1 flex size-7 shrink-0 items-center justify-center rounded max-sm:size-11"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      ))
    : null;

  return { cards, rowExtra, notices: noticeEls, views, provisional, journalLive: live };
}
