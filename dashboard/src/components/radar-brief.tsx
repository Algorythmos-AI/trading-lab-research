// The Radar's pre-market brief: the day's call, SPY on its levels, the session by the owner's own record, the names
// they trade, the mega caps and the week. Hand-built SVG like the rest of the Radar; colour always comes with a word.
import { CalendarDays, Clock, Gauge, ListChecks, Map as MapIcon, TrendingUp } from "lucide-react";
import { Panel } from "@/components/panel";
import { WeekStrip } from "@/components/radar-charts";
import { Badge } from "@/components/ui/badge";
import { num, shortDate, usd } from "@/lib/format";
import type { GroupRow } from "@/lib/journal";
import { calendarWeek, type Radar, type Tone } from "@/lib/radar";
import {
  GAP_SHARE,
  VIX_JUMP_PCT,
  WINDOW_MIN_TRADES,
  type Ladder,
  type NameRow,
  type Verdict,
  type VerdictLevel,
} from "@/lib/radar-brief";
import { cn } from "@/lib/utils";

const sgn = (v: number, d = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`;
const pnl = (v: number) => `${v > 0 ? "+" : ""}${usd(v)}`;

const VERDICT: Record<VerdictLevel, { label: string; tone: Tone }> = {
  red: { label: "Stand aside day", tone: "bad" },
  amber: { label: "Careful day", tone: "warn" },
  green: { label: "Normal day", tone: "good" },
  unchecked: { label: "Not fully checked", tone: "neutral" },
};

/** A. The day's call, its reasons and the inputs it could not check, with the rules printed underneath. */
export function VerdictPanel({ v, regime, vix }: { v: Verdict; regime: string | null | undefined; vix: string | null }) {
  const head = VERDICT[v.level];
  return (
    <Panel
      title="The day"
      icon={Gauge}
      means="One call before the bell, from the radar's calendar and gauges and the options levels. Research only."
      action={<Badge variant={head.tone}>{head.label}</Badge>}
    >
      <div className="grid gap-3 text-sm">
        <ul className="flex flex-wrap gap-1.5" aria-label="Why">
          {v.reasons.map((r, i) => (
            <li key={i}>
              <Badge variant={r.level === "red" ? "bad" : "warn"}>{r.text}</Badge>
            </li>
          ))}
          {vix ? (
            <li>
              <Badge variant="neutral">VIX {vix}</Badge>
            </li>
          ) : null}
          {regime ? (
            <li>
              <Badge variant="neutral">Regime {regime}</Badge>
            </li>
          ) : null}
          {v.reasons.length === 0 && v.level === "green" ? <li className="text-muted-foreground">No rule fired.</li> : null}
        </ul>
        {v.unknown.length > 0 ? (
          <p className="text-muted-foreground">
            Could not check: {v.unknown.join("; ")}. {v.reasons.length === 0 ? "So the day is not called normal." : ""}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          Rules: stand aside on an FOMC, CPI, payrolls or PCE day. Careful on the monthly options expiry, another high-impact
          release, an earnings report today on one of your names, VIX up more than {VIX_JUMP_PCT}%, or a name opening more
          than {Math.round(GAP_SHARE * 100)}% of its daily expected move from the close. Normal only when every input was
          there and none fired.
        </p>
      </div>
    </Panel>
  );
}

/** B. SPY's named levels around the pre-market price, with the day's expected-move band. */
export function LevelMap({ symbol, lad, session, current }: { symbol: string; lad: Ladder | null; session: string | null; current: boolean }) {
  if (!lad) {
    return (
      <Panel title={`Where ${symbol} opens against its levels`} icon={MapIcon} means="The options levels for this session are not available.">
        <p className="text-muted-foreground text-sm">No options edition, or it does not carry {symbol}.</p>
      </Panel>
    );
  }
  // Drawn at the width of the Radar's other charts so the text stays legible on a phone; the prices are listed
  // underneath, so the map only has to carry the level codes.
  const W = 360;
  const L = 14;
  const R = W - 14;
  const AXIS = 58;
  // The map spans the band, the close, pre-market and every level within two expected moves of the reference.
  const reach = lad.band ? lad.band[1] - lad.band[0] : lad.ref * 0.02;
  const near = lad.rungs.filter((x) => Math.abs(x.price - lad.ref) <= reach);
  const off = lad.rungs.filter((x) => Math.abs(x.price - lad.ref) > reach);
  const pts = [lad.close, lad.ref, ...near.map((x) => x.price), ...(lad.band ?? [])];
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  const pad = Math.max((hi - lo) * 0.06, lad.ref * 0.001);
  lo -= pad;
  hi += pad;
  const X = (p: number) => L + ((p - lo) / (hi - lo)) * (R - L);
  // Each code takes the first of three rows where it clears the last code in that row.
  const ends: number[] = [];
  const rows = near.map((x) => {
    const cx = X(x.price);
    let row = ends.findIndex((end) => cx - 13 > end + 3);
    if (row === -1) row = ends.length < 3 ? ends.length : ends.indexOf(Math.min(...ends));
    ends[row] = cx + 13;
    return row;
  });
  // A label near either edge hangs inwards so it is never cut off.
  const anchor = (x: number) => (x < L + 40 ? "start" : x > R - 40 ? "end" : "middle");
  const marks = [
    ...lad.rungs.map((x) => ({ key: x.code, price: x.price, text: `${x.code} ${num(x.price, 2)}`, note: x.label, tone: x.side === "above" ? "text-bad" : "text-good" })),
    { key: "close", price: lad.close, text: `Close ${num(lad.close, 2)}`, note: "the session's close", tone: "text-muted-foreground" },
    ...(lad.pre !== null ? [{ key: "pre", price: lad.pre, text: `Pre ${num(lad.pre, 2)}`, note: "pre-market", tone: "text-warn font-semibold" }] : []),
  ].sort((a, b) => b.price - a.price);
  const label = `${symbol}: ${lad.pre !== null ? `pre-market ${num(lad.pre, 2)}, ` : ""}close ${num(lad.close, 2)}. ${near
    .map((x) => `${x.code} ${num(x.price, 2)}`)
    .join(", ")}.${lad.band ? ` Expected move ${num(lad.band[0], 2)} to ${num(lad.band[1], 2)}.` : ""}`;
  const where =
    lad.up && lad.down
      ? `${lad.pre !== null ? "Pre-market" : "The close"} ${num(lad.ref, 2)} sits between ${lad.down.code} ${num(lad.down.price, 2)} and ${lad.up.code} ${num(lad.up.price, 2)}.`
      : lad.up
        ? `${num(lad.ref, 2)} is under every level; the nearest above is ${lad.up.code} ${num(lad.up.price, 2)}.`
        : lad.down
          ? `${num(lad.ref, 2)} is over every level; the nearest below is ${lad.down.code} ${num(lad.down.price, 2)}.`
          : null;
  return (
    <Panel
      title={`Where ${symbol} opens against its levels`}
      icon={MapIcon}
      means={
        current
          ? "The same levels as the Options page, for this session. Green is below price (support), red is above (resistance)."
          : `These levels are for the ${shortDate(session)} session, not this edition's: read them as last known.`
      }
    >
      <div className="grid gap-2">
        {where ? <p className="text-sm">{where}{lad.pre === null ? " No pre-market price yet." : ""}</p> : null}
        <svg viewBox={`0 0 ${W} 104`} role="img" aria-label={label} className="h-auto w-full">
          {lad.band ? <rect x={X(lad.band[0])} y={AXIS - 12} width={X(lad.band[1]) - X(lad.band[0])} height={24} fill="var(--info-soft)" /> : null}
          <line x1={L} x2={R} y1={AXIS} y2={AXIS} stroke="var(--border)" strokeWidth={2} />
          {near.map((x, i) => {
            const colour = x.side === "above" ? "var(--bad)" : "var(--good)";
            return (
              <g key={x.code}>
                <line x1={X(x.price)} x2={X(x.price)} y1={AXIS - 14} y2={AXIS + 14} stroke={colour} strokeWidth={2.5} />
                <text x={X(x.price)} y={AXIS - 20 - rows[i]! * 13} textAnchor={anchor(X(x.price))} fontSize={11} fontWeight={600} className="font-mono" style={{ fill: colour }}>
                  {x.code}
                </text>
              </g>
            );
          })}
          <circle cx={X(lad.close)} cy={AXIS} r={4.5} style={{ fill: "var(--muted-foreground)" }} />
          <text x={X(lad.close)} y={AXIS + 30} textAnchor={anchor(X(lad.close))} fontSize={11} className="font-mono" style={{ fill: "var(--muted-foreground)" }}>
            close
          </text>
          {lad.pre !== null ? (
            <>
              <circle cx={X(lad.pre)} cy={AXIS} r={6.5} fill="none" stroke="var(--warn-fill)" strokeWidth={2.5} />
              <text x={X(lad.pre)} y={AXIS + 44} textAnchor={anchor(X(lad.pre))} fontSize={11} fontWeight={600} className="font-mono" style={{ fill: "var(--warn)" }}>
                pre
              </text>
            </>
          ) : null}
        </svg>
        <ol aria-label={`${symbol} levels, highest first`} className="grid gap-x-4 gap-y-0.5 font-mono text-xs sm:grid-cols-2">
          {marks.map((m) => (
            <li key={m.key} className="flex justify-between gap-2">
              <span className={m.tone}>{m.text}</span>
              <span className="text-muted-foreground truncate font-sans">{m.note}</span>
            </li>
          ))}
        </ol>
        {lad.band ? (
          <p className="text-muted-foreground text-xs">
            Shaded: the day&apos;s expected move, {num(lad.band[0], 2)} – {num(lad.band[1], 2)}.
            {off.length > 0 ? ` Off the map: ${off.map((x) => x.code).join(", ")}.` : ""}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

/** C. The owner's same-day options record by when in the session the trade was opened. */
export function SessionRecord({ rec }: { rec: { rows: GroupRow[]; worst: string | null; trades: number } | null }) {
  if (!rec || rec.trades === 0) {
    return (
      <Panel title="Your session, by your own record" icon={Clock} means="Same-day options results by time of entry, this year.">
        <p className="text-muted-foreground text-sm">{rec ? "No same-day options trades in the journal this year." : "The trade journal is not available."}</p>
      </Panel>
    );
  }
  const max = Math.max(1, ...rec.rows.map((r) => Math.abs(r.pnl)));
  const worst = rec.rows.find((r) => r.key === rec.worst);
  return (
    <Panel
      title="Your session, by your own record"
      icon={Clock}
      means={`Your ${rec.trades} same-day options trades this year, by New York time of entry, before fees. A band needs ${WINDOW_MIN_TRADES} trades to be called the worst.`}
      action={worst ? <Badge variant="warn">Worst: {worst.label}</Badge> : undefined}
    >
      <ul className="grid gap-1.5 text-sm" aria-label="Result by time of entry">
        {rec.rows.map((r) => {
          const w = (Math.abs(r.pnl) / max) * 50;
          return (
            <li key={r.key} className="grid grid-cols-[5.5rem_1fr_8.5rem] items-center gap-2">
              <span className={cn("font-mono text-xs", r.key === rec.worst && "text-warn font-semibold")}>{r.label}</span>
              <span className="relative h-3" aria-hidden>
                <span className="bg-border absolute top-0 left-1/2 h-3 w-px" />
                {r.trades > 0 ? (
                  <span
                    className={cn("absolute top-0.5 h-2 rounded-sm", r.pnl < 0 ? "bg-bad-fill" : "bg-good-fill")}
                    style={r.pnl < 0 ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }}
                  />
                ) : null}
              </span>
              <span className={cn("text-right font-mono text-xs", r.pnl < 0 ? "text-bad" : r.pnl > 0 ? "text-good" : "text-muted-foreground")}>
                {r.trades > 0 ? `${pnl(r.pnl)} (${r.trades})` : "no trades"}
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Where({ r }: { r: NameRow }) {
  const parts: string[] = [];
  if (r.down) parts.push(`${r.down.code} ${num(r.down.price, 2)} below`);
  if (r.up) parts.push(`${r.up.code} ${num(r.up.price, 2)} above`);
  return parts.length > 0 ? <>{parts.join(" · ")}</> : <span className="text-muted-foreground">no levels for this session</span>;
}

/** D. The names behind most of the owner's trades this year, each against its nearest levels. */
export function YourNames({ rows, journal, earningsKnown }: { rows: NameRow[]; journal: boolean; earningsKnown: boolean }) {
  return (
    <Panel
      title="Your names this morning"
      icon={ListChecks}
      means="The names you traded most this year (from your journal), each against its nearest options levels. Right: your result this year, before fees."
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{journal ? "No trades in the journal yet." : "The trade journal is not available, so your names are not known."}</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.symbol} className="border-border grid gap-1 rounded-lg border p-3 sm:grid-cols-[4.5rem_1fr_auto] sm:items-baseline sm:gap-3">
              <span className="font-mono font-semibold">{r.symbol}</span>
              <span className="grid gap-0.5 text-sm">
                <span>
                  {r.pre !== null ? (
                    <span className="font-mono">
                      {num(r.pre, 2)} pre{r.prePct !== null ? `, ${sgn(r.prePct)}` : ""}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">no pre-market price</span>
                  )}
                  {r.gap !== null && Math.abs(r.gap) > GAP_SHARE ? (
                    <Badge variant="warn" className="ml-2">
                      gap {Math.abs(r.gap).toFixed(1)}× its daily move
                    </Badge>
                  ) : null}
                  {r.earnings ? (
                    <Badge variant="warn" className="ml-2">
                      earnings {shortDate(r.earnings.date)}
                      {r.earnings.time_et ? ` ${r.earnings.time_et}` : ""}
                    </Badge>
                  ) : null}
                </span>
                <span className="text-muted-foreground font-mono text-xs">
                  <Where r={r} />
                  {r.move !== null ? ` · move today ±${num(r.move, 2)}` : ""}
                </span>
                {r.why ? <span className="text-muted-foreground text-xs">{r.why}</span> : null}
              </span>
              {r.record ? (
                <span className={cn("font-mono text-xs sm:text-right", r.record.pnl < 0 ? "text-bad" : "text-good")}>
                  {pnl(r.record.pnl)} ({r.record.trades})
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && !earningsKnown ? (
        <p className="text-muted-foreground mt-3 text-xs">Earnings dates are not in today&apos;s calendar, so no name is flagged for them.</p>
      ) : null}
    </Panel>
  );
}

/** E. The mega caps that move the index, by pre-market move. */
export function MegaMovers({ movers }: { movers: { symbol: string; pct: number; why: string | null }[] }) {
  return (
    <Panel title="Mega caps before the bell" icon={TrendingUp} means="Pre-market move from the last price, for the names that move SPY.">
      {movers.length === 0 ? (
        <p className="text-muted-foreground text-sm">No pre-market prices in this edition.</p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {movers.map((m) => {
            const max = Math.max(1, ...movers.map((x) => Math.abs(x.pct)));
            const w = (Math.abs(m.pct) / max) * 50;
            return (
              <li key={m.symbol} className="grid grid-cols-[4rem_1fr_4.5rem] items-center gap-2" title={m.why ?? undefined}>
                <span className="font-mono text-xs font-semibold">{m.symbol}</span>
                <span className="relative h-3" aria-hidden>
                  <span className="bg-border absolute top-0 left-1/2 h-3 w-px" />
                  <span
                    className={cn("absolute top-0.5 h-2 rounded-sm", m.pct < 0 ? "bg-bad-fill" : "bg-good-fill")}
                    style={m.pct < 0 ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }}
                  />
                </span>
                <span className={cn("text-right font-mono text-xs", m.pct < 0 ? "text-bad" : "text-good")}>{sgn(m.pct)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** F. The week's dated events, with the owner's earnings called out. */
export function WeekAhead({ r, earningsKnown }: { r: Radar; earningsKnown: boolean }) {
  const { days, later } = calendarWeek(r);
  return (
    <Panel
      title="This week"
      icon={CalendarDays}
      means={
        earningsKnown
          ? "Dated releases and earnings from the radar's calendar. High-impact events are in amber."
          : "Dated releases from the radar's calendar. It carries no earnings dates today, so an empty day may still have a report."
      }
    >
      <WeekStrip days={days} later={later} today={r.edition_date} empty={earningsKnown ? "Nothing dated" : "No release dated"} />
    </Panel>
  );
}
