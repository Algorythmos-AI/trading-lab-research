"use client";

import { useState } from "react";
import type { Interest } from "@/lib/oi";
import type { MapLayer, Options, OptionsTicker } from "@/lib/options";
import type { OptionsLive } from "@/lib/options-live.types";
import { rulesToday } from "@/lib/triggers";
import { useLive } from "./live-layer";
import { OptionsDetail } from "./options-detail";

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
}: {
  e: Options;
  t: OptionsTicker;
  live: boolean;
  positions: OptionsLive | null;
  interest: Interest | null;
}) {
  const { now } = useLive();
  const [hidden, setHidden] = useState<ReadonlySet<MapLayer>>(new Set());
  const toggle = (layer: MapLayer) =>
    setHidden((was) => {
      const next = new Set(was);
      if (!next.delete(layer)) next.add(layer);
      return next;
    });
  // Until the browser's clock is read, the document's own time stands in, as on the desk.
  const rules = live ? rulesToday(positions, e, now ?? (positions ? Date.parse(positions.as_of) : 0)) : null;
  return (
    <div className="bg-card w-[min(calc(100vw-2rem),72rem)] justify-self-center overflow-clip rounded-xl border">
      <OptionsDetail e={e} t={t} live={live} hiddenLayers={hidden} onToggleLayer={toggle} interest={live ? interest : null} today={rules?.bySymbol[t.symbol] ?? null} expanded />
    </div>
  );
}
