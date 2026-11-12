"use client";

// The Feeds page's live parts (/options/feeds, DEC-0050 point 5): the board's live feed as its own answer names it, and
// per focus name plus SPY the price, the last trade's and the quote's ages, the spread and the session's 2-minute
// candles with volume. Only the board's own feed is ever asked for or drawn (the route reads ALPACA_FEED), and every
// number carries its feed's name.
//
// The poll is quote-poll.ts's startPoll: every POLL_MS, waits of 2, 4, 8 s up to 30 s after failures, Retry now, and
// nothing fetched while the tab is hidden. Ages are on the server's clock carried forward by the monotonic clock
// (feeds-live.ts serverClock), never the device's wall clock.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ageText } from "@/lib/feed-provenance";
import { candleGeometry, type LiveAnswer, liveFeedName, parseLiveAnswer, rowView, serverClock, spreadText, type RowView } from "@/lib/feeds-live";
import { type Backoff, type Poll, type PollResult, startPoll, statusResult } from "@/lib/quote-poll";
import { cn } from "@/lib/utils";

/** The wait between good answers. */
export const POLL_MS = 5_000;
/** The longest wait after failures in a row. */
export const RETRY_CAP_MS = 30_000;

type State =
  | { status: "loading" }
  | { status: "off"; why: "feed" | "plan" | null }
  | { status: "error" }
  | { status: "ok"; answer: LiveAnswer; perfReceived: number; failing: boolean };

interface Live {
  state: State;
  backoff: Backoff | null;
  retryNow: () => void;
  /** The monotonic clock, read once a second. */
  perf: number | null;
}

const Ctx = createContext<Live>({ state: { status: "loading" }, backoff: null, retryNow: () => undefined, perf: null });

