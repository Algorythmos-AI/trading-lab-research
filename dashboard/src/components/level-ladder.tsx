// A focus name's price ladder: its levels drawn to scale on one vertical axis. The ceiling and floor thick, with
// their word; the no-trade box shaded and hatched between them; targets as thin ticks; each side's entry and stop as
// glyphs; week and month levels as short dashes with their code; the four alternative triggers as small markers. The
// price dot and the distances are the live layer's (client/ladder-live.tsx), drawn over this one.
//
// Server-rendered SVG. Colour is never the only cue: every mark also has a word or a glyph, and a hidden ordered list
// names every level (price, name, role, line style) for a screen reader. Read only: nothing here is an order.
import { LadderLive } from "@/components/client/ladder-live";
import { LINE_SVG } from "@/lib/chart-code";
import { altTriggers, chartLevels, focusPlan } from "@/lib/focus-plan";
import { FRAMES, type LadderFrame, type LadderGeometry, ladderGeometry, type LadderRow, type LadderSide } from "@/lib/level-ladder";
import type { Options, OptionsTicker } from "@/lib/options";
import { cn } from "@/lib/utils";

type Item = NonNullable<Options["focus"]>["items"][number];

export interface LevelLadderProps {
  item: Item;
  /** The name's row on the board, for its levels, expected move, last bar and the live state. */
  ticker: OptionsTicker | undefined;
  session: string;
  /** The edition's half day, from options.ts isHalfDay(e): the board's one source, never a ticker's own flag. */
  halfDay: boolean;
  /** The day the edition's close is from (the edition's built_from): the dot before the open says "close Fri 9 Oct". */
  closeDate: string | null;
  /** The pre-market price on the focus card, if any. */
  premarket?: number | null;
  /** The side the board highlights; the other side's marks are dimmed. */
  highlight?: "call" | "put";
  /** "auto" draws the desktop ladder from the sm breakpoint and the phone ladder below it. */
  size?: "auto" | "desktop" | "phone";
  /** False draws the static ladder only, with no live layer. */
  live?: boolean;
  /** The alternative trigger the board shows live, if any: drawn in the warn tone with its word. */
  liveAlt?: LiveAlt | null;
  /**
   * Set when the same name's ladder is drawn twice on one page (the Cockpit's beside the card's): it keeps the element
   * ids apart, since a hatch pattern resolves to the first id in the page, which may sit in a hidden card.
   */
  idScope?: string;
}

export interface LiveAlt {
  kind: "failed_break" | "sweep_reclaim";
  side: LadderSide;
}

/** Everything the ladder is drawn from, worked out once per name. */
export function ladderInputs(item: Item, ticker: OptionsTicker | undefined, premarket: number | null | undefined) {
  const plans = focusPlan(item);
  const atr = item.atr && item.atr > 0 ? item.atr : ticker?.atr14 && ticker.atr14 > 0 ? ticker.atr14 : null;
  const close = item.close ?? ticker?.last?.close ?? null;
  return {
    lines: chartLevels(item, ticker?.levels),
    plans,
    alts: altTriggers(plans, atr),
    atr,
    close,
    pre: typeof premarket === "number" && Number.isFinite(premarket) ? premarket : null,
    // The last bar's range: the session's own range is not known until it trades, so PR 3 can feed it in.
    range: ticker?.last ? { high: ticker.last.high, low: ticker.last.low } : null,
    move: ticker?.expected_move?.day ?? null,
  };
}

export function geometryFor(
  item: Item,
  ticker: OptionsTicker | undefined,
  premarket: number | null | undefined,
  frame: LadderFrame,
  highlight?: LadderSide | null,
): LadderGeometry {
  const i = ladderInputs(item, ticker, premarket);
  return ladderGeometry({
    lines: i.lines,
    plans: i.plans,
    alts: frame.size === "mini" ? [] : i.alts,
    atr: i.atr,
    range: i.range,
    price: i.pre ?? i.close,
    height: frame.height,
    pad: frame.pad,
    labelGap: frame.gap,
    markerGap: frame.markerGap,
    expectedMove: i.move,
    reference: i.close,
    highlight: highlight ?? null,
  });
}

/** The ids' key: the symbol, plus the scope when the same name's ladder is drawn twice on the page. */
const idKey = (symbol: string, scope: string | undefined) => (scope ? `${symbol}-${scope}` : symbol);

