"use client";

import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Empty } from "@/components/empty";
import { LevelMap } from "@/components/options-charts";
import { Badge } from "@/components/ui/badge";
import { fracPct, num, rMult, signed } from "@/lib/format";
import {
  CHEAP_IVP,
  CHIP_LABEL,
  chipTone,
  ladder,
  levelPrice,
  MAP_LAYER_LABEL,
  MAP_LAYERS,
  mapView,
  moveBands,
  movesFromClose,
  nearest,
  paperFor,
  RICH_IVP,
  RULE_STATUS_LABEL,
  ruleTone,
  type MapLayer,
  type Options,
  type OptionsTicker,
  type Rung,
} from "@/lib/options";
import { cn } from "@/lib/utils";
import { StateChip, useLiveRead } from "./live-layer";

/** A label over its value: the desk's way of stating a fact, one unit per cell. */
function Fact({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-muted-foreground truncate text-[0.6875rem]">{label}</dt>
      <dd className="truncate font-mono text-[0.8125rem]">{children}</dd>
    </div>
  );
}

/** A live number that washes green or red for a moment when it changes. The wash is background only. */
export function Tick({ value, children, className }: { value: number | null; children: React.ReactNode; className?: string }) {
  const [seen, setSeen] = useState<{ value: number | null; dir: "up" | "down" | null }>({ value, dir: null });
  if (value !== seen.value) {
    setSeen({ value, dir: value !== null && seen.value !== null ? (value > seen.value ? "up" : "down") : null });
  }
  return (
    <span key={`${seen.value}`} className={cn("-mx-1 rounded-sm px-1", seen.dir === "up" && "tick-up", seen.dir === "down" && "tick-down", className)}>
      {children}
    </span>
  );
}

function ZoneRow({ r, side }: { r: Rung; side: "above" | "at" | "below" }) {
  const z = r.zone;
  return (
    <li className="grid break-inside-avoid grid-cols-[0.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2 py-1">
      <span
        aria-hidden
        className={cn("h-2.5 w-1 self-center rounded-full", side === "above" ? "bg-bad-fill" : side === "below" ? "bg-good-fill" : "bg-warn-fill", !z.big && "opacity-50")}
      />
      <span className="min-w-0">
        <span className="font-mono text-[0.8125rem]">{z.lo === z.hi ? num(z.lo, 2) : `${num(z.lo, 2)} to ${num(z.hi, 2)}`}</span>
        {z.big ? <span className="ml-1.5 text-[0.6875rem] font-medium">major</span> : null}
        <span className="text-muted-foreground block truncate text-[0.6875rem]">{(z.members ?? []).join(" + ")}</span>
      </span>
      <span className="text-muted-foreground text-right font-mono text-[0.6875rem]">
        {r.inside ? "price inside" : r.distAtr !== null ? `${num(r.distAtr, 1)} ATR` : `${signed(r.distPct, 1)}%`}
      </span>
    </li>
  );
}

/**
 * The selected name: its price against the levels map, the facts the map is drawn from, the nearest zones each
 * side, and what the rules have done on it. Every number comes from the edition or the shared live feed; a missing
 * one shows as a dash.
 */
