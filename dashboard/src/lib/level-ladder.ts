// The price ladder of a focus name: its levels drawn to scale on one vertical axis, with the no-trade box between the
// ceiling and the floor, each side's entry, stop and targets, the four alternative triggers as small markers, and the
// price. This file is the geometry and the words only: where every level, label and marker sits, and what the price
// dot says in each board mode. The drawing is components/level-ladder.tsx; the live dot is client/ladder-live.tsx.
//
// Pure: no I/O, no React, no clock. Advisory and read-only: nothing here suggests placing an order.
import { spread } from "./chart-geometry";
import { CHART_CODE } from "./chart-code";
import { type AltCondition, type ChartLine, levelWords, type SidePlan } from "./focus-plan";
import type { BoardMode } from "./trade-now";

/** The axis never spans less than this many ATRs: a narrow day still reads as a narrow day, not a cliff. */
export const LADDER_MIN_ATR = 1.5;
/** ...nor more than this many: further levels become edge chevrons with their price. */
export const LADDER_MAX_ATR = 8;
/** A week or month level gets a label only within this many ATRs of the price (or when it is a target). */
export const NEAR_ATR = 0.5;
/** Room above the highest and below the lowest price drawn, in ATRs. */
export const LADDER_PAD_ATR = 0.15;

export type LadderSide = "call" | "put";
export type LadderRole = "ceiling" | "floor" | "week" | "month" | "target" | "entry" | "stop";

export interface LadderRow {
  key: string;
  price: number;
  role: LadderRole;
  /** The side this row belongs to; null for a week or month line that is no side's target. */
  side: LadderSide | null;
  /** The short visible tag: "Ceiling", "T1", "PWH", "▲ in", "× stop". */
  tag: string;
  /** The words for the hidden list: "yesterday's high", "call entry". */
  name: string;
  /** The line style in words for the hidden list: "red, solid, thick". */
  style: string;
  /** A second target farther from the close than the name's 1-day expected move. */
  beyondMove: boolean;
  /**
   * Drawn with a label. Hidden rows stay in the hidden list for a screen reader: entry and stop show only for the
   * highlighted side, and week or month levels only near the price or when they are a target.
   */
  visible: boolean;
  /** The line's y; at the top or bottom edge when the price is off the scale. */
  y: number;
  /** The label's y after de-collision. */
  labelY: number;
  offscale: "above" | "below" | null;
}

export interface LadderMarker {
  key: string;
  kind: AltCondition["kind"];
  side: LadderSide;
  level: number;
  glyph: string;
  word: "fail" | "sweep";
  /** "↩ fail → put", "⤓ sweep → call". */
  label: string;
  /** The phone's short form: "↩ put", "⤓ call". */
  short: string;
  y: number;
  labelY: number;
}

/** A short note: the box's "no trade inside" (inside the box), a target's "beyond 1-day move" (under its label). */
export interface LadderNote {
  key: string;
  kind: "box" | "beyond";
  side: LadderSide | null;
  text: string;
  y: number;
  labelY: number;
}

export interface LadderGeometry {
  domain: { lo: number; hi: number };
  /** Price to y in the frame: higher prices higher up. Not clamped. */
  y: (p: number) => number;
  /** The y band the axis draws in. */
  frame: { top: number; bottom: number; height: number };
  /** Highest price first, like a chart's axis. */
  rows: LadderRow[];
  /** The no-trade box between floor and ceiling, clipped to the scale; null without both triggers. */
  box: { lo: number; hi: number; top: number; bottom: number } | null;
  markers: LadderMarker[];
  notes: LadderNote[];
}

