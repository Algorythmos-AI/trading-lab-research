import { CalendarDays, Clock, Hourglass, PartyPopper, TimerReset } from "lucide-react";
import Link from "next/link";
import { CalendarYear } from "@/components/client/calendar-year";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import { Notice } from "@/components/ui/notice";
import { newYork } from "@/lib/format";
import { journalStale } from "@/lib/journal";
import {
  eventsByDay,
  GROUP_DOT,
  mergeEarnings,
  nextEarnings,
  nextHalfDay,
  nextHoliday,
  nyNow,
  pickYear,
  RANGE,
  releaseNotes,
  sessionMoves,
  shortDay,
  tradingCalendarDiffs,
  tradingDaysLeft,
  unlistedByMonth,
  yearTotals,
  yearView,
  YEARS,
  yourDays,
  type EventGroup,
  type YourDay,
} from "@/lib/market-calendar";
import { earningsOf } from "@/lib/radar-brief";
import { loadCalendar, loadJournal, loadOptions, loadRadar, pageTime } from "@/lib/snapshot";
import { DAY_LOSS_LIMIT, MAX_TRADES_PER_DAY, money } from "@/lib/trade-rules";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calendar" };

const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

const LEGEND: { group: EventGroup; label: string }[] = [
  { group: "fed", label: "Fed" },
  { group: "inflation", label: "Inflation (CPI, PPI, PCE)" },
  { group: "growth", label: "Jobs, GDP, retail sales" },
  { group: "expiry", label: "Monthly expiry" },
  { group: "earnings", label: "Earnings" },
];

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [q, now, journal, radar, options, calendar] = await Promise.all([searchParams, pageTime(), loadJournal(), loadRadar(), loadOptions(), loadCalendar()]);
  const year = pickYear(q.y, now);
  const today = nyNow(now).day;
  // A journal that is stored but cannot be worked through (a corrupt row) costs only the results, never the market.
  let you: Map<string, YourDay> | null = null;
  if (journal.status === "ok") {
    try {
      you = yourDays(journal.doc.trades);
    } catch {
      you = null;
    }
  }
  const results = you !== null;
  const opt = options.status === "ok" ? options.edition : null;
  const fromEditions =
    radar.status === "ok"
      ? earningsOf(radar.edition, opt)
      : (opt?.events ?? []).flatMap((e) => (e.kind === "earnings" && e.symbol ? [{ date: e.date, symbol: e.symbol, when: e.when ?? null }] : []));
  const earnings = mergeEarnings(fromEditions);
  const cal = calendar.status === "ok" ? calendar.doc : null;
  const official = cal?.events ?? [];
  const months = yearView(year, now, you ?? new Map(), eventsByDay(earnings, official));
  const totals = yearTotals(months);
  const begun = months.some((m) => m.started);
  const unlisted = unlistedByMonth(cal?.not_announced);
  const notes = releaseNotes(calendar.status, cal, tradingCalendarDiffs(official), now);
  const left = tradingDaysLeft(now);
  const holiday = nextHoliday(now);
  const half = nextHalfDay(now);
  const move = YEARS.flatMap((y) => sessionMoves(y)).find((m) => m.day >= today) ?? null;
  const initial = today.startsWith(String(year)) ? today : null;

  return (
    <>
      <PageHeading
        title="Calendar"
        intro="The US market year as you see it from Sydney: every open day, holiday and 1 pm close, the session in Sydney time as the clocks change, the days to trade around, and how each of your own days went."
      />

      <StatTiles>
        <StatTile
          label={`Days left in ${today.slice(0, 4)}`}
          icon={Hourglass}
          value={left ?? "—"}
          hint={left === null ? `The calendar runs to ${shortDay(RANGE.end)}.` : "Counting today until the New York close."}
        />
        <StatTile
          label="Next holiday"
          icon={PartyPopper}
          tone="warn"
          value={holiday ? holiday.name : "—"}
          hint={holiday ? `${shortDay(holiday.day)} · ${inDays(holiday.inDays)} · market closed` : "None left in the calendar."}
        />
        <StatTile
          label="Next half day"
          icon={TimerReset}
          tone="info"
          value={half ? shortDay(half.day) : "—"}
          hint={half ? `${half.name} · ${inDays(half.inDays)} · closes 1 pm New York` : "None left in the calendar."}
        />
        <StatTile
          label="First session after a time change"
          icon={Clock}
          value={move ? shortDay(move.day) : "—"}
          hint={move ? `${move.cause.where} clocks go ${move.cause.direction}: the open moves from ${move.from} to ${move.to} Sydney.` : "None left in the calendar."}
        />
      </StatTiles>

      {!results ? (
        <Notice tone="warn" size="sm" role="status">
          {journal.status === "missing" ? "Your trade journal has not been published yet, so" : "Your trade journal could not be read, so"} the days below show the market
          only, without your results.
        </Notice>
      ) : journal.status === "ok" && journalStale(journal.doc, now) ? (
        <Notice tone="warn" size="sm" role="status">
          Your journal was last read from the broker on {newYork(journal.doc.as_of)} New York time. Trades since then are not shown yet.
        </Notice>
      ) : null}

      <Panel
        id="calendar"
        icon={CalendarDays}
        title="The market year"
        means={`Monday to Friday, with weekends narrow. Tap a day for its hours in Sydney${results ? ", your result" : ""} and what is on.`}
        action={
          <nav aria-label="Year" className="flex gap-1">
            {YEARS.map((y) => (
              <Link
                key={y}
                href={`/calendar?y=${y}`}
                aria-current={y === year ? "page" : undefined}
                className={cn("rounded-md border px-3 py-1 font-mono text-sm", y === year ? "bg-foreground text-background border-foreground" : "hover:bg-muted")}
              >
                {y}
              </Link>
            ))}
          </nav>
        }
        contentClassName="grid gap-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 text-sm">
          <p>
            <span className="font-semibold">{year}</span>
            <span className="text-muted-foreground"> · {totals.marketDays} market days</span>
            {results && begun ? (
              <>
                <span className="text-muted-foreground"> · {totals.daysTraded} traded · </span>
                <span className={totals.ruleDays ? "text-bad" : "text-muted-foreground"}>{totals.ruleDays} broke a day rule</span>
                {totals.daysTraded ? (
                  <span className={cn("ml-2 font-mono font-semibold", totals.pnl > 0 ? "text-good" : totals.pnl < 0 ? "text-bad" : undefined)}>{money(totals.pnl)}</span>
                ) : null}
              </>
            ) : null}
          </p>
          <nav aria-label="Months" className="flex flex-wrap gap-1">
            {months.map((m) => (
              <a key={m.key} href={`#m-${m.key}`} className={cn("hover:bg-muted rounded px-1.5 py-0.5 text-xs", m.key === today.slice(0, 7) ? "text-foreground font-semibold" : "text-muted-foreground")}>
                {m.label.slice(0, 3)}
              </a>
            ))}
          </nav>
        </div>

        <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Key">
          {results ? (
            <>
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="bg-good-fill size-3 rounded-[3px]" />
                Made money
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="bg-bad-fill size-3 rounded-[3px]" />
                Lost money (darker is bigger, up to ${DAY_LOSS_LIMIT})
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="text-bad font-bold">!</span>
                Broke a day rule (over {MAX_TRADES_PER_DAY} trades or −${DAY_LOSS_LIMIT})
              </li>
            </>
          ) : null}
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="bg-warn-soft border-warn/40 size-3 rounded-[3px] border" />
            Market closed
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="bg-info-soft border-info/40 size-3 rounded-[3px] border" />
            Half day, 1 pm close
          </li>
          <li className="flex items-center gap-1.5">
            <Clock aria-hidden className="text-info size-3" />
            Clocks change or the Sydney open moves
          </li>
          {LEGEND.map((l) => (
            <li key={l.group} className="flex items-center gap-1.5">
              <span aria-hidden className={cn("size-2 rounded-full", GROUP_DOT[l.group])} />
              {l.label}
            </li>
          ))}
        </ul>

        <PaneBoundary name="The market year">
          <CalendarYear months={months} initial={initial} results={results} />
        </PaneBoundary>

        <UnlistedNote year={year} unlisted={unlisted} official={cal !== null} />
        {notes.length ? (
          <ul className="grid gap-1" data-testid="release-notes" aria-label="About the release dates">
            {notes.map((n) =>
              n.tone === "warn" ? (
                <li key={n.text}>
                  <Notice tone="warn">{n.text}</Notice>
                </li>
              ) : (
                <li key={n.text} className="text-muted-foreground text-xs">
                  {n.text}
                </li>
              ),
            )}
          </ul>
        ) : null}
      </Panel>

      <Panel id="earnings" icon={CalendarDays} title="Earnings for your Options names" means="The next report for each of the twelve names, when a date is known. A date marked expected has not been confirmed by the company.">
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3 lg:grid-cols-4">
          {nextEarnings(earnings, now).map(({ symbol, row }) => (
            <li key={symbol} className="flex items-baseline justify-between gap-2 border-b py-1">
              <span className="font-mono font-semibold">{symbol}</span>
              <span className={cn("text-xs", row ? undefined : "text-muted-foreground")}>
                {row ? `${shortDay(row.date)}${row.when === "amc" ? ", after close" : row.when === "bmo" ? ", before open" : ""}${row.expected ? " (expected)" : ""}` : "Date not yet known"}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-3 text-xs">AVGO and AMD list Monday, Wednesday and Friday expiries only.</p>
      </Panel>
    </>
  );
}

function UnlistedNote({ year, unlisted, official }: { year: number; unlisted: Map<string, string[]>; official: boolean }) {
  const rows = [...unlisted.entries()].filter(([m]) => m.startsWith(String(year)));
  if (!rows.length) return null;
  const byLabel = new Map<string, string[]>();
  for (const [m, labels] of rows) for (const l of labels) byLabel.set(l, [...(byLabel.get(l) ?? []), m]);
  const month = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
  const span = (ms: string[]) => (ms.length === 12 ? `all of ${year}` : `${month(ms[0]!)}${ms.length > 1 ? ` to ${month(ms.at(-1)!)}` : ""} ${year}`);
  // Releases missing for the same stretch share a line.
  const bySpan = new Map<string, string[]>();
  for (const [label, ms] of byLabel) bySpan.set(span(ms), [...(bySpan.get(span(ms)) ?? []), label]);
  return (
    <ul className="text-muted-foreground grid gap-0.5 text-xs" data-testid="not-listed">
      {[...bySpan.entries()].map(([when, labels]) => (
        <li key={when}>
          {official ? "Not yet announced" : "Not yet in the calendar"} for {when}: {labels.join(", ")}.{" "}
          {official ? "The weekly refresh adds them once each agency publishes its schedule." : "Those dates are added once the agency publishes them."}
        </li>
      ))}
    </ul>
  );
}