export function FeedsLiveProvider({ symbols, children }: { symbols: string; children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [backoff, setBackoff] = useState<Backoff | null>(null);
  const [perf, setPerf] = useState<number | null>(null);
  const poll = useRef<Poll | null>(null);
  const retryNow = useCallback(() => poll.current?.retryNow(), []);

  useEffect(() => {
    const id = window.setInterval(() => setPerf(performance.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let stopped = false;
    const run = async (): Promise<PollResult> => {
      try {
        const res = await fetch(`/api/feeds/live?s=${encodeURIComponent(symbols)}`, { cache: "no-store" });
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
          if (!stopped) setState((s) => (s.status === "ok" ? { ...s, failing: true } : { status: "error" }));
          return r;
        }
        const answer = parseLiveAnswer(await res.json());
        if (!answer) {
          if (!stopped) setState((s) => (s.status === "ok" ? { ...s, failing: true } : { status: "error" }));
          return "error";
        }
        const now = performance.now();
        if (!stopped) {
          setState({ status: "ok", answer, perfReceived: now, failing: false });
          setPerf(now);
        }
        return "ok";
      } catch {
        if (!stopped) setState((s) => (s.status === "ok" ? { ...s, failing: true } : { status: "error" }));
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

  return <Ctx.Provider value={{ state, backoff, retryNow, perf }}>{children}</Ctx.Provider>;
}

const useFeedsLive = () => useContext(Ctx);

/** The board's live feed as the last answer named it: SIP authoritative, or IEX with a warning; never a guess. */
export function BoardFeedLine() {
  const { state } = useFeedsLive();
  if (state.status === "ok") {
    const name = liveFeedName(state.answer.feed);
    return name === "SIP" ? (
      <p data-board-feed="sip" className="text-good text-base font-semibold">
        SIP · authoritative
      </p>
    ) : (
      <p data-board-feed="iex" className="border-warn-fill/70 bg-warn-soft rounded-md border px-3 py-2 text-base font-semibold">
        IEX — the board is not on SIP yet (DEC-0050)
      </p>
    );
  }
  const why =
    state.status === "loading"
      ? "waiting for the first answer"
      : state.status === "off"
        ? state.why === "plan"
          ? "the data plan refuses SIP"
          : state.why === "feed"
            ? "the feed setting is not iex or sip"
            : "no market-data keys"
        : "the live route did not answer";
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

/** A candle chart with volume under it, drawn from the board feed's 2-minute bars. */
export function Candles({ row }: { row: RowView }) {
  const W = 320;
  const H = 120;
  const g = candleGeometry(row.bars, W, H);
  if (!g) return <p className="text-muted-foreground text-xs">No {row.feed} bars yet this session.</p>;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" role="img" aria-label={`${row.symbol} 2-minute candles on ${row.feed}, ${row.bars.length} bars, low ${g.low.toFixed(2)}, high ${g.high.toFixed(2)}, with volume`}>
      <line x1={0} x2={W} y1={g.priceHeight + 1} y2={g.priceHeight + 1} className="stroke-border" strokeWidth={1} />
      {g.candles.map((c, i) => (
        <g key={i} className={c.up ? "fill-good-fill stroke-good-fill" : "fill-bad-fill stroke-bad-fill"}>
          <line x1={c.x + c.w / 2} x2={c.x + c.w / 2} y1={c.wickTop} y2={c.wickBottom} strokeWidth={1} />
          <rect x={c.x} y={c.bodyTop} width={c.w} height={c.bodyHeight} strokeWidth={0} />
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
      <dd className={cn("font-mono text-sm tabular-nums", warn ? "text-warn" : null)}>{value}</dd>
    </div>
  );
}

function Row({ v }: { v: RowView }) {
  const age = (ms: number | null) => (ms === null ? "not available" : ageText(ms));
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
        <Stat label={`${v.feed} price`} value={v.price === null ? "not available" : v.price.toFixed(2)} />
        <Stat label={`${v.feed} last trade age`} value={age(v.tradeAgeMs)} warn={v.stale} />
        <Stat label={`${v.feed} quote age`} value={age(v.quoteAgeMs)} />
        <Stat label={`${v.feed} spread`} value={spreadText(v.spread)} warn={v.spread.kind !== "bp"} />
      </dl>
      <div className={v.stale ? "opacity-50 grayscale" : undefined}>
        <Candles row={v} />
      </div>
    </li>
  );
}

/** The live rows, one per name in `symbols` (comma-separated, in order), with the retry line when the route fails. */
export function FeedsLiveRows({ symbols }: { symbols: string }) {
  const { state, backoff, retryNow, perf } = useFeedsLive();
  const names = symbols.split(",").filter(Boolean);
  const inS = backoff ? retryIn(backoff, perf) : null;
  return (
    <div className="grid gap-3">
      <p role="status" aria-live="polite" className="text-xs">
        {backoff ? (
          <span data-feeds-retry className="flex flex-wrap items-center gap-2">
            <span className="text-warn">Live data did not answer: {backoff.at === null || !inS ? "trying again now" : `trying again in ${inS} s`}.</span>
            <Button size="sm" variant="outline" onClick={retryNow} disabled={backoff.at === null || backoff.limited}>
              Retry now
            </Button>
          </span>
        ) : null}
      </p>
      {state.status === "ok" ? (
        <ul data-feeds-live className="grid gap-3 lg:grid-cols-2">
          {names.map((s) => (
            <Row key={s} v={rowView(s, state.answer.feed, state.answer.rows[s], perf === null ? null : serverClock(state.answer.served_at, state.perfReceived, Math.max(perf, state.perfReceived)))} />
          ))}
        </ul>
      ) : (
        <p data-feeds-live-off className="text-muted-foreground text-sm">
          {state.status === "loading" ? "Waiting for the board feed's first answer." : state.status === "off" ? "Live data not available: the board feed is off on this deployment." : "Live data not available: the route did not answer."}
        </p>
      )}
    </div>
  );
}

/**
 * Children shown only until the server clock (`serverNow` at render, carried forward by the monotonic clock) reaches
 * `hideAt` (epoch ms): the sessions compared leave the page at the next open, even on a page left open.
 */
export function HideAtOpen({ serverNow, hideAt, children }: { serverNow: number; hideAt: number | null; children: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (hideAt === null) return;
    const start = performance.now();
    const check = () => {
      if (serverNow + (performance.now() - start) >= hideAt) setHidden(true);
    };
    check();
    const id = window.setInterval(check, 1_000);
    return () => window.clearInterval(id);
  }, [serverNow, hideAt]);
  return hidden ? <p className="text-muted-foreground text-sm">The session has opened: the comparison is shown again after the close.</p> : <>{children}</>;
}
