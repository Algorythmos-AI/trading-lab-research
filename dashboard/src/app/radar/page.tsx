import { ArrowUpRight } from "lucide-react";
import { PageHeading } from "@/components/page-heading";
import { PaneBoundary } from "@/components/client/pane-boundary";
import {
  AvoidPanel,
  CalendarPanel,
  EditionPanel,
  EditionPicker,
  NoRadar,
  PicksPanel,
  ScorePanel,
  TickerCards,
  WatchlistPanel,
} from "@/components/radar";
import { MoversPanel, OpenMapPanel, SessionPanel, VerdictPanel, WeekPanel, YourNamesPanel } from "@/components/radar-brief";
import { RadarEditionNotice } from "@/components/radar-edition-notice";
import { RadarSchedulePanel } from "@/components/radar-schedule";
import { sydney, weekDate } from "@/lib/format";
import type { Radar } from "@/lib/radar";
import {
  briefWeek,
  dayVerdict,
  earningsOf,
  movers,
  laterPremarket, openRead,
  sessionRecord,
  timedEvents,
  vixJumpPct,
  yourNames,
} from "@/lib/radar-brief";
import type { OptionsEdition } from "@/lib/options.types";
import type { Trade } from "@/lib/journal";
import { loadRadarPipeline } from "@/lib/radar-pipeline-run";
import { listRadarDates, loadJournal, loadOptions, loadRadar, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Radar" };

export default async function RadarPage({ searchParams }: { searchParams: Promise<{ d?: string | string[] }> }) {
  const raw = (await searchParams).d;
  const date = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  const [result, dates, now, journal] = await Promise.all([loadRadar(date), listRadarDates(), pageTime(), loadJournal()]);
  // One small summary the 10-minute cron writes; with none, the card draws the schedule alone.
  const pipeline = await loadRadarPipeline(now);
  if (result.status !== "ok") {
    return (
      <>
        <PageHeading title="Radar" intro="Your pre-market brief: the day, where SPY opens against your levels, and the names you trade." />
        <RadarSchedulePanel file={pipeline.file} now={pipeline.now} />
        <NoRadar status={result.status} date={date} />
      </>
    );
  }
  const r = result.edition;
  // The levels must be the ones built for this edition's session; the fixture pairs whatever it has.
  const opt = await loadOptions(r.edition_date);
  const options: OptionsEdition | null =
    opt.status === "ok" && (opt.source === "fixture" || opt.edition.session === r.edition_date) ? opt.edition : null;
  const trades: Trade[] = journal.status === "ok" ? journal.doc.trades : [];
  return (
    <>
      <PageHeading
        title="Radar"
        intro="Your pre-market brief: the day, where SPY opens against your levels, and the names you trade. Research only; nothing here is an order."
      />
      <RadarSchedulePanel file={pipeline.file} now={pipeline.now} />
      <EditionPicker dates={dates} current={r.edition_date} />
      <RadarEditionNotice editionDate={r.edition_date} now={now} live={!date} />
      <PaneBoundary name="The brief">
        <Brief r={r} options={options} trades={trades} />
      </PaneBoundary>
      <PaneBoundary name="Swing research">
        <SwingResearch r={r} trades={trades} />
      </PaneBoundary>
    </>
  );
}

function Brief({ r, options, trades }: { r: Radar; options: OptionsEdition | null; trades: Trade[] }) {
  const opt = new Map((options?.tickers ?? []).map((t) => [t.symbol, t]));
  const rad = new Map((r.tickers ?? []).map((t) => [t.symbol, t]));
  const names = trades.length > 0 ? yourNames(trades, r.edition_date) : [];
  const symbols = names.length > 0 ? names.map((n) => n.symbol) : ["SPY"];
  const later = laterPremarket(options, r.as_of);
  const reads = symbols.map((s) => openRead(s, opt.get(s), rad.get(s), later.get(s)));
  const spy = reads.find((o) => o.symbol === "SPY") ?? openRead("SPY", opt.get("SPY"), rad.get("SPY"), later.get("SPY"));
  const refreshed = later.size > 0 ? [...later.values()][0]!.asOf : null;
  const earnings = earningsOf(r, options);
  const verdict = dayVerdict(r, symbols, reads, earnings);
  const week = briefWeek(r, earnings, symbols);
  const vix = (r.gauges ?? []).find((g) => /\bvix\b/i.test(g.label));
  const vixJump = vixJumpPct(r);
  const inWeek = new Set(week.days.map((d) => d.date));
  return (
    <>
      <p className="text-muted-foreground -mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>
          {weekDate(r.edition_date)} · prices {r.prices_as_of ?? "not stated"} · published {sydney(r.as_of)} Sydney
          {refreshed ? ` · pre-market prices refreshed ${sydney(refreshed)} Sydney` : ""}
        </span>
        {r.report_url ? (
          <a href={r.report_url} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1">
            Full report <ArrowUpRight aria-hidden className="size-3" />
          </a>
        ) : null}
      </p>
      <VerdictPanel
        verdict={verdict}
        vix={vix?.value ?? null}
        vixChange={vixJump}
        spyMove={spy.move}
        regime={r.regime_word ?? null}
      />
      <OpenMapPanel read={spy} />
      <SessionPanel
        day={r.edition_date}
        record={trades.length > 0 ? sessionRecord(trades) : null}
        events={timedEvents(r)}
        halfDay={Boolean(opt.get("SPY")?.half_day)}
      />
      {names.length > 0 ? (
        <YourNamesPanel names={names} reads={reads} earnings={earnings.filter((e) => inWeek.has(e.date))} year={r.edition_date.slice(0, 4)} />
      ) : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <MoversPanel rows={movers(r, options)} />
        <WeekPanel days={week.days} later={week.later} today={r.edition_date} earningsKnown={earnings.length > 0} />
      </div>
    </>
  );
}

/** The radar's swing research, whole, one click away: the picks, the scorecard, every list, the notes. */
function SwingResearch({ r, trades }: { r: Radar; trades: Trade[] }) {
  const traded = new Set(trades.map((t) => t.symbol));
  const all = (r.tickers ?? []).map((t) => t.symbol);
  const never = trades.length > 0 ? all.filter((s) => !traded.has(s)).length : 0;
  return (
    <details className="group border-border rounded-xl border border-dashed p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Swing research: the radar&apos;s picks, lists and notes
        <span className="text-muted-foreground font-normal">
          {" "}
          · {all.length} names{never > 0 ? `, ${never} you have never traded` : ""}
        </span>
      </summary>
      <div className="mt-4 grid gap-5">
        <EditionPanel r={r} />
        <ScorePanel r={r} />
        <PicksPanel r={r} />
        <CalendarPanel r={r} />
        <AvoidPanel r={r} />
        {(r.lists ?? []).map((l) => (
          <WatchlistPanel key={l.name} r={r} name={l.name} note={l.note} />
        ))}
        <TickerCards r={r} />
        {r.footnote ? <p className="text-muted-foreground max-w-prose text-xs">{r.footnote}</p> : null}
      </div>
    </details>
  );
}
