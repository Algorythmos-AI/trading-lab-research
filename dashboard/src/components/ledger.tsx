// How the Top 4 Focus Card did: one session's review (each name on its 2-minute chart with the levels, the fill and
// the exit, the result in R and on one option contract) and the running record. Server-rendered SVG and native
// <details>, so it needs no script. Its own small charts: the shared price chart is left alone.
import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import { Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status";
import { DivergingBars } from "@/components/charts/diverging-bars";
import { Notice } from "@/components/ui/notice";
import { DASH, fracPct, newYork, num, rMult, shortDate, weekDate } from "@/lib/format";
import {
  BIAS_LABEL,
  contractLabel,
  isWin,
  optionExit,
  optionStoppedFirst,
  optionTotal,
  RESULT,
  running,
  sessionMinute,
  weekGrid,
  type LedgerDay,
  type LedgerEdition,
  type LedgerName,
  type LedgerSide,
} from "@/lib/ledger";
import { cn } from "@/lib/utils";

const NO_ENTRY: [number, number][] = [
  [0, 5],
  [120, 210],
];

/** "+$35" / "−$45": one option contract's dollars, whole dollars. */
function dollars(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return DASH;
  const s = `$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
  return Math.round(v) === 0 ? s : `${v > 0 ? "+" : "−"}${s}`;
}

const toneOf = (v: number | null | undefined) => (typeof v !== "number" || v === 0 ? "" : v > 0 ? "text-good" : "text-bad");
const r2 = (v: number | null | undefined) => rMult(v, 2);
const et = (iso: string | null | undefined) => newYork(iso, false);

/** One name's session on its 2-minute closes: the ceiling and floor, the no-entry times, and each filled side from fill to exit. */
export function DayChart({ n, big = false }: { n: LedgerName; big?: boolean }) {
  const W = big ? 960 : 380;
  const H = big ? 300 : 150;
  const pad = { l: big ? 56 : 6, r: big ? 64 : 52, t: 10, b: 20 };
  const b = n.bars;
  if (!b || b.t.length < 2) {
    return <p className="text-muted-foreground py-6 text-center text-xs">No bars for this session.</p>;
  }
  const filled = n.sides.filter((s) => s.filled);
  const ys = [...b.low, ...b.high, ...(n.ceiling ? [n.ceiling] : []), ...(n.floor ? [n.floor] : []), ...filled.flatMap((s) => [s.stop, s.t1])];
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  const room = (hi - lo) * 0.06 || 1;
  lo -= room;
  hi += room;
  const X = (m: number) => pad.l + (Math.min(390, Math.max(0, m)) / 390) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const line = b.close.map((c, i) => `${i ? "L" : "M"}${X(b.t[i]!).toFixed(1)},${Y(c).toFixed(1)}`).join("");
  const fs = big ? 11 : 10.5;
  const level = (v: number | null, color: string, key: string) =>
    v === null ? null : (
      <g key={key}>
        <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} stroke={color} strokeWidth={1.2} strokeDasharray="4 3" />
        <text x={W - pad.r + 4} y={Y(v) + 3.5} fontSize={fs} fill={color} className="font-mono">
          {v.toFixed(2)}
        </text>
      </g>
    );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${n.symbol}: the session's 2-minute closes against the card's levels`}>
      {NO_ENTRY.map(([a, z]) => (
        <rect key={a} x={X(a)} y={pad.t} width={X(z) - X(a)} height={H - pad.t - pad.b} fill="var(--muted-foreground)" opacity={0.08} />
      ))}
      {[30, 150, 270, 390].map((m) => (
        <g key={m}>
          <line x1={X(m)} x2={X(m)} y1={pad.t} y2={H - pad.b} stroke="var(--chart-grid)" />
          <text x={X(m)} y={H - 5} textAnchor={m === 390 ? "end" : "middle"} fontSize={fs} fill="var(--muted-foreground)" className="font-mono">
            {`${Math.floor((570 + m) / 60)}:00`}
          </text>
        </g>
      ))}
      {big
        ? [lo + room, hi - room].map((v) => (
            <text key={v} x={pad.l - 6} y={Y(v) + 3.5} textAnchor="end" fontSize={fs} fill="var(--muted-foreground)" className="font-mono">
              {v.toFixed(2)}
            </text>
          ))
        : null}
      {level(n.ceiling, "var(--chart-1)", "ceiling")}
      {level(n.floor, "var(--chart-2)", "floor")}
      {filled.map((s) => {
        const a = X(sessionMinute(s.fill_time) ?? 0);
        const z = X(sessionMinute(s.exit_time) ?? 390);
        const tone = s.result === "stopped" ? "bad" : isWin(s) ? "good" : "neutral";
        return (
          <rect
            key={`${s.side}-band`}
            x={a}
            y={Math.min(Y(s.t1), Y(s.stop))}
            width={Math.max(z - a, 2)}
            height={Math.abs(Y(s.t1) - Y(s.stop))}
            fill={`var(--${tone}-fill)`}
            opacity={0.1}
          />
        );
      })}
      {big ? <path d={b.high.map((h, i) => `M${X(b.t[i]!).toFixed(1)},${Y(h).toFixed(1)}V${Y(b.low[i]!).toFixed(1)}`).join("")} stroke="var(--chart-axis)" strokeWidth={1} /> : null}
      <path d={line} fill="none" stroke="var(--foreground)" strokeWidth={1.4} strokeLinejoin="round" />
      {n.sides.map((s) => {
        const tm = sessionMinute(s.trigger_time);
        if (!s.filled) {
          if (tm === null) return null;
          const tx = X(tm);
          const ty = Y(s.level);
          return <path key={s.side} d={`M${tx - 4},${ty + 4}L${tx},${ty - 3}L${tx + 4},${ty + 4}Z`} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.2} />;
        }
        const a = X(sessionMinute(s.fill_time) ?? 0);
        const z = X(sessionMinute(s.exit_time) ?? 390);
        const exitColor = s.result === "stopped" ? "var(--bad-fill)" : isWin(s) ? "var(--good-fill)" : "var(--neutral-fill)";
        const optStop = big && s.option?.reason === "option_stop_25pct" ? sessionMinute(s.option.exit_time) : null;
        return (
          <g key={s.side}>
            <line x1={a} x2={z} y1={Y(s.t1)} y2={Y(s.t1)} stroke="var(--good-fill)" strokeWidth={1.5} />
            <line x1={a} x2={z} y1={Y(s.stop)} y2={Y(s.stop)} stroke="var(--bad-fill)" strokeWidth={1.5} />
            <line x1={a} x2={z} y1={Y(s.entry)} y2={Y(s.entry)} stroke="var(--muted-foreground)" strokeDasharray="2 2" />
            <circle cx={a} cy={Y(s.entry)} r={3.6} fill="var(--card)" stroke="var(--foreground)" strokeWidth={1.6} />
            <rect x={z - 3.5} y={Y(s.exit ?? s.entry) - 3.5} width={7} height={7} fill={exitColor} />
            {optStop !== null ? (
              <g>
                <line x1={X(optStop)} x2={X(optStop)} y1={pad.t} y2={H - pad.b} stroke="var(--warn-fill)" strokeWidth={1.2} strokeDasharray="3 3" />
                <text x={X(optStop) + 4} y={pad.t + 11} fontSize={fs} fill="var(--warn)">
                  {`option stopped ${et(s.option?.exit_time)}`}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function SideRow({ s }: { s: LedgerSide }) {
  const res = RESULT[s.result] ?? { label: s.result, tone: "neutral" as const };
  return (
    <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 text-[0.8125rem]">
      <span className="text-muted-foreground text-[0.6875rem] font-semibold tracking-wider uppercase">{s.side}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2">
        <StatusBadge tone={res.tone}>{res.label}</StatusBadge>
        {s.filled ? (
          <span className="text-muted-foreground text-xs">
            filled {et(s.fill_time)}
            {s.exit_time ? `, out ${et(s.exit_time)}` : ""}
          </span>
        ) : null}
      </span>
      <span className={cn("min-w-[4.5rem] text-right font-mono tabular-nums", toneOf(s.r))}>{s.filled ? r2(s.r) : DASH}</span>
      {s.option ? (
        <span className="text-muted-foreground col-span-2 col-start-2 text-xs">
          Option {contractLabel(s.option)}: <span className={cn("font-mono", toneOf(s.option.pnl_usd))}>{dollars(s.option.pnl_usd)}</span>, {optionExit(s.option.reason)}
          {s.option.exit_time && s.option.reason !== "session_close" ? ` at ${et(s.option.exit_time)}` : ""}
        </span>
      ) : null}
    </div>
  );
}

function SideTable({ n }: { n: LedgerName }) {
  const p = (v: number | null) => (v === null ? DASH : v.toFixed(2));
  return (
    // Focusable, so a keyboard can scroll it on a phone.
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`${n.symbol}: both sides`}>
      <table className="w-full text-[0.8125rem]">
        <thead className="text-muted-foreground text-xs">
          <tr className="border-b text-left">
            {["Side", "Level", "Entry", "Stop", "Target 1", "Target 2", "Result", "R, card", "R, 5-min rule", "R, hold for T2", "Option"].map((h, i) => (
              <th key={h} className={cn("py-1.5 pr-3 font-medium whitespace-nowrap", i > 0 && i !== 6 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {n.sides.map((s) => (
            <tr key={s.side} className="border-b last:border-0">
              <td className="py-1.5 pr-3 font-sans font-medium uppercase">{s.side}</td>
              <td className="pr-3 text-right">{p(s.level)}</td>
              <td className="pr-3 text-right">{p(s.entry)}</td>
              <td className="pr-3 text-right">{p(s.stop)}</td>
              <td className="pr-3 text-right">{p(s.t1)}</td>
              <td className="pr-3 text-right">{p(s.t2)}</td>
              <td className="pr-3 font-sans whitespace-nowrap">{(RESULT[s.result] ?? { label: s.result }).label}</td>
              <td className={cn("pr-3 text-right", toneOf(s.r))}>{s.filled ? r2(s.r) : DASH}</td>
              <td className={cn("pr-3 text-right", toneOf(s.r_five_min))}>{s.filled ? r2(s.r_five_min) : DASH}</td>
              <td className={cn("pr-3 text-right", toneOf(s.r_hold_t2))}>{s.filled ? r2(s.r_hold_t2) : DASH}</td>
              <td className={cn("text-right whitespace-nowrap", toneOf(s.option?.pnl_usd))}>{s.option ? `${contractLabel(s.option)} ${dollars(s.option.pnl_usd)}` : DASH}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NameTile({ n }: { n: LedgerName }) {
  return (
    <article className="bg-card grid min-w-0 content-start gap-2 rounded-lg border p-3 has-[details[open]]:md:col-span-2" aria-label={n.symbol} data-testid="ledger-name">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-[0.9375rem] font-semibold">{n.symbol}</span>
        <span className="text-muted-foreground font-mono text-xs">#{n.rank}</span>
        <span className="text-muted-foreground text-xs">{BIAS_LABEL[n.bias] ?? n.bias}</span>
        <span className="ml-auto">
          {n.bias_correct === null ? (
            <StatusBadge tone="neutral">No bias call</StatusBadge>
          ) : (
            <StatusBadge tone={n.bias_correct ? "good" : "bad"}>Bias {n.bias_correct ? "right" : "wrong"}</StatusBadge>
          )}
        </span>
      </header>
      <DayChart n={n} />
      <div className="grid gap-1.5">
        {n.sides.map((s) => (
          <SideRow key={s.side} s={s} />
        ))}
      </div>
      <details className="group">
        <summary className="text-primary flex cursor-pointer list-none items-center gap-1 text-xs font-medium [&::-webkit-details-marker]:hidden">
          Full chart and both sides
          <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-2 grid gap-2">
          <DayChart n={n} big />
          <SideTable n={n} />
          <p className="text-muted-foreground text-xs">ATR {n.atr.toFixed(2)}. New York time on the axis.</p>
        </div>
      </details>
    </article>
  );
}

function Legend() {
  const item = (style: React.CSSProperties, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="inline-block w-3.5 border-t-2" style={style} />
      {label}
    </span>
  );
  return (
    <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {item({ borderColor: "var(--chart-1)", borderTopStyle: "dashed" }, "Ceiling (call level)")}
      {item({ borderColor: "var(--chart-2)", borderTopStyle: "dashed" }, "Floor (put level)")}
      {item({ borderColor: "var(--good-fill)" }, "Target 1")}
      {item({ borderColor: "var(--bad-fill)" }, "Stop, on a 2-minute close")}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="bg-muted-foreground/15 inline-block h-2.5 w-3.5" />
        No-entry times
      </span>
      <span>○ fill · ■ exit · △ level reached, no fill</span>
    </div>
  );
}

/** The day in one sentence: fills, targets, stops, then the stock and the option result. */
function Verdict({ d }: { d: LedgerDay }) {
  if (d.filled === 0) {
    return (
      <p className="max-w-prose text-[0.9375rem] font-medium">
        No side filled. {d.triggered > 0 ? `${d.triggered} level${d.triggered === 1 ? " was" : "s were"} reached, but price never came back for the entry.` : "No level was reached."}
      </p>
    );
  }
  const opt = d.option_usd;
  return (
    <p className="max-w-prose text-[0.9375rem] font-medium">
      {d.t1} of {d.filled} fill{d.filled === 1 ? "" : "s"} reached target 1 and {d.stopped} {d.stopped === 1 ? "was" : "were"} stopped. The stock made{" "}
      <span className={cn("font-mono", toneOf(d.r))}>{r2(d.r)}</span>
      {opt === null ? (
        "; option prices were not kept that day."
      ) : (
        <>
          {(opt < 0) === (d.r < 0) ? " and" : ", but"} the options {opt < 0 ? "lost" : "made"} <span className={cn("font-mono", toneOf(opt))}>{dollars(opt)}</span>.
        </>
      )}
    </p>
  );
}

function Counts({ d }: { d: LedgerDay }) {
  const items: [string, string][] = [
    [num(d.sides), "sides"],
    [num(d.triggered), "levels reached"],
    [num(d.filled), "filled on the retest"],
    [num(d.t1), "hit target 1"],
    [num(d.stopped), "stopped"],
    [d.bias_calls ? `${d.bias_right} of ${d.bias_calls}` : DASH, "bias right"],
  ];
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      {items.map(([v, k]) => (
        <div key={k} className="grid">
          <dd className="font-mono text-lg font-medium tabular-nums">{v}</dd>
          <dt className="text-muted-foreground order-last text-xs">{k}</dt>
        </div>
      ))}
    </dl>
  );
}

/** The lesson a day teaches, when the data shows one: stock winners whose option was stopped out first. */
function Lesson({ e }: { e: LedgerEdition }) {
  const hits = optionStoppedFirst(e);
  if (hits.length === 0) return null;
  const names = hits.map((h) => h.symbol);
  return (
    <p className="bg-warn-soft flex items-start gap-2 rounded-md px-3 py-2 text-sm">
      <TriangleAlert aria-hidden className="text-warn mt-0.5 size-4 shrink-0" />
      <span>
        <b>Lesson of the day:</b> {names.join(" and ")} reached target 1 on the stock, but the option hit its −25% stop first (
        {hits.map((h) => `${h.symbol}: option out ${et(h.side.option?.exit_time)}, target ${et(h.side.exit_time)}`).join("; ")}). The option stop was tighter than the card&apos;s stop.
      </span>
    </p>
  );
}

/** One session's review. `base` is the page whose ?d= opens another session. */
export function LedgerReview({ e, base = "/options/record", id = "card-review" }: { e: LedgerEdition; base?: string; id?: string }) {
  const days = e.record.days;
  const i = days.findIndex((d) => d.session === e.session);
  const prev = i > 0 ? days[i - 1] : i === -1 ? days[days.length - 1] : undefined;
  const next = i >= 0 && i < days.length - 1 ? days[i + 1] : undefined;
  const nav = (
    <div className="flex items-center gap-1 text-xs">
      {prev ? (
        <Link href={`${base}?d=${prev.session}#${id}`} className="hover:bg-muted inline-flex items-center rounded-md border px-2 py-1">
          <ChevronLeft aria-hidden className="size-3.5" />
          {shortDate(prev.session)}
        </Link>
      ) : null}
      {next ? (
        <Link href={`${base}?d=${next.session}#${id}`} className="hover:bg-muted inline-flex items-center rounded-md border px-2 py-1">
          {shortDate(next.session)}
          <ChevronRight aria-hidden className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
  return (
    <Panel
      id={id}
      title={`How the card did · ${weekDate(e.session)}`}
      means={
        e.card_source === "rebuilt"
          ? "A rebuilt card: re-picked later by the card's own code, not the one you saw before the open."
          : "Every side of the Top 4 Focus Card against the market: where it filled, where it left, and what one option contract did."
      }
      action={nav}
      contentClassName="grid gap-4"
    >
      <Verdict d={e.day} />
      <Counts d={e.day} />
      <Lesson e={e} />
      <Legend />
      <div className="grid gap-3 md:grid-cols-2">
        {e.names.map((n) => (
          <NameTile key={n.symbol} n={n} />
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        Stock R is measured on the share price, with no option costs. Option dollars are one contract bought at the fill and sold at the −25% option stop, target 1 or the close, on 2-minute last-trade bars, before fees. The
        stock stop counts only on a 2-minute close; the option stop counts on any trade.
      </p>
    </Panel>
  );
}

/** Running total of the days in R, for the card's exits and the 5-minute rule. */
function RunningChart({ days, W = 560, H = 220, className }: { days: readonly LedgerDay[]; W?: number; H?: number; className?: string }) {
  const pts = running(days);
  const pad = { l: 44, r: 16, t: 12, b: 24 };
  const all = pts.flatMap((p) => [p.r, p.r5]);
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  const room = (hi - lo) * 0.1 || 1;
  lo -= room;
  hi += room;
  const n = pts.length;
  const X = (i: number) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i / (n - 1)) * (W - pad.l - pad.r));
  const Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const step = Math.max(1, Math.ceil((hi - lo) / 5));
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const path = (k: "r" | "r5") => pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p[k]).toFixed(1)}`).join("");
  const labelEvery = Math.max(1, Math.ceil(n / (W < 500 ? 4 : 8)));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("h-auto w-full", className)} role="img" aria-label="Running total of the card's R, day by day">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} />
          <text x={pad.l - 6} y={Y(v) + 3.5} textAnchor="end" fontSize={11} fill="var(--muted-foreground)" className="font-mono">
            {v > 0 ? `+${v}` : v}
          </text>
        </g>
      ))}
      {pts.map((p, i) =>
        i % labelEvery === 0 || i === n - 1 ? (
          <text key={p.session} x={X(i)} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)" className="font-mono">
            {shortDate(p.session)}
          </text>
        ) : null,
      )}
      <path d={`${path("r")}L${X(n - 1)},${Y(0)}L${X(0)},${Y(0)}Z`} fill="var(--chart-1)" opacity={0.08} />
      <path d={path("r5")} fill="none" stroke="var(--neutral-fill)" strokeWidth={1.5} strokeDasharray="5 4" />
      <path d={path("r")} fill="none" stroke="var(--chart-1)" strokeWidth={2} />
      {n <= 40 ? pts.map((p, i) => <circle key={p.session} cx={X(i)} cy={Y(p.r)} r={3} fill="var(--chart-1)" stroke="var(--card)" strokeWidth={1.5} />) : null}
      {n > 0 ? (
        <>
          {/* The higher line's total sits above its end, the lower one's below, so the two never overlap. */}
          <text x={X(n - 1) - 4} y={Y(pts[n - 1]!.r) + (pts[n - 1]!.r >= pts[n - 1]!.r5 ? -8 : 16)} textAnchor="end" fontSize={11.5} fontWeight={600} fill="var(--chart-1)" className="font-mono">
            {r2(pts[n - 1]!.r)}
          </text>
          <text x={X(n - 1) - 4} y={Y(pts[n - 1]!.r5) + (pts[n - 1]!.r >= pts[n - 1]!.r5 ? 16 : -8)} textAnchor="end" fontSize={11} fill="var(--muted-foreground)" className="font-mono">
            {r2(pts[n - 1]!.r5)}
          </text>
        </>
      ) : null}
    </svg>
  );
}

/** Each scored day as a cell, coloured by its R; a cell opens that day's review. */
function DayCalendar({ days, current, base }: { days: readonly LedgerDay[]; current: string; base: string }) {
  const weeks = weekGrid(days);
  const reach = Math.max(0.01, ...days.map((d) => Math.abs(d.r)));
  return (
    <div className="grid gap-1.5">
      <div className="text-muted-foreground grid grid-cols-5 gap-1.5 text-center text-[0.6875rem]">
        {["Mon", "Tue", "Wed", "Thu", "Fri"].map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      {weeks.map((w) => (
        <div key={w[0]!.date} className="grid grid-cols-5 gap-1.5">
          {w.map(({ date, day }) =>
            day ? (
              <Link
                key={date}
                href={`${base}?d=${date}#card-review`}
                title={`${weekDate(date)}: ${day.t1} hit target 1, ${day.stopped} stopped${day.option_usd !== null ? `, options ${dollars(day.option_usd)}` : ""}`}
                aria-current={date === current ? "date" : undefined}
                className={cn("text-foreground grid rounded-md border border-transparent px-1 py-1.5 text-center text-xs", date === current && "border-primary")}
                style={{
                  background: `color-mix(in srgb, ${day.r >= 0 ? "var(--good-fill)" : "var(--bad-fill)"} ${Math.round(10 + (30 * Math.abs(day.r)) / reach)}%, var(--card))`,
                }}
              >
                <span className="text-[0.6875rem]">{shortDate(date)}</span>
                <span className="font-mono font-medium">{r2(day.r)}</span>
                <span className="text-[0.6875rem]">
                  {day.filled} fill{day.filled === 1 ? "" : "s"}
                </span>
              </Link>
            ) : (
              <span key={date} className="text-muted-foreground grid rounded-md border border-dashed px-1 py-1.5 text-center text-[0.6875rem]">
                {shortDate(date)}
              </span>
            ),
          )}
        </div>
      ))}
    </div>
  );
}

type Tier = NonNullable<LedgerEdition["record"]["tiers"]["published"]>;

function rangeOf(r: Tier["win"]): string {
  return r.lo === null || r.hi === null ? DASH : `${Math.round(r.lo * 100)}–${Math.round(r.hi * 100)}%`;
}

function TierRow({ name, t, trust, tone }: { name: string; t: Tier; trust: string; tone: "good" | "info" | "warn" }) {
  return (
    <tr className="border-b last:border-0">
      <td className="py-2 pr-3 font-medium whitespace-nowrap">{name}</td>
      <td className="pr-3">
        <StatusBadge tone={tone}>{trust}</StatusBadge>
      </td>
      <td className="pr-3 font-mono text-xs whitespace-nowrap">
        {shortDate(t.from)}–{shortDate(t.to)}
      </td>
      <td className="pr-3 text-right font-mono">{num(t.sides)}</td>
      <td className="pr-3 text-right font-mono">{num(t.filled)}</td>
      <td className="pr-3 text-right font-mono">{fracPct(t.win.rate, 0)}</td>
      <td className="text-muted-foreground pr-3 text-right font-mono">{rangeOf(t.win)}</td>
      <td className={cn("pr-3 text-right font-mono", toneOf(t.avg_r))}>{r2(t.avg_r)}</td>
      <td className="pr-3 text-right font-mono">{t.profit_factor === null ? DASH : t.profit_factor.toFixed(2)}</td>
      <td className="text-right font-mono">{fracPct(t.bias.rate, 0)}</td>
    </tr>
  );
}

function TierTable({ tiers }: { tiers: LedgerEdition["record"]["tiers"] }) {
  const head = ["Cards", "Trust", "Sessions", "Sides", "Fills", "Target 1 first", "95% range", "Avg R per fill", "Profit factor", "Bias right"];
  const table = (rows: React.ReactNode, label: string) => (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={label}>
      <table className="w-full text-[0.8125rem]">
        <thead className="text-muted-foreground text-xs">
          <tr className="border-b text-left">
            {head.map((h, i) => (
              <th key={h} className={cn("py-1.5 pr-3 font-medium whitespace-nowrap", i > 2 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
  return (
    <div className="grid gap-2">
      {table(
        <>
          {tiers.published ? <TierRow name="Live cards" t={tiers.published} trust="Published before the open" tone="good" /> : null}
          {tiers.rebuilt_2min ? <TierRow name="Rebuilt, 2-minute bars" t={tiers.rebuilt_2min} trust="Same scorer, re-picked cards" tone="info" /> : null}
        </>,
        "Live and rebuilt cards",
      )}
      {tiers.rebuilt_60min ? (
        <details className="group">
          <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1 text-xs [&::-webkit-details-marker]:hidden">
            Also show the hourly-bar cards, which look better than they were
            <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2">{table(<TierRow name="Rebuilt, hourly bars" t={tiers.rebuilt_60min} trust="Too rosy: hides stops" tone="warn" />, "Hourly-bar cards")}</div>
        </details>
      ) : null}
    </div>
  );
}

function HistoryChart({ daily, W = 960, H = 180, className }: { daily: readonly { session: string; r: number }[]; W?: number; H?: number; className?: string }) {
  const pts = running(daily.map((d) => ({ session: d.session, r: d.r, r_five_min: 0 }) as LedgerDay));
  const pad = { l: 44, r: 16, t: 12, b: 24 };
  const vals = pts.map((p) => p.r);
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  const room = (hi - lo) * 0.1 || 1;
  lo -= room;
  hi += room;
  const n = pts.length;
  const X = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
  const Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const step = Math.max(5, Math.ceil((hi - lo) / 5 / 5) * 5);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const every = W < 500 ? 2 : 1;
  const months = pts
    .flatMap((p, i) => (i === 0 || p.session.slice(5, 7) !== pts[i - 1]!.session.slice(5, 7) ? [{ i, label: shortDate(p.session) }] : []))
    .filter((_, k) => k % every === 0);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.r).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("h-auto w-full", className)} role="img" aria-label="Running total of the rebuilt cards' R">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} />
          <text x={pad.l - 6} y={Y(v) + 3.5} textAnchor="end" fontSize={11} fill="var(--muted-foreground)" className="font-mono">
            {v > 0 ? `+${v}` : v}
          </text>
        </g>
      ))}
      {months.map((m) => (
        <text key={m.i} x={X(m.i)} y={H - 6} textAnchor={m.i === 0 ? "start" : "middle"} fontSize={11} fill="var(--muted-foreground)" className="font-mono">
          {m.label}
        </text>
      ))}
      {n > 1 ? (
        <>
          <path d={`${d}L${X(n - 1)},${Y(0)}L${X(0)},${Y(0)}Z`} fill="var(--chart-1)" opacity={0.08} />
          <path d={d} fill="none" stroke="var(--chart-1)" strokeWidth={1.8} />
          <text x={X(n - 1) - 4} y={Y(pts[n - 1]!.r) - 8} textAnchor="end" fontSize={11.5} fontWeight={600} fill="var(--chart-1)" className="font-mono">
            {r2(pts[n - 1]!.r)}
          </text>
        </>
      ) : null}
    </svg>
  );
}

function ShareBars({ rows }: { rows: { key: string; label: string; value: number | null; hint: string }[] }) {
  return (
    <div className="grid gap-1.5">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3.5rem] items-center gap-x-3 text-[0.8125rem]" title={r.hint}>
          <span className="font-mono">{r.label}</span>
          <span className="bg-track/60 relative h-4 rounded-sm" aria-hidden>
            <span className="bg-chart-1 absolute inset-y-0.5 left-0 rounded-[2px]" style={{ width: `${Math.round((r.value ?? 0) * 100)}%` }} />
          </span>
          <span className="text-right font-mono text-xs">{fracPct(r.value, 0)}</span>
        </div>
      ))}
    </div>
  );
}

/** The running record: the live days, how far each number can be trusted, and the rebuilt history. */
export function LedgerRecord({ e, base = "/options/record", current }: { e: LedgerEdition; base?: string; current?: string }) {
  const { days, tiers, history } = e.record;
  const pub = tiers.published;
  const hist = tiers.rebuilt_2min;
  const opt = optionTotal(days);
  return (
    <>
      <Panel
        id="card-record"
        title={days.length ? `Card record since ${weekDate(days[0]!.session)}` : "Card record"}
        means="Every published card, scored after its close. Fills are the sides whose level was reached and retested for the entry."
        contentClassName="grid gap-5"
      >
        {pub ? (
          <StatTiles className="lg:grid-cols-5">
            <StatTile label="Fills" value={num(pub.filled)} hint={`of ${num(pub.sides)} sides over ${num(pub.sessions)} days`} />
            <StatTile label="Reached target 1 first" value={fracPct(pub.win.rate, 0)} hint={`95% range ${rangeOf(pub.win)}`} tone={pub.win.rate !== null && pub.win.rate > 1 / 3 ? "good" : "warn"} />
            <StatTile label="Average per fill" value={r2(pub.avg_r)} hint={hist ? `History ${r2(hist.avg_r)}` : undefined} tone={(pub.avg_r ?? 0) > 0 ? "good" : "bad"} />
            <StatTile label="Bias right" value={fracPct(pub.bias.rate, 0)} hint={hist ? `History ${fracPct(hist.bias.rate, 0)}` : undefined} />
            <StatTile
              label="Options, one contract each"
              value={dollars(opt.usd)}
              hint={opt.first ? `Since ${shortDate(opt.first)}, when option prices start` : "No option prices kept yet"}
              tone={opt.usd === null ? "neutral" : opt.usd >= 0 ? "good" : "bad"}
            />
          </StatTiles>
        ) : null}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-2">
            <h3 className="text-sm font-medium">Running total, R</h3>
            {/* A phone gets its own narrower drawing, so the labels stay readable instead of shrinking with it. */}
            <RunningChart days={days} className="hidden sm:block" />
            <RunningChart days={days} W={360} H={200} className="sm:hidden" />
            <div className="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block w-3.5 border-t-2" style={{ borderColor: "var(--chart-1)" }} />
                Card exits: target 1 or stop
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block w-3.5 border-t-2 border-dashed" style={{ borderColor: "var(--neutral-fill)" }} />
                With the 5-minute rule
              </span>
            </div>
          </div>
          <div className="grid content-start gap-2">
            <h3 className="text-sm font-medium">Each day</h3>
            <DayCalendar days={days} current={current ?? e.session} base={base} />
            <p className="text-muted-foreground text-xs">Colour shows the day&apos;s R. Tap a day to open its review.</p>
          </div>
        </div>
      </Panel>

      <Panel id="card-trust" title="How much each number can be trusted" means="The live cards next to the history, which was re-picked by the card's own code and scored the same way." contentClassName="grid gap-2">
        <TierTable tiers={tiers} />
        <p className="text-muted-foreground text-xs">
          Ranges are 95%. Sides on the same day move together, so the true uncertainty is wider than shown. At 2R targets, reaching target 1 first more than a third of the time is above break-even, before option costs.
        </p>
      </Panel>

      {history ? (
        <Panel
          id="card-history"
          title="What the card does well and badly"
          means={hist ? `Rebuilt cards on 2-minute bars, ${weekDate(hist.from)} to ${weekDate(hist.to)}. History, not proof.` : "Rebuilt cards on 2-minute bars."}
          contentClassName="grid gap-5"
        >
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">Running total over {num(history.daily_r.length)} sessions, R</h3>
            <HistoryChart daily={history.daily_r} className="hidden sm:block" />
            <HistoryChart daily={history.daily_r} W={360} H={180} className="sm:hidden" />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="grid content-start gap-2">
              <h3 className="text-sm font-medium">Average R per fill, by name</h3>
              <DivergingBars
                label="Average R per fill by name"
                better="positive"
                format={(v) => rMult(v, 2)}
                rows={[...history.by_symbol]
                  .filter((s) => s.filled >= 5)
                  .sort((a, b) => (b.avg_r ?? 0) - (a.avg_r ?? 0))
                  .map((s) => ({ key: s.key, label: <span className="font-mono">{s.key}</span>, value: s.avg_r }))}
              />
              <p className="text-muted-foreground text-xs">Names with five fills or more.</p>
            </div>
            <div className="grid content-start gap-2">
              <h3 className="text-sm font-medium">How often the level is reached, by distance from the close</h3>
              <ShareBars rows={history.by_distance.map((s) => ({ key: s.key, label: s.key.replace("-", "–"), value: s.trigger_rate, hint: `${num(s.sides)} sides` }))} />
              <p className="text-muted-foreground text-xs">Levels more than an ATR away are rarely reached the next day.</p>
            </div>
            <div className="grid content-start gap-2">
              <h3 className="text-sm font-medium">Average R per fill, by weekday</h3>
              <DivergingBars
                label="Average R per fill by weekday"
                better="positive"
                format={(v) => rMult(v, 2)}
                rows={history.by_weekday.map((s) => ({ key: s.key, label: s.key, value: s.avg_r }))}
              />
            </div>
          </div>
        </Panel>
      ) : null}
    </>
  );
}

/** Nothing scored yet, or the session asked for was not scored. */
export function NoLedger({ status, date }: { status: "missing" | "error"; date?: string }) {
  if (status === "error") {
    return (
      <Notice tone="bad" size="sm" role="alert">
        The card record could not be read just now. Reload in a minute.
      </Notice>
    );
  }
  return (
    <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
      {date
          ? `No scored card for ${weekDate(date)}. The ledger scores each session after the close, from about 16:30 New York.`
        : "No card has been scored yet. The ledger scores each session after the close, from about 16:30 New York."}
    </p>
  );
}
