"use client";

// The Now hero: the one name the page wants looked at, full width at the top, big enough to read from across the desk.
// In the live mode it is the board's most urgent row (useBoard().rows[0]): its state word, its side, the three numbers
// (In, Stop, T1) as tiles, the live price and the distance to the nearer trigger, up to two cautions, and, when the
// owner is in a trade on that name, the manage card's word. Under the tiles, small, the what-if lines for the side the
// board points at: the at-the-money option against the premium cap, which stop comes first, and the day's room after a
// stop (HeroChecks). Before the live mode it shows the mode's line and the #1
// focus name with its two triggers.
//
// Every state is read from the board, never worked out here, so the hero always says what the board says. Prices that
// have stopped grey the whole hero and say for how long: no entry and no reassuring manage word is ever shown on old
// prices. Read only: the tiles are labelled In, Stop and T1, and nothing here places an order.
import { CircleCheck, Eye, GitBranch, Hourglass, Ban, OctagonX, Pause, SkipForward, TriangleAlert, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { TONE_TEXT } from "@/components/status";
import { ladderInputs } from "@/components/level-ladder";
import { focusPlan } from "@/lib/focus-plan";
import type { Tone } from "@/lib/labels";
import { type LadderLiveView } from "@/lib/level-ladder";
import { ACTION_WORD, type ManageView, PAUSED_LINE } from "@/lib/trade-manage";
import { type BoardRow, rowView, type RowView, STATE_WORD } from "@/lib/trade-now";
import type { NameStateName } from "@/lib/trade-state";
import { cn } from "@/lib/utils";
import { bellMinute } from "@/lib/contract";
import { atmContract, chainFresh, chainPx, chainStamp, entryStopDistance, premiumCheck, roomShown, UNLIKELY_WORDS, whichStopFirst } from "@/lib/what-if";
import { useLadderLive } from "./ladder-live";
import { openTicket } from "./ticket";
import { type Board, openFocusCard, TestingTag, useBoard } from "./trade-now";
import { useChain } from "./use-chain";
import { usePerfNow } from "./use-now";

const STATE_ICON: Record<NameStateName, LucideIcon> = {
  no_trade: Ban,
  watch: Eye,
  get_ready: Hourglass,
  enter_zone: CircleCheck,
  plan_off: OctagonX,
  missed: SkipForward,
  paused: Pause,
};

/** A state word's chip: the word in the page's own text colour (7:1 or better), the tone in the tint, the bar and the icon. */
const CHIP: Record<Tone, string> = {
  good: "bg-good-soft border-good-fill",
  warn: "bg-warn-soft border-warn-fill",
  bad: "bg-bad-soft border-bad-fill",
  info: "bg-info-soft border-info-fill",
  neutral: "bg-neutral-soft border-neutral-fill",
};

function WordChip({ word, tone, icon: Icon, data }: { word: string; tone: Tone; icon: LucideIcon; data?: Record<string, string> }) {
  return (
    <span {...data} className={cn("text-decision inline-flex items-center gap-2 rounded-md border border-l-[6px] px-2.5 py-0.5 whitespace-nowrap", CHIP[tone])}>
      <Icon aria-hidden className={cn("size-6 shrink-0 sm:size-7", TONE_TEXT[tone])} />
      {word}
    </span>
  );
}

/** One number as a tile: "Stop 752.01", with an option's stop beside it as a note ("or −25%"). */
function Tile({ label, value, data }: { label: string; value: string; data: string }) {
  const [price, ...rest] = value.split(" or ");
  return (
    <div data-hero-tile={data} className="bg-muted/40 min-w-0 rounded-md border px-2.5 py-2 sm:px-3">
      <dt className="text-explain text-muted-foreground font-medium">{label}</dt>
      <dd className="text-price font-mono tabular-nums">{price}</dd>
      {rest.length ? <dd className="text-explain text-muted-foreground">or {rest.join(" or ")}</dd> : null}
    </div>
  );
}

const TO = { ceiling: "Ceiling", floor: "Floor" } as const;

/** The live price and the distance to the nearer trigger, from the ladder's own live layer (its rules, its clock). */
function PriceLine({ view }: { view: LadderLiveView }) {
  const near = view.distances.find((d) => d.near);
  return (
    <div data-hero-price={view.dot?.kind ?? "none"} className="grid gap-0.5 sm:justify-items-end sm:text-right">
      {view.dot ? (
        <p className="flex flex-wrap items-baseline gap-x-2 sm:justify-end">
          <span className={cn("text-live font-mono tabular-nums", view.dot.kind !== "live" && "text-muted-foreground")}>{view.dot.price.toFixed(2)}</span>
          <span className="text-explain text-muted-foreground">{view.dot.label}</span>
        </p>
      ) : view.caption ? (
        <p className="text-explain text-muted-foreground">{view.caption}</p>
      ) : null}
      {near ? (
        <p data-hero-distance={near.to} className="text-live tabular-nums">
          {TO[near.to]} {near.level.toFixed(2)} · {near.text}
          {near.unlikely ? <span className="text-explain text-muted-foreground"> · {UNLIKELY_WORDS}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** The hero's price line for one name: the ladder's live view, worked out from the board's own data. */
function usePriceView(b: Board, symbol: string | null): LadderLiveView {
  const item = symbol ? b.items.find((i) => i.symbol === symbol) : undefined;
  const ticker = symbol ? b.ticker(symbol) : undefined;
  const i = item ? ladderInputs(item, ticker, b.premarket[item.symbol] ?? null) : null;
  return useLadderLive({
    symbol: symbol ?? "",
    session: b.session,
    halfDay: b.halfDay,
    premarket: i?.pre ?? null,
    close: i?.close ?? null,
    closeDate: b.closeDate,
    ceiling: i?.plans.call?.level ?? null,
    floor: i?.plans.put?.level ?? null,
    atr: i?.atr ?? null,
    move: i?.move ?? null,
  });
}

/**
 * The hero's what-if lines, small, under the tiles: the at-the-money option's cost against the premium cap and which
 * stop comes first (from one option chain, for the hero's name only and only in the live mode with the board pointing
 * at a side), then the day's room after a stop. Each line shows only when its inputs are present and fresh: the chain
 * no older than STALE_SAME_DAY_MIN, for this very name, labelled with its time and "15 min behind"; nothing at all on
 * old prices. The which-stop line measures entry to stop (entryStopDistance, as the manage card does), and is left out
 * when the stop is on the wrong side of the entry.
 */
function HeroChecks({ b, row, view, side, room }: { b: Board; row: BoardRow; view: LadderLiveView; side: "call" | "put" | null; room: string | null }) {
  const perfNow = usePerfNow(1_000);
  const price = view.dot?.kind === "live" ? view.dot.price : null;
  const close = b.ticker(row.symbol)?.last?.close ?? null;
  const on = side !== null && price !== null;
  const { feed } = useChain(row.symbol, on ? chainPx(close, price) : null, on);
  if (!on) return null;
  // The answer must be this name's: a chain for the last hero name is never priced against this one.
  const fresh = feed.status === "ok" && feed.chain.symbol === row.symbol && chainFresh(feed.chain, feed.receivedPerf, perfNow);
  const chain = feed.status === "ok" && fresh ? feed.chain : null;
  const atm = chain && b.now !== null ? atmContract(chain, side, price, b.now, (x) => bellMinute(x, b.session, b.halfDay)) : null;
  const premium = premiumCheck(atm?.contract);
  const plan = row.state?.plan;
  const dist = plan ? entryStopDistance(side, plan.entry, plan.stop) : null;
  const first = premium ? whichStopFirst(dist, atm?.contract.delta, premium.ask) : null;
  if (!premium && !room) return null;
  return (
    <div data-hero-checks className="text-explain grid gap-0.5">
      {chain && premium ? (
        <>
          <p data-hero-premium={premium.over ? "over" : "under"} className={cn("font-medium", premium.over && "text-warn")}>
            {premium.line}
          </p>
          {first ? (
            <p data-hero-stop-first={first.first} className="text-muted-foreground">
              {first.text} Est. from delta.
            </p>
          ) : null}
          <p data-hero-chain className="text-muted-foreground text-xs">
            {chainStamp(chain)}
          </p>
        </>
      ) : null}
      {room ? (
        <p data-hero-room className="text-muted-foreground">
          {room}
        </p>
      ) : null}
    </div>
  );
}

/** The words that reassure: never shown while prices are paused. */
const REASSURING = new Set(["hold", "trail", "sell_half"]);

/** The manage card's word for an open trade, or CHECK while the hero's prices are paused. */
export function heroManage(v: Pick<ManageView, "action" | "tone" | "line">, paused: boolean): { word: string; tone: Tone; line: string } {
  if (paused && REASSURING.has(v.action)) return { word: ACTION_WORD.check, tone: "warn", line: PAUSED_LINE };
  return { word: ACTION_WORD[v.action], tone: v.tone, line: v.line };
}

/** The hero's numbers: the row's own grid (an entry or a live alternative), else the side's plan for a get-ready. */
export function heroTiles(row: BoardRow, v: RowView, paused: boolean): { enter: string; stop: string; target: string | null; plan: boolean } | null {
  const s = row.state;
  if (!s || paused || s.state === "paused") return null;
  if (v.grid) return { ...v.grid, plan: false };
  if (s.state === "get_ready" && s.plan && s.plan.entry !== null && s.plan.stop !== null)
    return { enter: `~${s.plan.entry.toFixed(2)}`, stop: s.plan.stop.toFixed(2), target: s.plan.target1 !== null ? s.plan.target1.toFixed(2) : null, plan: true };
  return null;
}

const sameCent = (a: number | null | undefined, b: number | null | undefined) => a == null || b == null ? a == null && b == null : Math.round(a * 100) === Math.round(b * 100);

/**
 * The side the hero's "Size the …" button opens a ticket for, or null for no button. Only when the card has a plan for
 * that side, the hero is not showing an alternative trigger (its own stop and target), and the row's plan has the
 * card's stop and T1 to the cent: the ticket estimates from the card's levels, so it is hidden rather than ever showing
 * numbers that disagree with the hero's tiles.
 */
export function heroTicketSide(
  side: "call" | "put" | null,
  row: Pick<BoardRow, "state">,
  v: Pick<RowView, "badge">,
  card: { stop: number | null; target1: number | null } | null | undefined,
): "call" | "put" | null {
  if (!side || !card || v.badge.alt) return null;
  const p = row.state?.plan;
  if (p && (!sameCent(p.stop, card.stop) || !sameCent(p.target1, card.target1))) return null;
  return side;
}

/** A one-off highlight when the hero's name changes (motion-safe only); the first name on screen plays none. */
const FLASH = `
@keyframes now-hero-in { from { box-shadow: 0 0 0 4px var(--ring); } to { box-shadow: 0 0 0 0 transparent; } }
@media (prefers-reduced-motion: no-preference) { [data-hero-flash="on"] { animation: now-hero-in 1.4s ease-out 1; } }
`;

function useFlash(key: string | null): number {
  const [seen, setSeen] = useState<string | null>(key);
  const [n, setN] = useState(0);
  if (key !== seen) {
    setSeen(key);
    if (seen !== null && key !== null) setN(n + 1);
  }
  return n;
}

function Live({ b, row, room }: { b: Board; row: BoardRow; room: string | null }) {
  const s = row.state!;
  const v = rowView(s);
  const paused = b.paused || s.state === "paused";
  const view = usePriceView(b, row.symbol);
  const tiles = heroTiles(row, v, paused);
  const trades = b.manage.views.filter((m) => m.symbol === row.symbol);
  const others = b.manage.views.filter((m) => m.symbol !== row.symbol);
  const age = b.ageS[row.symbol] ?? null;
  const shownState: NameStateName = paused ? "paused" : s.state;
  const word = paused ? STATE_WORD.paused : v.badge.word;
  const tone: Tone = paused ? "neutral" : v.badge.tone;
  const icon = paused ? Pause : v.badge.alt ? GitBranch : STATE_ICON[s.state];
  // The side the board points at (an entry or a get-ready), as the ladder and the cards read it: none while paused.
  const side = !paused && (s.state === "enter_zone" || s.state === "get_ready") ? (s.side ?? null) : null;
  const cardItem = b.items.find((i) => i.symbol === row.symbol);
  const ticketSide = heroTicketSide(side, row, v, side && cardItem ? focusPlan(cardItem)[side] : null);
  return (
    <div data-hero-paused={paused ? "true" : undefined} className={cn("grid gap-3", paused && "grayscale")}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span data-hero-symbol className="text-decision font-mono">{row.symbol}</span>
          <WordChip word={word} tone={tone} icon={icon} data={{ "data-hero-word": shownState }} />
          {v.badge.side && !paused ? (
            <span data-hero-side={v.badge.side} className="text-decision">
              {v.badge.side.toUpperCase()}
            </span>
          ) : null}
          {v.testing && !paused ? <TestingTag /> : null}
        </div>
        <PriceLine view={view} />
      </div>
      {paused ? (
        <p role="status" data-hero-stale className="text-live text-foreground font-medium">
          Prices paused{age !== null ? ` ${age} s` : ""}: no entry is shown on old prices. Check your platform.
        </p>
      ) : (
        <p className="text-base leading-snug font-medium sm:text-lg">{v.headline}</p>
      )}
      {tiles ? (
        <div className="grid gap-1">
          {tiles.plan ? <p className="text-explain text-muted-foreground">The {s.side} plan, if the break holds:</p> : null}
          {/* Two and one on a phone: three 22 px prices side by side do not fit 375 px. */}
          <dl data-hero-tiles className="grid max-w-2xl grid-cols-2 gap-2 sm:grid-cols-3">
            <Tile label="In" value={tiles.enter} data="in" />
            <Tile label="Stop" value={tiles.stop} data="stop" />
            {tiles.target !== null ? <Tile label="T1" value={tiles.target} data="t1" /> : null}
          </dl>
        </div>
      ) : null}
      {ticketSide ? (
        // Hidden in the cockpit, which hides the cards the ticket sits on.
        <button
          type="button"
          data-cockpit-hide
          data-hero-ticket={ticketSide}
          onClick={() => openTicket(row.symbol, ticketSide)}
          className="text-explain hover:bg-muted/50 inline-flex min-h-11 w-fit items-center rounded-md border px-3 font-medium"
        >
          Size the {ticketSide} from your Webull price
        </button>
      ) : null}
      <HeroChecks b={b} row={row} view={view} side={side} room={roomShown(room, b.manage.views.length, b.manage.provisional, b.manage.journalLive)} />
      {!paused && s.cautions.length ? (
        <ul className="flex flex-wrap items-center gap-2" data-hero-cautions={s.cautions.length + s.moreCautions} aria-label="Cautions">
          {s.cautions.slice(0, 2).map((c) => (
            <li key={c.id} title={c.why} className="text-explain bg-warn-soft border-warn-fill inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-semibold">
              <TriangleAlert aria-hidden className="text-warn size-4" />
              {c.word}
            </li>
          ))}
          {s.cautions.length + s.moreCautions > 2 ? <li className="text-explain text-muted-foreground">+{s.cautions.length + s.moreCautions - 2} more on the board</li> : null}
        </ul>
      ) : null}
      {trades.map((m) => {
        const w = heroManage(m, paused);
        return (
          <div key={m.id} data-hero-manage={m.action} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border px-3 py-2">
            <span className="text-explain text-muted-foreground font-medium">
              In a trade · {m.symbol} {m.side}
            </span>
            <WordChip word={w.word} tone={w.tone} icon={w.tone === "good" ? CircleCheck : TriangleAlert} />
            <span className="text-base font-medium">{w.line}</span>
          </div>
        );
      })}
      {others.length ? (
        <p className="text-explain text-muted-foreground">
          Also in a trade:{" "}
          {others.map((m, i) => {
            const w = heroManage(m, b.paused);
            return (
              <span key={m.id} data-hero-other={m.symbol}>
                {i ? ", " : ""}
                <span className="text-foreground font-semibold">
                  {m.symbol} {m.side} · {w.word}
                </span>
              </span>
            );
          })}
        </p>
      ) : null}
      {b.barsDelayed && !paused ? <p className="text-explain text-muted-foreground">Session bars delayed: the state uses this page&apos;s prices only.</p> : null}
    </div>
  );
}

/**
 * What the hero shows of the #1 name's triggers before the live mode: full size before the open and while connecting;
 * greyed with the live prices off (the plan stands, but nothing here is watching it); none for an older focus card,
 * whose triggers are not today's. Pure.
 */
export function heroTriggers(mode: Board["mode"]["kind"]): "full" | "grey" | "none" {
  return mode === "old" ? "none" : mode === "off" ? "grey" : "full";
}

function BeforeLive({ b }: { b: Board }) {
  const item = b.items[0] ?? null;
  const plan = item ? focusPlan(item) : { call: null, put: null };
  const view = usePriceView(b, item?.symbol ?? null);
  const line = b.mode.kind === "live" ? "" : b.mode.line;
  const triggers = heroTriggers(b.mode.kind);
  return (
    <div className="grid gap-3">
      <p data-hero-line className="text-price leading-tight">
        {line}
      </p>
      {item ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <p className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-explain text-muted-foreground font-medium">#1 focus</span>
              <span data-hero-symbol className="text-decision font-mono">
                {item.symbol}
              </span>
            </p>
            <PriceLine view={view} />
          </div>
          {triggers === "none" ? (
            <p data-hero-triggers="none" className="text-explain text-muted-foreground">
              This card is for an earlier day: its triggers are not shown.
            </p>
          ) : (
            <>
              <dl data-hero-triggers={triggers} className={cn("grid max-w-2xl grid-cols-2 gap-2", triggers === "grey" && "text-muted-foreground grayscale")}>
                {plan.call ? <Tile label="Calls above" value={plan.call.level.toFixed(2)} data="call" /> : null}
                {plan.put ? <Tile label="Puts below" value={plan.put.level.toFixed(2)} data="put" /> : null}
              </dl>
              <p className="text-explain text-muted-foreground">
                {triggers === "grey" ? "Live prices are off: the plan is on the cards below." : "Enter only on a break, then a retest that holds."}
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The hero at the top of the page; nothing for an older edition or one without focus names. `room` is the server's
 * day-room line (what-if's dayRoom), shown only with the board pointing at a side and no trade card open (roomShown).
 */
export function NowHero({ room = null }: { room?: string | null }) {
  const b = useBoard();
  const live = !!b && b.on && b.mode.kind === "live" && b.rows.length > 0 && b.rows[0]!.state !== null;
  const top = live ? `${b.rows[0]!.symbol}` : b?.on ? `pre:${b.mode.kind}` : null;
  const flash = useFlash(top);
  if (!b || !b.on) return null;
  const row = live ? b.rows[0]! : null;
  return (
    <section
      aria-labelledby="now-hero-title"
      data-now-hero={row ? "live" : b.mode.kind}
      data-hero-for={row?.symbol ?? b.items[0]?.symbol}
      data-hero-state={row?.state ? (b.paused ? "paused" : row.state.state) : undefined}
      data-hero-flash={flash > 0 ? "on" : undefined}
      key={flash}
      className="bg-card grid gap-3 rounded-lg border p-3 sm:p-4"
    >
      <style>{FLASH}</style>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="now-hero-title" className="text-explain text-muted-foreground font-semibold">
          Now
        </h2>
        {row ? (
          // Hidden in the cockpit, which hides the cards it would scroll to.
          <button type="button" data-cockpit-hide onClick={() => openFocusCard(row.symbol)} className="text-explain text-muted-foreground hover:text-foreground underline-offset-4 hover:underline">
            Show the {row.symbol} card
          </button>
        ) : null}
      </div>
      {row ? <Live b={b} row={row} room={room} /> : <BeforeLive b={b} />}
      <p className="text-muted-foreground text-xs">Advisory, from the board: confirm on your chart. Read only: nothing here places an order.</p>
    </section>
  );
}
