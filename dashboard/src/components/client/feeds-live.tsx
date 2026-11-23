"use client";

// The Feeds page's live parts (/options/feeds, DEC-0050 point 5). The price, the last trade's age, the feed's name
// and the stale verdict are the board's own: read from the page's LiveQuotes (live-layer.tsx, /api/quote) with
// feed-provenance's feedAges, as the board reads them. The top of the book and the 2-minute bars with volume, which
// the board does not carry, come from /api/feeds/live: "quote and bars, read every 5 s", through quote-poll.ts's
// startPoll (waits of 2, 4, 8 s up to 30 s after failures, Retry now, nothing fetched while the tab is hidden).
//
// Fail closed: while a source is failing its numbers are "not available"; after the tab was hidden (or the timers
// stood still) the clock is not trusted until a new answer comes; "Sessions compared" leaves the page at the next open
// and whenever the server time cannot be vouched for (compareShown).
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { feedAges, feedLabel } from "@/lib/feed-provenance";
import {
  candleGeometry,
  compareShown,
  type LiveAnswer,
  liveFeedName,
  oldRender,
  PANEL_MAX_AGE_MS,
  panelOutOfDate,
  parseLiveAnswer,
  ROUTE_FAILED,
  rowView,
  serverClock,
  spreadText,
  tickWoke,
  type RowView,
} from "@/lib/feeds-live";
import { type Backoff, type Poll, type PollResult, startPoll, statusResult } from "@/lib/quote-poll";
import { cn } from "@/lib/utils";
import { liveRead, type LiveRead, type OptionsTicker } from "@/lib/options";
import { useLive } from "./live-layer";

/** The wait between good answers. */
export const POLL_MS = 5_000;
/** The longest wait after failures in a row. */
export const RETRY_CAP_MS = 30_000;
/** A gap this long between one-second ticks means the timers stood still (a hidden tab, a sleeping machine). */
export const TICK_GAP_MS = 5_000;
/** A 5 s read that has not answered in this long is a failure. */
export const FETCH_TIMEOUT_MS = 4_000;
/** The page is rendered again on the server this often while it is open. */
export const REFRESH_MS = 60_000;

type State =
  | { status: "loading" }
  | { status: "off"; why: "feed" | "plan" | null }
  | { status: "error" }
  | { status: "ok"; answer: LiveAnswer; perfReceived: number; failing: boolean };

interface Wake {
  /** The monotonic and wall times the tab was last shown again after a hidden period; null when it never was. */
  perf: number | null;
  wall: number | null;
}

interface Live {
  state: State;
  backoff: Backoff | null;
  retryNow: () => void;
  /** The monotonic clock, read once a second; null before the page runs. */
  perf: number | null;
  wake: Wake;
}

const Ctx = createContext<Live>({ state: { status: "loading" }, backoff: null, retryNow: () => undefined, perf: null, wake: { perf: null, wall: null } });

/** The last time the tab came back from a hidden period (visibilitychange, a bfcache restore, or timers that stood still). */
function useWake(): { wake: Wake; perf: number | null } {
  const [wake, setWake] = useState<Wake>({ perf: null, wall: null });
  const [perf, setPerf] = useState<number | null>(null);
  useEffect(() => {
    let last = { perf: performance.now(), wall: Date.now() };
    const woke = () => setWake({ perf: performance.now(), wall: Date.now() });
    const onVis = () => {
      if (document.visibilityState === "visible") woke();
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) woke();
    };
    const id = window.setInterval(() => {
      // Either clock can miss a sleep the other sees; a wall clock that jumps (either way) counts as one too.
      const now = { perf: performance.now(), wall: Date.now() };
      if (tickWoke(last, now, TICK_GAP_MS)) woke();
      last = now;
      setPerf(now.perf);
    }, 1_000);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);
  return { wake, perf };
}

