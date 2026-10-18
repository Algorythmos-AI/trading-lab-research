// The Radar's pre-market brief: the day's verdict, where SPY opens against the marked levels, the session against
// the owner's own record, the names they trade, the big names that move SPY, and the week. Hand-built SVG and plain
// HTML, like the rest of the Radar page. Green is support, red is resistance, amber is attention; colour always comes
// with a word.
import { CalendarDays, Clock, Gauge, Map as MapIcon, TrendingUp, UserRound } from "lucide-react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { num, shortDate, signed } from "@/lib/format";
import {
  GAP_LIMIT,
  mergedLevels,
  openPlan,
  sydneyAt,
  type BriefTone,
  type Earnings,
  type Mover,
  type OpenRead,
  type SessionRecord,
  type Verdict,
  type WeekDay,
  type YourName,
} from "@/lib/radar-brief";
import type { RadarEvent } from "@/lib/radar";
import { cn } from "@/lib/utils";

const TONE_BADGE: Record<BriefTone, "good" | "warn" | "bad"> = { good: "good", warn: "warn", bad: "bad" };
const pctTxt = (v: number, d = 2) => {
  const body = Math.abs(v).toFixed(d);
  return `${Number(body) === 0 ? "" : v > 0 ? "+" : "−"}${body}%`;
};
/** Whole dollars with a sign: "+$124", "−$2,362". */
export const dollars = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;

function weekday(ymd: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));
}

// ── A. The day's verdict ─────────────────────────────────────────────────────────────────────────────────────────

export function VerdictPanel({
  verdict,
  vix,
  vixChange,
  spyMove,
  regime,
}: {
  verdict: Verdict;
  vix: string | null;
  vixChange: number | null;
  spyMove: number | null;
  regime: string | null;
}) {
  return (
    <Panel
      title="The day"
      icon={Gauge}
      means="Red on a CPI, FOMC, payrolls or PCE day. Amber on the monthly expiry, an earnings report from one of your names, a VIX jump over 10%, or a gap past 80% of a name's expected move. Green otherwise, and only when every check had its data."
    >
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`The day: ${verdict.word}`}>
        <span
          className={cn(
            "rounded-lg border px-3 py-1.5 text-base font-semibold",
            verdict.tone === "bad" && "bg-bad-soft text-bad border-bad/40",
            verdict.tone === "warn" && "bg-warn-soft text-warn border-warn/40",
            verdict.tone === "good" && "bg-good-soft text-good border-good/40",
          )}
        >
          {verdict.word}
        </span>
        {verdict.reasons.map((r, i) => (
          <Badge key={i} variant={TONE_BADGE[r.tone]} className="text-[0.8125rem] whitespace-normal">
            {r.text}
          </Badge>
        ))}
        {verdict.unchecked.length > 0 ? (
          <Badge variant="neutral" className="text-[0.8125rem] whitespace-normal">
            Not checked: {verdict.unchecked.join(", ")}
          </Badge>
        ) : null}
        {verdict.reasons.length === 0 && verdict.unchecked.length === 0 ? <Badge variant="good" className="text-[0.8125rem] whitespace-normal">No market-moving release, no expiry, no earnings on your names</Badge> : null}
        {vix ? (
          <Badge variant="neutral" className="font-mono text-[0.8125rem]">
            VIX {vix}
            {vixChange !== null ? ` ${signed(vixChange, 2)}` : ""}
          </Badge>
        ) : null}
        {spyMove !== null ? (
          <Badge variant="neutral" className="font-mono text-[0.8125rem]">
            SPY move today ±{num(spyMove, 2)}
          </Badge>
        ) : null}
        {regime ? (
          <Badge variant="neutral" className="text-[0.8125rem] capitalize">
            {regime}
          </Badge>
        ) : null}
      </div>
    </Panel>
  );
}

// ── B. Where SPY opens ───────────────────────────────────────────────────────────────────────────────────────────

const LEVEL_INK: Record<string, string> = { below: "var(--good)", above: "var(--bad)" };

