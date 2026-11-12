import { CalendarClock } from "lucide-react";
import type { BoardEvent } from "@/lib/board-events";

/**
 * The board's event line: what the calendar schedules on the board's day, when (New York time) and for whom, in the
 * board's small muted type, under its header and above its rows. Display only (DEC-0042, note of 2026-11-12): it
 * reads no state and no state reads it, and it carries no colour or weight of its own beside the states. Nothing is
 * drawn when the calendar lists nothing, and the items for a day do not change while it lasts (only their wording
 * does), so the line never appears or goes during a session.
 */
export function BoardEventsLine({ events }: { events: readonly BoardEvent[] }) {
  if (events.length === 0) return null;
  return (
    <p data-board-events={events.length} className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] leading-snug max-sm:text-xs">
      <CalendarClock aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">Calendar: </span>
      {events.map((ev, i) => (
        <span key={ev.key} data-board-event={ev.kind} data-board-event-symbol={ev.symbol ?? undefined} data-board-event-timing={ev.timing ?? undefined} className="inline-flex items-center gap-2">
          {i > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span className="sr-only">; </span>
            </>
          ) : null}
          <span>{ev.text}</span>
        </span>
      ))}
    </p>
  );
}
