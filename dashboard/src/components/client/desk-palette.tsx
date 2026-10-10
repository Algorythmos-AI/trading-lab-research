"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Command, defaultFilter, useCommandState } from "cmdk";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CHEAP_IVP, CHIP_LABEL, DESK_VIEWS, MAP_LAYER_LABEL, RICH_IVP, type DeskView, type MapLayer, type OptionsTicker } from "@/lib/options";
import { NAV } from "./nav-tabs";

const VIEW_LABEL: Record<DeskView, string> = { brief: "Brief", live: "Live", review: "Review" };
const VIEW_WHEN: Record<DeskView, string> = { brief: "before the open", live: "while the session trades", review: "after the close" };

const GROUP =
  "[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[0.6875rem] [&_[cmdk-group-heading]]:font-medium";
const ITEM =
  "flex cursor-pointer items-baseline gap-3 rounded-md px-2 py-1.5 text-[0.8125rem] data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground";

/** The one item that typing can never match: it is offered only when nothing else is. */
const CLEAR = "clear-the-search";

/**
 * Shown under "Nothing matches": one thing to do next. It also keeps the list from ever being empty, which a
 * screen reader would be told is a list with nothing in it.
 */
function NoMatch({ onClear }: { onClear: () => void }) {
  // Only once something has been typed. Before the first filter runs the count is also zero; showing this item
  // then would make it the palette's first highlighted row, and it would take that highlight away with it.
  const none = useCommandState((state) => state.search !== "" && state.filtered.count === 0);
  if (!none) return null;
  return (
    <Command.Item forceMount value={CLEAR} onSelect={onClear} className={ITEM}>
      Clear the search
    </Command.Item>
  );
}

/** What the reader would say about a name's options, for the list and for searching ("rich", "cheap"). */
function optionWord(t: OptionsTicker): string | null {
  const ivp = t.expected_move?.iv_pct_52w;
  if (ivp == null) return null;
  return ivp >= RICH_IVP ? "options rich" : ivp <= CHEAP_IVP ? "options cheap" : "options middling";
}

/**
 * The desk's command palette: type to jump to a name, switch view, switch a map layer off or on, or go to another
 * page. It opens on Cmd K or Ctrl K, lists everything before anything is typed, and gives the keyboard back to the
 * desk when it closes, on the selected name.
 *
 * Names can be found by what they are as well as by ticker: "strong", "weak", "rich", "cheap".
 */
export function DeskPalette({
  open,
  onOpenChange,
  tickers,
  symbol,
  view,
  layers,
  hiddenLayers,
  onName,
  onView,
  onLayer,
  onShortcuts,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tickers: readonly OptionsTicker[];
  symbol: string | null;
  view: DeskView;
  /** The layers the selected name's map can show. */
  layers: readonly MapLayer[];
  hiddenLayers: ReadonlySet<MapLayer>;
  onName: (symbol: string) => void;
  onView: (view: DeskView) => void;
  onLayer: (layer: MapLayer) => void;
  onShortcuts: () => void;
  /** Called once the palette has gone, so the desk can take the keyboard back. */
  onClosed: () => void;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(ev) => {
            // This runs however the palette closed (an item, Escape, a click outside, the shortcut again), so it
            // is the one place that makes each opening start from an empty search.
            setSearch("");
            // Not back to whatever had focus before: to the selected name, so J, K and the rest work at once.
            ev.preventDefault();
            onClosed();
          }}
          className="bg-popover text-popover-foreground fixed top-[12vh] left-1/2 z-50 w-[min(calc(100vw-2rem),34rem)] -translate-x-1/2 overflow-hidden rounded-xl border shadow-2xl"
        >
          <Dialog.Title className="sr-only">Search names and actions</Dialog.Title>
          <Command label="Search names and actions" loop filter={(value, query, keywords) => (value === CLEAR ? 0 : defaultFilter(value, query, keywords))}>
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="A ticker, a view, a layer or a page"
              // 16px on a phone: iOS zooms the whole page when a smaller input takes focus.
              className="placeholder:text-muted-foreground w-full border-b bg-transparent px-3.5 py-3 text-base outline-none sm:text-sm"
            />
            <Command.List className="max-h-[min(60vh,24rem)] overflow-y-auto p-1.5">
              <Command.Empty className="text-muted-foreground px-2 pt-5 pb-3 text-center text-sm">
                Nothing matches. Try a ticker, a view, a layer or a page.
              </Command.Empty>
              <NoMatch onClear={() => setSearch("")} />

              <Command.Group heading="Names" className={GROUP}>
                {tickers.map((t) => {
                  const chip = t.close_strength?.chip;
                  const strength = chip ? (CHIP_LABEL[chip] ?? chip) : null;
                  const word = optionWord(t);
                  return (
                    <Command.Item key={t.symbol} value={t.symbol} keywords={[strength, word].filter((k): k is string => k !== null)} onSelect={() => run(() => onName(t.symbol))} className={ITEM}>
                      <span className="w-14 font-mono font-semibold">{t.symbol}</span>
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{[strength, word].filter(Boolean).join(", ")}</span>
                      {t.symbol === symbol ? <span className="text-muted-foreground text-xs">selected</span> : null}
                    </Command.Item>
                  );
                })}
              </Command.Group>

              <Command.Group heading="View" className={GROUP}>
                {DESK_VIEWS.map((v) => (
                  <Command.Item key={v} value={`${VIEW_LABEL[v]} view`} keywords={[VIEW_WHEN[v]]} onSelect={() => run(() => onView(v))} className={ITEM}>
                    <span className="flex-1">
                      {VIEW_LABEL[v]} <span className="text-muted-foreground text-xs">{VIEW_WHEN[v]}</span>
                    </span>
                    {v === view ? <span className="text-muted-foreground text-xs">showing</span> : null}
                  </Command.Item>
                ))}
              </Command.Group>

              {layers.length > 0 ? (
                <Command.Group heading="Map layers" className={GROUP}>
                  {layers.map((k) => {
                    const hidden = hiddenLayers.has(k);
                    const label = `${hidden ? "Show" : "Hide"} ${MAP_LAYER_LABEL[k].toLowerCase()}`;
                    return (
                      <Command.Item key={k} value={label} keywords={["map", "layer"]} onSelect={() => run(() => onLayer(k))} className={ITEM}>
                        <span className="flex-1">{label}</span>
                        <span className="text-muted-foreground text-xs">{hidden ? "hidden" : "shown"}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}

              <Command.Group heading="Go to" className={GROUP}>
                {NAV.filter((p) => p.href !== "/options").map((p) => (
                  <Command.Item key={p.href} value={`${p.label} page`} onSelect={() => run(() => router.push(p.href))} className={ITEM}>
                    {p.label}
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group heading="This page" className={GROUP}>
                <Command.Item value="Keyboard shortcuts" keywords={["keys", "help"]} onSelect={() => run(onShortcuts)} className={ITEM}>
                  Keyboard shortcuts
                </Command.Item>
                <Command.Item value="Classic layout" keywords={["old", "previous"]} onSelect={() => run(() => router.push("/options?view=classic"))} className={ITEM}>
                  <span className="flex-1">Classic layout</span>
                  <span className="text-muted-foreground text-xs">the page before the desk</span>
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
