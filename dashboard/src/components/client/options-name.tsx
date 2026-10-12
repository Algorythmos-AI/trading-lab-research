"use client";

import { useState } from "react";
import type { HourlyBar } from "@/lib/hourly";
import type { Interest } from "@/lib/oi";
import type { MapLayer, Options, OptionsTicker } from "@/lib/options";
import type { OptionsLive } from "@/lib/options-live.types";
import { weekDate } from "@/lib/format";
import { isHalfDay, sessionClock } from "@/lib/options";
import { rulesAreOld, rulesToday } from "@/lib/triggers";
import { FeedPill, useLive } from "./live-layer";
import { OptionsDetail } from "./options-detail";
import { Notice } from "@/components/ui/notice";

/**
 * One name on a page of its own: the same pane the desk shows beside its list, at the page's full width and with
 * the zones list open. It holds what the desk holds for that pane (the map layers switched off) and nothing else.
 */
export function OptionsName({
  e,
  t,
  live,
  positions,
  interest,
  hourly,
  stale,
}: {
  e: Options;
  t: OptionsTicker;
  live: boolean;
  positions: OptionsLive | null;
  interest: Interest | null;
  hourly: HourlyBar[] | null;
  /** A later session has started and no newer edition has published. */
  stale: boolean;
}) {
  const { now } = useLive();
  const [hidden, setHidden] = useState<ReadonlySet<MapLayer>>(new Set());
  const [range, setRange] = useState<"daily" | "hourly">("daily");
  const toggle = (layer: MapLayer) =>
    setHidden((was) => {
      const next = new Set(was);
      if (!next.delete(layer)) next.add(layer);
      return next;
    });
  // Until the browser's clock is read, the document's own time stands in, as on the desk.
  const rules = live ? rulesToday(positions, e, now ?? (positions ? Date.parse(positions.as_of) : 0)) : null;
  // The desk shows the states' age beside them; here there is no such pane, so states that have gone old are not shown.
  const open = now !== null && sessionClock(e.session, isHalfDay(e), new Date(now))?.phase === "open";
  const today = rules && !rulesAreOld(rules, open) ? (rules.bySymbol[t.symbol] ?? null) : null;
  return (
    // `data-ready` once the browser has taken the page over (the clock is only read there): the browser tests wait for it.
    <div data-name-page={t.symbol} data-ready={now !== null ? "true" : undefined} className="bg-card w-[min(calc(100vw-2rem),72rem)] justify-self-center overflow-clip rounded-xl border">
      {live || stale ? (
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-b px-4 py-2">
          {stale ? (
            <Notice tone="bad" size="sm" role="alert" className="mr-auto">
              These levels were for {weekDate(e.session)}. A later session has started and no newer edition has published, so do not trade from
              them.
            </Notice>
          ) : null}
          {live ? <FeedPill /> : null}
        </div>
      ) : null}
      <OptionsDetail e={e} t={t} live={live} hiddenLayers={hidden} onToggleLayer={toggle} interest={live ? interest : null} today={today} hourly={live ? hourly : null} range={range} onRange={setRange} expanded />
    </div>
  );
}