export interface LadderInput {
  /** chartLevels(item, levels). */
  lines: readonly ChartLine[];
  /** focusPlan(item). */
  plans: { call: SidePlan | null; put: SidePlan | null };
  /** altTriggers(plans, atr). */
  alts: readonly AltCondition[];
  atr: number | null | undefined;
  /** The day's range to keep on the scale (high and low), when known. */
  range?: { high: number | null | undefined; low: number | null | undefined } | null;
  /** The price the ladder is drawn around: the pre-market price or the close. */
  price?: number | null;
  height: number;
  /** Space kept free at the top and bottom of the frame for labels, px. */
  pad?: number;
  /** Least distance between two labels, px (the label's font size plus a little). */
  labelGap?: number;
  /** Least distance between two marker-column labels, px. */
  markerGap?: number;
  /** The name's 1-day expected move ($), for the "beyond 1-day move" mark on a second target. */
  expectedMove?: number | null;
  /** The side the board highlights: only its entry and stop get a label. */
  highlight?: LadderSide | null;
  /** Where the expected move is measured from: the close. */
  reference?: number | null;
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const cent = (p: number) => p.toFixed(2);
const posAtr = (a: number | null | undefined) => (fin(a) && a > 0 ? a : null);

/** The scale: every price that must show, padded, with its span kept between LADDER_MIN_ATR and LADDER_MAX_ATR. */
export function ladderDomain(
  prices: readonly number[],
  atr: number | null | undefined,
  anchor: { ceiling: number | null; floor: number | null },
): { lo: number; hi: number } {
  const ps = prices.filter(fin);
  if (!ps.length) return { lo: 0, hi: 1 };
  let lo = Math.min(...ps);
  let hi = Math.max(...ps);
  const a = posAtr(atr);
  const pad = a ? LADDER_PAD_ATR * a : Math.max((hi - lo) * 0.05, Math.abs(hi) * 0.001, 0.01);
  lo -= pad;
  hi += pad;
  if (!a) return { lo, hi };
  const min = LADDER_MIN_ATR * a;
  const max = LADDER_MAX_ATR * a;
  if (hi - lo < min) {
    const c = (lo + hi) / 2;
    return { lo: c - min / 2, hi: c + min / 2 };
  }
  if (hi - lo > max) {
    // Too wide: centre on the no-trade box, so both triggers stay on the scale and far levels go to the edges.
    const { ceiling, floor } = anchor;
    const c = fin(ceiling) && fin(floor) ? (ceiling + floor) / 2 : fin(ceiling) ? ceiling : fin(floor) ? floor : (lo + hi) / 2;
    return { lo: c - max / 2, hi: c + max / 2 };
  }
  return { lo, hi };
}

/**
 * Places labels so none overlaps: the ceiling's and floor's labels first, at their own lines, then the rest spread in
 * the room above, between and below them. When a stretch is too small for its labels, every label is spread at once.
 */
export function placeLabels(rows: LadderRow[], gap: number, top: number, bottom: number): void {
  for (const r of rows) r.labelY = r.y;
  const pins = rows.filter((r) => r.role === "ceiling" || r.role === "floor").sort((a, b) => a.y - b.y);
  if (pins.length > 1) {
    const ys = pins.map((p) => ({ y: p.y }));
    spread(ys, gap, top, bottom);
    pins.forEach((p, i) => (p.labelY = ys[i]!.y));
  } else if (pins.length === 1) pins[0]!.labelY = Math.min(bottom, Math.max(top, pins[0]!.y));
  const rest = rows.filter((r) => !pins.includes(r));
  // Which stretch a row falls in: by price against the pins (higher price, higher up).
  const stretches: LadderRow[][] = Array.from({ length: pins.length + 1 }, () => []);
  for (const r of rest) {
    let i = 0;
    while (i < pins.length && r.price < pins[i]!.price) i++;
    stretches[i]!.push(r);
  }
  const feasible = stretches.every((s, i) => {
    if (!s.length) return true;
    const from = i === 0 ? top : pins[i - 1]!.labelY + gap;
    const to = i === pins.length ? bottom : pins[i]!.labelY - gap;
    return to - from >= (s.length - 1) * gap;
  });
  if (!feasible) {
    // Nothing fits as placed: every label in one pass, in price order. The pins still keep their order.
    const all = rows.map((r) => ({ r, y: r.y }));
    spread(all, gap, top, bottom);
    for (const x of all) x.r.labelY = x.y;
    return;
  }
  stretches.forEach((s, i) => {
    if (!s.length) return;
    const from = i === 0 ? top : pins[i - 1]!.labelY + gap;
    const to = i === pins.length ? bottom : pins[i]!.labelY - gap;
    const ys = s.map((r) => ({ r, y: Math.min(to, Math.max(from, r.y)) }));
    spread(ys, gap, from, to);
    for (const x of ys) x.r.labelY = x.y;
  });
}

const STYLE = (k: keyof typeof CHART_CODE) => `${CHART_CODE[k].colour.toLowerCase()}, ${CHART_CODE[k].line}`;

/** The geometry of one name's ladder. */
export function ladderGeometry(input: LadderInput): LadderGeometry {
  const { lines, plans, alts, height } = input;
  const pad = input.pad ?? 14;
  const gap = input.labelGap ?? 19;
  const markerGap = input.markerGap ?? 17;
  const top = pad;
  const bottom = height - pad;
  const atr = posAtr(input.atr);
  const { call, put } = plans;

  const prices: number[] = [...lines.map((l) => l.price)];
  for (const p of [call, put]) {
    if (!p) continue;
    prices.push(p.level);
    for (const v of [p.entry, p.stop, p.target1, p.target2?.price]) if (fin(v)) prices.push(v);
  }
  if (input.range) for (const v of [input.range.high, input.range.low]) if (fin(v)) prices.push(v);
  if (fin(input.price)) prices.push(input.price);
  const domain = ladderDomain(prices, atr, { ceiling: call?.level ?? null, floor: put?.level ?? null });
  const y = (p: number) => top + ((domain.hi - p) / (domain.hi - domain.lo)) * (bottom - top);
  const at = (p: number) => ({
    y: y(Math.min(domain.hi, Math.max(domain.lo, p))),
    offscale: p > domain.hi ? ("above" as const) : p < domain.lo ? ("below" as const) : null,
  });

  const rows: LadderRow[] = [];
  const has = (p: number) => rows.some((r) => cent(r.price) === cent(p));
  const add = (r: Omit<LadderRow, "y" | "labelY" | "offscale" | "beyondMove" | "visible"> & { beyondMove?: boolean }) =>
    rows.push({ beyondMove: false, visible: true, ...r, ...at(r.price), labelY: 0 });

  // 1. The chart lines: ceiling, floor, the week and month levels near them, and the targets the card draws.
  for (const l of lines) {
    const tShort = l.targets.map((t) => (/target 2$/.test(t) ? "T2" : "T1"));
    const tSide = l.targets.map((t) => (t.startsWith("call") ? "call" : "put") as LadderSide);
    const code = l.codes[0] ?? "";
    const words = levelWords(l.codes.join("/"));
    const side: LadderSide | null = l.kind === "ceiling" ? "call" : l.kind === "floor" ? "put" : (tSide[0] ?? null);
    const tag =
      l.kind === "ceiling"
        ? "Ceiling"
        : l.kind === "floor"
          ? "Floor"
          : l.kind === "target"
            ? [...new Set(tShort)].join(" ")
            : // A week or month level that is a target reads "T2" (its code is in the hidden list): short tags keep the
              // price column clear on a phone.
              tShort.length
              ? [...new Set(tShort)].join(" ")
              : code;
    const name = [words, ...l.targets].filter(Boolean).join(", ") || CHART_CODE[l.kind].what.toLowerCase();
    add({ key: `${l.kind}-${cent(l.price)}`, price: l.price, role: l.kind, side, tag, name, style: STYLE(l.kind) });
  }
  // 2. Each side's entry and stop (glyphs on the line area), and any target the chart lines left out.
  for (const p of [call, put]) {
    if (!p) continue;
    const up = p.side === "call";
    if (!has(p.level))
      add({ key: `${up ? "ceiling" : "floor"}-${cent(p.level)}`, price: p.level, role: up ? "ceiling" : "floor", side: p.side, tag: up ? "Ceiling" : "Floor", name: levelWords(p.levelName), style: STYLE(up ? "ceiling" : "floor") });
    if (fin(p.entry)) add({ key: `${p.side}-entry`, price: p.entry, role: "entry", side: p.side, tag: up ? "▲ in" : "▼ in", name: `${p.side} entry`, style: up ? "up triangle" : "down triangle" });
    if (fin(p.stop)) add({ key: `${p.side}-stop`, price: p.stop, role: "stop", side: p.side, tag: "× stop", name: `${p.side} stop`, style: "cross" });
    if (fin(p.target1) && !has(p.target1)) add({ key: `${p.side}-t1`, price: p.target1, role: "target", side: p.side, tag: "T1", name: `${p.side} target 1`, style: "grey, thin tick" });
    if (p.target2 && !has(p.target2.price))
      add({ key: `${p.side}-t2`, price: p.target2.price, role: "target", side: p.side, tag: "T2", name: [levelWords(p.target2.name), `${p.side} target 2`].filter(Boolean).join(", "), style: "grey, thin tick" });
  }
  // 3. A second target past the 1-day expected move, measured from the close. Its note is a second line under (or,
  // for a call, over) the target's label in the label column, so it takes a label's room of its own.
  const notes: LadderNote[] = [];
  const phantoms: { row: LadderRow; note: LadderNote }[] = [];
  const move = fin(input.expectedMove) && input.expectedMove > 0 ? input.expectedMove : null;
  if (move !== null && fin(input.reference))
    for (const p of [call, put]) {
      if (!p?.target2) continue;
      if (Math.abs(p.target2.price - input.reference) <= move) continue;
      const r = rows.find((x) => cent(x.price) === cent(p.target2!.price));
      if (!r) continue;
      r.beyondMove = true;
      const note: LadderNote = { key: `${p.side}-beyond`, kind: "beyond", side: p.side, text: "beyond 1-day move", y: r.y, labelY: r.y };
      notes.push(note);
      // A stand-in row just outside the target, so the label placement keeps a line free for the note.
      const out = p.side === "call" ? 1 : -1;
      phantoms.push({ note, row: { ...r, key: `${r.key}-note`, price: r.price + out * 1e-6, y: r.y - out * 1e-6 } });
    }
  // 4. Fewer labels: entry and stop only for the highlighted side (the decision strips carry both sides), and a week
  // or month level only when it is a target or within NEAR_ATR of the price.
  const near = atr && fin(input.price) ? NEAR_ATR * atr : null;
  for (const r of rows) {
    if (r.role === "entry" || r.role === "stop") r.visible = !!input.highlight && r.side === input.highlight;
    if ((r.role === "week" || r.role === "month") && !/^T[12]/.test(r.tag)) r.visible = near !== null && Math.abs(r.price - input.price!) <= near;
  }
  rows.sort((a, b) => b.price - a.price);
  for (const r of rows) r.labelY = r.y;
  const placing = [...rows.filter((r) => r.visible), ...phantoms.map((x) => x.row)].sort((a, b) => b.price - a.price);
  placeLabels(placing, gap, top, bottom);
  for (const x of phantoms) x.note.labelY = x.row.labelY;

  // 4. The box (its note sits inside it), and the alternative triggers at its edges.
  const box =
    call && put && call.level > put.level
      ? { hi: call.level, lo: put.level, top: at(call.level).y, bottom: at(put.level).y }
      : null;
  if (box) {
    const mid = (box.top + box.bottom) / 2;
    notes.push({ key: "box", kind: "box", side: null, text: "no trade inside", y: mid, labelY: mid });
  }
  const markers: LadderMarker[] = alts.map((a) => {
    const atCeiling = a.side === "put";
    const glyph = a.kind === "failed_break" ? "↩" : atCeiling ? "⤒" : "⤓";
    const word = a.kind === "failed_break" ? ("fail" as const) : ("sweep" as const);
    const ly = at(a.level).y;
    // A failed break sits on the outside of its line, a sweep on the inside: the two never start on one spot.
    const nudge = (a.kind === "failed_break") === atCeiling ? -markerGap / 2 : markerGap / 2;
    return { key: `${a.kind}-${a.side}`, kind: a.kind, side: a.side, level: a.level, glyph, word, label: `${glyph} ${word} → ${a.side}`, short: `${glyph} ${a.side}`, y: ly, labelY: ly + nudge };
  });
  const column = markers.map((m) => ({ m, y: m.labelY }));
  spread(column, markerGap, top, bottom);
  for (const c of column) c.m.labelY = c.y;

  return { domain, y, frame: { top, bottom, height }, rows, box, markers, notes };
}

// ---- the price dot ----------------------------------------------------------------------------------------------
export type LadderDotKind = "live" | "stale" | "pre" | "close";

export interface LadderDistance {
  to: "ceiling" | "floor";
  level: number;
  /** "1.18 away · 0.2× move", or "+0.4 ATR past" once the price is through the trigger. */
  text: string;
  /** $ from the price to the trigger; 0 once through it. */
  dist: number;
  /** The nearer of the two triggers (listed first). */
  near: boolean;
}

export interface LadderLiveView {
  /** What the dot shows, or null for no dot. Live is filled; the others are hollow. */
  dot: { kind: LadderDotKind; price: number; label: string } | null;
  /** A short line when there is no dot or the dot is not live: "Prices off: static plan". */
  caption: string | null;
  /** Distances to the two triggers: only from a live, fresh price, or from the pre-market price before the open. */
  distances: LadderDistance[];
  /** Where the distances are measured from. */
  from: "live" | "pre" | null;
}

export const OFF_CAPTION = "Prices off: static plan";
export const PAUSED_CAPTION = "Prices paused: static plan";
export const CONNECTING_CAPTION = "Connecting to live prices";

/** Distance from a price to each trigger, in $ and in 1-day moves (ATRs without a move); past the trigger, in ATRs. */
export function triggerDistances(
  price: number,
  ceiling: number | null | undefined,
  floor: number | null | undefined,
  atr: number | null | undefined,
  move: number | null | undefined,
): LadderDistance[] {
  const a = posAtr(atr);
  const m = posAtr(move);
  const away = (d: number) => `${d.toFixed(2)} away${m ? ` · ${(d / m).toFixed(1)}× move` : a ? ` · ${(d / a).toFixed(1)} ATR` : ""}`;
  const past = (d: number) => (a ? `+${(d / a).toFixed(1)} ATR past` : `+${d.toFixed(2)} past`);
  const out: LadderDistance[] = [];
  if (fin(ceiling)) out.push({ to: "ceiling", level: ceiling, text: price > ceiling ? past(price - ceiling) : away(ceiling - price), dist: Math.max(0, ceiling - price), near: false });
  if (fin(floor)) out.push({ to: "floor", level: floor, text: price < floor ? past(floor - price) : away(price - floor), dist: Math.max(0, price - floor), near: false });
  out.sort((a, b) => a.dist - b.dist);
  if (out[0]) out[0].near = true;
  return out;
}

export interface LadderLiveInput {
  /** The board's mode (trade-now's boardMode), or "loading" before the clock is known. */
  mode: BoardMode["kind"];
  /** The board would show this name as "prices paused": no quote, or the feed or the trade too old. */
  paused: boolean;
  /** The name off the live feed (options.ts liveRead). */
  read: { price: number | null; inSession: boolean; stale: boolean; ageS: number | null };
  /** The live quote's New York time, "10:14". */
  liveAt: string | null;
  /** The pre-market price on the focus card, if any. */
  premarket: number | null;
  /** The edition's close. */
  close: number | null;
  /** The session has closed today (the dot shows the day's last price as a close). */
  afterClose: boolean;
  /** The day's last price after the close, if the feed has one. */
  lastPrice?: number | null;
  ceiling: number | null;
  floor: number | null;
  atr: number | null | undefined;
  move: number | null | undefined;
}

/** What the price dot, its label and the distances say in each board mode. */
export function ladderLiveView(i: LadderLiveInput): LadderLiveView {
  const none = (caption: string | null): LadderLiveView => ({ dot: null, caption, distances: [], from: null });
  switch (i.mode) {
    case "old":
    case "off":
      return none(OFF_CAPTION);
    case "loading":
      return none(CONNECTING_CAPTION);
    case "live":
    case "opening": {
      const p = i.read.price;
      if (i.paused || !i.read.inSession || !fin(p)) return none(PAUSED_CAPTION);
      if (i.read.stale)
        return { dot: { kind: "stale", price: p, label: `stale ${i.read.ageS ?? "?"} s` }, caption: null, distances: [], from: null };
      return {
        dot: { kind: "live", price: p, label: `live ${i.liveAt ?? ""}`.trim() },
        caption: null,
        distances: triggerDistances(p, i.ceiling, i.floor, i.atr, i.move),
        from: "live",
      };
    }
    case "next": {
      if (i.afterClose) {
        const p = fin(i.lastPrice) ? i.lastPrice : i.close;
        return fin(p) ? { dot: { kind: "close", price: p, label: `close ${p.toFixed(2)}` }, caption: null, distances: [], from: null } : none(null);
      }
      if (fin(i.premarket))
        return {
          dot: { kind: "pre", price: i.premarket, label: `pre ${i.premarket.toFixed(2)}` },
          caption: null,
          distances: triggerDistances(i.premarket, i.ceiling, i.floor, i.atr, i.move),
          from: "pre",
        };
      return fin(i.close) ? { dot: { kind: "close", price: i.close, label: `close ${i.close.toFixed(2)}` }, caption: null, distances: [], from: null } : none(null);
    }
  }
}

// ---- the frames ---------------------------------------------------------------------------------------------------
/** Pixel layout of one ladder size, in the SVG's own units (drawn 1:1 up to `width`). */
export interface LadderFrame {
  size: "desktop" | "phone" | "mini";
  width: number;
  height: number;
  font: number;
  small: number;
  gap: number;
  markerGap: number;
  pad: number;
  /** The left gutter's right edge: markers and the dot's tag are right-aligned here, beside the drawing. */
  markerX: number;
  /** Where the entry and stop glyphs sit: just left of the line area, clear of the price dot's label. */
  glyphX: number;
  lineFrom: number;
  lineTo: number;
  tagX: number;
  priceX: number;
  dotX: number;
  /** A live alternative trigger in its short form ("⤒ sweep"): the phone's gutter is narrow. */
  shortMarkers: boolean;
}

export const FRAMES: Record<LadderFrame["size"], LadderFrame> = {
  // Ladder labels 16 px on a desktop, 15 px on a phone; nothing below 14 px (the plan's size table).
  desktop: { size: "desktop", width: 530, height: 320, font: 16, small: 14, gap: 19, markerGap: 17, pad: 14, markerX: 86, glyphX: 124, lineFrom: 92, lineTo: 384, tagX: 396, priceX: 526, dotX: 104, shortMarkers: false },
  phone: { size: "phone", width: 340, height: 240, font: 15, small: 14, gap: 16, markerGap: 16, pad: 12, markerX: 76, glyphX: 112, lineFrom: 82, lineTo: 206, tagX: 216, priceX: 336, dotX: 92, shortMarkers: true },
  mini: { size: "mini", width: 150, height: 120, font: 15, small: 14, gap: 17, markerGap: 16, pad: 10, markerX: 0, glyphX: 0, lineFrom: 4, lineTo: 80, tagX: 84, priceX: 146, dotX: 16, shortMarkers: true },
};