// The far side is dimmed only while the board highlights one side (LadderLive sets data-highlight).
const DIM: Record<LadderSide, string> = {
  call: "group-data-[highlight=put]/ladder:opacity-40",
  put: "group-data-[highlight=call]/ladder:opacity-40",
};
const dim = (side: LadderSide | null) => (side ? DIM[side] : "");

// The alternative the board shows live (LadderLive sets data-live-alt, ladder-live's liveAltKey): its marker takes the
// warn tone and bold weight. Each class is written out in full so the stylesheet keeps it, with no underscore in the
// value (Tailwind reads one there as a space); the tone is a variable the marker's tick and word read.
const LIT: Record<`${LiveAlt["kind"]}-${LadderSide}`, string> = {
  "failed_break-call": "group-data-[live-alt=fail-call]/ladder:[--alt-tone:var(--warn)] group-data-[live-alt=fail-call]/ladder:font-bold",
  "failed_break-put": "group-data-[live-alt=fail-put]/ladder:[--alt-tone:var(--warn)] group-data-[live-alt=fail-put]/ladder:font-bold",
  "sweep_reclaim-call": "group-data-[live-alt=sweep-call]/ladder:[--alt-tone:var(--warn)] group-data-[live-alt=sweep-call]/ladder:font-bold",
  "sweep_reclaim-put": "group-data-[live-alt=sweep-put]/ladder:[--alt-tone:var(--warn)] group-data-[live-alt=sweep-put]/ladder:font-bold",
};

const TAG_FILL: Record<LadderRow["role"], string> = {
  ceiling: LINE_SVG.ceiling.text,
  floor: LINE_SVG.floor.text,
  week: LINE_SVG.week.text,
  month: LINE_SVG.month.text,
  target: "var(--foreground)",
  entry: "var(--foreground)",
  stop: "var(--bad)",
};

/** The mark a row draws on the line area. */
function RowMark({ r, f }: { r: LadderRow; f: LadderFrame }) {
  if (r.offscale) {
    // Off the scale: a chevron at the edge pointing the way to the price; the label carries the price.
    const x = f.lineTo - 12;
    const d = r.offscale === "above" ? `M${x - 7},${r.y + 6} L${x},${r.y - 2} L${x + 7},${r.y + 6}` : `M${x - 7},${r.y - 6} L${x},${r.y + 2} L${x + 7},${r.y - 6}`;
    return <path d={d} fill="none" stroke="var(--foreground)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />;
  }
  switch (r.role) {
    case "ceiling":
    case "floor": {
      const s = LINE_SVG[r.role];
      return <line x1={f.lineFrom} x2={f.lineTo} y1={r.y} y2={r.y} stroke={s.stroke} strokeWidth={s.width} />;
    }
    case "week":
    case "month": {
      const s = LINE_SVG[r.role];
      return <line x1={f.lineTo - 40} x2={f.lineTo} y1={r.y} y2={r.y} stroke={s.stroke} strokeWidth={s.width} strokeDasharray={s.dash} />;
    }
    case "target":
      return <line x1={f.lineTo - 20} x2={f.lineTo} y1={r.y} y2={r.y} stroke={LINE_SVG.target.stroke} strokeWidth={LINE_SVG.target.width} />;
    case "entry":
      return (
        <text x={f.glyphX} y={r.y} textAnchor="middle" dominantBaseline="central" fontSize={f.small} style={{ fill: "var(--foreground)" }}>
          {r.side === "call" ? "▲" : "▼"}
        </text>
      );
    case "stop":
      return (
        <text x={f.glyphX} y={r.y} textAnchor="middle" dominantBaseline="central" fontSize={f.small + 2} fontWeight={700} style={{ fill: "var(--bad)" }}>
          ×
        </text>
      );
  }
}

