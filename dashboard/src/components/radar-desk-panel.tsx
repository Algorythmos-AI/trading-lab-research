import { StatusBadge } from "@/components/status";
import { weekDate } from "@/lib/format";
import type { RadarDeskView } from "@/lib/radar-desk-view";

// The Radar desk file on the Options page: each focus name's flags as coloured chips and its next earnings, with one
// coverage line. Display only: it changes nothing on the board. A server component, so only the focus rows the view
// kept are ever sent to the browser.

export function RadarDeskPanel({ view }: { view: RadarDeskView }) {
  if (view.status !== "ok") {
    return (
      <p data-radar-desk={view.status} className="text-muted-foreground text-xs">
        {view.status === "none" ? "No Radar desk file for today" : "The Radar desk file could not be read"}
      </p>
    );
  }
  return (
    <section data-radar-desk="ok" aria-label="Radar desk" className="bg-card grid gap-2 rounded-lg border p-3">
      <p className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="text-sm font-semibold">Radar desk · focus names</span>
        <span data-radar-desk-coverage className={view.focusMissing ? "text-warn" : "text-muted-foreground"}>
          {view.coverage}
        </span>
      </p>
      {view.rows.length ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {view.rows.map((r) => (
            <li key={r.symbol} data-radar-desk-name={r.symbol} className="grid gap-1.5 rounded-md border p-2">
              <p className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-price font-mono">{r.symbol}</span>
                <span className="text-muted-foreground text-xs">
                  {r.earnings ? `Earnings ${weekDate(r.earnings.date)}, ${r.earnings.when}` : "No earnings on file"}
                </span>
              </p>
              <p className="flex flex-wrap gap-1">
                {r.flags.length ? (
                  r.flags.map((f) => (
                    <StatusBadge key={f.code} tone={f.tone}>
                      {f.label}
                    </StatusBadge>
                  ))
                ) : (
                  <StatusBadge tone="good">No flags</StatusBadge>
                )}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">{view.focusMissing ? "No focus names: the focus file is missing." : "No focus names in the file."}</p>
      )}
      <p className="text-muted-foreground text-xs">Display only: these flags change no pick and no board state.</p>
    </section>
  );
}
