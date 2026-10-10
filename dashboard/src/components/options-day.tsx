import { Badge } from "@/components/ui/badge";
import { fracPct, num, signed, weekDate } from "@/lib/format";
import { dayContext, earningsWhen, eventLabel, eventTime, sessionHours, type Options, type OptionsEvent } from "@/lib/options";

/** " 08:30 ET", or nothing for an event with no time. Every time on this line is New York's and says so. */
const at = (ev: OptionsEvent) => {
  const time = eventTime(ev);
  return time ? ` ${time} ET` : "";
};

/**
 * The day the levels are for, in one line: the VIX, the scheduled releases on the day and in the six days after,
 * which of the edition's names report earnings in that time, and the session's hours.
 *
 * It comes from the edition's second format. An edition in the first format carries none of it, and this draws
 * nothing rather than an empty line. It says a day has no scheduled release only when the edition says its
 * calendar is complete; otherwise an empty day is one it knows nothing about, and it says that instead.
 */
export function OptionsDay({ e }: { e: Options }) {
  const day = dayContext(e);
  const vix = e.market?.vix?.close != null ? e.market.vix : null;
  const hours = e.market?.session?.half_day != null ? sessionHours(e) : null;
  if (!day && !vix && !hours) return null;
  // The parts a reader needs less often. A wide screen has room for them in the line; a phone keeps them behind
  // one tap, so the list of names is not pushed half way down the screen.
  const rest = (
    <>
      {day && day.ahead.length > 0 ? (
        <span>
          Next 6 days: {day.ahead.map((ev) => `${eventLabel(ev.type)} ${weekDate(ev.date)}${at(ev)}`).join(", ")}
        </span>
      ) : null}
      {day && day.earnings.length > 0 ? (
        <span>
          Earnings, next 6 days:{" "}
          {day.earnings
            .map((ev) => {
              const when = earningsWhen(ev.when);
              return `${ev.symbol} ${weekDate(ev.date)}${when ? ` ${when}` : ""}`;
            })
            .join(", ")}
        </span>
      ) : null}
      {hours ? (
        <span>
          Session{" "}
          <span className="text-foreground font-mono">
            {hours.open} to {hours.close}
          </span>{" "}
          ET{hours.halfDay ? ", a half day" : ""}
        </span>
      ) : null}
    </>
  );
  const hasRest = Boolean(hours) || Boolean(day && (day.ahead.length > 0 || day.earnings.length > 0));
  return (
    <div data-desk-day className="text-muted-foreground flex basis-full flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.6875rem]">
      {vix ? (
        <span title="The VIX at the close the levels were built from, its change on the day, and where it sits in its own last year">
          VIX <span className="text-foreground font-mono">{num(vix.close, 2)}</span>
          {vix.change != null ? <span className="font-mono"> {signed(vix.change, 2)}</span> : null}
          {vix.pct_52w != null ? <span> · above {fracPct(vix.pct_52w, 0)} of the last year</span> : null}
        </span>
      ) : null}
      {day ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{weekDate(e.session)}:</span>
          {day.onTheDay.length === 0 ? (
            <span>{day.complete ? "no scheduled release" : "releases not known"}</span>
          ) : (
            // The index is part of the key: nothing stops an edition listing the same release twice.
            day.onTheDay.map((ev, i) => (
              <Badge key={`${i}:${ev.type}`} variant={ev.severity === "high" ? "warn" : "neutral"} className="px-1.5 text-[0.6875rem]">
                {eventLabel(ev.type)}
                {at(ev)}
              </Badge>
            ))
          )}
        </span>
      ) : null}
      {hasRest ? (
        <>
          <span data-day-wide className="contents max-sm:hidden">
            {rest}
          </span>
          <details data-day-more className="basis-full sm:hidden">
            <summary className="cursor-pointer">More about the week</summary>
            <div className="mt-1.5 grid gap-1">{rest}</div>
          </details>
        </>
      ) : null}
    </div>
  );
}
