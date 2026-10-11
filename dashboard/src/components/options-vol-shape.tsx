import { fracPct, num } from "@/lib/format";
import type { VolShape as Shape } from "@/lib/volshape";

const W = 320;
const H = 112;
const X0 = 40;
const X1 = W - 8;
const TOP = 10;
const BOTTOM = H - 20;

/**
 * Implied volatility across one expiry's strikes: a filled dot for the call, an outlined one for the put, a dashed
 * line at the stock's price and a ring on the strike being priced. Blue, as everything from the option market is.
 * The same numbers follow as a table.
 */
export function VolShape({ shape, spot, strike, expiry }: { shape: Shape; spot: number; strike: number | null; expiry: string }) {
  const first = shape.points[0]!.strike;
  const last = shape.points[shape.points.length - 1]!.strike;
  const span = last - first || 1;
  // A flat shape still needs a scale: half a volatility point either side.
  const pad = Math.max((shape.hi - shape.lo) * 0.12, 0.005);
  const lo = Math.max(0, shape.lo - pad);
  const hi = shape.hi + pad;
  const x = (k: number) => X0 + ((k - first) / span) * (X1 - X0);
  const y = (v: number) => TOP + ((hi - v) / (hi - lo)) * (BOTTOM - TOP);
  const strikeText = (k: number) => num(k, k % 1 === 0 ? 0 : 2);
  return (
    <figure data-vol-shape={shape.points.length} className="grid gap-1">
      <figcaption className="text-xs">
        <span className="font-medium">Volatility by strike</span>
        <span className="text-muted-foreground">
          {" "}
          · {fracPct(shape.atm.iv, 1)} at {strikeText(shape.atm.strike)}, from {fracPct(shape.lo, 1)} to {fracPct(shape.hi, 1)} across the strikes shown
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Implied volatility by strike for the ${expiry} expiry`} className="w-full max-w-md">
        {[shape.hi, shape.lo].map((v) => (
          <g key={v}>
            <line x1={X0} x2={X1} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={X0 - 4} y={y(v) + 3.5} fontSize={9.5} textAnchor="end" style={{ fill: "var(--muted-foreground)" }} className="font-mono">
              {fracPct(v, 1)}
            </text>
          </g>
        ))}
        {spot >= first && spot <= last ? <line x1={x(spot)} x2={x(spot)} y1={TOP} y2={BOTTOM} stroke="var(--foreground)" strokeOpacity={0.6} strokeDasharray="4 3" /> : null}
        {shape.points.map((p) => (
          <g key={p.strike}>
            <title>{`${strikeText(p.strike)}: call ${p.call !== null ? fracPct(p.call, 1) : "none"}, put ${p.put !== null ? fracPct(p.put, 1) : "none"}`}</title>
            {p.put !== null ? <circle cx={x(p.strike)} cy={y(p.put)} r={2.6} fill="var(--card)" stroke="var(--info)" strokeWidth={1.2} /> : null}
            {p.call !== null ? <circle cx={x(p.strike)} cy={y(p.call)} r={2.2} fill="var(--info)" /> : null}
            {p.strike === strike ? <line x1={x(p.strike)} x2={x(p.strike)} y1={BOTTOM} y2={BOTTOM + 5} stroke="var(--info)" strokeWidth={2} /> : null}
          </g>
        ))}
        <text x={X0} y={H - 4} fontSize={9.5} style={{ fill: "var(--muted-foreground)" }} className="font-mono">
          {strikeText(first)}
        </text>
        <text x={X1} y={H - 4} fontSize={9.5} textAnchor="end" style={{ fill: "var(--muted-foreground)" }} className="font-mono">
          {strikeText(last)}
        </text>
      </svg>
      <p className="text-muted-foreground text-[0.6875rem]">Filled: calls. Outlined: puts. Dashed line: the stock&apos;s price. The tick under the axis is the strike being priced.</p>
      <details className="text-xs">
        <summary className="text-muted-foreground cursor-pointer">The same as a table ({shape.points.length} strikes)</summary>
        <table className="mt-1 w-full max-w-xs font-mono">
          <thead>
            <tr className="text-muted-foreground text-left font-sans text-[0.6875rem]">
              <th scope="col" className="py-0.5 pr-2 font-normal">
                Strike
              </th>
              <th scope="col" className="px-2 py-0.5 text-right font-normal">
                Call
              </th>
              <th scope="col" className="py-0.5 pl-2 text-right font-normal">
                Put
              </th>
            </tr>
          </thead>
          <tbody>
            {shape.points.map((p) => (
              <tr key={p.strike} className="border-border/60 border-t">
                <th scope="row" className="py-0.5 pr-2 text-left font-normal">
                  {strikeText(p.strike)}
                </th>
                <td className="px-2 py-0.5 text-right">{p.call !== null ? fracPct(p.call, 1) : "—"}</td>
                <td className="py-0.5 pl-2 text-right">{p.put !== null ? fracPct(p.put, 1) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