/** The static ladder for one frame (desktop or phone). */
export function LadderSvg({ g, f, symbol, labelledBy, liveAlt }: { g: LadderGeometry; f: LadderFrame; symbol: string; labelledBy: string; liveAlt?: LiveAlt | null }) {
  const hatch = `ladder-hatch-${symbol}-${f.size}`;
  return (
    <svg
      role="img"
      aria-labelledby={labelledBy}
      viewBox={`0 0 ${f.width} ${f.height}`}
      className="block h-auto w-full overflow-visible"
      data-testid={`ladder-svg-${f.size}`}
    >
      <defs>
        <pattern id={hatch} width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={7} stroke="var(--neutral)" strokeOpacity={0.6} strokeWidth={1.6} />
        </pattern>
      </defs>
      {/* the axis */}
      <line x1={f.lineTo} x2={f.lineTo} y1={g.frame.top} y2={g.frame.bottom} stroke="var(--chart-axis)" strokeWidth={1} />
      {g.box ? (
        <g data-testid="ladder-box">
          <rect x={f.lineFrom} y={g.box.top} width={f.lineTo - f.lineFrom} height={Math.max(0, g.box.bottom - g.box.top)} fill="var(--neutral-soft)" />
          <rect x={f.lineFrom} y={g.box.top} width={f.lineTo - f.lineFrom} height={Math.max(0, g.box.bottom - g.box.top)} fill={`url(#${hatch})`} />
        </g>
      ) : null}
      {/* the lines, ticks and glyphs; then the leaders and labels */}
      {g.rows.map((r) => (
        <g key={r.key} data-role={r.role} data-side={r.side ?? undefined} data-visible={r.visible ? undefined : "no"} className={dim(r.side)}>
          {/* A hidden entry or stop draws nothing (it is in the hidden list); a hidden week or month line keeps its dash. */}
          {r.visible || r.role === "week" || r.role === "month" ? <RowMark r={r} f={f} /> : null}
          {r.visible ? (
            <>
          {/* One short straight leader from the axis to the label: level when the label sits at its own height. */}
          <line x1={f.lineTo} y1={r.y} x2={f.tagX - 3} y2={r.labelY} stroke="var(--chart-axis)" strokeWidth={1} />
          <text
            x={f.tagX}
            y={r.labelY}
            dominantBaseline="central"
            fontSize={f.font}
            fontWeight={r.role === "ceiling" || r.role === "floor" ? 700 : 500}
            style={{ fill: TAG_FILL[r.role] }}
          >
            {r.tag}
            {r.offscale ? (r.offscale === "above" ? " ↑" : " ↓") : ""}
          </text>
          <text
            x={f.priceX}
            y={r.labelY}
            textAnchor="end"
            dominantBaseline="central"
            fontSize={f.font}
            fontWeight={r.role === "ceiling" || r.role === "floor" ? 700 : 500}
            className="font-mono tabular-nums"
            style={{ fill: "var(--foreground)" }}
          >
            {r.price.toFixed(2)}
          </text>
            </>
          ) : null}
        </g>
      ))}
      {/* the marker column: the alternative triggers, each with a tick at its level */}
      {g.markers.map((m) => {
        // Muted until the board says this one is live; then the warn tone, with its word. A fixed liveAlt is drawn so
        // here; the live board's one is lit by CSS from LadderLive's data-live-alt (tone and weight; the short form stays).
        const on = !!liveAlt && liveAlt.kind === m.kind && liveAlt.side === m.side;
        const tone = on ? "var(--warn)" : "var(--alt-tone, var(--muted-foreground))";
        return (
          <g key={m.key} data-alt={m.kind} data-alt-side={m.side} data-alt-live={on ? "yes" : undefined} className={on ? undefined : cn(dim(m.side), LIT[`${m.kind}-${m.side}`])}>
            <line x1={f.lineFrom - 3} x2={f.lineFrom + 4} y1={m.y} y2={m.y} stroke={tone} strokeWidth={2} />
            <text x={f.markerX} y={m.labelY} textAnchor="end" dominantBaseline="central" fontSize={f.small} fontWeight={on ? 700 : undefined} style={{ fill: tone }}>
              {on ? (f.shortMarkers ? `${m.glyph} ${m.word}` : m.label) : m.short}
            </text>
          </g>
        );
      })}
      {g.notes.map((n) =>
        n.kind === "box" ? (
          // Inside the box, only when the box is tall enough to hold it without crossing its lines.
          g.box && g.box.bottom - g.box.top >= f.small + 8 ? (
            <g key={n.key}>
              <rect x={f.lineFrom + 2} y={n.labelY - f.small / 2 - 2} width={f.lineTo - f.lineFrom - 4} height={f.small + 4} rx={3} fill="var(--card)" fillOpacity={0.85} />
              <text data-note="box" x={(f.lineFrom + f.lineTo) / 2} y={n.labelY} textAnchor="middle" dominantBaseline="central" fontSize={f.small} fontWeight={600} style={{ fill: "var(--foreground)" }}>
                {n.text}
              </text>
            </g>
          ) : null
        ) : (
          <text key={n.key} data-note="beyond" x={f.tagX} y={n.labelY} dominantBaseline="central" fontSize={f.small} fontWeight={600} className={dim(n.side)} style={{ fill: "var(--warn)" }}>
            {n.text}
          </text>
        ),
      )}
    </svg>
  );
}

