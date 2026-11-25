// The arms' window as a calendar: the 9 sessions they were booked in (5 to 17 Nov 2026, from the market calendar),
// each shadow arm's simulated trades in each, the 11 sessions each trial still needed and never got, and the empty
// runway to the close, in which nothing can be booked. Counts of trades, never results, and never pooled across arms.
import { Empty } from "@/components/empty";
import { COUNT, RUNWAY_SESSIONS, WINDOW, WINDOW_SESSIONS, recordHref, type HeatRow } from "@/lib/research-arms";
import { cn } from "@/lib/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (ymd: string) => `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;
const shade = (n: number, most: number) => (n === 0 ? "bg-muted" : n / most > 0.66 ? "bg-info-fill" : n / most > 0.33 ? "bg-info-fill/60" : "bg-info-fill/30");

export function SessionHeatmap({ rows, unread = false }: { rows: HeatRow[] | null; unread?: boolean }) {
  const missing = Math.max(0, COUNT.sessions - WINDOW_SESSIONS.length);
  const most = Math.max(1, ...(rows ?? []).flatMap((r) => r.cells));
  const outside = (rows ?? []).reduce((s, r) => s + r.outside, 0);
  return (
    <div className="grid gap-4">
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-1 text-xs">
          <caption className="sr-only">Simulated trades of each shadow arm in each session of the window, then the sessions each trial needed and never got</caption>
          <thead>
            <tr>
              <th scope="col" className="text-muted-foreground pr-2 text-left font-medium">
                Arm
              </th>
              {WINDOW_SESSIONS.map((d) => (
                <th key={d} scope="col" className="text-muted-foreground w-7 text-center font-normal">
                  <span className="block">{Number(d.slice(8, 10))}</span>
                </th>
              ))}
              <th scope="col" colSpan={missing} className="text-muted-foreground pl-2 text-left font-normal">
                {missing} more needed
              </th>
            </tr>
          </thead>
          <tbody>
            {rows && rows.length > 0 ? (
              rows.map((r) => (
                <tr key={r.hyp} data-heat={r.hyp}>
                  <th scope="row" className="pr-2 text-left font-normal">
                    <a href={recordHref(r.hyp)} className="font-mono underline decoration-dotted underline-offset-2">
                      {r.hyp}
                    </a>
                  </th>
                  {r.cells.map((n, i) => (
                    <td key={WINDOW_SESSIONS[i]} className={cn("size-7 rounded text-center font-mono", shade(n, most), n / most > 0.66 ? "text-white" : "")}>
                      <span className="sr-only">{day(WINDOW_SESSIONS[i]!)}: </span>
                      {n || "·"}
                    </td>
                  ))}
                  {Array.from({ length: missing }, (_, i) => (
                    <td key={`m${i}`} className="border-border size-7 rounded border border-dashed">
                      <span className="sr-only">never booked</span>
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={WINDOW_SESSIONS.length + missing + 1} className="pt-2">
                  <Empty title={unread ? "The arms' simulated trades could not be read" : rows ? "No simulated trade inside the window" : "The arms' simulated trades are not being sent yet"} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground text-xs">
        Each number is that arm&apos;s simulated trades opened in that session, November 2026; a dot is none. Each trial needed {COUNT.sessions} sessions and got {WINDOW_SESSIONS.length} at most.
        {outside > 0 ? ` ${outside} ${outside === 1 ? "trade is" : "trades are"} dated outside the window and left out.` : ""}
      </p>
      <div className="grid gap-1.5" data-runway="">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground font-mono">{day(WINDOW.last)}</span>
          <div className="bg-muted relative h-3 grow overflow-hidden rounded-full border border-dashed" role="img" aria-label={`${RUNWAY_SESSIONS.length} sessions from 18 Nov 2026 to 5 Nov 2027, none booked`}>
            <div className="bg-info-fill absolute inset-y-0 left-0 rounded-full" style={{ width: `${(WINDOW_SESSIONS.length / (WINDOW_SESSIONS.length + RUNWAY_SESSIONS.length)) * 100}%` }} />
          </div>
          <span className="text-muted-foreground font-mono">5 Nov 2027</span>
        </div>
        <p className="text-muted-foreground text-xs">
          The runway to the close: {RUNWAY_SESSIONS.length} more sessions in the market&apos;s calendar, and none can be booked. Booking is off, so the count stays where it is.
        </p>
      </div>
    </div>
  );
}
