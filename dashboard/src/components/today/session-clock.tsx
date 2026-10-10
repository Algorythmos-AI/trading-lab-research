"use client";

import { useNow } from "@/components/client/use-now";
import { newYork } from "@/lib/format";
import { humanize, jobName, type Tone } from "@/lib/labels";
import { nyClock } from "@/lib/options";
import { BELL_CLOSE, BELL_OPEN, CLOCK_FROM, CLOCK_TO, type ClockRun } from "@/lib/today";

const W = 400;
const L = 80;
const R = W - 52;
const TOP = 30;
const LANE = 24;

const FILL: Record<Tone, string> = {
  good: "var(--good-fill)",
  bad: "var(--bad-fill)",
  warn: "var(--warn-fill)",
  info: "var(--info-fill)",
  neutral: "var(--neutral-fill)",
};
const INK: Record<Tone, string> = {
  good: "var(--good)",
  bad: "var(--bad)",
  warn: "var(--warn)",
  info: "var(--info)",
  neutral: "var(--muted-foreground)",
};

const SHORT: Record<string, string> = { routine: "Routine", "paper-b": "Paper B", forward: "Forward" };

const X = (m: number) => L + ((Math.max(CLOCK_FROM, Math.min(CLOCK_TO, m)) - CLOCK_FROM) / (CLOCK_TO - CLOCK_FROM)) * (R - L);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function statusWord(r: ClockRun): string {
  if (r.running) return "running";
  if (r.from === null) return "no run";
  return humanize(r.status).toLowerCase() || "unknown";
}

/**
 * The New York day as one picture: pre-market, the session and after hours across the top, a lane per job with
 * its scheduled start (a tick) and the span its last run took that day, and a line at the time now. Colour always
 * comes with a word: each lane ends with its status.
 */
export function SessionClock({ day, runs }: { day: string | null; runs: ClockRun[] }) {
  const nowMs = useNow(30_000);
  const now = nowMs === null ? null : nyClock(new Date(nowMs).toISOString());
  const nowMin = now && now.day === day && now.minutes >= CLOCK_FROM && now.minutes <= CLOCK_TO ? now.minutes : null;
  const bottom = TOP + runs.length * LANE + 6;
  const H = bottom + 22;
  const label = `The New York day ${day ?? ""} from 04:00 to 20:00. ${runs
    .map((r) => `${jobName(r.key)}: scheduled ${hhmm(r.at)}, ${r.from === null ? "no run that day" : `${statusWord(r)}, started ${hhmm(r.from)}`}`)
    .join(". ")}.${nowMin !== null ? ` Now ${hhmm(nowMin)}.` : ""}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full max-w-2xl" data-testid="session-clock">
      <rect x={X(CLOCK_FROM)} y={TOP - 6} width={X(BELL_OPEN) - X(CLOCK_FROM)} height={bottom - TOP + 6} fill="var(--info-fill)" fillOpacity={0.05} />
      <rect x={X(BELL_OPEN)} y={TOP - 6} width={X(BELL_CLOSE) - X(BELL_OPEN)} height={bottom - TOP + 6} fill="var(--info-fill)" fillOpacity={0.16} />
      <rect x={X(BELL_CLOSE)} y={TOP - 6} width={X(CLOCK_TO) - X(BELL_CLOSE)} height={bottom - TOP + 6} fill="var(--info-fill)" fillOpacity={0.05} />
      {[
        [CLOCK_FROM, BELL_OPEN, "pre-market"],
        [BELL_OPEN, BELL_CLOSE, "session"],
        [BELL_CLOSE, CLOCK_TO, "after hours"],
      ].map(([a, b, t]) => (
        <text
          key={t}
          x={(X(a as number) + X(b as number)) / 2}
          y={TOP - 12}
          textAnchor="middle"
          fontSize={11.5}
          style={{ fill: "var(--muted-foreground)" }}
        >
          {t}
        </text>
      ))}
      {runs.map((r, i) => {
        const y = TOP + i * LANE + LANE / 2;
        const to = r.running ? (nowMin ?? r.from) : r.to;
        const spanFrom = r.from;
        const width = spanFrom !== null && to !== null ? Math.max(4, X(to) - X(spanFrom)) : 0;
        return (
          <g key={r.key} data-testid={`clock-${r.key}`}>
            <title>{`${jobName(r.key)}: scheduled ${hhmm(r.at)} New York. ${
              r.from === null
                ? r.started
                  ? `Last run ${newYork(r.started)}, not on this day.`
                  : "No run yet."
                : `${statusWord(r)}, ran ${newYork(r.started, false)}${r.ended && !r.running ? ` to ${newYork(r.ended, false)}` : ""} New York.`
            }`}</title>
            <text x={L - 8} y={y + 4} textAnchor="end" fontSize={12} style={{ fill: "var(--foreground)" }}>
              {SHORT[r.key] ?? jobName(r.key)}
            </text>
            <line x1={L} x2={R} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
            <line x1={X(r.at)} x2={X(r.at)} y1={y - 8} y2={y + 8} stroke="var(--muted-foreground)" strokeWidth={1.5} strokeDasharray="2 2" />
            {spanFrom !== null && to !== null ? (
              <rect
                x={X(spanFrom)}
                y={y - 5}
                width={width}
                height={10}
                rx={3}
                fill={FILL[r.tone]}
                fillOpacity={0.85}
                className={r.running ? "motion-safe:animate-pulse" : undefined}
              />
            ) : null}
            <text x={R + 8} y={y + 4} fontSize={11.5} fontWeight={600} style={{ fill: INK[r.tone] }}>
              {statusWord(r)}
            </text>
          </g>
        );
      })}
      {nowMin !== null ? (
        <g data-testid="clock-now">
          <line x1={X(nowMin)} x2={X(nowMin)} y1={TOP - 6} y2={bottom} stroke="var(--warn-fill)" strokeWidth={2} />
          <text
            x={X(nowMin) + (nowMin > 17 * 60 ? -4 : 4)}
            y={bottom + 14}
            textAnchor={nowMin > 17 * 60 ? "end" : "start"}
            fontSize={11.5}
            fontWeight={600}
            style={{ fill: "var(--warn)" }}
          >
            now {hhmm(nowMin)}
          </text>
        </g>
      ) : null}
      {[4, 8, 12, 16, 20].map((h) =>
        nowMin !== null && Math.abs(X(h * 60) - X(nowMin)) < 30 ? null : (
          <text key={h} x={X(h * 60)} y={bottom + 14} textAnchor="middle" fontSize={11} style={{ fill: "var(--muted-foreground)" }}>
            {hhmm(h * 60)}
          </text>
        ),
      )}
    </svg>
  );
}