/** Every level in words, highest first, for a screen reader: price, name, role and line style. */
export function LadderList({ g, id, highlight, liveAlt, live = false }: { g: LadderGeometry; id: string; highlight?: LadderSide | null; liveAlt?: LiveAlt | null; live?: boolean }) {
  const items: { key: string; price: number; text: string }[] = g.rows.map((r) => ({
    key: r.key,
    price: r.price,
    text: `${r.price.toFixed(2)}: ${r.tag.replace(/^[▲▼×] /, "")}, ${r.name}, ${r.role}, ${r.style}${r.beyondMove ? ", beyond the 1-day move" : ""}${r.offscale ? `, off the scale ${r.offscale}` : ""}${r.merged ? `, drawn on the ${r.merged.price.toFixed(2)} level` : ""}${r.visible ? "" : ", not labelled on the drawing"}`,
  }));
  if (g.box) items.push({ key: "box", price: (g.box.hi + g.box.lo) / 2, text: `${g.box.lo.toFixed(2)} to ${g.box.hi.toFixed(2)}: no-trade box, grey, hatched, no trade inside` });
  for (const m of g.markers)
    items.push({
      key: m.key,
      price: m.level,
      text: `${m.level.toFixed(2)}: alternative trigger, ${m.kind === "failed_break" ? "failed break" : "sweep"}, a ${m.side} (testing)${liveAlt && liveAlt.kind === m.kind && liveAlt.side === m.side ? ", live now on the board" : ""}`,
    });
  items.sort((a, b) => b.price - a.price);
  return (
    <ol id={id} className="sr-only">
      {/* With the live layer on, the board can change the side: the live layer says which (ladder-live's ladderBoardLine),
          so this list never contradicts what is drawn. A fixed side is said here. */}
      {highlight ? (
        <li key="highlight">{`The ${highlight} side is highlighted; the ${highlight === "call" ? "put" : "call"} side is dimmed.`}</li>
      ) : live ? null : (
        <li key="highlight">No side is highlighted.</li>
      )}
      {items.map((x) => (
        <li key={x.key}>{x.text}</li>
      ))}
    </ol>
  );
}

function Frame({ props, f }: { props: LevelLadderProps; f: LadderFrame }) {
  const { item, ticker, session, premarket, highlight, liveAlt, live = true } = props;
  const g = geometryFor(item, ticker, premarket, f, highlight);
  const i = ladderInputs(item, ticker, premarket);
  const key = idKey(item.symbol, props.idScope);
  const ids = `ladder-title-${key} ladder-list-${key}`;
  const svg = <LadderSvg g={g} f={f} symbol={key} labelledBy={ids} liveAlt={liveAlt} />;
  if (!live || !ticker)
    return (
      <div className="group/ladder" data-highlight={highlight ?? "none"}>
        {svg}
      </div>
    );
  return (
    <LadderLive
      symbol={item.symbol}
      session={session}
      halfDay={props.halfDay}
      closeDate={props.closeDate}
      premarket={i.pre}
      close={i.close}
      ceiling={i.plans.call?.level ?? null}
      floor={i.plans.put?.level ?? null}
      atr={i.atr}
      move={i.move}
      frame={f}
      domain={g.domain}
      highlight={highlight}
      busy={g.markers.map((m) => m.labelY)}
    >
      {svg}
    </LadderLive>
  );
}

/** One focus name's ladder: the desktop and phone frames (one shown by width), and the hidden list of levels. */
export function LevelLadder(props: LevelLadderProps) {
  const { item, ticker, premarket, highlight, liveAlt, size = "auto" } = props;
  const g = geometryFor(item, ticker, premarket, FRAMES.desktop, highlight);
  if (!g.rows.length) return null;
  const key = idKey(item.symbol, props.idScope);
  return (
    <figure className="grid gap-2" data-testid={`ladder-${item.symbol}`}>
      <p id={`ladder-title-${key}`} className="sr-only">
        {item.symbol} price ladder, highest price first
      </p>
      <LadderList g={g} id={`ladder-list-${key}`} highlight={highlight} liveAlt={liveAlt} live={(props.live ?? true) && !!ticker} />
      {size === "phone" ? null : (
        <div className={cn(size === "auto" && "hidden sm:block")}>
          <Frame props={props} f={FRAMES.desktop} />
        </div>
      )}
      {size === "desktop" ? null : (
        <div className={cn(size === "auto" && "sm:hidden")}>
          <Frame props={props} f={FRAMES.phone} />
        </div>
      )}
    </figure>
  );
}