export function OpenMapPanel({ read }: { read: OpenRead }) {
  const ref = read.premarket ?? read.close;
  const plan = openPlan(read);
  if (ref === null || read.levels.length === 0) {
    return (
      <Panel title="Where SPY opens" icon={MapIcon} means="SPY against the day, week and month highs and lows from the Options page.">
        <p className="text-muted-foreground text-sm">No SPY levels were published for this session, so there is nothing to place the open against.</p>
      </Panel>
    );
  }
  const move = read.move ?? Math.max(1, ref * 0.008);
  const marks = mergedLevels(read.levels);
  // Show the levels within reach: at least two expected moves either side, at most three, and always the nearest
  // level each side.
  const nearest = Math.max(read.above ? read.above.price - ref : 0, read.below ? ref - read.below.price : 0) * 1.12;
  const half = Math.min(3 * move, Math.max(2 * move, nearest));
  const lo = ref - half;
  const hi = ref + half;
  const shown = marks.filter((m) => m.price >= lo && m.price <= hi);
  const off = marks.filter((m) => m.price < lo || m.price > hi);
  const step = half > 12 ? 5 : half > 5 ? 2 : 1;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const label = `SPY ${read.premarket !== null ? `pre-market ${read.premarket.toFixed(2)}, ` : ""}close ${num(read.close, 2)}, expected move ±${num(read.move, 2)}. Levels: ${marks
    .map((m) => `${m.names} ${m.price.toFixed(2)}`)
    .join(", ")}.`;
  // One drawing per width: a narrow one for phones keeps the labels readable instead of shrinking a wide one.
  const draw = (W: number, cls: string) => {
    const L = W < 500 ? 22 : 40;
    const R = W - L;
    const X = (p: number) => L + ((p - lo) / (hi - lo)) * (R - L);
    // Each label takes the lowest row where it clears the labels already placed (about 7.2 units a character).
    const rows: number[] = [];
    const rightEdge = [-Infinity, -Infinity, -Infinity];
    for (const m of shown) {
      const x = X(m.price);
      const half = ((m.names.length + 7) * 7.2) / 2;
      const free = rightEdge.findIndex((r) => x - half > r + 4);
      const row = free === -1 ? 2 : free;
      rows.push(row);
      rightEdge[row] = x + half;
    }
    const cx = read.close !== null ? X(read.close) : null;
    const px = read.premarket !== null ? X(read.premarket) : null;
    const every = W < 500 ? Math.max(1, Math.ceil(ticks.length / 6)) : 1;
    return (
            <svg viewBox={`0 0 ${W} 150`} role="img" aria-label={label} className={cls}>
              {read.close !== null && read.move !== null ? (
                <rect x={X(read.close - read.move)} y={58} width={X(read.close + read.move) - X(read.close - read.move)} height={26} style={{ fill: "var(--info-soft)" }} />
              ) : null}
              <line x1={L} x2={R} y1={71} y2={71} stroke="var(--border)" strokeWidth={2} />
              {shown.map((m, i) => {
                const side = m.price <= ref ? "below" : "above";
                const y = 40 - (rows[i] ?? 0) * 14;
                return (
                  <g key={m.names}>
                    <line x1={X(m.price)} x2={X(m.price)} y1={46} y2={96} stroke={LEVEL_INK[side]} strokeWidth={3} />
                    <text x={X(m.price)} y={y} textAnchor="middle" fontSize={12} className="font-mono" style={{ fill: LEVEL_INK[side] }}>
                      {m.names} {m.price.toFixed(2)}
                    </text>
                  </g>
                );
              })}
              {cx !== null ? (
                <>
                  <circle cx={cx} cy={71} r={6} style={{ fill: "var(--foreground)" }} />
                  <text x={cx} y={116} textAnchor={px !== null && px < cx ? "start" : "end"} dx={px !== null && px < cx ? 6 : -6} fontSize={11} className="font-mono" style={{ fill: "var(--muted-foreground)" }}>
                    close {read.close?.toFixed(2)}
                  </text>
                </>
              ) : null}
              {px !== null ? (
                <>
                  <circle cx={px} cy={71} r={7} fill="none" stroke="var(--warn-fill)" strokeWidth={3} />
                  <text x={px} y={132} textAnchor="middle" fontSize={12} className="font-mono" style={{ fill: "var(--warn)" }}>
                    pre {read.premarket?.toFixed(2)}
                  </text>
                </>
              ) : null}
              {ticks.filter((_, i) => i % every === 0).map((v) => (
                <text key={v} x={X(v)} y={148} textAnchor="middle" fontSize={11} className="font-mono" style={{ fill: "var(--muted-foreground)" }}>
                  {v}
                </text>
              ))}
            </svg>
    );
  };
  return (
    <Panel
      title="Where SPY opens against your levels"
      icon={MapIcon}
      means="The same day, week and month highs and lows as the Options desk. The blue band is the day's expected move from implied vol; the amber ring is the pre-market price."
    >
      <div className="grid gap-3">
        {plan ? <p className="max-w-prose text-sm">{plan}</p> : null}
        {draw(360, "h-auto w-full sm:hidden")}
        {draw(700, "hidden h-auto w-full max-w-[52rem] sm:block")}
        <p className="text-muted-foreground text-xs">
          {off.length > 0 ? `Off the scale: ${off.map((m) => `${m.names} ${m.price.toFixed(2)}`).join(", ")}. ` : ""}
          Live price and VWAP are on the Options page; this is the view before the bell.
        </p>
      </div>
    </Panel>
  );
}

