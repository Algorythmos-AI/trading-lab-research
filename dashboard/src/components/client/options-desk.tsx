"use client";

import { ArrowDown, ArrowUp, Keyboard, Search, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { RoomBar } from "@/components/options-charts";
import { fracPct, num, rMult, signed, weekDate } from "@/lib/format";
import {
  CHEAP_IVP,
  CHIP_LABEL,
  clockSpan,
  DESK_VIEWS,
  liveRead,
  mapLayersOf,
  movesFromClose,
  nearest,
  needsALook,
  paperFor,
  RICH_IVP,
  roomView,
  sessionClock,
  sortByNumber,
  viewForClock,
  type DeskView,
  type LiveRead,
  type MapLayer,
  type Options,
  type OptionsTicker,
} from "@/lib/options";
import { cn } from "@/lib/utils";
import { DeskPalette } from "./desk-palette";
import { FeedPill, StateChip, useLive } from "./live-layer";
import { OptionsDetail, Tick } from "./options-detail";
import { PaneBoundary } from "./pane-boundary";

const VIEW_LABEL: Record<DeskView, string> = { brief: "Brief", live: "Live", review: "Review" };
const VIEW_HINT: Record<DeskView, string> = {
  brief: "Before the open: where each name closed and what its options cost",
  live: "While the session trades: live prices against the levels",
  review: "After the close: what the paper rules did",
};

const CHIP_DOT: Record<string, string> = { STRONG: "bg-good-fill", MID: "bg-neutral-fill", WEAK: "bg-bad-fill" };

/** Everything the monitor shows for one name, worked out once per render. */
interface Row {
  t: OptionsTicker;
  read: LiveRead;
  close: number | null;
  /** Percent change from the edition's close, in session only. */
  change: number | null;
  /** The same change in one-day expected moves. */
  moves: number | null;
  near: ReturnType<typeof nearest>;
  paper: ReturnType<typeof paperFor>;
}

interface Column {
  key: string;
  head: string;
  /** Said in full for a screen reader and on hover: what the number is and its unit. */
  hint: string;
  align?: "left" | "right";
  /**
   * The column's width from the `md` breakpoint up, where the table has a fixed layout so numbers never push each
   * other about. Each view leaves one column without a width: it takes what is left, so the fixed ones always fit.
   * On a phone the table lays itself out and the `wideOnly` columns are hidden.
   */
  width: string;
  sort?: (r: Row) => number | null | undefined;
  cell: (r: Row) => React.ReactNode;
  /** Columns a phone has no room for. */
  wideOnly?: boolean;
}

const dash = <span className="text-muted-foreground">—</span>;
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "" : v > 0 ? "text-good" : "text-bad");

function Distance({ edge, atr }: { edge: number | null | undefined; atr: number | null | undefined }) {
  if (edge == null) return <span className="text-muted-foreground">none near</span>;
  return (
    <>
      {num(edge, 2)}
      {atr != null ? <span className="text-muted-foreground block text-[0.6875rem]">{num(atr, 1)} ATR</span> : null}
    </>
  );
}

