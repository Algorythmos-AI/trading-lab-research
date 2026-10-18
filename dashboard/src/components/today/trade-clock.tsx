import { BELL_CLOSE, BELL_OPEN, CLOCK_FROM, CLOCK_TO } from "@/lib/today";
import type { ClockTrade } from "@/lib/overview";

const W = 640;
const L = 44;
const R = W - 10;
const LANE = 16;
const TOP = 22;
const CURVE = 84;

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
const usd = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/**
 * One trading day on the New York clock: every trade as a bar from entry to exit (green made money, red lost, blue
 * still open), on its own row when trades overlap, and the day's running result underneath as a step line. The
 * window is the regular session, widened to take any trade outside it.
 */
export function TradeClock({ items, lanes, steps, nowMinute, day }: { items: ClockTrade[]; lanes: number; steps: { at: number; cum: number }[]; nowMinute: number | null; day: string }) {
  const first = Math.min(BELL_OPEN - 30, ...items.map((i) => i.from - 10));
  const last = Math.max(BELL_CLOSE + 30, ...items.map((i) => i.to + 10), nowMinute !== null && nowMinute <= CLOCK_TO ? nowMinute + 5 : 0);
  const from = Math.max(CLOCK_FROM, Math.floor(first / 30) * 30);
  const to = Math.min(CLOCK_TO, Math.ceil(last / 30) * 30);
  const X = (m: number) => L + ((Math.max(from, Math.min(to, m)) - from) / (to - from)) * (R - L);
  const rows = Math.max(1, lanes);
  const laneBottom = TOP + rows * LANE + 6;
  const curveTop = laneBottom + 10;
  const curveBottom = curveTop + CURVE;
  const H = curveBottom + 22;
  const reach = Math.max(25, ...steps.map((s) => Math.abs(s.cum)));
  const Y = (v: number) => curveTop + CURVE / 2 - (v / reach) * (CURVE / 2 - 4);
  const end = steps.at(-1)?.cum ?? 0;
  const path = steps.length
    ? `M${X(from)},${Y(0)} L${X(steps[0]!.at)},${Y(0)} ` +
      steps.map((s, i) => `L${X(s.at)},${Y(s.cum)}${i < steps.length - 1 ? ` L${X(steps[i + 1]!.at)},${Y(s.cum)}` : ""}`).join(" ") +
      ` L${X(nowMinute !== null && nowMinute < to ? Math.max(nowMinute, steps.at(-1)!.at) : to)},${Y(end)}`
    : "";
  const ticks: number[] = [];
  for (let m = Math.ceil(from / 60) * 60; m <= to; m += 60) ticks.push(m);
  const nowIn = nowMinute !== null && nowMinute >= from && nowMinute <= to ? nowMinute : null;
  const label = `Your trades on ${day}, New York time: ${items.length} trade${items.length === 1 ? "" : "s"}${steps.length ? `, ending the day ${usd(end)}` : ""}.`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full" data-testid="trade-clock">
      <rect x={X(Math.max(from, BELL_OPEN))} y={TOP - 6} width={Math.max(0, X(Math.min(to, BELL_CLOSE)) - X(Math.max(from, BELL_OPEN)))} height={curveBottom - TOP + 6} fill="var(--info-fill)" fillOpacity={0.08} />
      <text x={(X(Math.max(from, BELL_OPEN)) + X(Math.min(to, BELL_CLOSE))) / 2} y={TOP - 10} textAnchor="middle" fontSize={10.5} style={{ fill: "var(--muted-foreground)" }}>
        regular session
      </text>
      <text x={L - 6} y={TOP + (rows * LANE) / 2 + 4} textAnchor="end" fontSize={10.5} style={{ fill: "var(--muted-foreground)" }}>
        trades
      </text>
      {Array.from({ length: rows }, (_, i) => (
        <line key={i} x1={L} x2={R} y1={TOP + i * LANE + LANE / 2} y2={TOP + i * LANE + LANE / 2} stroke="var(--border)" strokeWidth={1} />
      ))}
      {items.map((t) => {
        const y = TOP + t.lane * LANE + LANE / 2;
        const fill = t.open ? "var(--info-fill)" : (t.pnl ?? 0) >= 0 ? "var(--good-fill)" : "var(--bad-fill)";
        return (
          <g key={t.id}>
            <title>{`${t.label}: ${hhmm(t.from)} to ${t.open ? "now, still open" : hhmm(t.to)} New York${t.pnl !== null ? `, ${usd(t.pnl)}` : ""}`}</title>
            <rect x={X(t.from)} y={y - 5} width={Math.max(4, X(t.to) - X(t.from))} height={10} rx={2.5} fill={fill} className={t.open ? "motion-safe:animate-pulse" : undefined} />
          </g>
        );
      })}
      <text x={L - 6} y={Y(0) + 4} textAnchor="end" fontSize={10.5} style={{ fill: "var(--muted-foreground)" }}>
        $0
      </text>
      <line x1={L} x2={R} y1={Y(0)} y2={Y(0)} stroke="var(--chart-axis)" strokeWidth={1} />
      {[reach, -reach].map((v) => (
        <text key={v} x={L - 6} y={Y(v) + 4} textAnchor="end" fontSize={10} style={{ fill: "var(--muted-foreground)" }}>
          {usd(v)}
        </text>
      ))}
      {path ? <path d={path} fill="none" stroke={end >= 0 ? "var(--good-fill)" : "var(--bad-fill)"} strokeWidth={2} strokeLinejoin="round" /> : null}
      {steps.length ? (
        <text x={Math.min(R - 2, X(steps.at(-1)!.at) + 6)} y={Y(end) + (end >= 0 ? -6 : 14)} textAnchor={X(steps.at(-1)!.at) > R - 70 ? "end" : "start"} fontSize={11} fontWeight={600} style={{ fill: end >= 0 ? "var(--good)" : "var(--bad)" }}>
          {usd(end)}
        </text>
      ) : null}
      {nowIn !== null ? <line x1={X(nowIn)} x2={X(nowIn)} y1={TOP - 6} y2={curveBottom} stroke="var(--warn-fill)" strokeWidth={2} data-testid="trade-clock-now" /> : null}
      {ticks.map((m) => (
        <text key={m} x={X(m)} y={H - 6} textAnchor="middle" fontSize={10.5} style={{ fill: "var(--muted-foreground)" }}>
          {hhmm(m)}
        </text>
      ))}
    </svg>
  );
}