export function OptionsDetail({
  e,
  t,
  hiddenLayers,
  onToggleLayer,
}: {
  e: Options;
  t: OptionsTicker;
  /** Map layers the reader has switched off. Held by the desk, so the choice survives a change of name. */
  hiddenLayers: ReadonlySet<MapLayer>;
  onToggleLayer: (layer: MapLayer) => void;
}) {
  const read = useLiveRead(t);
  const close = t.last?.close ?? null;
  const price = read.price;
  const change = read.inSession && price !== null && close !== null ? price - close : null;
  const moves = read.inSession ? movesFromClose(t, price) : null;
  const ivp = t.expected_move?.iv_pct_52w ?? null;
  const near = nearest(t);
  const { above, at, below } = ladder(t);
  const pdh = levelPrice(t, "PDH");
  const pdl = levelPrice(t, "PDL");
  const paper = paperFor(e, t.symbol);
  const view = mapView(t);
  const hasMap = view !== null && close !== null;
  const strength = t.close_strength?.chip;
  // Only the layers the map actually draws for this name, judged the way the map judges them: no candles toggle
  // without bars, no expected-move toggle without a move, no zones toggle when no zone falls inside the window.
  const layers = MAP_LAYERS.filter((k) =>
    k === "candles" ? (view?.bars.length ?? 0) > 0 : k === "move" ? moveBands(t).day !== null : k === "zones" ? (view?.zones.length ?? 0) > 0 : true,
  );

  return (
    <div className="grid content-start gap-4 p-4" data-desk-detail={t.symbol}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-xl leading-none font-semibold">{t.symbol}</h2>
        <span className="font-mono text-xl leading-none">
          <Tick value={price}>{num(price, 2)}</Tick>
        </span>
        {change !== null ? (
          <span className={cn("font-mono text-sm", change > 0 ? "text-good" : change < 0 ? "text-bad" : "text-muted-foreground")}>
            {signed(change, 2)}
            {moves !== null ? <span className="text-muted-foreground"> · {signed(moves, 2)} expected moves</span> : null}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">
            {read.inSession ? "live; no close in this edition to compare with" : price === null ? "no last bar in this edition" : "at the close"}
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <StateChip read={read} />
          {strength ? <Badge variant={chipTone(strength)}>{CHIP_LABEL[strength] ?? strength}</Badge> : null}
          {ivp !== null ? (
            <Badge variant={ivp >= RICH_IVP ? "warn" : ivp <= CHEAP_IVP ? "info" : "neutral"}>
              {ivp >= RICH_IVP ? "Options rich" : ivp <= CHEAP_IVP ? "Options cheap" : "Options middling"}
            </Badge>
          ) : null}
        </span>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_15rem]">
        {hasMap ? (
          <div className="mx-auto grid w-full max-w-2xl content-start gap-1.5">
            <div role="group" aria-label="Map layers" className="flex flex-wrap items-center gap-1">
              <span className="text-muted-foreground mr-1 text-[0.6875rem]">Show</span>
              {layers.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={!hiddenLayers.has(k)}
                  onClick={(ev) => {
                    // Safari does not focus a button on click; keep focus in the desk so the shortcuts still hear keys.
                    ev.currentTarget.focus();
                    onToggleLayer(k);
                  }}
                  className={cn(
                    "rounded border px-1.5 py-0.5 text-[0.6875rem] transition-colors",
                    hiddenLayers.has(k) ? "text-muted-foreground hover:text-foreground" : "bg-accent text-foreground",
                  )}
                >
                  {MAP_LAYER_LABEL[k]}
                </button>
              ))}
            </div>
            <div data-hide={[...hiddenLayers].join(" ") || undefined}>
              <LevelMap t={t} interactive />
            </div>
          </div>
        ) : (
          <Empty title="No level map for this name">
            The edition has no recent bars or no last close for {t.symbol}, so there is nothing to draw the levels against.
          </Empty>
        )}

        <section aria-label={`${t.symbol} rules`} className="xl:border-l xl:pl-4">
          <h3 className="text-[0.8125rem] font-medium">Rules on this name</h3>
          <p className="text-muted-foreground text-[0.6875rem]">
            {paper.n === 0
              ? "No paper trades on this name yet."
              : `${paper.n} paper ${paper.n === 1 ? "trade" : "trades"}, ${paper.wins} won, ${rMult(paper.totalR, 2)} in total. R is measured on the stock.`}
          </p>
          <ul className="divide-border/60 mt-1 divide-y">
            {(e.rules ?? []).map((rule) => {
              const mine = paper.rows.filter((p) => p.rule === rule.id);
              const total = mine.reduce((a, p) => a + (p.r ?? 0), 0);
              return (
                <li key={rule.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 py-1.5">
                  <span className="min-w-0">
                    <span className="block text-[0.8125rem] leading-snug">{rule.label ?? rule.id}</span>
                    <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-[0.6875rem]">
                      <Badge variant={ruleTone(rule.status)} className="px-1 text-[0.625rem]">
                        {RULE_STATUS_LABEL[rule.status]}
                      </Badge>
                      {rule.side ? (rule.side === "call" ? "calls" : "puts") : null}
                    </span>
                  </span>
                  <span className={cn("text-right font-mono text-[0.8125rem]", mine.length === 0 ? "text-muted-foreground" : total > 0 ? "text-good" : total < 0 ? "text-bad" : "")}>
                    {mine.length === 0 ? "—" : rMult(total, 2)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 border-t pt-3 sm:grid-cols-5">
        <Fact label="Support" title="Nearest zone below the close, and how far in ATRs">
          {near.support ? num(near.support.edge, 2) : close === null ? "—" : "none near"}
          {near.support?.distAtr != null ? <span className="text-muted-foreground"> · {num(near.support.distAtr, 1)} ATR</span> : null}
        </Fact>
        <Fact label="Resistance" title="Nearest zone above the close, and how far in ATRs">
          {near.resistance ? num(near.resistance.edge, 2) : close === null ? "—" : "none near"}
          {near.resistance?.distAtr != null ? <span className="text-muted-foreground"> · {num(near.resistance.distAtr, 1)} ATR</span> : null}
        </Fact>
        <Fact label="1-day move" title="What the options market prices for one day">
          {t.expected_move?.day != null ? `±${num(t.expected_move.day, 2)}` : "—"}
        </Fact>
        <Fact label="1-week move" title="What the options market prices for one week">
          {t.expected_move?.week != null ? `±${num(t.expected_move.week, 2)}` : "—"}
        </Fact>
        <Fact label="ATR, 14 days">{num(t.atr14, 2)}</Fact>
        <Fact label="Prior high" title="The high of the session the levels were built from">
          {num(t.last?.high ?? pdh, 2)}
        </Fact>
        <Fact label="Prior low" title="The low of the session the levels were built from">
          {num(t.last?.low ?? pdl, 2)}
        </Fact>
        <Fact label="Close in range" title="Where the close sat between the day's low (0%) and high (100%)">
          {fracPct(t.close_strength?.pos, 0)}
        </Fact>
        <Fact label="Implied vol" title="Annualised, from the options market at the close">
          {fracPct(t.expected_move?.annual_iv, 1)}
        </Fact>
        <Fact label="IV percentile" title="Where implied vol sits in its own last 52 weeks">
          {fracPct(ivp, 0)}
        </Fact>
      </dl>

      {above.length + at.length + below.length > 0 ? (
        <details className="border-t pt-3 text-sm">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            The zones on the map as a list ({above.length + at.length + below.length})
          </summary>
          <ol aria-label={`${t.symbol} zones, highest first`} className="divide-border/60 mt-1 divide-y sm:columns-2 sm:gap-8">
            {[...above].reverse().map((r, i) => (
              <ZoneRow key={`a${i}`} r={r} side="above" />
            ))}
            {at.map((r, i) => (
              <ZoneRow key={`i${i}`} r={r} side="at" />
            ))}
            {below.map((r, i) => (
              <ZoneRow key={`b${i}`} r={r} side="below" />
            ))}
          </ol>
        </details>
      ) : null}

      {(t.problems ?? []).length > 0 ? (
        <p className="text-warn flex items-start gap-1.5 text-xs">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {(t.problems ?? []).join(" ")}
        </p>
      ) : null}
    </div>
  );
}
