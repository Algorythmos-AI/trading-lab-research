"use client";

import { useNow } from "@/components/client/use-now";
import { useQuotes } from "@/components/client/use-quotes";
import { newYork, num, rMult } from "@/lib/format";
import { STALE_MS } from "@/lib/options";
import { openR, positionScale, type OpenPosition } from "@/lib/trading";

const W = 400;
const H = 108;
const L = 18;
const R = W - 18;
const Y = 50;

/**
 * Paper B's open position as one bar: red from the stop to the entry (the room it can lose), green from the entry
 * to the target, and a dot at the price. The price is the live quote while one is fresh (the same read-only
 * /api/quote feed as the Options page), else the paper account's last mark. Before the fill the trigger stands in
 * for the entry and no R is shown.
 */
export function PositionBar({ p, asOf }: { p: OpenPosition; asOf: string | null | undefined }) {
  const filled = p.state === "in_position";
  const feed = useQuotes(p.symbol, filled);
  const nowMs = useNow(1_000);
  const q = feed.status === "ok" ? feed.quotes[p.symbol] : undefined;
  const age = q && nowMs !== null ? nowMs - Date.parse(q.at) : null;
  const live = q !== undefined && age !== null && age <= STALE_MS;
  const price = q && live ? q.price : (p.mark ?? q?.price ?? null);
  const scale = positionScale(p, price);
  if (!scale) return null;
  const x = (v: number) => L + ((v - scale.lo) / (scale.hi - scale.lo)) * (R - L);
  const base = filled ? p.entry : p.trigger;
  const r = openR(p, price);
  const marks: [number | null, string, string][] = [
    [p.stop, "stop", "var(--bad)"],
    [base, filled ? "entry" : "trigger", "var(--muted-foreground)"],
    [p.target, "target", "var(--good)"],
  ];
  const source = live ? "live" : q ? `last ${newYork(q.at, false)}` : `as of ${asOf ? newYork(asOf, false) : "the last update"}`;
  const label = `${p.symbol} paper position: stop ${num(p.stop, 2)}, ${filled ? "entry" : "trigger"} ${num(base, 2)}, target ${num(p.target, 2)}${
    price !== null ? `, price ${num(price, 2)} (${source})${r !== null ? `, ${rMult(r, 2)}` : ""}` : ""
  }.`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full max-w-xl" data-testid="position-bar">
      {p.stop !== null && base !== null ? (
        <rect x={x(p.stop)} y={Y - 8} width={Math.max(0, x(base) - x(p.stop))} height={16} fill="var(--bad-fill)" fillOpacity={0.28} />
      ) : null}
      {base !== null && p.target !== null ? (
        <rect x={x(base)} y={Y - 8} width={Math.max(0, x(p.target) - x(base))} height={16} fill="var(--good-fill)" fillOpacity={0.28} />
      ) : null}
      {marks.map(([v, t, c]) =>
        v === null ? null : (
          <g key={t}>
            <line x1={x(v)} x2={x(v)} y1={Y - 13} y2={Y + 13} stroke={c} strokeWidth={2} strokeDasharray={t === "trigger" ? "3 2" : undefined} />
            <text x={x(v)} y={Y + 29} textAnchor="middle" fontSize={13} style={{ fill: c }}>
              {t}
            </text>
            <text x={x(v)} y={Y + 43} textAnchor="middle" fontSize={12.5} className="font-mono" style={{ fill: "var(--muted-foreground)" }}>
              {num(v, 2)}
            </text>
          </g>
        ),
      )}
      {price !== null ? (
        <g data-testid="position-price">
          <circle
            cx={x(price)}
            cy={Y}
            r={7}
            fill={live ? "var(--warn-fill)" : "var(--card)"}
            stroke={live ? "var(--card)" : "var(--warn-fill)"}
            strokeWidth={2}
            strokeDasharray={live ? undefined : "2 2"}
          />
          <text
            x={x(price) > R - 90 ? x(price) + 10 : x(price) < L + 90 ? x(price) - 10 : x(price)}
            y={Y - 18}
            textAnchor={x(price) > R - 90 ? "end" : x(price) < L + 90 ? "start" : "middle"}
            fontSize={13}
            fontWeight={600}
            className="font-mono"
            style={{ fill: "var(--warn)" }}
          >
            {`${source === "live" ? "live" : "price"} ${num(price, 2)}${r !== null ? ` · ${rMult(r, 2)}` : ""}`}
          </text>
        </g>
      ) : null}
    </svg>
  );
}