export function FeedsLiveProvider({ symbols, children }: { symbols: string; children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [backoff, setBackoff] = useState<Backoff | null>(null);
  const { wake, perf } = useWake();
  const poll = useRef<Poll | null>(null);
  const retryNow = useCallback(() => poll.current?.retryNow(), []);

  useEffect(() => {
    let stopped = false;
    const failed = () => {
      if (!stopped) setState((s) => (s.status === "ok" ? { ...s, failing: true } : { status: "error" }));
    };
    const run = async (): Promise<PollResult> => {
      try {
        // A read that hangs is a failure, not a pause: the rows grey and the comparison hides.
        const res = await fetch(`/api/feeds/live?s=${encodeURIComponent(symbols)}`, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const r = statusResult(res.status);
        if (r === "off") {
          const why = await res
            .json()
            .then((b: { why?: unknown }) => (b?.why === "feed" || b?.why === "plan" ? b.why : null))
            .catch(() => null);
          if (!stopped) setState({ status: "off", why });
          return "off";
        }
        if (r !== "ok") {
          failed();
          return r;
        }
        const answer = parseLiveAnswer(await res.json());
        if (!answer) {
          failed();
          return "error";
        }
        if (!stopped) setState({ status: "ok", answer, perfReceived: performance.now(), failing: false });
        return "ok";
      } catch {
        failed();
        return "error";
      }
    };
    const p = startPoll({
      run,
      page: document,
      show: window,
      now: () => performance.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      pollMs: POLL_MS,
      backoff: { capMs: RETRY_CAP_MS },
      onBackoff: setBackoff,
    });
    poll.current = p;
    return () => {
      stopped = true;
      p.stop();
      if (poll.current === p) poll.current = null;
    };
  }, [symbols]);

  return <Ctx.Provider value={{ state, backoff, retryNow, perf, wake }}>{children}</Ctx.Provider>;
}

const useFeedsLive = () => useContext(Ctx);

/** The board's live feed as the board's own quotes answer names it: SIP authoritative, or IEX with a warning; never a guess. */
export function BoardFeedLine() {
  const { feed } = useLive();
  const name = feed.status === "ok" ? feedLabel(feed.source) : null;
  if (name === "SIP")
    return (
      <p data-board-feed="sip" className="text-good text-base font-semibold">
        SIP · authoritative
      </p>
    );
  if (name === "IEX")
    return (
      <p data-board-feed="iex" className="border-warn-fill/70 bg-warn-soft rounded-md border px-3 py-2 text-base font-semibold">
        IEX — the board is not on SIP yet (DEC-0050)
      </p>
    );
  const why =
    feed.status === "loading"
      ? "waiting for the first answer"
      : feed.status === "off"
        ? feed.why === "plan"
          ? "the data plan refuses SIP"
          : feed.why === "feed"
            ? "the feed setting is not iex or sip"
            : "no market-data keys"
        : feed.status === "error"
          ? "the live prices did not answer"
          : "the answer named no feed";
  return (
    <p data-board-feed="unknown" className="text-warn text-base font-semibold">
      Board feed not available ({why})
    </p>
  );
}

function retryIn(b: Backoff, perf: number | null): number | null {
  if (b.at === null || perf === null) return null;
  return Math.max(0, Math.ceil((b.at - perf) / 1000));
}

/** A candle chart with volume under it, from the board feed's 2-minute bars; the forming bar is drawn hollow. */
export function Candles({ row }: { row: RowView }) {
  const W = 320;
  const H = 120;
  if (row.bars === null) return <p className="text-warn text-xs">{row.bookFeed ?? "Board feed"} bars not available (cut short).</p>;
  const g = candleGeometry(row.bars, W, H);
  if (!g) return <p className="text-muted-foreground text-xs">No {row.bookFeed ?? "board feed"} bars yet this session.</p>;
  const forming = row.bars[row.bars.length - 1]?.forming === true;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-28 w-full"
      role="img"
      aria-label={`${row.symbol} 2-minute candles on ${row.bookFeed ?? "the board feed"}, ${row.bars.length} bars${forming ? ", the last still forming" : ""}, low ${g.low.toFixed(2)}, high ${g.high.toFixed(2)}, with volume`}
    >
      <line x1={0} x2={W} y1={g.priceHeight + 1} y2={g.priceHeight + 1} className="stroke-border" strokeWidth={1} />
      {g.candles.map((c, i) => (
        <g key={i} data-forming={c.forming ? "true" : undefined} className={c.up ? "fill-good-fill stroke-good-fill" : "fill-bad-fill stroke-bad-fill"}>
          <line x1={c.x + c.w / 2} x2={c.x + c.w / 2} y1={c.wickTop} y2={c.wickBottom} strokeWidth={1} />
          <rect x={c.x} y={c.bodyTop} width={c.w} height={c.bodyHeight} strokeWidth={c.forming ? 1 : 0} fillOpacity={c.forming ? 0 : 1} />
          {c.volTop !== null ? <rect x={c.x} y={c.volTop} width={c.w} height={c.volHeight} className="fill-muted-foreground/50" strokeWidth={0} /> : null}
        </g>
      ))}
    </svg>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn("font-mono text-sm tabular-nums break-words", warn ? "text-warn" : null)}>{value}</dd>
    </div>
  );
}