/**
 * The small ladder for the fourfold glance: about 120 px tall, the ceiling and floor with their prices, the box, the
 * targets as ticks, and the price dot. No other labels.
 */
export function LadderMini({ item, ticker, session, halfDay, closeDate, premarket, highlight, live = true }: Omit<LevelLadderProps, "size">) {
  const f = FRAMES.mini;
  const g = geometryFor(item, ticker, premarket, f);
  if (!g.rows.length) return null;
  const i = ladderInputs(item, ticker, premarket);
  const hatch = `ladder-hatch-${item.symbol}-mini`;
  const edges = g.rows.filter((r) => r.role === "ceiling" || r.role === "floor");
  const label = [
    `${item.symbol} small price ladder`,
    ...edges.map((r) => `${r.tag.toLowerCase()} ${r.price.toFixed(2)}`),
  ].join(", ");
  const svg = (
    <svg role="img" aria-label={label} viewBox={`0 0 ${f.width} ${f.height}`} className="block h-auto w-full overflow-visible" data-testid="ladder-svg-mini">
      <defs>
        <pattern id={hatch} width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={7} stroke="var(--neutral)" strokeOpacity={0.6} strokeWidth={1.6} />
        </pattern>
      </defs>
      {g.box ? (
        <g data-testid="ladder-box">
          <rect x={f.lineFrom} y={g.box.top} width={f.lineTo - f.lineFrom} height={Math.max(0, g.box.bottom - g.box.top)} fill="var(--neutral-soft)" />
          <rect x={f.lineFrom} y={g.box.top} width={f.lineTo - f.lineFrom} height={Math.max(0, g.box.bottom - g.box.top)} fill={`url(#${hatch})`} />
        </g>
      ) : null}
      {g.rows
        .filter((r) => r.role === "target" && !r.offscale)
        .map((r) => (
          <line key={r.key} x1={f.lineTo - 14} x2={f.lineTo} y1={r.y} y2={r.y} stroke={LINE_SVG.target.stroke} strokeWidth={LINE_SVG.target.width} className={dim(r.side)} />
        ))}
      {edges.map((r) => {
        const s = LINE_SVG[r.role as "ceiling" | "floor"];
        // The two prices never overlap: the ceiling's label sits above its line and the floor's below, when close.
        const close = edges.length === 2 && Math.abs(edges[1]!.y - edges[0]!.y) < f.gap;
        const ly = close ? r.y + (r.role === "ceiling" ? -f.gap / 2 : f.gap / 2) : r.y;
        return (
          <g key={r.key} data-role={r.role} data-offscale={r.offscale ?? undefined} className={dim(r.side)}>
            {r.offscale ? (
              // Off the scale: a chevron at the edge pointing the way, in the line's colour; the price says where.
              <path
                d={(() => {
                  const x = (f.lineFrom + f.lineTo) / 2;
                  return r.offscale === "above" ? `M${x - 8},${r.y + 6} L${x},${r.y - 2} L${x + 8},${r.y + 6}` : `M${x - 8},${r.y - 6} L${x},${r.y + 2} L${x + 8},${r.y - 6}`;
                })()}
                fill="none"
                stroke={s.stroke}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <line x1={f.lineFrom} x2={f.lineTo} y1={r.y} y2={r.y} stroke={s.stroke} strokeWidth={s.width} />
            )}
            <text x={f.priceX} y={ly} textAnchor="end" dominantBaseline="central" fontSize={f.font} fontWeight={700} className="font-mono tabular-nums" style={{ fill: s.text }}>
              {r.offscale === "above" ? "↑" : r.offscale === "below" ? "↓" : ""}
              {r.price.toFixed(2)}
            </text>
          </g>
        );
      })}
    </svg>
  );
  if (!live || !ticker)
    return (
      <div className="group/ladder" data-highlight={highlight ?? "none"} data-testid={`ladder-mini-${item.symbol}`} style={{ maxWidth: f.width }}>
        {svg}
      </div>
    );
  return (
    <div data-testid={`ladder-mini-${item.symbol}`}>
      <LadderLive
        symbol={item.symbol}
        session={session}
        halfDay={halfDay}
        closeDate={closeDate}
        premarket={i.pre}
        close={i.close}
        ceiling={i.plans.call?.level ?? null}
        floor={i.plans.put?.level ?? null}
        atr={i.atr}
        move={i.move}
        frame={f}
        domain={g.domain}
        highlight={highlight}
      >
        {svg}
      </LadderLive>
    </div>
  );
}
