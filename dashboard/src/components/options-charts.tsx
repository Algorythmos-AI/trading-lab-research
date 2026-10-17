// The Options page's pictures: the room bar, the level map, the rule ranges and the evidence bars. Server-safe
// (no hooks); every number a picture encodes is also in its title text or the table under it.
import { num, signed } from "@/lib/format";
import {
  CHEAP_IVP,
  CHIP_LABEL,
  mapView,
  moveBands,
  niceStep,
  RICH_IVP,
  ROOM_REACH,
  spreadLabels,
  STRONG_POS,
  type structureView,
  type Finding,
  type OptionsRule,
  type OptionsTicker,
  type MapZone,
  type roomView, zoneKey } from "@/lib/options";
import { shortCount, type Interest } from "@/lib/oi";
import { cn } from "@/lib/utils";
import { LiveMapMark } from "./client/live-layer";
import { MapFrame } from "./client/map-frame";
import { Badge } from "./ui/badge";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const TONE_FILL = { support: "var(--good-fill)", resistance: "var(--bad-fill)", at: "var(--warn-fill)" } as const;

/** Left offset on the room bar for an ATR offset from price. */
const roomAt = (v: number) => `${((v + ROOM_REACH) / (2 * ROOM_REACH)) * 100}%`;

/**
 * One name's room bar: price in the middle, every zone within three ATRs each way (green below, red above, amber
 * when price sits inside one), and the one-day expected move as a blue band. Heavier zones are drawn stronger.
 */
export function RoomBar({
  view,
  label,
  trail = [],
  live = false,
  stale = false,
}: {
  view: NonNullable<ReturnType<typeof roomView>>;
  label: string;
  /** Recent live prices as ATR offsets from the current one, oldest first: drawn as fading dots behind it. */
  trail?: number[];
  live?: boolean;
  stale?: boolean;
}) {
  return (
    <div className="relative h-7" role="img" aria-label={label}>
      <span className="bg-track absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full" />
      {view.em !== null ? (
        <span
          className="bg-info-fill/25 absolute top-1/2 h-4 -translate-y-1/2 rounded-sm"
          style={{ left: roomAt(-Math.min(view.em, ROOM_REACH)), width: `${(Math.min(view.em, ROOM_REACH) / ROOM_REACH) * 50}%` }}
        />
      ) : null}
      {view.zones.map((z, i) => (
        <span
          key={i}
          className="absolute inset-y-0.5 min-w-[3px] rounded-[2px]"
          style={{
            left: roomAt(z.from),
            width: `${((z.to - z.from) / (2 * ROOM_REACH)) * 100}%`,
            background: TONE_FILL[z.tone],
            opacity: z.big ? 0.8 : 0.4,
          }}
        />
      ))}
      {[-2, -1, 1, 2].map((k) => (
        <span key={k} className="bg-chart-axis absolute bottom-0 h-1.5 w-px" style={{ left: roomAt(k) }} />
      ))}
      {trail.map((v, i) => (
        <span
          key={i}
          className="bg-foreground absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: roomAt(Math.max(-ROOM_REACH, Math.min(ROOM_REACH, v))), opacity: 0.12 + (0.33 * (i + 1)) / trail.length }}
        />
      ))}
      <span
        className={cn(
          "absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2",
          stale ? "bg-card border-warn-fill border-dashed" : live ? "bg-warn-fill border-card" : "bg-foreground border-card",
        )}
      />
    </div>
  );
}