function Row({ v }: { v: RowView }) {
  const pf = v.priceFeed ?? "Board feed";
  const bf = v.bookFeed ?? "Board feed";
  return (
    <li data-feeds-row={v.symbol} data-stale={v.stale ? "true" : "false"} className={cn("bg-card grid min-w-0 gap-2 rounded-lg border p-3", v.stale ? "bg-muted border-dashed" : null)}>
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-base font-semibold">{v.symbol}</span>
        {v.staleLine ? (
          <span data-stale-line className="text-warn text-xs font-semibold">
            {v.staleLine}
          </span>
        ) : null}
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={`${pf} price (the board's)`} value={v.price} warn={v.stale} />
        <Stat label={`${pf} last trade age`} value={v.tradeAge} warn={v.stale} />
        <Stat label={`${bf} quote age`} value={v.quoteAge} />
        <Stat label={`${bf} spread`} value={spreadText(v.spread)} warn={v.spread.kind !== "bp"} />
      </dl>
      <div className={v.stale ? "opacity-50 grayscale" : undefined}>
        <Candles row={v} />
      </div>
    </li>
  );
}

/** The live rows, one per name in `symbols` (comma-separated, in order), with the retry line when the 5 s read fails. */
export function FeedsLiveRows({ symbols, tickers }: { symbols: string; tickers: readonly OptionsTicker[] }) {
  const { state, backoff, retryNow, perf, wake } = useFeedsLive();
  const live = useLive();
  const names = symbols.split(",").filter(Boolean);
  const inS = backoff ? retryIn(backoff, perf) : null;
  const q = live.feed;
  const quotesOk = q.status === "ok";
  const quotesFailing = !quotesOk || live.backoff !== null;
  const quotesSlept = quotesOk && wake.wall !== null && q.receivedAt < wake.wall;
  // The session passed as the board's own line passes it, so a trade from another day is "no trade today".
  const ages = (s: string) => (quotesOk && live.now !== null ? feedAges({ asOf: q.asOf, receivedAt: q.receivedAt, quotes: q.quotes }, [s], live.now, live.session || null) : null);
  // The board's per-name read (the one behind its state chip), for the names the edition has.
  const read = (s: string): LiveRead | null => {
    const t = tickers.find((x) => x.symbol === s);
    if (!t || !quotesOk || !q.quotes[s]) return null;
    return liveRead(t, q.quotes[s], live.session, live.now, q.receivedAt);
  };
  const book = state.status === "ok" ? state : null;
  const bookSlept = book !== null && wake.perf !== null && book.perfReceived < wake.perf;
  const bookFailing = book === null || book.failing;
  const clock = book && perf !== null ? serverClock(book.answer.served_at, book.perfReceived, Math.max(perf, book.perfReceived)) : null;
  return (
    <div className="grid gap-3">
      <p role="status" aria-live="polite" className="text-xs">
        {backoff ? (
          <span data-feeds-retry className="flex flex-wrap items-center gap-2">
            <span className="text-warn">Quote and bars did not answer: {backoff.at === null || !inS ? "trying again now" : `trying again in ${inS} s`}.</span>
            <Button size="sm" variant="outline" onClick={retryNow} disabled={backoff.at === null || backoff.limited}>
              Retry now
            </Button>
          </span>
        ) : null}
      </p>
      {quotesOk || book ? (
        <ul data-feeds-live className="grid gap-3 lg:grid-cols-2">
          {names.map((s) => {
            const a = ages(s);
            const v = rowView(
              s,
              {
                feed: quotesOk ? feedLabel(q.source) : null,
                read: read(s),
                tradeAgeMs: a?.trade.traded ? a.trade.newestMs : null,
                noTradeToday: a !== null && a.trade.noTrade > 0,
                failing: quotesFailing,
                slept: quotesSlept,
              },
              {
                feed: book ? liveFeedName(book.answer.feed) : null,
                row: book?.answer.rows[s],
                clock,
                servedAt: book ? Date.parse(book.answer.served_at) : null,
                failing: bookFailing,
                slept: bookSlept,
              },
            );
            return <Row key={s} v={v} />;
          })}
        </ul>
      ) : (
        <p data-feeds-live-off className="text-muted-foreground text-sm">
          {state.status === "loading" || q.status === "loading" ? "Waiting for the board feed's first answer." : state.status === "off" && q.status === "off" ? "Live data not available: the board feed is off on this deployment." : `Live data ${ROUTE_FAILED}.`}
        </p>
      )}
    </div>
  );
}

