import { Notice } from "@/components/ui/notice";
import { radarNotTodayYet } from "@/lib/edition-truth";
import { weekDate } from "@/lib/format";
import { radarStale } from "@/lib/radar";

/**
 * What the Radar page says when the edition on show is not today's: from 09:30 New York a red notice (the morning's
 * run did not publish); before 09:30 on a session day a warning that today's has not arrived yet. Nothing when an
 * older edition was opened on purpose (`live` false), and nothing on a weekend or a holiday before the open.
 */
export function RadarEditionNotice({ editionDate, now, live }: { editionDate: string; now: Date; live: boolean }) {
  if (!live) return null;
  if (radarStale(editionDate, now)) {
    return (
      <Notice tone="bad" size="sm" role="alert">
        This radar is from {weekDate(editionDate)}. Today&apos;s session has opened and no newer edition has published (or the
        market is shut for a holiday), so its levels and notes may be out of date.
      </Notice>
    );
  }
  if (radarNotTodayYet(editionDate, now)) {
    return (
      <Notice tone="warn" size="sm" role="status">
        <span data-radar-not-today>
          Not today&apos;s edition: this radar is from {weekDate(editionDate)}. Today&apos;s builds about 05:30 New York and has not
          arrived yet.
        </span>
      </Notice>
    );
  }
  return null;
}