// Level map geometry, in viewBox units. Candles fill the plot; the expected move gets a narrow gutter after the
// last candle; the price axis, with one tag a level, runs down the right edge as on a broker's chart.
interface MapGeometry {
  W: number;
  H: number;
  TOP: number;
  X0: number;
  X1: number;
  XD: number;
  XW: number;
  /** The price axis: tags start here and run to the right edge. */
  AX: number;
  TAG_H: number;
  /** Height kept under the candles for volume, when the bars carry it. */
  VOL_H: number;
  /** Height of the date row under the candles. */
  DATE_H: number;
  /** Levels tagged each side of the close; the rest are drawn as faint lines and listed under the chart. */
  LABELS_EACH_SIDE: number;
  /** Text size, as a multiple of the wide map's. */
  F: number;
}
const WIDE: MapGeometry = { W: 640, H: 340, TOP: 10, X0: 4, X1: 536, XD: 552, XW: 568, AX: 574, TAG_H: 14, VOL_H: 40, DATE_H: 20, LABELS_EACH_SIDE: 2, F: 1 };
/** A phone's map: a narrower, taller box, so the candles keep their height and the text reads at phone size. */
const PHONE: MapGeometry = { W: 410, H: 470, TOP: 12, X0: 4, X1: 316, XD: 328, XW: 338, AX: 342, TAG_H: 20, VOL_H: 56, DATE_H: 28, LABELS_EACH_SIDE: 2, F: 1.4 };

/**
 * Recent candles, each nearby zone as one thin line at the edge price meets first (with a faint band behind it for
 * the zone's width), the close, and the options market's expected move as a cone into the next day and the week.
 * Green and red candles, as on a broker's chart; the price axis on the right carries a tag at the close and at the
 * nearest two levels each side, so the numbers that matter are read where a trader looks for them.
 *
 * The zones, the candles, the expected move and the tags are each a layer (`data-layer`), so a wrapper can hide one
 * with `data-hide`. With `interactive` the map carries a crosshair that reads a price and a candle off it.
 */
/** Where the contract being priced breaks even at expiry, for the level map to draw. */
export interface BreakevenMark {
  price: number;
  kind: "call" | "put";
}

/** How long the longest open-interest bar is drawn, in the map's units. */
const OI_BAR = 54;