const COLUMNS: Record<DeskView, Column[]> = {
  brief: [
    { key: "close", head: "Close", hint: "Last close, in dollars", width: "md:w-[5.5rem]", sort: (r) => r.close, cell: (r) => num(r.close, 2) },
    {
      key: "em",
      head: "1-day move",
      hint: "The move the options market prices for one day, in dollars",
      width: "md:w-[5.5rem]",
      sort: (r) => r.t.expected_move?.day,
      cell: (r) => (r.t.expected_move?.day != null ? `±${num(r.t.expected_move.day, 2)}` : dash),
    },
    {
      key: "ivp",
      head: "IV percentile",
      hint: "Where implied vol sits in its own last 52 weeks; low means options are cheap for this name",
      width: "",
      sort: (r) => r.t.expected_move?.iv_pct_52w,
      cell: (r) => {
        const ivp = r.t.expected_move?.iv_pct_52w;
        if (ivp == null) return dash;
        return (
          <span className="grid gap-1">
            <span className="flex items-baseline justify-end gap-1.5">
              <span className="text-muted-foreground font-sans text-[0.6875rem]">{ivp >= RICH_IVP ? "rich" : ivp <= CHEAP_IVP ? "cheap" : ""}</span>
              {fracPct(ivp, 0)}
            </span>
            <span className="bg-track relative h-1 overflow-hidden rounded-full">
              <span className={cn("absolute inset-y-0 left-0 rounded-full", ivp >= RICH_IVP ? "bg-warn-fill" : "bg-info-fill")} style={{ width: `${Math.max(2, ivp * 100)}%` }} />
            </span>
          </span>
        );
      },
    },
    {
      key: "support",
      head: "Support",
      hint: "Nearest zone below the close, and how far in ATRs",
      width: "md:w-[6rem]",
      sort: (r) => r.near.support?.distAtr,
      // Without a close there is nothing to measure from: a dash, not "none near".
      cell: (r) => (r.close === null ? dash : <Distance edge={r.near.support?.edge} atr={r.near.support?.distAtr} />),
      wideOnly: true,
    },
    {
      key: "resistance",
      head: "Resistance",
      hint: "Nearest zone above the close, and how far in ATRs",
      width: "md:w-[6rem]",
      sort: (r) => r.near.resistance?.distAtr,
      cell: (r) => (r.close === null ? dash : <Distance edge={r.near.resistance?.edge} atr={r.near.resistance?.distAtr} />),
      wideOnly: true,
    },
  ],
  live: [
    {
      key: "last",
      head: "Last",
      hint: "Live price in session, otherwise the close, in dollars",
      width: "md:w-[5.5rem]",
      sort: (r) => r.read.price,
      cell: (r) => <Tick value={r.read.price}>{num(r.read.price, 2)}</Tick>,
    },
    {
      key: "change",
      head: "Change",
      hint: "Change from the close, in percent",
      width: "md:w-[4.75rem]",
      sort: (r) => r.change,
      cell: (r) => (r.change === null ? dash : <span className={tone(r.change)}>{signed(r.change, 2)}%</span>),
    },
    {
      key: "moves",
      head: "Moves",
      hint: "Change from the close in one-day expected moves: 1.00 is the whole move the options market priced",
      width: "md:w-[4.25rem]",
      sort: (r) => r.moves,
      cell: (r) => (r.moves === null ? dash : <span className={tone(r.moves)}>{signed(r.moves, 2)}</span>),
      wideOnly: true,
    },
    {
      key: "room",
      head: "Room",
      hint: "Three ATRs each side of the price: support zones green, resistance red, the one-day expected move blue",
      align: "left",
      width: "",
      wideOnly: true,
      cell: (r) => {
        const view = r.read.price !== null ? roomView(r.t, r.read.price) : null;
        if (!view) return <span className="text-muted-foreground font-sans text-[0.6875rem]">no ATR, so no bar</span>;
        return (
          <RoomBar
            view={view}
            live={r.read.inSession}
            stale={r.read.stale}
            label={`${r.t.symbol}: ${view.downAtr === null ? "no support near" : `${num(view.downAtr, 1)} ATR down to support at ${num(view.down, 2)}`}, ${view.upAtr === null ? "no resistance near" : `${num(view.upAtr, 1)} ATR up to resistance at ${num(view.up, 2)}`}`}
          />
        );
      },
    },
    {
      key: "state",
      head: "State",
      hint: "Where the live price stands against the levels: a location, not a signal",
      align: "left",
      width: "md:w-[10.5rem]",
      cell: (r) =>
        r.read.inSession ? <StateChip read={r.read} /> : dash,
    },
  ],
  review: [
    { key: "trades", head: "Paper trades", hint: "Paper trades the probation rules took on this name", width: "md:w-[6.5rem]", sort: (r) => r.paper.n, cell: (r) => num(r.paper.n) },
    { key: "won", head: "Won", hint: "How many of them finished above zero", width: "md:w-[4rem]", sort: (r) => (r.paper.n > 0 ? r.paper.wins : null), cell: (r) => (r.paper.n > 0 ? num(r.paper.wins) : dash) },
    {
      key: "total",
      head: "Total, R",
      hint: "Their sum in R, measured on the stock with no option prices or costs",
      width: "md:w-[5.5rem]",
      sort: (r) => r.paper.totalR,
      cell: (r) => (r.paper.totalR === null ? dash : <span className={tone(r.paper.totalR)}>{rMult(r.paper.totalR, 2)}</span>),
    },
    {
      key: "strength",
      head: "Close",
      hint: "Where the close sat in the day's range",
      align: "left",
      width: "",
      sort: (r) => r.t.close_strength?.pos,
      cell: (r) => (r.t.close_strength?.chip ? <span className="font-sans text-xs">{CHIP_LABEL[r.t.close_strength.chip] ?? r.t.close_strength.chip}</span> : dash),
      wideOnly: true,
    },
  ],
};

