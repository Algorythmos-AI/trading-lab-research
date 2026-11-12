// What the all-switches-off proof compares (guards-off.test.ts): for one board input, the board's rows (the engine's
// output), the "Trade now" board drawn from them, and the page's other surfaces drawn from the same board: the hero,
// each name's glance chip and tile, the status rail, each name's level ladder (its live dot and distances) and the
// manage card of an open trade on the first focus name; for one slot, the server's evaluation and the engine's fields
// of its record (all but `engine`, the label, which changes with any engine file by design). Each is serialised with
// every key in its place and an undefined value written out, then hashed.
//
// It uses only what the code before the guards already had, so the same file was run on the commit before them
// (origin/integration 61f46e6) to write the pinned hashes in guards-off.golden.json.
import { createHash } from "node:crypto";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardChip, GlanceTile } from "@/components/client/focus-glance";
import { LadderLive } from "@/components/client/ladder-live";
import { LiveContext } from "@/components/client/live-layer";
import { NowHero } from "@/components/client/now-hero";
import { StatusRail } from "@/components/client/status-rail";
import { ManageCard } from "@/components/client/trade-manage";
import { type Board, BoardContext, TradeNowBoard } from "@/components/client/trade-now";
import { evaluateSlot, type EvalInput, serverRecord } from "@/lib/desk-eval";
import { focusPlan } from "@/lib/focus-plan";
import { FRAMES } from "@/lib/level-ladder";
import { manageView, type ManualNote, openTrades } from "@/lib/trade-manage";
import { type BoardInput, boardMode, boardRows } from "@/lib/trade-now";

/** JSON with an undefined value written out, so a key added as undefined still shows. */
export const serialise = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x === undefined ? "<undefined>" : x));
export const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function runBoard(input: BoardInput, live: boolean): { rows: string; html: string; surfaces: string } {
  const rows = boardRows(input, live);
  const mode = boardMode(input.session, input.halfDay, "ok", input.now);
  const states = rows.map((r) => r.state).filter((s) => s !== null);
  const paused = mode.kind === "live" && states.length > 0 && states.every((s) => s.state === "paused");
  const html = renderToStaticMarkup(createElement(TradeNowBoard, { mode, rows, now: input.now, paused, onOpen: () => undefined }));

  // The page's other surfaces, from the same board (BoardProvider's shape) and the same live feed.
  const items = [...input.items].sort((a, b) => a.rank - b.rank);
  const board: Board = {
    on: true,
    session: input.session,
    halfDay: input.halfDay,
    items,
    ticker: (s) => input.tickers.find((t) => t.symbol === s),
    premarket: {},
    closeDate: null,
    ageS: {},
    mode,
    now: input.now,
    rows,
    states,
    paused,
    barsDelayed: false,
    manage: { cards: null, rowExtra: () => null, notices: null, views: [], provisional: 0, journalLive: true } as unknown as Board["manage"],
    notices: [],
    dropNotice: () => undefined,
    log: [],
    spoken: "",
    doneFor: () => false,
    maskFor: () => null,
  };
  const asOf = new Date(input.receivedAt ?? input.now).toISOString();
  const feed = { status: "ok" as const, asOf, source: null, quotes: { ...input.quotes }, missing: [], receivedAt: input.receivedAt ?? input.now, trails: {} };
  const wrap = (node: ReactNode) =>
    renderToStaticMarkup(
      createElement(
        LiveContext.Provider,
        { value: { feed, session: input.session, now: input.now, backoff: null, retryNow: () => undefined } },
        createElement(BoardContext.Provider, { value: board }, node),
      ),
    );
  const parts: string[] = [wrap(createElement(NowHero)), wrap(createElement(StatusRail, { day: null }))];
  for (const it of items) {
    const plan = focusPlan(it);
    const t = input.tickers.find((x) => x.symbol === it.symbol);
    parts.push(wrap(createElement(BoardChip, { symbol: it.symbol })));
    // eslint-disable-next-line react/no-children-prop -- the file is run as it was on the commit before the guards
    parts.push(wrap(createElement(GlanceTile, { symbol: it.symbol, children: null })));
    const lo = Math.min(plan.put?.level ?? Infinity, plan.call?.level ?? Infinity) - 5;
    const hi = Math.max(plan.put?.level ?? -Infinity, plan.call?.level ?? -Infinity) + 5;
    parts.push(
      wrap(
        // eslint-disable-next-line react/no-children-prop -- the file is run as it was on the commit before the guards
        createElement(LadderLive, {
          symbol: it.symbol,
          session: input.session,
          halfDay: input.halfDay,
          premarket: null,
          close: t?.last?.close ?? null,
          closeDate: null,
          ceiling: plan.call?.level ?? null,
          floor: plan.put?.level ?? null,
          atr: it.atr ?? null,
          move: null,
          frame: FRAMES.desktop,
          domain: { lo: Number.isFinite(lo) ? lo : 0, hi: Number.isFinite(hi) ? hi : 1 },
          children: null,
        }),
      ),
    );
  }
  // An open trade on the first focus name: a note at its price a minute ago, on its call plan (or its put).
  const first = items[0];
  const q = first ? input.quotes[first.symbol] : undefined;
  const plan = first ? (focusPlan(first).call ?? focusPlan(first).put) : null;
  if (first && q && plan) {
    const note: ManualNote = { symbol: first.symbol, side: plan.side, price: q.price, at: new Date(input.now - 60_000).toISOString(), kind: "plan", plan };
    const [trade] = openTrades(input.items, [], [note], input.session, [], null);
    const row = rows.find((r) => r.symbol === first.symbol);
    if (trade) {
      const v = manageView(trade, {
        session: input.session,
        halfDay: input.halfDay,
        quote: q,
        trail: [],
        serverBars: input.serverBars[first.symbol] ?? [],
        serverFetchedAt: input.serverFetchedAt[first.symbol] ?? null,
        now: input.now,
        rowState: row?.state?.state ?? null,
        // only the new code knows `guards`; with every guard off a row never has any
        ...((row?.state as { guards?: unknown } | null | undefined)?.guards ? { guards: (row!.state as unknown as { guards: never }).guards } : {}),
        feed: "live",
      });
      parts.push(serialise(v), renderToStaticMarkup(createElement(ManageCard, { v })));
    }
  }
  return { rows: hash(serialise(rows)), html: hash(html), surfaces: hash(parts.join("\n")) };
}

export function runEval(input: EvalInput, evaluatedAt: number): string {
  const ev = evaluateSlot(input);
  const { engine: _engine, ...record } = serverRecord(ev, input.slot, evaluatedAt, input.edition);
  void _engine;
  return hash(serialise({ ev, record }));
}
