import { CalendarClock } from "lucide-react";
import { type BoardEvent, NOTE_KINDS, RELEASE_COVERAGE } from "@/lib/board-events";

/** At most this many items are drawn; the rest are counted ("+N more") and named in the title and to a screen reader. */
export const MAX_SHOWN = 5;

/**
 * The board's event line: what the calendar schedules on the board's day, when (New York time) and for whom, in the
 * board's small muted type. trade-now.tsx's BoardEvents draws it in one place at a time: in the status rail under its
 * session bar while the board is folded into the rail or the cockpit is on, and otherwise in the board, under its
 * header and above its rows. Display only (DEC-0042, note of 2026-11-12): it reads no state and no state reads it, and
 * it carries no colour or weight of its own beside the states. Nothing is drawn when the calendar lists nothing, and
 * the items for a day do not change while it lasts (only their wording does), so the line does not come and go
 * during a session.
 *
 * Events come first, in time order, and the notes on what the calendar does not cover last, so when the line is cut
 * it is a note that is folded, never an event. The whole list, with what the calendar covers, is the element's title
 * and its screen-reader text.
 */
export function BoardEventsLine({ events, where }: { events: readonly BoardEvent[]; where?: "board" | "rail" }) {
  if (events.length === 0) return null;
  const ordered = [...events.filter((e) => !NOTE_KINDS.has(e.kind)), ...events.filter((e) => NOTE_KINDS.has(e.kind))];
  const shown = ordered.slice(0, MAX_SHOWN);
  const more = ordered.length - shown.length;
  const all = `${RELEASE_COVERAGE}: ${ordered.map((e) => e.text).join("; ")}`;
  return (
    <p
      data-board-events={events.length}
      data-board-events-where={where}
      title={all}
      className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] leading-snug max-sm:text-xs"
    >
      <CalendarClock aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">{all}</span>
      {shown.map((ev, i) => (
        <span
          key={ev.key}
          aria-hidden
          data-board-event={ev.kind}
          data-board-event-symbol={ev.symbol ?? undefined}
          data-board-event-timing={ev.timing ?? undefined}
          className="inline-flex items-center gap-2"
        >
          {i > 0 ? <span>·</span> : null}
          <span>{ev.text}</span>
        </span>
      ))}
      {more > 0 ? (
        <span aria-hidden data-board-events-more={more}>
          +{more} more
        </span>
      ) : null}
    </p>
  );
}