/** The edition's session against the clock, in words: when it opens, when it closes, or that it has closed. */
function SessionLine({ session, halfDay }: { session: string; halfDay: boolean }) {
  const { now } = useLive();
  const day = weekDate(session);
  const clock = now === null ? null : sessionClock(session, halfDay, new Date(now));
  return (
    <p className="text-muted-foreground text-xs">
      Session <span className="text-foreground font-medium">{day}</span>
      {halfDay ? " (half day)" : ""}
      {clock === null ? null : clock.phase === "before" ? (
        <>
          {" "}
          opens in <span className="text-foreground font-mono">{clockSpan(clock.ms ?? 0)}</span>
        </>
      ) : clock.phase === "open" ? (
        <>
          {" "}
          closes in <span className="text-foreground font-mono">{clockSpan(clock.ms ?? 0)}</span>
        </>
      ) : (
        " has closed"
      )}
    </p>
  );
}

const SHORTCUTS: [string, string][] = [
  ["⌘K  Ctrl K", "Search names and actions"],
  ["J  K", "Next and previous name"],
  ["1  2  3", "Brief, Live, Review"],
  ["/", "Search"],
  ["?", "Show or hide this list"],
];

/**
 * The Options desk: one frame with the monitor of every name on the left and the selected name's map on the right.
 * The view (Brief, Live, Review) follows the New York clock until the reader picks one; the view and the selected
 * name live in the address, so a reload or a bookmark lands in the same place. Selecting a name changes nothing on
 * the server: the whole edition is already here.
 *
 * Single-key shortcuts work only while focus is inside the desk, so they never fire while typing elsewhere.
 */
