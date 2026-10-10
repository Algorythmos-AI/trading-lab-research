// The Options page's pictures: the room bar, the level map, the rule ranges and the evidence bars. Server-safe
// (no hooks); every number a picture encodes is also in its title text or the table under it.
import { num, signed } from "@/lib/format";
import {
  CHIP_LABEL,
  mapView,
  moveBands,
  niceStep,
  ROOM_REACH,
  spreadLabels,
  type OptionsRule,
  type OptionsTicker,
  type roomView,
} from "@/lib/options";
import { cn } from "@/lib/utils";
import { LiveMapMark } from "./client/live-layer";

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

// Level map geometry, in viewBox units.
const W = 496;
const H = 300;
const TOP = 12;
const BOTTOM = H - 22;
const X0 = 4;
const X1 = 292;
const XD = 314;
const XW = 340;
const LX = 350;
const LABEL_GAP = 27;
/** Zones labelled each side of the close; the rest are drawn unlabelled and listed under the chart. */
const LABELS_EACH_SIDE = 3;

/**
 * Recent daily candles with every nearby zone as a band (stronger when more timeframes agree), the close, and the
 * options market's expected move as a cone into the next day and the week. Candles stay grey so colour only ever
 * means support (green) or resistance (red).
 */
export function LevelMap({ t }: { t: OptionsTicker }) {
  const v = mapView(t);
  const close = t.last?.close;
  if (!v || !isNum(close)) return null;
  const y = (p: number) => TOP + ((v.hi - p) / (v.hi - v.lo)) * (BOTTOM - TOP);
  const step = niceStep(v.hi - v.lo, 5);
  const ticks: number[] = [];
  for (let p = Math.ceil(v.lo / step) * step; p <= v.hi; p += step) ticks.push(p);
  const n = v.bars.length;
  const bw = n > 0 ? (X1 - X0) / n : 0;
  const xLast = n > 0 ? X0 + bw * (n - 0.5) : X1;
  const bands = moveBands(t);

  const above = v.zones.filter((z) => z.tone === "resistance").sort((a, b) => a.zone.lo - b.zone.lo).slice(0, LABELS_EACH_SIDE);
  const below = v.zones.filter((z) => z.tone === "support").sort((a, b) => b.zone.hi - a.zone.hi).slice(0, LABELS_EACH_SIDE);
  const labels = [
    ...[...above, ...below].map(({ zone, tone }) => ({
      y: y((zone.lo + zone.hi) / 2),
      text: zone.lo === zone.hi ? num(zone.lo, 2) : `${num(zone.lo, 2)}–${num(zone.hi, 2)}`,
      sub: `${(zone.members ?? []).join(" + ")}${zone.weight != null ? ` · w${zone.weight}` : ""}`,
      color: tone === "support" ? "var(--good)" : "var(--bad)",
      strong: Boolean(zone.big),
    })),
    {
      y: y(close),
      text: `Close ${num(close, 2)}`,
      sub: t.close_strength?.chip ? (CHIP_LABEL[t.close_strength.chip] ?? "") : "",
      color: "var(--foreground)",
      strong: true,
    },
  ];
  const placed = spreadLabels(
    labels.map((l) => l.y),
    LABEL_GAP,
    TOP + 4,
    H - 10,
  );

  return (
    <figure className="grid gap-1.5">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${t.symbol}: last ${n} daily bars with support and resistance zones and the expected move`}
      >
        {ticks.map((p) => (
          <g key={p}>
            <line x1={X0} x2={XW} y1={y(p)} y2={y(p)} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={X0 + 2} y={y(p) - 3} fontSize={10.5} style={{ fill: "var(--muted-foreground)" }} className="font-mono">
              {num(p, step < 1 ? 2 : 0)}
            </text>
          </g>
        ))}
        {v.zones.map(({ zone, tone }, i) => {
          const y1 = y(zone.hi);
          const h = Math.max(3, y(zone.lo) - y1);
          const fill = tone === "support" ? "var(--good-fill)" : "var(--bad-fill)";
          return (
            <rect
              key={i}
              x={X0}
              y={h === 3 ? y1 - 1.5 : y1}
              width={XW - X0}
              height={h}
              fill={fill}
              fillOpacity={Math.min(0.5, 0.08 + 0.07 * (zone.weight ?? 1))}
            >
              <title>
                {`${tone === "support" ? "Support" : "Resistance"} ${num(zone.lo, 2)}${zone.lo === zone.hi ? "" : `–${num(zone.hi, 2)}`}: ${(zone.members ?? []).join(" + ")}`}
              </title>
            </rect>
          );
        })}
        {v.bars.map((b, i) => {
          const cx = X0 + bw * (i + 0.5);
          const up = b.c >= b.o;
          const top = y(Math.max(b.o, b.c));
          return (
            <g key={b.d}>
              <title>{`${b.d}  O ${num(b.o, 2)}  H ${num(b.h, 2)}  L ${num(b.l, 2)}  C ${num(b.c, 2)}`}</title>
              <line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} stroke="var(--muted-foreground)" strokeWidth={1} />
              <rect
                x={cx - bw * 0.32}
                y={top}
                width={bw * 0.64}
                height={Math.max(1.2, Math.abs(y(b.o) - y(b.c)))}
                rx={0.8}
                fill={up ? "var(--card)" : "var(--muted-foreground)"}
                stroke="var(--muted-foreground)"
                strokeWidth={1}
              />
              {i % 10 === 0 || i === n - 1 ? (
                <text x={i === 0 ? X0 : cx} y={H - 6} fontSize={10.5} textAnchor={i === 0 ? "start" : "middle"} style={{ fill: "var(--muted-foreground)" }} className="font-mono">
                  {b.d.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
        {n === 0 ? (
          <text x={(X0 + X1) / 2} y={H - 6} fontSize={9} textAnchor="middle" style={{ fill: "var(--muted-foreground)" }}>
            Candles appear once the after-close run sends recent bars.
          </text>
        ) : null}
        {bands.day ? (
          <g>
            <title>{`Expected move: 1 day ${num(bands.day[0], 2)} to ${num(bands.day[1], 2)}${bands.week ? `, 1 week ${num(bands.week[0], 2)} to ${num(bands.week[1], 2)}` : ""}`}</title>
            <polygon
              points={
                bands.week
                  ? `${xLast},${y(close)} ${XD},${y(bands.day[1])} ${XW},${y(bands.week[1])} ${XW},${y(bands.week[0])} ${XD},${y(bands.day[0])}`
                  : `${xLast},${y(close)} ${XD},${y(bands.day[1])} ${XD},${y(bands.day[0])}`
              }
              fill="var(--info-fill)"
              fillOpacity={0.14}
              stroke="var(--info-fill)"
              strokeOpacity={0.5}
            />
            <line x1={XD} x2={XD} y1={y(bands.day[1])} y2={y(bands.day[0])} stroke="var(--info-fill)" strokeWidth={2} />
            <text x={XD} y={y(bands.day[1]) - 5} fontSize={10.5} textAnchor="middle" style={{ fill: "var(--info)" }} className="font-mono">
              1d
            </text>
            {bands.week ? (
              <text x={XW - 2} y={y(bands.week[1]) - 5} fontSize={10.5} textAnchor="end" style={{ fill: "var(--info)" }} className="font-mono">
                1w
              </text>
            ) : null}
          </g>
        ) : null}
        <line x1={X0} x2={XW} y1={y(close)} y2={y(close)} stroke="var(--foreground)" strokeOpacity={0.7} strokeDasharray="4 3" />
        <circle cx={xLast} cy={y(close)} r={4} fill="var(--foreground)" stroke="var(--card)" strokeWidth={2} />
        <LiveMapMark t={{ ...t, bars: undefined }} lo={v.lo} hi={v.hi} top={TOP} bottom={BOTTOM} xFrom={xLast} xTo={XD} lineFrom={X0} lineTo={XW} />
        {labels.map((l, i) => (
          <g key={i}>
            <path d={`M${XW} ${l.y} L${LX - 4} ${placed[i]! - 3}`} stroke={l.color} strokeOpacity={0.5} fill="none" />
            <text x={LX} y={placed[i]! - 1} fontSize={12.5} fontWeight={l.strong ? 600 : 400} style={{ fill: l.color }} className="font-mono">
              {l.text}
            </text>
            <text x={LX} y={placed[i]! + 11} fontSize={10} style={{ fill: "var(--muted-foreground)" }} className="font-mono">
              {l.sub}
            </text>
          </g>
        ))}
      </svg>
    </figure>
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

/** A finding as a share of days, against the share expected by chance when there is one. */
export interface Finding {
  title: string;
  value: number;
  valueLabel: string;
  base?: number;
  baseLabel?: string;
  use: string;
}

/** The testing behind the page, as bars: each finding's rate and, where it has one, the ordinary-day rate. */
export function EvidenceBars({ findings }: { findings: Finding[] }) {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      {findings.map((f) => (
        <div key={f.title} className="grid content-start gap-1.5">
          <p className="text-sm font-medium">{f.title}</p>
          <div className="grid gap-1" role="img" aria-label={`${f.value}% ${f.valueLabel}${f.base != null ? `, against ${f.base}% ${f.baseLabel}` : ""}`}>
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
