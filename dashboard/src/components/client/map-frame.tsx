"use client";

import { useRef, useState } from "react";
import { num, signed } from "@/lib/format";
import { mapReadout, priceAtY, type MapZone, type OptionsTicker } from "@/lib/options";
import { cn } from "@/lib/utils";

/**
 * The level map's frame: the picture itself, and when `interactive` a crosshair that reads a price off it. Move
 * the pointer over the map (or tap it) and a line marks the price; the line under the map says how far that price
 * is from the close in dollars, in ATRs and in expected moves, and names the zone it is inside.
 *
 * The readout keeps its room whether or not it is showing, so the page does not move as it appears. The crosshair is a pointer aid: the
 * same distances are in the zones list for a keyboard or a screen reader.
 */
export function MapFrame({
  t,
  label,
  w,
  h,
  top,
  bottom,
  x0,
  x1,
  lo,
  hi,
  zones,
  interactive = false,
  children,
}: {
  t: OptionsTicker;
  label: string;
  w: number;
  h: number;
  /** The plot's vertical extent and the crosshair's horizontal span, in the map's own units. */
  top: number;
  bottom: number;
  x0: number;
  x1: number;
  lo: number;
  hi: number;
  zones: readonly MapZone[];
  interactive?: boolean;
  children: React.ReactNode;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [y, setY] = useState<number | null>(null);

  const place = (ev: React.PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.height === 0) return;
    setY(Math.max(top, Math.min(bottom, ((ev.clientY - box.top) / box.height) * h)));
  };

  const read = y === null ? null : mapReadout(t, priceAtY(y, lo, hi, top, bottom), zones);
  const z = read?.zone ?? null;

  return (
    <figure className="grid gap-1.5">
      <svg
        ref={svg}
        viewBox={`0 0 ${w} ${h}`}
        className="h-auto w-full"
        role="img"
        aria-label={label}
        // A mouse moves the crosshair and clears it on leaving. A finger sets it with a tap and it stays. The tap
        // is read when the finger lifts: a scroll that starts on the map ends in a cancel, not a lift, so it
        // leaves no stray line behind.
        onPointerMove={interactive ? (ev) => ev.pointerType === "mouse" && place(ev) : undefined}
        onPointerUp={interactive ? (ev) => ev.pointerType !== "mouse" && place(ev) : undefined}
        onPointerLeave={interactive ? (ev) => ev.pointerType === "mouse" && setY(null) : undefined}
      >
        {children}
        {read && y !== null ? (
          <g aria-hidden pointerEvents="none" data-map-crosshair>
            <line x1={x0} x2={x1} y1={y} y2={y} stroke="var(--foreground)" strokeWidth={1} strokeOpacity={0.85} />
            <text
              x={x0 + 2}
              y={y - 4 < top + 10 ? y + 12 : y - 4}
              fontSize={11}
              fontWeight={600}
              className="font-mono"
              style={{ fill: "var(--foreground)", paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3 }}
            >
              {num(read.price, 2)}
            </text>
          </g>
        ) : null}
      </svg>
      {interactive ? (
        // Room for three lines on a phone and one from there up, so the readout never pushes the page about.
        <p data-map-readout className="flex min-h-[3.25rem] flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs sm:min-h-5">
          {read ? (
            <>
              <span className="font-mono font-semibold">{num(read.price, 2)}</span>
              {read.fromClose !== null ? <span className="font-mono">{signed(read.fromClose, 2)} from the close</span> : null}
              {read.atrs !== null ? <span className="text-muted-foreground font-mono">{signed(read.atrs, 2)} ATR</span> : null}
              {read.moves !== null ? <span className="text-muted-foreground font-mono">{signed(read.moves, 2)} expected moves</span> : null}
              {z ? (
                <span className={cn("max-w-full truncate", z.tone === "support" ? "text-good" : "text-bad")}>
                  inside {z.tone} {z.zone.lo === z.zone.hi ? num(z.zone.lo, 2) : `${num(z.zone.lo, 2)} to ${num(z.zone.hi, 2)}`}
                  {(z.zone.members ?? []).length > 0 ? ` (${(z.zone.members ?? []).join(" + ")})` : ""}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">Point at the map to read a price against the close.</span>
          )}
        </p>
      ) : null}
    </figure>
  );
}