export function OptionsDesk({
  e,
  live,
  initialView,
  manualView,
  initialSymbol,
  stale,
}: {
  e: Options;
  /** False for an older edition: no live feed, and the view does not follow the clock. */
  live: boolean;
  /** The view to draw first: the address's, or the one the server's clock chose. */
  initialView: DeskView;
  /** True when the address named the view, so the clock must not change it. */
  manualView: boolean;
  initialSymbol: string | null;
  stale: boolean;
}) {
  const { feed, session, now } = useLive();
  const halfDay = e.tickers.some((t) => t.half_day);
  const [picked, setPicked] = useState<DeskView | null>(manualView ? initialView : null);
  const view: DeskView = picked ?? (live && now !== null ? viewForClock(e.session, halfDay, new Date(now)) : initialView);
  const [symbol, setSymbol] = useState<string | null>(initialSymbol);
  const [sort, setSort] = useState<{ view: DeskView; key: string; dir: "asc" | "desc" } | null>(null);
  const [help, setHelp] = useState(false);
  const [palette, setPalette] = useState(false);
  const [hiddenLayers, setHiddenLayers] = useState<ReadonlySet<MapLayer>>(new Set());
  const toggleLayer = (layer: MapLayer) =>
    setHiddenLayers((cur) => {
      const next = new Set(cur);
      if (!next.delete(layer)) next.add(layer);
      return next;
    });
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const frame = useRef<HTMLElement>(null);

  const remember = useCallback((params: Record<string, string>) => {
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
      window.history.replaceState(null, "", url);
    } catch {
      // Safari refuses more than 100 of these in 30 seconds (a held key gets there). The address then lags the
      // desk for a moment; the desk itself must carry on.
    }
  }, []);

  const ok = feed.status === "ok";
  const rows: Row[] = e.tickers.map((t) => {
    const read = liveRead(t, ok ? feed.quotes[t.symbol] : undefined, session, now, ok ? feed.receivedAt : null);
    const close = t.last?.close ?? null;
    const inPlay = read.inSession && read.price !== null && close !== null && close !== 0;
    return {
      t,
      read,
      close,
      change: inPlay ? ((read.price! - close!) / close!) * 100 : null,
      moves: read.inSession ? movesFromClose(t, read.price) : null,
      near: nearest(t),
      paper: paperFor(e, t.symbol),
    };
  });

  const columns = COLUMNS[view];
  const active = sort && sort.view === view ? columns.find((c) => c.key === sort.key && c.sort) : undefined;
  const ordered = active ? sortByNumber(rows, active.sort!, sort!.dir) : view === "live" ? needsALook(rows, (r) => r.read) : rows;
  const selected = ordered.find((r) => r.t.symbol === symbol) ?? ordered[0] ?? null;
  const symbolRef = useRef<string | null>(null);
  useEffect(() => {
    symbolRef.current = selected?.t.symbol ?? null;
  });

  // Every way of choosing a name leaves focus on that name's button. A click on a table cell would otherwise
  // drop focus to the page, and the shortcuts, which only hear keys from inside the desk, would go quiet.
  const select = (s: string) => {
    setSymbol(s);
    remember({ s });
    rowButtons.current.get(s)?.focus();
  };
  const choose = (v: DeskView) => {
    setPicked(v);
    remember({ view: v });
    // Changing view replaces the column headers. If focus was on one, it is gone once they redraw: put it on the
    // selected name, so the keyboard keeps working.
    window.setTimeout(() => {
      if (!frame.current?.contains(document.activeElement)) rowButtons.current.get(symbolRef.current ?? "")?.focus();
    }, 0);
  };
  const step = (by: number) => {
    if (ordered.length === 0) return;
    const i = Math.max(0, ordered.findIndex((r) => r.t.symbol === selected?.t.symbol));
    select(ordered[(i + by + ordered.length) % ordered.length]!.t.symbol);
  };
  const cycleSort = (c: Column) => {
    if (!c.sort) return;
    setSort((cur) => (cur && cur.view === view && cur.key === c.key ? (cur.dir === "desc" ? { ...cur, dir: "asc" } : null) : { view, key: c.key, dir: "desc" }));
  };

  // Cmd K or Ctrl K opens the palette from anywhere on the page. A chord with a modifier cannot fire while
  // someone is typing a word, so unlike the single keys below it does not need focus to be in the desk.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        // A held chord repeats; without this the palette would flicker open and shut.
        if (!ev.repeat) setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // When the palette has gone, the keyboard goes to the selected name, whichever way the palette was closed.
  const focusSelected = () => window.setTimeout(() => rowButtons.current.get(symbolRef.current ?? "")?.focus(), 0);

  const onKeyDown = (ev: React.KeyboardEvent) => {
    // The palette is drawn outside the desk but its keys still bubble here through React; they are its own.
    if (palette) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const el = ev.target as HTMLElement;
    if (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
    const inMonitor = Boolean(el.closest("[data-desk-monitor]"));
    if (ev.key === "j" || (ev.key === "ArrowDown" && inMonitor)) step(1);
    else if (ev.key === "k" || (ev.key === "ArrowUp" && inMonitor)) step(-1);
    else if (ev.key === "1" || ev.key === "2" || ev.key === "3") choose(DESK_VIEWS[Number(ev.key) - 1]!);
    else if (ev.key === "/") setPalette(true);
    else if (ev.key === "?") setHelp((h) => !h);
    else if (ev.key === "Escape" && help) setHelp(false);
    else return;
    ev.preventDefault();
  };

  return (
    // The key handler only hears keys that bubble up from the desk's own buttons; the section itself takes no focus.
    <section
      ref={frame}
      aria-label="Options desk"
      data-desk-view={view}
      // Set once the browser has taken over from the server-drawn page (the clock is only read in the browser).
      // A click that lands before then is lost, so the browser tests wait for this before they touch the desk.
      data-ready={now !== null ? "true" : undefined}
      onKeyDown={onKeyDown}
      className="bg-card w-[min(calc(100vw-2rem),96rem)] justify-self-center overflow-hidden rounded-xl border xl:grid xl:h-[calc(100dvh-10.5rem)] xl:min-h-[35rem] xl:grid-rows-[auto_minmax(0,1fr)]"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b px-3 py-2">
        <div role="group" aria-label="View" className="bg-muted inline-flex rounded-md p-0.5">
          {DESK_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              title={VIEW_HINT[v]}
              onClick={(ev) => {
                // Safari does not focus a button on click; without focus in the desk the shortcuts would not hear keys.
                ev.currentTarget.focus();
                choose(v);
              }}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                view === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        <SessionLine session={e.session} halfDay={halfDay} />
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-[0.6875rem]">
            <span className={cn("inline-block size-2 rounded-full", stale ? "bg-bad-fill" : "bg-good-fill")} />
            Levels {weekDate(e.built_from)} close
          </span>
          {live ? <FeedPill /> : null}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-keyshortcuts="Meta+K Control+K"
            title="Search names and actions (Cmd K or Ctrl K)"
            onClick={() => setPalette(true)}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded px-1 text-[0.6875rem]"
          >
            <Search aria-hidden className="size-3.5" />
            Search
            <kbd aria-hidden className="bg-muted rounded px-1 font-mono text-[0.625rem]">
              ⌘K
            </kbd>
          </button>
          <button
            type="button"
            aria-expanded={help}
            aria-controls="desk-shortcuts"
            onClick={() => setHelp((h) => !h)}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded px-1 text-[0.6875rem]"
          >
            <Keyboard aria-hidden className="size-3.5" />
            Shortcuts
          </button>
        </div>
        {help ? (
          <div id="desk-shortcuts" className="text-muted-foreground flex basis-full flex-wrap items-baseline gap-x-6 gap-y-1 text-[0.6875rem]">
            <dl className="flex flex-wrap gap-x-6 gap-y-1">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={keys} className="flex items-baseline gap-2">
                  <dt className="text-foreground bg-muted rounded px-1.5 py-0.5 font-mono">{keys}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
            <p>The single keys work while focus is inside the desk. Cmd K or Ctrl K works anywhere on the page.</p>
          </div>
        ) : null}
        {stale ? (
          <p role="alert" className="text-bad flex basis-full items-start gap-2 text-sm">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            These levels were for {weekDate(e.session)}. A later session has started and no newer edition has published, so do not trade
            from them.
          </p>
        ) : null}
      </div>

      <div className="xl:grid xl:min-h-0 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div data-desk-monitor className="overflow-x-auto border-b xl:min-h-0 xl:overflow-y-auto xl:border-r xl:border-b-0">
          {/* The monitor and the selected name fail apart: a name that cannot be drawn leaves the board standing. */}
          <PaneBoundary name="The monitor">
            <table className="w-full border-collapse text-[0.8125rem] md:table-fixed">
              <caption className="sr-only">
                Every name in the {VIEW_LABEL[view]} view. Choose a name to see its level map.
              </caption>
              <colgroup>
                <col className="md:w-[5.75rem]" />
                {columns.map((c) => (
                  <col key={c.key} className={cn(c.width, c.wideOnly && "max-md:hidden")} />
                ))}
              </colgroup>
              <thead className="bg-card sticky top-0 z-10">
                <tr className="border-b">
                  <th scope="col" className="text-muted-foreground px-2 py-2 text-left text-[0.6875rem] font-medium md:px-3">
                    Name
                  </th>
                  {columns.map((c) => {
                    const dir = active?.key === c.key ? sort!.dir : null;
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        title={c.hint}
                        aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
                        className={cn("text-muted-foreground px-1.5 py-2 text-[0.6875rem] font-medium md:px-2", c.align === "left" ? "text-left" : "text-right", c.wideOnly && "max-md:hidden")}
                      >
                        {c.sort ? (
                          <button type="button" onClick={() => cycleSort(c)} className={cn("hover:text-foreground inline-flex items-center gap-0.5 rounded", dir && "text-foreground")}>
                            {c.head}
                            {dir === "asc" ? <ArrowUp aria-hidden className="size-3" /> : dir === "desc" ? <ArrowDown aria-hidden className="size-3" /> : null}
                            <span className="sr-only">: {c.hint}. Sort.</span>
                          </button>
                        ) : (
                          <>
                            {c.head}
                            <span className="sr-only">: {c.hint}</span>
                          </>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {ordered.map((r) => {
                  const on = r.t.symbol === selected?.t.symbol;
                  const testing = r.read.inSession && (r.read.state === "TESTING SUPPORT" || r.read.state === "TESTING RESISTANCE");
                  const chip = r.t.close_strength?.chip;
                  return (
                    <tr
                      key={r.t.symbol}
                      data-desk-row={r.t.symbol}
                      onClick={() => select(r.t.symbol)}
                      className={cn(
                        "h-11 cursor-pointer border-b last:border-b-0",
                        on ? "bg-accent shadow-[inset_2px_0_0_var(--primary)]" : testing ? "bg-warn-soft" : "hover:bg-muted/60",
                      )}
                    >
                      <th scope="row" className="px-2 text-left font-normal md:px-3">
                        <button
                          type="button"
                          ref={(el) => {
                            if (el) rowButtons.current.set(r.t.symbol, el);
                            else rowButtons.current.delete(r.t.symbol);
                          }}
                          aria-pressed={on}
                          className="flex items-center gap-1.5 rounded font-mono font-semibold"
                        >
                          {chip ? <span aria-hidden className={cn("inline-block size-2 rounded-[2px]", CHIP_DOT[chip])} title={CHIP_LABEL[chip] ?? chip} /> : null}
                          {r.t.symbol}
                          {chip ? <span className="sr-only">, {CHIP_LABEL[chip] ?? chip}</span> : null}
                        </button>
                      </th>
                      {columns.map((c) => (
                        <td key={c.key} className={cn("px-1.5 font-mono md:px-2", c.align === "left" ? "text-left" : "text-right", c.wideOnly && "max-md:hidden")}>
                          {c.cell(r)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </PaneBoundary>
        </div>

        <div className="xl:min-h-0 xl:overflow-y-auto">
          {selected ? (
            <PaneBoundary key={selected.t.symbol} name={selected.t.symbol}>
              <OptionsDetail e={e} t={selected.t} hiddenLayers={hiddenLayers} onToggleLayer={toggleLayer} />
            </PaneBoundary>
          ) : null}
        </div>
      </div>
      <DeskPalette
        open={palette}
        onOpenChange={setPalette}
        tickers={e.tickers}
        symbol={selected?.t.symbol ?? null}
        view={view}
        layers={selected ? mapLayersOf(selected.t) : []}
        hiddenLayers={hiddenLayers}
        onName={select}
        onView={choose}
        onLayer={toggleLayer}
        onShortcuts={() => setHelp(true)}
        onClosed={focusSelected}
      />
    </section>
  );
}