/** When HideAtOpen last asked for a refresh of an old render (performance.now()), for the whole page. */
let lastOldRefresh = -Infinity;

/**
 * "Sessions compared", shown only while the server time is known to be before `hideAt` (the next open). The time is
 * the render's (`serverNow`) or the newest 5 s answer's, carried forward by the monotonic clock. Hidden while that
 * read is failing and after the tab was hidden, until a fresh answer vouches for the time again (compareShown).
 */
export function HideAtOpen({ serverNow, hideAt, children }: { serverNow: number; hideAt: number | null; children: ReactNode }) {
  const { state, perf, wake } = useFeedsLive();
  const router = useRouter();
  // The monotonic time of this mount; the page keys this part by `serverNow`, so a new render starts afresh. Only an
  // answer received after it vouches for the server time (a back/forward restore can bring an old render).
  const [mountPerf] = useState<number | null>(() => (typeof performance === "undefined" ? null : performance.now()));
  // At most once a REFRESH_MS for the page, not once a mount: the page keys this part by `serverNow`, so with the
  // computer's clock far from the server's each new render would read "old" again and ask for the next one at once.
  useEffect(() => {
    if (!oldRender(serverNow, Date.now())) return;
    const at = performance.now();
    if (at - lastOldRefresh < REFRESH_MS) return;
    lastOldRefresh = at;
    router.refresh();
  }, [serverNow, router]);
  const book = state.status === "ok" ? state : null;
  const shown = compareShown({
    hideAt,
    mountPerf,
    perfNow: perf,
    answer: book ? { servedAt: Date.parse(book.answer.served_at), perfReceived: book.perfReceived, failing: book.failing } : null,
    routeError: state.status === "error" || state.status === "off",
    wakePerf: wake.perf,
  });
  return shown ? (
    <>{children}</>
  ) : (
    <p data-compared-hidden className="text-muted-foreground text-sm">
      Not shown now: the comparison is drawn only once a fresh answer shows the server time is before the next open.
    </p>
  );
}

/**
 * The stamp panel's freshness: "out of date" once more than PANEL_MAX_AGE_MS have passed since this render on the
 * monotonic clock, or the tab was hidden since, until the next server render (PageRefresh) replaces it. Keyed by
 * the render's time where it is used, so each render starts afresh.
 */
export function FreshPanel({ children }: { children: ReactNode }) {
  const { perf, wake } = useFeedsLive();
  const [start] = useState<number | null>(() => (typeof performance === "undefined" ? null : performance.now()));
  const since = start === null || perf === null ? 0 : perf - start;
  const out = start !== null && panelOutOfDate(since, wake.perf !== null && wake.perf >= start);
  return (
    <div data-stamp-fresh={out ? "out-of-date" : "ok"} className={cn("grid gap-2", out ? "border-warn-fill/70 bg-warn-soft rounded-md border p-2" : null)}>
      {out ? (
        <p role="status" className="text-warn text-sm font-semibold">
          Out of date: more than {Math.round(PANEL_MAX_AGE_MS / 60_000)} min since this was read, or the tab was hidden. Refreshing.
        </p>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The page's own refresh: once at once when it is restored from the back-forward cache (an old render brought back).
 * The minute refresh and the one when the tab is shown again are the layout's (AutoRefresh, guarded so a second one
 * never starts while the last is still being drawn); this page used to run its own copy of both, so it refreshed
 * twice a minute and twice on every tab switch.
 */
export function PageRefresh() {
  const router = useRouter();
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && document.visibilityState === "visible") router.refresh();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [router]);
  return null;
}
