// The Radar page's pictures: hand-built SVG and plain HTML, like the Options page's, with no chart library.
// Green is support, red is resistance, amber is attention; colour always comes with a word.
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { num, shortDate } from "@/lib/format";
import { gaugeTone, roomOf, type Distance, type RadarEvent, type RadarGauge, type RadarTicker, type ScoreRow, type Tone } from "@/lib/radar";
import { cn } from "@/lib/utils";

const sgn = (v: number, d = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`;

/**
 * Each list's average move in the last session (dot) against its benchmark's (tick). The bar between them is green
 * when the list beat its benchmark and red when it lagged.
 */
export function ScoreDumbbells({ rows, session }: { rows: ScoreRow[]; session: string | null | undefined }) {
  const W = 360;
  // Room each side for a value label beside a dot at either end.
  const L = 48;
  const R = W - 48;
  const ROW = 50;
  const H = rows.length * ROW + 30;
  const vals = rows.flatMap((r) => [r.move, r.benchMove ?? r.move, 0]);
  const lo = Math.floor(Math.min(...vals));
  const hi = Math.ceil(Math.max(...vals));
  const span = Math.max(1, hi - lo);
  const step = span > 6 ? 2 : 1;
  const X = (v: number) => L + ((v - lo) / span) * (R - L);
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  const label = `Each list's average move${session ? ` on ${shortDate(session)}` : ""} against its benchmark. ${rows
    .map((r) => `${r.list}: ${sgn(r.move)}${r.benchmark && r.benchMove !== null ? `, ${r.benchmark} ${sgn(r.benchMove)}` : ""}${r.hits ? `, ${r.hits}` : ""}`)
    .join(". ")}.`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full max-w-xl">
      {ticks.map((v) => (
        <g key={v}>
          {rows.map((_, i) => (
            <line
              key={i}
              x1={X(v)}
              x2={X(v)}
              y1={36 + i * ROW - 10}
              y2={36 + i * ROW + 10}
              stroke={v === 0 ? "var(--muted-foreground)" : "var(--border)"}
              strokeWidth={v === 0 ? 1.2 : 1}
            />
          ))}
          <text x={X(v)} y={H - 8} textAnchor="middle" fontSize={11} style={{ fill: "var(--muted-foreground)" }}>
            {v > 0 ? `+${v}%` : `${v}%`}
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const y = 36 + i * ROW;
        const ahead = r.benchMove === null || r.move >= r.benchMove;
        const col = r.benchMove === null ? "var(--foreground)" : ahead ? "var(--good-fill)" : "var(--bad-fill)";
        const ink = r.benchMove === null ? "var(--foreground)" : ahead ? "var(--good)" : "var(--bad)";
        return (
          <g key={r.list}>
            <title>{`${r.list}: ${sgn(r.move)}${r.benchmark && r.benchMove !== null ? ` against ${r.benchmark} ${sgn(r.benchMove)}` : ""}${r.hits ? ` · ${r.hits}` : ""}`}</title>
            <text x={0} y={y - 18} fontSize={12} style={{ fill: "var(--foreground)" }}>
              {r.list}
              <tspan fontSize={11} style={{ fill: "var(--muted-foreground)" }}>
                {"  "}
                {[r.hits, r.benchmark ? `vs ${r.benchmark}` : null].filter(Boolean).join(" · ")}
              </tspan>
            </text>
            {r.benchMove !== null ? (
              <>
                <line x1={X(r.benchMove)} x2={X(r.move)} y1={y} y2={y} stroke={col} strokeWidth={3} strokeOpacity={0.5} />
                <line x1={X(r.benchMove)} x2={X(r.benchMove)} y1={y - 8} y2={y + 8} stroke="var(--foreground)" strokeWidth={2} />
              </>
            ) : null}
            <circle cx={X(r.move)} cy={y} r={6} fill={col} stroke="var(--card)" strokeWidth={2} />
            <text
              x={X(r.move) + (ahead ? 10 : -10)}
              y={y + 4}
              textAnchor={ahead ? "start" : "end"}
              fontSize={11.5}
              fontWeight={600}
              className="font-mono"
              style={{ fill: ink }}
            >
              {sgn(r.move)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const REGIME: { word: string; label: string; tone: Tone }[] = [
  { word: "risk-off", label: "Risk-off", tone: "bad" },
  { word: "neutral", label: "Neutral", tone: "warn" },
  { word: "risk-on", label: "Risk-on", tone: "good" },
];

const TONE_BG: Record<Tone, string> = { good: "bg-good-fill", bad: "bg-bad-fill", warn: "bg-warn-fill", info: "bg-info-fill", neutral: "bg-neutral-fill" };
const TONE_INK: Record<Tone, string> = { good: "text-good", bad: "text-bad", warn: "text-warn", info: "text-info", neutral: "text-muted-foreground" };

/** The regime as one word on a three-step scale, the chosen step filled and named. */
export function RegimeScale({ word }: { word: string }) {
  return (
    <div className="grid gap-1.5" role="img" aria-label={`Market regime: ${word}`}>
      <div className="grid grid-cols-3 gap-1">
        {REGIME.map((s) => (
          <span key={s.word} className={cn("h-2 rounded-full", s.word === word ? TONE_BG[s.tone] : "bg-muted")} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1 text-xs">
        {REGIME.map((s) => (
          <span key={s.word} className={cn("text-center", s.word === word ? cn("font-semibold", TONE_INK[s.tone]) : "text-muted-foreground")}>
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The market gauges as tiles: value, then the move with an arrow, coloured by whether it helps stocks. */
export function GaugeTiles({ gauges }: { gauges: RadarGauge[] }) {
  return (
    <ul aria-label="Market gauges" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {gauges.map((g) => {
        const tone = gaugeTone(g);
        const ch = g.change;
        const Icon = ch === null || ch === undefined || ch === 0 ? Minus : ch > 0 ? ArrowUp : ArrowDown;
        return (
          <li key={g.label} className="bg-muted/40 border-border min-w-0 rounded-lg border p-2.5">
            <p className="text-muted-foreground truncate text-xs">{g.label}</p>
            <p className="font-mono text-base font-semibold tabular-nums">{g.value ?? "—"}</p>
            <p className={cn("flex items-center gap-1 font-mono text-xs tabular-nums", TONE_INK[tone])}>
              {typeof ch === "number" ? (
                <>
                  <Icon aria-hidden className="size-3" />
                  {g.change_unit === "pts" ? `${ch > 0 ? "+" : ""}${num(ch, 2)}` : sgn(ch)}
                </>
              ) : null}
              {g.note ? <span className="text-muted-foreground truncate font-sans">{g.note}</span> : null}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/** A small room bar for a pick: support to the line above, the price on it, and the pre-market price hollow. */
function PickRoom({ t }: { t: RadarTicker }) {
  const room = roomOf(t);
  if (!room) return null;
  const W = 300;
  const H = 48;
  const l = 6;
  const r = W - 6;
  const pts = [room.support, room.price, room.ceiling, room.premarket].filter((v): v is number => v !== null);
  const lo0 = Math.min(...pts);
  const hi0 = Math.max(...pts);
  const pad = (hi0 - lo0) * 0.12 || 1;
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const X = (v: number) => l + ((v - lo) / (hi - lo)) * (r - l);
  const label = `${t.symbol}: price ${num(room.price, 2)}, support ${num(room.support, 2)} (${room.roomPct.toFixed(1)}% below), ${
    room.ceiling === null ? "no line above" : `${room.atHigh ? "52-week high" : "resistance"} ${num(room.ceiling, 2)}`
  }${room.premarket !== null ? `, pre-market ${num(room.premarket, 2)}` : ""}.`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
      <rect x={l} y={18} width={r - l} height={4} rx={2} fill="var(--border)" />
      <rect x={X(room.support)} y={18} width={Math.max(0, X(room.price) - X(room.support))} height={4} fill="var(--good-fill)" fillOpacity={0.4} />
      <rect x={X(room.support) - 2} y={11} width={4} height={18} rx={1} fill="var(--good-fill)" />
      <text x={X(room.support)} y={43} textAnchor="start" fontSize={11} className="font-mono" style={{ fill: "var(--good)" }}>
        {num(room.support, 2)}
      </text>
      {room.ceiling !== null ? (
        <>
          <rect
            x={X(room.ceiling) - 2}
            y={11}
            width={4}
            height={18}
            rx={1}
            fill={room.atHigh ? "var(--muted-foreground)" : "var(--bad-fill)"}
          />
          <text
            x={X(room.ceiling)}
            y={43}
            textAnchor="end"
            fontSize={11}
            className="font-mono"
            style={{ fill: room.atHigh ? "var(--muted-foreground)" : "var(--bad)" }}
          >
            {room.atHigh ? `high ${num(room.ceiling, 2)}` : num(room.ceiling, 2)}
          </text>
        </>
      ) : null}
      <text x={(X(room.support) + X(room.price)) / 2} y={10} textAnchor="middle" fontSize={10.5} style={{ fill: "var(--muted-foreground)" }}>
        {room.roomPct.toFixed(1)}% room
      </text>
      {room.premarket !== null ? <circle cx={X(room.premarket)} cy={20} r={5} fill="none" stroke="var(--warn-fill)" strokeWidth={2} /> : null}
      <circle cx={X(room.price)} cy={20} r={6} fill="var(--foreground)" stroke="var(--card)" strokeWidth={2} />
    </svg>
  );
}

const GRADE = ["", "weak", "moderate", "strong"];

/** A three-step meter with its word, so the grade never rests on colour alone. */
function Meter({ name, grade }: { name: string; grade: number | null | undefined }) {
  if (typeof grade !== "number") return null;
  const tone: Tone = grade >= 3 ? "good" : grade === 2 ? "warn" : "bad";
  return (
    <span className="flex items-center gap-1.5 text-xs" aria-label={`${name}: ${GRADE[grade]}`}>
      <span className="text-muted-foreground">{name}</span>
      <span className="flex gap-0.5" aria-hidden>
        {[1, 2, 3].map((k) => (
          <i key={k} className={cn("h-2 w-4 rounded-sm", k <= grade ? TONE_BG[tone] : "bg-muted")} />
        ))}
      </span>
      <span className={TONE_INK[tone]}>{GRADE[grade]}</span>
    </span>
  );
}

/** One card per daily pick: the room bar, the two grades and one line of why. */
export function PickCards({ picks }: { picks: RadarTicker[] }) {
  return (
    <ul aria-label="Daily radar picks" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {picks.map((t) => (
        <li key={t.symbol} className={cn("bg-muted/40 border-border grid gap-2 rounded-lg border p-3", t.tag === "risk" && "border-warn-fill")}>
          <div className="flex flex-wrap items-baseline gap-2">
            <a href={`#t-${t.symbol}`} className="font-mono text-base font-semibold">
              {t.symbol}
            </a>
            {t.tag === "new" ? <Badge variant="info">New</Badge> : t.tag === "risk" ? <Badge variant="warn">High risk</Badge> : null}
            <span className="text-muted-foreground ml-auto font-mono text-sm">
              {num(t.price, 2)}
              {typeof t.premarket_price === "number" ? ` · pre ${num(t.premarket_price, 2)}` : ""}
            </span>
          </div>
          <PickRoom t={t} />
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Meter name="Evidence" grade={t.evidence_grade} />
            <Meter name="Chart" grade={t.chart_grade} />
          </div>
          {t.why ? <p className="text-[0.8125rem]">{t.why}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * How far each name sits from its line, shortest first. Bars under half a percent are drawn solid: those names are
 * on the line now. A name already through it shows its distance as negative, in amber.
 */
export function DistanceBars({ rows, title, kind }: { rows: Distance[]; title: string; kind: "support" | "breakout" }) {
  const W = 360;
  const L = 74;
  const R = W - 52;
  const ROW = 24;
  const H = rows.length * ROW + 30;
  const max = Math.max(3, Math.ceil(Math.max(...rows.map((d) => d.pct), 0)));
  const X = (v: number) => L + (Math.max(0, Math.min(max, v)) / max) * (R - L);
  const fill = kind === "support" ? "var(--good-fill)" : "var(--bad-fill)";
  const label = `${title}. ${rows.map((d) => `${d.symbol} ${d.pct.toFixed(1)}%`).join(", ")}.`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
      {Array.from({ length: max + 1 }, (_, v) => v).map((v) => (
        <g key={v}>
          <line x1={X(v)} x2={X(v)} y1={4} y2={H - 20} stroke="var(--border)" />
          <text x={X(v)} y={H - 6} textAnchor="middle" fontSize={11} style={{ fill: "var(--muted-foreground)" }}>
            {v}%
          </text>
        </g>
      ))}
      {rows.map((d, i) => {
        const y = 8 + i * ROW;
        const through = d.pct < 0;
        return (
          <g key={d.symbol}>
            <text x={0} y={y + 11} fontSize={12} fontWeight={600} className="font-mono" style={{ fill: "var(--foreground)" }}>
              {d.symbol}
            </text>
            {d.tag ? (
              <text x={46} y={y + 11} fontSize={10.5} style={{ fill: d.tag === "risk" ? "var(--warn)" : "var(--info)" }}>
                {d.tag === "risk" ? "risk" : "new"}
              </text>
            ) : null}
            <rect
              x={L}
              y={y + 2}
              width={through ? 3 : Math.max(2, X(d.pct) - L)}
              height={12}
              rx={2}
              fill={through ? "var(--warn-fill)" : fill}
              fillOpacity={d.pct < 0.5 ? 0.9 : 0.5}
            />
            <text x={(through ? L + 3 : X(d.pct)) + 5} y={y + 12} fontSize={11.5} className="font-mono" style={{ fill: through ? "var(--warn)" : "var(--muted-foreground)" }}>
              {through ? `${d.pct.toFixed(1)}% ${kind === "support" ? "below" : "above"}` : `${d.pct.toFixed(1)}%`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", timeZone: "UTC" });

const KIND_BAR: Record<string, string> = { macro: "bg-info-fill", earnings: "bg-neutral-fill", holiday: "bg-muted-foreground", other: "bg-neutral-fill" };

function Event({ e }: { e: RadarEvent }) {
  const high = e.impact === "high";
  return (
    <li className="flex gap-2">
      <span aria-hidden className={cn("mt-0.5 w-1 shrink-0 rounded-sm", high ? "bg-warn-fill" : KIND_BAR[e.kind ?? "other"])} />
      <span className="min-w-0">
        <span className={cn("block text-[0.8125rem]", high && "text-warn font-medium")}>
          {e.label}
          {high ? <span className="sr-only"> (high impact)</span> : null}
        </span>
        <span className="text-muted-foreground block text-xs">{[e.time_et ? `${e.time_et} NY` : null, e.kind].filter(Boolean).join(" · ")}</span>
      </span>
    </li>
  );
}

/** Five weekdays of dated events, today first; high-impact events in amber. Later events trail after. */
export function WeekStrip({ days, later, today }: { days: { date: string; events: RadarEvent[] }[]; later: RadarEvent[]; today: string }) {
  return (
    <div className="grid gap-3">
      <ol aria-label="Catalysts this week" className="grid gap-2 sm:grid-cols-5">
        {days.map((d) => (
          <li
            key={d.date}
            className={cn("border-border min-w-0 rounded-lg border p-2.5", d.date === today && "bg-muted/40", d.events.length === 0 && "hidden sm:block")}
          >
            <p className={cn("mb-2 text-xs font-semibold", d.date === today ? "text-foreground" : "text-muted-foreground")}>
              {weekday(d.date)}
              {d.date === today ? " · today" : ""}
            </p>
            {d.events.length === 0 ? (
              <p className="text-muted-foreground text-xs">Nothing dated</p>
            ) : (
              <ul className="grid gap-2">
                {d.events.map((e, i) => (
                  <Event key={i} e={e} />
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {later.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Later:{" "}
          {later.map((e, i) => (
            <span key={i} className={cn(e.impact === "high" && "text-warn font-medium")}>
              {i > 0 ? " · " : ""}
              {e.label} {shortDate(e.date)}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