export function LevelMap({
  t,
  interactive = false,
  breakeven = null,
  interest = null,
  hotZone = null,
  onZone,
  unit = "daily",
  closeDay = null,
  phone = false,
}: {
  t: OptionsTicker;
  interactive?: boolean;
  breakeven?: BreakevenMark | null;
  /** The strikes holding the most open calls and puts, when the host has sent open interest. */
  interest?: Interest | null;
  /** The zone to pick out (`zoneKey`), and a way to say which zone the pointer is over: the zones list uses both. */
  hotZone?: string | null;
  onZone?: (key: string | null) => void;
  /** What one candle is. Hourly candles carry a time in their date (`withHourly`) and are dated once a session. */
  unit?: "daily" | "hourly";
  /** The day of the close the levels were built from. Hourly candles after it are today's: the close's dot, the
   *  expected move and the live price start at that day's last candle, not at the newest one. */
  closeDay?: string | null;
  /** Draw the phone's geometry: taller, with larger text. */
  phone?: boolean;
}) {
  const { W, H, TOP, X0, X1, XD, XW, AX, TAG_H, VOL_H, DATE_H, LABELS_EACH_SIDE, F } = phone ? PHONE : WIDE;
  /** Where the open-interest bars start: clear of the plot's left edge. */
  const OI_X = X0 + 6;
  const v = mapView(t);
  const close = t.last?.close;
  if (!v || !isNum(close)) return null;
  const n = v.bars.length;
  const vols = v.bars.map((b) => (isNum(b.v) && b.v >= 0 ? b.v : null));
  const hasVol = vols.some((x) => x !== null && x > 0);
  const BOTTOM = H - DATE_H - (hasVol ? VOL_H : 0);
  const y = (p: number) => TOP + ((v.hi - p) / (v.hi - v.lo)) * (BOTTOM - TOP);
  const step = niceStep(v.hi - v.lo, 6);
  const ticks: number[] = [];
  for (let p = Math.ceil(v.lo / step) * step; p <= v.hi; p += step) ticks.push(p);
  const bw = n > 0 ? (X1 - X0) / n : 0;
  const upTo = unit === "hourly" && closeDay ? v.bars.findLastIndex((b) => b.d.slice(0, 10) <= closeDay) : n - 1;
  const xLast = n > 0 ? X0 + bw * (Math.max(upTo, 0) + 0.5) : X1;
  const bands = moveBands(t);
  const most = Math.max(1, ...vols.map((x) => x ?? 0));
  // Dates under the candles: hourly ones once a session, daily ones about every two weeks, never crowded.
  const dated = new Set<number>();
  {
    let lastX = -Infinity;
    v.bars.forEach((b, i) => {
      const x = X0 + bw * (i + 0.5);
      const due = unit === "hourly" ? i === 0 || b.d.slice(0, 10) !== v.bars[i - 1]!.d.slice(0, 10) : i % 10 === 0;
      if (due && x - lastX >= 44 * F && x <= X1 - 20) {
        dated.add(i);
        lastX = x;
      }
    });
  }

  // Each zone is drawn at the edge price reaches first: the bottom of one above, the top of one below.
  const edge = ({ zone, tone }: MapZone) => (tone === "resistance" ? zone.lo : zone.hi);
  const toneColor = (tone: MapZone["tone"]) => (tone === "support" ? "var(--good)" : "var(--bad)");
  const above = v.zones.filter((z) => z.tone === "resistance").sort((a, b) => a.zone.lo - b.zone.lo).slice(0, LABELS_EACH_SIDE);
  const below = v.zones.filter((z) => z.tone === "support").sort((a, b) => b.zone.hi - a.zone.hi).slice(0, LABELS_EACH_SIDE);
  const tagged = new Set([...above, ...below]);
  const tags = [
    ...[...above, ...below].map((z) => ({
      y: y(edge(z)),
      text: num(edge(z), 2),
      title: `${z.tone === "support" ? "Support" : "Resistance"} ${z.zone.lo === z.zone.hi ? num(z.zone.lo, 2) : `${num(z.zone.lo, 2)} to ${num(z.zone.hi, 2)}`}: ${(z.zone.members ?? []).join(" + ")}`,
      fill: toneColor(z.tone),
      ink: "var(--card)",
    })),
    {
      y: y(close),
      text: num(close, 2),
      title: `Close ${num(close, 2)}${t.close_strength?.chip ? `, ${(CHIP_LABEL[t.close_strength.chip] ?? "").toLowerCase()}` : ""}`,
      fill: "var(--foreground)",
      ink: "var(--card)",
    },
  ];
  const placed = spreadLabels(
    tags.map((l) => l.y),
    TAG_H + 1,
    TOP + TAG_H / 2,
    BOTTOM - TAG_H / 2,
  );
  // Axis prices give way to a tag sitting on them.
  const freeTicks = ticks.filter((p) => placed.every((ty) => Math.abs(ty - y(p)) > TAG_H - 2));

  return (
    <MapFrame
      t={{ ...t, bars: undefined }}
      label={`${t.symbol}: last ${n} ${unit} bars with support and resistance levels and the expected move`}
      w={W}
      h={H}
      top={TOP}
      bottom={BOTTOM}
      x0={X0}
      x1={XW}
      lo={v.lo}
      hi={v.hi}
      zones={v.zones}
      interactive={interactive}
      onZone={onZone}
      candles={n > 0 ? { x0: X0, bw, bars: v.bars.map((b) => ({ d: unit === "hourly" ? `${b.d.replace("T", " ")} ET` : b.d, o: b.o, h: b.h, l: b.l, c: b.c })) } : undefined}
    >
        {ticks.map((p) => (
          <line key={p} x1={X0} x2={XW} y1={y(p)} y2={y(p)} stroke="var(--chart-grid)" strokeWidth={0.75} />
        ))}
        <line x1={AX - 2} x2={AX - 2} y1={TOP} y2={H - DATE_H} stroke="var(--chart-grid)" strokeWidth={1} />
        {freeTicks.map((p) => (
          <text key={p} x={AX + 4} y={y(p) + 3.5 * F} fontSize={10 * F} style={{ fill: "var(--muted-foreground)" }} className="font-mono">
            {num(p, step < 1 ? 2 : 0)}
          </text>
        ))}
        <g data-layer="zones">
          {v.zones.map((z, i) => {
            const { zone, tone } = z;
            const y1 = y(zone.hi);
            const h = Math.max(0, y(zone.lo) - y1);
            const key = zoneKey(zone);
            const hot = hotZone === key;
            const color = toneColor(tone);
            const at = y(edge(z));
            return (
              <g key={i}>
                <rect
                  data-zone={key}
                  data-hot={hot ? "" : undefined}
                  x={X0}
                  y={h < 4 ? at - 2 : y1}
                  width={XW - X0}
                  height={Math.max(4, h)}
                  fill={color}
                  fillOpacity={hot ? 0.22 : h < 4 ? 0 : 0.06}
                  stroke={hot ? color : "none"}
                  strokeOpacity={0.6}
                >
                  <title>
                    {`${tone === "support" ? "Support" : "Resistance"} ${num(zone.lo, 2)}${zone.lo === zone.hi ? "" : `–${num(zone.hi, 2)}`}: ${(zone.members ?? []).join(" + ")}`}
                  </title>
                </rect>
                <line
                  x1={X0}
                  x2={AX - 2}
                  y1={at}
                  y2={at}
                  stroke={color}
                  strokeWidth={tagged.has(z) || hot ? 1.25 : 1}
                  strokeOpacity={tagged.has(z) || hot ? 0.9 : 0.35}
                  strokeDasharray={tagged.has(z) || hot ? undefined : "2 3"}
                  pointerEvents="none"
                />
                {tagged.has(z) && (zone.members ?? []).length > 0 ? (
                  <text
                    x={X0 + 3}
                    y={at - 3}
                    fontSize={9 * F}
                    pointerEvents="none"
                    style={{ fill: color, paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3 }}
                    className="font-mono"
                  >
                    {(zone.members ?? []).slice(0, 3).join(" · ")}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
        <g data-layer="candles">
          {v.bars.map((b, i) => {
            const cx = X0 + bw * (i + 0.5);
            const color = b.c >= b.o ? "var(--good)" : "var(--bad)";
            const top = y(Math.max(b.o, b.c));
            const vol = vols[i] ?? null;
            return (
              <g key={b.d}>
                <title>{`${unit === "hourly" ? `${b.d.replace("T", " ")} ET` : b.d}  O ${num(b.o, 2)}  H ${num(b.h, 2)}  L ${num(b.l, 2)}  C ${num(b.c, 2)}${vol !== null ? `  Vol ${shortCount(vol)}` : ""}`}</title>
                <line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} stroke={color} strokeWidth={1} />
                <rect x={cx - bw * 0.36} y={top} width={bw * 0.72} height={Math.max(1, Math.abs(y(b.o) - y(b.c)))} fill={color} />
                {hasVol && vol !== null ? (
                  <rect x={cx - bw * 0.36} y={H - DATE_H - (vol / most) * (VOL_H - 6)} width={bw * 0.72} height={(vol / most) * (VOL_H - 6)} fill={color} fillOpacity={0.35} />
                ) : null}
                {dated.has(i) ? (
                  <text x={i === 0 ? X0 : cx} y={H - 6 * F} fontSize={10 * F} textAnchor={i === 0 ? "start" : "middle"} style={{ fill: "var(--muted-foreground)" }} className="font-mono">
                    {b.d.slice(5, 10)}
                  </text>
                ) : null}
              </g>
            );
          })}
          {n === 0 ? (
            <text x={(X0 + X1) / 2} y={H - 6 * F} fontSize={9 * F} textAnchor="middle" style={{ fill: "var(--muted-foreground)" }}>
              Candles appear once the after-close run sends recent bars.
            </text>
          ) : null}
        </g>
        {bands.day ? (
          <g data-layer="move">
            <title>{`Expected move: 1 day ${num(bands.day[0], 2)} to ${num(bands.day[1], 2)}${bands.week ? `, 1 week ${num(bands.week[0], 2)} to ${num(bands.week[1], 2)}` : ""}`}</title>
            <polygon
              points={
                bands.week
                  ? `${xLast},${y(close)} ${XD},${y(bands.day[1])} ${XW},${y(bands.week[1])} ${XW},${y(bands.week[0])} ${XD},${y(bands.day[0])}`
                  : `${xLast},${y(close)} ${XD},${y(bands.day[1])} ${XD},${y(bands.day[0])}`
              }
              fill="var(--info-fill)"
              fillOpacity={0.12}
              stroke="var(--info-fill)"
              strokeOpacity={0.45}
            />
            <line x1={XD} x2={XD} y1={y(bands.day[1])} y2={y(bands.day[0])} stroke="var(--info-fill)" strokeWidth={2} />
            <text x={XD} y={y(bands.day[1]) - 4} fontSize={9.5 * F} textAnchor="middle" style={{ fill: "var(--info)" }} className="font-mono">
              1d
            </text>
            {bands.week ? (
              <text x={XW} y={y(bands.week[1]) - 4} fontSize={9.5 * F} textAnchor="end" style={{ fill: "var(--info)" }} className="font-mono">
                1w
              </text>
            ) : null}
          </g>
        ) : null}
        {interest ? (
          // Bars at the strikes with the most open contracts: filled for calls above the strike's line, outlined for
          // puts below it, each as long as its share of the largest, with one label a strike. Blue, as everything
          // from the option market is.
          <g data-layer="oi" data-interest={interest.marks.filter((m) => m.strike >= v.lo && m.strike <= v.hi).length}>
            {(() => {
              const shown = interest.marks.filter((m) => m.strike >= v.lo && m.strike <= v.hi);
              const top = Math.max(1, ...shown.map((m) => m.oi));
              const strikes = [...new Set(shown.map((m) => m.strike))];
              return strikes.map((strike) => {
                const here = shown.filter((m) => m.strike === strike).sort((p, q) => (p.kind === q.kind ? 0 : p.kind === "call" ? -1 : 1));
                const len = (m: (typeof here)[number]) => Math.max(4, (m.oi / top) * OI_BAR);
                return (
                  <g key={strike}>
                    <title>{`${here.map((m) => `${num(m.oi)} open ${m.kind}s`).join(" and ")} at ${num(strike, strike % 1 === 0 ? 0 : 2)}${interest.asOf ? `, as of ${interest.asOf}` : ""}`}</title>
                    {here.map((m) => (
                      <rect
                        key={m.kind}
                        x={OI_X}
                        y={y(strike) + (m.kind === "call" ? -5 : 1)}
                        width={len(m)}
                        height={4}
                        fill={m.kind === "call" ? "var(--info)" : "var(--card)"}
                        stroke="var(--info)"
                        strokeWidth={1}
                      />
                    ))}
                    <text
                      x={OI_X + Math.max(...here.map(len)) + 4}
                      y={y(strike) + 3}
                      fontSize={9.5 * F}
                      style={{ fill: "var(--info)", paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 2.5 }}
                      className="font-mono"
                    >
                      {here.map((m) => `${shortCount(m.oi)} ${m.kind === "call" ? "C" : "P"}`).join(" · ")}
                    </text>
                  </g>
                );
              });
            })()}
          </g>
        ) : null}
        {breakeven && isNum(breakeven.price) && breakeven.price > 0 ? (
          // Blue, like everything else on the map that comes from option prices. Off the map's range it is named
          // at the edge it lies beyond, never drawn where it is not.
          <g data-breakeven={breakeven.price > v.hi ? "above" : breakeven.price < v.lo ? "below" : "on"}>
            <title>{`Breakeven at expiry for the ${breakeven.kind} being priced: ${num(breakeven.price, 2)}`}</title>
            {breakeven.price <= v.hi && breakeven.price >= v.lo ? (
              <line x1={X0} x2={XW} y1={y(breakeven.price)} y2={y(breakeven.price)} stroke="var(--info)" strokeWidth={1.5} strokeDasharray="7 3 2 3" />
            ) : null}
            <text
              x={X0 + 6}
              y={breakeven.price > v.hi ? TOP + 11 : breakeven.price < v.lo ? BOTTOM - 5 : y(breakeven.price) < TOP + 15 ? y(breakeven.price) + 12 : y(breakeven.price) - 4}
              fontSize={10.5 * F}
              style={{ fill: "var(--info)", paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3 }}
              className="font-mono"
            >
              {`Breakeven ${num(breakeven.price, 2)}${breakeven.price > v.hi ? " ↑ above this range" : breakeven.price < v.lo ? " ↓ below this range" : ""}`}
            </text>
          </g>
        ) : null}
        <line x1={X0} x2={AX - 2} y1={y(close)} y2={y(close)} stroke="var(--foreground)" strokeOpacity={0.55} strokeDasharray="3 3" />
        <circle cx={xLast} cy={y(close)} r={3} fill="var(--foreground)" stroke="var(--card)" strokeWidth={1.5} />
        <LiveMapMark t={{ ...t, bars: undefined }} lo={v.lo} hi={v.hi} top={TOP} bottom={BOTTOM} xFrom={xLast} xTo={XD} lineFrom={X0} lineTo={XW} />
        <g data-layer="labels">
          {tags.map((l, i) => (
            <g key={i}>
              <title>{l.title}</title>
              {Math.abs(placed[i]! - l.y) > 1 ? <path d={`M${AX - 2} ${l.y} L${AX + 2} ${placed[i]!}`} stroke={l.fill} strokeOpacity={0.7} fill="none" /> : null}
              <rect x={AX} y={placed[i]! - TAG_H / 2} width={W - AX - 1} height={TAG_H} rx={2} fill={l.fill} />
              <text x={AX + 4} y={placed[i]! + 3.5 * F} fontSize={10.5 * F} fontWeight={600} style={{ fill: l.ink }} className="font-mono">
                {l.text}
              </text>
            </g>
          ))}
        </g>
    </MapFrame>
  );
}

/** Where a value in R sits on the rule chart's axis, which always shows at least ±0.5R. */
function rAxis(rules: OptionsRule[]) {
  const vals = rules.flatMap((r) => [r.backtest?.ci_lo, r.backtest?.ci_hi, r.backtest?.avg_r, r.live?.avg_r]).filter(isNum);
  // Round the reach up to a quarter R so the axis labels are tidy.
  const reach = Math.ceil(Math.max(0.5, ...vals.map((v) => Math.abs(v) * 1.05)) / 0.25) * 0.25;
  return { reach, at: (v: number) => `${((Math.max(-reach, Math.min(reach, v)) + reach) / (2 * reach)) * 100}%` };
}

/** Promotion needs this many paper cases. */
export const PROMOTION_CASES = 30;

/**
 * Each rule's backtest average with its 95% range against a zero line, plus the live paper average as a ring. A
 * range that crosses zero is grey: no proven edge. A bar shows how far the paper record is towards promotion.
 */
export function RuleRanges({ rules }: { rules: OptionsRule[] }) {
  const { reach, at } = rAxis(rules);
  const ticks = [-reach, 0, reach];
  return (
    <figure className="grid gap-3" role="group" aria-label="Each rule's backtest range against zero, with paper results">
      {rules.map((r) => {
        const b = r.backtest;
        const ranged = isNum(b?.ci_lo) && isNum(b?.ci_hi);
        const tone = !ranged ? "neutral" : b!.ci_lo! > 0 ? "good" : b!.ci_hi! < 0 ? "bad" : "neutral";
        const fill = tone === "good" ? "bg-good-fill" : tone === "bad" ? "bg-bad-fill" : "bg-neutral-fill";
        const paperN = r.live?.n ?? 0;
        return (
          <div key={r.id} className="grid items-center gap-x-4 gap-y-1.5 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_8rem]">
            <div className="min-w-0">
              <p className="text-[0.8125rem] font-medium break-words">{r.label ?? r.id}</p>
              <p className="text-muted-foreground font-mono text-[0.6875rem]">
                <span className={r.status === "proven" ? "text-good" : r.status === "probation" ? "text-warn" : ""}>
                  {r.status === "proven" ? "PROVEN" : r.status === "probation" ? "ON PROBATION" : "RETIRED"}
                </span>
                {r.side ? ` · ${r.side === "call" ? "calls" : "puts"}` : ""}
                {isNum(b?.n) ? ` · backtest n ${b!.n}` : ""}
              </p>
            </div>
            <div
              className="bg-track/60 relative h-7 rounded-sm"
              title={`Backtest ${signed(b?.avg_r, 3)}R${ranged ? `, 95% range ${signed(b!.ci_lo, 2)} to ${signed(b!.ci_hi, 2)}` : ""}${paperN > 0 ? `. Paper ${signed(r.live?.avg_r, 3)}R, ${r.live?.wins ?? 0} of ${paperN} won` : ". No paper trades yet"}`}
            >
              <span className="bg-foreground/60 absolute inset-y-0 w-px" style={{ left: "50%" }} />
              {ranged ? (
                <span
                  className={cn("absolute top-1/2 h-2 -translate-y-1/2 rounded-full opacity-70", fill)}
                  style={{ left: at(b!.ci_lo!), width: `calc(${at(b!.ci_hi!)} - ${at(b!.ci_lo!)})` }}
                />
              ) : null}
              {isNum(b?.avg_r) ? (
                <span className="bg-foreground absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2" style={{ left: at(b!.avg_r!) }} />
              ) : null}
              {paperN > 0 && isNum(r.live?.avg_r) ? (
                <span
                  className="border-info-fill absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                  style={{ left: at(r.live!.avg_r!) }}
                />
              ) : null}
            </div>
            <div className="grid gap-1">
              <span className="bg-track relative h-1.5 overflow-hidden rounded-full">
                <span
                  className="bg-info-fill absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${Math.min(100, (paperN / PROMOTION_CASES) * 100)}%` }}
                />
              </span>
              <span className="text-muted-foreground font-mono text-[0.6875rem]">
                {paperN} of {PROMOTION_CASES} paper cases
              </span>
            </div>
          </div>
        );
      })}
      <div className="text-muted-foreground grid font-mono text-[0.6875rem] md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_8rem] md:gap-x-4" aria-hidden>
        <span className="hidden md:block" />
        <span className="flex justify-between">
          {ticks.map((v) => (
            <span key={v}>{v === 0 ? "0R" : `${signed(v, 2)}R`}</span>
          ))}
        </span>
      </div>
    </figure>
  );
}

const CHIP_FILL: Record<string, string> = { STRONG: "var(--good-fill)", MID: "var(--neutral-fill)", WEAK: "var(--bad-fill)" };

/**
 * Close strength against option price, one dot per name: up is a stronger close (where it sat in the day's range),
 * right is pricier options (52-week IV percentile). The left band is where options are cheap, the right band where
 * they are rich. The two axes are the two leads from early testing; a band says what a call or put costs against
 * its own year, never a trade.
 */
export function StructureMap({ view }: { view: ReturnType<typeof structureView> }) {
  const W = 480;
  const H = 330;
  const L = 58;
  const R = W - 12;
  const T = 26;
  const B = H - 42;
  const x = (v: number) => L + v * (R - L);
  const y = (v: number) => B - v * (B - T);
  const pts = [...view.points].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full max-w-xl"
      role="img"
      aria-label={`Close strength against IV percentile for ${pts.length} names`}
    >
      <rect x={L} y={T} width={x(CHEAP_IVP) - L} height={B - T} fill="var(--info-fill)" fillOpacity={0.1} />
      <rect x={x(RICH_IVP)} y={T} width={R - x(RICH_IVP)} height={B - T} fill="var(--warn-fill)" fillOpacity={0.1} />
      <text x={L + 4} y={T - 8} fontSize={12} style={{ fill: "var(--info)" }}>
        cheap options
      </text>
      <text x={R - 4} y={T - 8} fontSize={12} textAnchor="end" style={{ fill: "var(--warn)" }}>
        rich options
      </text>
      {[0.25, 0.5, 0.75].map((v) => (
        <line key={`v${v}`} x1={x(v)} x2={x(v)} y1={T} y2={B} stroke="var(--chart-grid)" strokeDasharray={v === 0.5 ? "3 3" : undefined} />
      ))}
      <line x1={L} x2={R} y1={y(0.5)} y2={y(0.5)} stroke="var(--chart-grid)" strokeDasharray="3 3" />
      <line x1={L} x2={R} y1={y(STRONG_POS)} y2={y(STRONG_POS)} stroke="var(--good-fill)" strokeOpacity={0.5} />
      <text x={R - 4} y={y(STRONG_POS) - 4} fontSize={11.5} textAnchor="end" style={{ fill: "var(--good)" }}>
        strong close
      </text>
      <line x1={L} x2={R} y1={B} y2={B} stroke="var(--chart-axis)" />
      <line x1={L} x2={L} y1={T} y2={B} stroke="var(--chart-axis)" />
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <text x={x(v)} y={B + 14} fontSize={11.5} textAnchor="middle" style={{ fill: "var(--muted-foreground)" }} className="font-mono">
            {Math.round(v * 100)}%
          </text>
          <text x={L - 6} y={y(v) + 3} fontSize={11.5} textAnchor="end" style={{ fill: "var(--muted-foreground)" }} className="font-mono">
            {v === 1 ? "high" : v === 0 ? "low" : v.toFixed(2)}
          </text>
        </g>
      ))}
      <text x={(L + R) / 2} y={H - 8} fontSize={12} textAnchor="middle" style={{ fill: "var(--muted-foreground)" }}>
        IV percentile, 52 weeks → pricier options
      </text>
      <text x={12} y={(T + B) / 2} fontSize={12} textAnchor="middle" transform={`rotate(-90 12 ${(T + B) / 2})`} style={{ fill: "var(--muted-foreground)" }}>
        close in the day&apos;s range →
      </text>
      {pts.map((p) => {
        const cx = x(p.ivp);
        const cy = y(p.pos);
        // A name with a neighbour just above-left puts its label below, so close dots keep readable labels.
        const crowded = pts.some((q) => q !== p && Math.abs(x(q.ivp) - cx) < 44 && cy - y(q.pos) > 0 && cy - y(q.pos) < 14);
        // Keep a label off the strong-close line.
        const onLine = cy - y(STRONG_POS) > 0 && cy - y(STRONG_POS) < 16;
        const right = cx < R - 40;
        return (
          <g key={p.symbol}>
            <title>{`${p.symbol}: close at ${Math.round(p.pos * 100)}% of the day's range${p.chip ? ` (${CHIP_LABEL[p.chip] ?? p.chip})` : ""}, IV percentile ${Math.round(p.ivp * 100)}%`}</title>
            <circle cx={cx} cy={cy} r={6} fill={p.chip ? (CHIP_FILL[p.chip] ?? "var(--neutral-fill)") : "var(--neutral-fill)"} stroke="var(--card)" strokeWidth={2} />
            <text
              x={right ? cx + 9 : cx - 9}
              y={crowded || onLine ? cy + 16 : cy - 6}
              fontSize={13}
              fontWeight={600}
              textAnchor={right ? "start" : "end"}
              style={{ fill: "var(--foreground)" }}
              className="font-mono"
            >
              {p.symbol}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The testing behind the page, as bars: each finding's rate and, where it has one, the rate to compare it with.
 * A finding with no registered experiment behind it carries an Exploratory badge.
 */
export function EvidenceBars({ findings }: { findings: Finding[] }) {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      {findings.map((f) => (
        <div key={f.title} className="grid content-start gap-1.5">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {f.title}
            {f.exploratory ? <Badge variant="warn">Exploratory</Badge> : null}
          </p>
          <div
            className="grid gap-1"
            role="img"
            aria-label={`${f.exploratory ? "Exploratory: " : ""}${f.value}% ${f.valueLabel}${f.base != null ? `, against ${f.base}% ${f.baseLabel}` : ""}`}
          >
            <span className="bg-track relative h-3 overflow-hidden rounded-sm">
              <span className="bg-info-fill absolute inset-y-0 left-0 rounded-sm" style={{ width: `${f.value}%` }} />
            </span>
            <span className="font-mono text-xs">
              <span className="font-semibold">{f.value}%</span> <span className="text-muted-foreground">{f.valueLabel}</span>
            </span>
            {f.base != null ? (
              <>
                <span className="bg-track relative h-2 overflow-hidden rounded-sm">
                  <span className="bg-neutral-fill absolute inset-y-0 left-0 rounded-sm" style={{ width: `${f.base}%` }} />
                </span>
                <span className="text-muted-foreground font-mono text-xs">
                  {f.base}% {f.baseLabel}
                </span>
              </>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">{f.use}</p>
        </div>
      ))}
    </div>
  );
}