// ── C. The session against the owner's record ────────────────────────────────────────────────────────────────────

const OPEN = 570;
const CLOSE = 960;

export function SessionPanel({
  day,
  record,
  events,
  halfDay,
}: {
  day: string;
  record: SessionRecord | null;
  events: { minute: number; label: string; tone: BriefTone }[];
  halfDay: boolean;
}) {
  const end = halfDay ? 780 : CLOSE;
  const worst = record?.worst ?? null;
  const preOpen = events.filter((e) => e.minute < OPEN);
  const inside = events.filter((e) => e.minute >= OPEN && e.minute <= end);
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const label = `The New York session on ${day}${halfDay ? ", closing at 13:00" : ""}: no entries 09:30 to 09:35${
    worst ? `, your worst window ${worst.label}` : ""
  }${halfDay ? "" : ", no new same-day options after 15:00"}${inside.length ? `. Releases: ${inside.map((e) => `${hhmm(e.minute)} ${e.label}`).join(", ")}` : ""}.`;
  const draw = (W: number, cls: string) => {
    const L = W < 500 ? 16 : 40;
    const R = W - L;
    const X = (m: number) => L + ((Math.min(Math.max(m, OPEN), end) - OPEN) / (end - OPEN)) * (R - L);
    const ticks = (W < 500 ? [OPEN, 690, 780, CLOSE] : [OPEN, 630, 690, 780, 900, CLOSE]).filter((m) => m <= end);
    return (
            <svg viewBox={`0 0 ${W} 120`} role="img" aria-label={label} className={cls}>
              <rect x={L} y={42} width={R - L} height={30} rx={4} style={{ fill: "var(--muted)" }} />
              <rect x={X(OPEN)} y={42} width={X(OPEN + 5) - X(OPEN)} height={30} style={{ fill: "var(--bad-fill)" }} opacity={0.7} />
              {worst ? (
                <>
                  <rect x={X(worst.from)} y={42} width={X(worst.to) - X(worst.from)} height={30} style={{ fill: "var(--warn-fill)" }} opacity={0.35} />
                  <text x={(X(worst.from) + X(worst.to)) / 2} y={62} textAnchor="middle" fontSize={W < 500 ? 11 : 12} style={{ fill: "var(--foreground)" }}>
                    {X(worst.to) - X(worst.from) > 120 ? "your worst window" : "worst"}
                  </text>
                </>
              ) : null}
              {!halfDay ? (
                <>
                  <rect x={X(900)} y={42} width={X(CLOSE) - X(900)} height={30} style={{ fill: "var(--bad-fill)" }} opacity={0.3} />
                  <text x={(X(900) + X(CLOSE)) / 2} y={62} textAnchor="middle" fontSize={W < 500 ? 11 : 12} style={{ fill: "var(--foreground)" }}>
                    {X(CLOSE) - X(900) > 90 ? "no new 0DTE" : "no 0DTE"}
                  </text>
                </>
              ) : null}
              {inside.map((e, i) => (
                <g key={i}>
                  <line x1={X(e.minute)} x2={X(e.minute)} y1={30} y2={82} stroke={e.tone === "bad" ? "var(--bad-fill)" : "var(--warn-fill)"} strokeWidth={2} />
                  <text
                    x={X(e.minute)}
                    y={i % 2 ? 26 : 12}
                    textAnchor={X(e.minute) > W * 0.7 ? "end" : X(e.minute) < W * 0.3 ? "start" : "middle"}
                    fontSize={11}
                    style={{ fill: e.tone === "bad" ? "var(--bad)" : "var(--warn)" }}
                  >
                    {hhmm(e.minute)} {e.label}
                  </text>
                </g>
              ))}
              {ticks.map((m) => (
                <g key={m} className="font-mono" fontSize={11} style={{ fill: "var(--muted-foreground)" }}>
                  <text x={X(m)} y={92} textAnchor={m === OPEN ? "start" : m === end ? "end" : "middle"}>
                    {hhmm(m)}
                  </text>
                  <text x={X(m)} y={108} textAnchor={m === OPEN ? "start" : m === end ? "end" : "middle"}>
                    {m === OPEN && W >= 500 ? sydneyAt(day, m) : sydneyAt(day, m).slice(-5)}
                    {m === end && W >= 500 ? " Syd" : ""}
                  </text>
                </g>
              ))}
            </svg>
    );
  };
  return (
    <Panel
      title="Your session"
      icon={Clock}
      means="New York time, with Sydney underneath. The shaded windows come from your rules and your own trade record."
    >
      <div className="grid gap-3">
        {preOpen.length > 0 ? (
          <p className="text-muted-foreground text-xs">Before the bell: {preOpen.map((e) => `${hhmm(e.minute)} ${e.label}`).join(" · ")}</p>
        ) : null}
        {draw(360, "h-auto w-full sm:hidden")}
        {draw(700, "hidden h-auto w-full max-w-[52rem] sm:block")}
        {record && record.rows.some((r) => r.trades > 0) ? (
          <ul aria-label="Your record by time of day" className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
            <li className="text-muted-foreground font-sans">Your {record.scope} by entry time:</li>
            {record.rows
              .filter((r) => r.trades > 0)
              .map((r) => (
                <li key={r.key} className={cn(r.key === worst?.key && "font-semibold")}>
                  {r.label} <span className={r.pnl < 0 ? "text-bad" : r.pnl > 0 ? "text-good" : ""}>{dollars(r.pnl)}</span>{" "}
                  <span className="text-muted-foreground">({r.trades})</span>
                </li>
              ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}

// ── D. The owner's names ─────────────────────────────────────────────────────────────────────────────────────────

const whenWord = (w: string | null) => (w === "amc" ? " after the close" : w === "bmo" ? " before the open" : "");

export function YourNamesPanel({ names, reads, earnings, year }: { names: YourName[]; reads: OpenRead[]; earnings: Earnings[]; year: string }) {
  return (
    <Panel
      title="Your names this morning"
      icon={UserRound}
      means={`The names you trade most, each against its nearest marked level. Right: your ${year} result before fees, and how many trades.`}
    >
      <ul aria-label="Your names this morning" className="grid gap-2">
        {names.map((n) => {
          const o = reads.find((r) => r.symbol === n.symbol);
          const report = earnings.find((e) => e.symbol === n.symbol);
          const gapFlag = o?.gapVsMove !== null && o?.gapVsMove !== undefined && o.gapVsMove > GAP_LIMIT;
          const ref = o?.premarket ?? o?.close ?? null;
          return (
            <li key={n.symbol} className="border-border grid grid-cols-[3.5rem_1fr] items-start gap-x-3 gap-y-1 rounded-lg border p-3 sm:grid-cols-[4rem_1fr_auto]">
              <span className="font-mono text-[0.9375rem] font-semibold">{n.symbol}</span>
              <div className="min-w-0 text-[0.8125rem] leading-snug">
                {ref !== null ? (
                  <p>
                    <span className="font-mono">
                      {ref.toFixed(2)} {o?.premarket !== null ? "pre" : "close"}
                    </span>
                    {o?.gapPct !== null && o?.gapPct !== undefined ? (
                      <span className={cn("ml-1.5 font-mono font-medium", gapFlag && "text-warn")}>{pctTxt(o.gapPct, 1)}</span>
                    ) : null}
                    {o?.below ? (
                      <span className="text-muted-foreground">
                        {" · "}
                        <span className="text-good">
                          {o.below.name} {o.below.price.toFixed(2)}
                        </span>{" "}
                        below
                      </span>
                    ) : null}
                    {o?.above ? (
                      <span className="text-muted-foreground">
                        {" · "}
                        <span className="text-bad">
                          {o.above.name} {o.above.price.toFixed(2)}
                        </span>{" "}
                        above
                      </span>
                    ) : null}
                    {o?.move ? <span className="text-muted-foreground font-mono"> · move ±{o.move.toFixed(2)}</span> : null}
                  </p>
                ) : (
                  <p className="text-muted-foreground">No levels or price for this name today.</p>
                )}
                {gapFlag && o?.gapVsMove ? (
                  <p className="text-warn">Gap is {o.gapVsMove.toFixed(1)}× its daily move: wait for a retest, don&apos;t chase the open.</p>
                ) : null}
                {o?.why ? <p className="text-muted-foreground mt-0.5">{o.why}</p> : null}
                {report ? (
                  <Badge variant="warn" className="mt-1">
                    Earnings {weekday(report.date)}
                    {whenWord(report.when)}
                  </Badge>
                ) : null}
              </div>
              <p className="col-start-2 font-mono text-xs whitespace-nowrap sm:col-start-3 sm:text-right">
                <span className={n.yearPnl < 0 ? "text-bad" : n.yearPnl > 0 ? "text-good" : ""}>{dollars(n.yearPnl)}</span>
                <span className="text-muted-foreground"> ({n.yearTrades})</span>
                {n.allTrades > n.yearTrades ? (
                  <span className="text-muted-foreground block">all time {dollars(n.allPnl)}</span>
                ) : null}
              </p>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ── E. The big names that move SPY ───────────────────────────────────────────────────────────────────────────────

export function MoversPanel({ rows }: { rows: Mover[] }) {
  if (rows.length === 0) return null;
  const W = 420;
  const ROW = 26;
  const Z = 210;
  const H = rows.length * ROW + 10;
  const top = Math.max(1, ...rows.map((r) => Math.abs(r.pct)));
  // Room either side of zero for the bar and its value label, clear of the ticker column.
  const room = Math.min(Z - 120, W - Z - 70);
  const len = (v: number) => (Math.abs(v) / top) * room;
  return (
    <Panel title="Big names that move SPY, pre-market" icon={TrendingUp} means="Each name's pre-market price against its last close. Hover a bar for the radar's reason.">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Pre-market moves: ${rows.map((r) => `${r.symbol} ${pctTxt(r.pct)}`).join(", ")}.`}
        className="h-auto w-full max-w-xl"
      >
        <line x1={Z} x2={Z} y1={0} y2={H} stroke="var(--border)" />
        {rows.map((r, i) => {
          const y = 6 + i * ROW;
          const flat = Math.abs(r.pct) < 0.005;
          const up = r.pct >= 0;
          return (
            <g key={r.symbol}>
              <title>{`${r.symbol} ${pctTxt(r.pct)}${r.why ? `: ${r.why}` : ""}`}</title>
              <text x={8} y={y + 12} fontSize={12} className="font-mono" style={{ fill: "var(--foreground)" }}>
                {r.symbol}
              </text>
              <rect x={up ? Z : Z - len(r.pct)} y={y} width={Math.max(2, len(r.pct))} height={15} style={{ fill: flat ? "var(--muted-foreground)" : up ? "var(--good-fill)" : "var(--bad-fill)" }} />
              <text
                x={up ? Z + len(r.pct) + 6 : Z - len(r.pct) - 6}
                y={y + 12}
                textAnchor={up ? "start" : "end"}
                fontSize={11.5}
                className="font-mono"
                style={{ fill: flat ? "var(--muted-foreground)" : up ? "var(--good)" : "var(--bad)" }}
              >
                {pctTxt(r.pct)}
              </text>
            </g>
          );
        })}
      </svg>
    </Panel>
  );
}

// ── F. The week ──────────────────────────────────────────────────────────────────────────────────────────────────

export function WeekPanel({ days, later, today, earningsKnown }: { days: WeekDay[]; later: RadarEvent[]; today: string; earningsKnown: boolean }) {
  return (
    <Panel
      title="This week, for your names"
      icon={CalendarDays}
      means={
        earningsKnown
          ? "Releases from the radar, and earnings, with your names in amber. Times are New York."
          : "Releases from the radar. Neither calendar carries earnings dates, so a report from one of your names may be missing here. Times are New York."
      }
    >
      <div className="grid gap-3">
        <ol aria-label="This week" className="grid gap-2 sm:grid-cols-5">
          {days.map((d) => (
            <li key={d.date} className={cn("border-border grid min-w-0 content-start gap-1.5 rounded-lg border p-2.5 text-xs", d.date === today && "bg-muted/40")}>
              <p className={cn("font-semibold", d.date === today ? "text-foreground" : "text-muted-foreground")}>
                {weekday(d.date)}
                {d.date === today ? " · today" : ""}
              </p>
              {d.events.map((e, i) => (
                <p key={i} className={cn(e.impact === "high" && "text-warn font-medium")}>
                  {e.time_et ? <span className="font-mono">{e.time_et} </span> : null}
                  {e.label}
                </p>
              ))}
              {d.earnings.length > 0 ? (
                <p>
                  {d.earnings.map((e, i) => (
                    <span key={e.symbol} className={cn("font-mono", e.yours ? "text-warn font-semibold" : "text-muted-foreground")}>
                      {i > 0 ? ", " : ""}
                      {e.symbol}
                    </span>
                  ))}{" "}
                  <span className="text-muted-foreground">earnings</span>
                </p>
              ) : null}
              {d.events.length === 0 && d.earnings.length === 0 ? <p className="text-muted-foreground">None listed</p> : null}
            </li>
          ))}
        </ol>
        {later.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Later:{" "}
            {later.map((e, i) => (
              <span key={i} className="text-warn font-medium">
                {i > 0 ? " · " : ""}
                {e.label} {shortDate(e.date)}
                {e.time_et ? ` ${e.time_et}` : ""}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
