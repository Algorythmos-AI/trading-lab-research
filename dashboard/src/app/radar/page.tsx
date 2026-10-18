import { PageHeading } from "@/components/page-heading";
import {
  AvoidPanel,
  EditionPanel,
  EditionPicker,
  NoRadar,
  PicksPanel,
  ScorePanel,
  TickerCards,
  WatchlistPanel,
} from "@/components/radar";
import { LevelMap, MegaMovers, SessionRecord, VerdictPanel, WeekAhead, YourNames } from "@/components/radar-brief";
import { Notice } from "@/components/ui/notice";
import { weekDate } from "@/lib/format";
import type { Options } from "@/lib/options";
import { radarStale, type Radar } from "@/lib/radar";
import {
  dayVerdict,
  hasEarningsData,
  levelLadder,
  matchingOptions,
  megaMovers,
  nameRows,
  vixChangePct,
  windowRecord,
  yourNames,
} from "@/lib/radar-brief";
import { listRadarDates, loadJournal, loadOptions, loadRadar, pageTime, type JournalResult, type OptionsResult } from "@/lib/snapshot";

/**
 * The options edition for the radar's session. The newest one is for the next session once a close has been
 * built, so when it does not match the radar the dated copy for the radar's day is tried before giving up.
 */
async function optionsFor(r: Radar, first: OptionsResult): Promise<Options | null> {
  const o = first.status === "ok" ? first.edition : null;
  if (matchingOptions(r, o)) return o;
  const dated = await loadOptions(r.edition_date);
  return dated.status === "ok" ? (matchingOptions(r, dated.edition) ?? o) : o;
}

/** The SPY pre-market brief above the swing research. Each source can be missing without breaking the others. */
async function Brief({ r, optionsFirst, journal, now }: { r: Radar; optionsFirst: OptionsResult; journal: JournalResult; now: Date }) {
  const options = await optionsFor(r, optionsFirst);
  const j = journal.status === "ok" ? journal.doc : null;
  const names = yourNames(j, now);
  const symbols = names.map((n) => n.key);
  const verdict = dayVerdict(r, options, symbols);
  const vixGauge = (r.gauges ?? []).find((g) => /^vix\b/i.test(g.label.trim()));
  const vixPct = vixChangePct(r.gauges);
  const vix = vixGauge?.value ? `${vixGauge.value}${vixPct !== null ? ` (${vixPct > 0 ? "+" : vixPct < 0 ? "−" : ""}${Math.abs(vixPct).toFixed(1)}%)` : ""}` : null;
  const spyOpt = options?.tickers.find((t) => t.symbol === "SPY");
  const spyPre = (r.tickers ?? []).find((t) => t.symbol === "SPY")?.premarket_price;
  const current = matchingOptions(r, options) !== null;
  const earningsKnown = hasEarningsData(r);
  return (
    <>
      <VerdictPanel v={verdict} regime={r.regime_word} vix={vix} />
      <LevelMap symbol="SPY" lad={spyOpt ? levelLadder(spyOpt, current ? spyPre : null) : null} session={options?.session ?? null} current={current} />
      <div className="grid gap-5 lg:grid-cols-2">
        <SessionRecord rec={j ? windowRecord(j, now) : null} />
        <MegaMovers movers={megaMovers(r)} />
      </div>
      <YourNames rows={nameRows(r, options, names)} journal={j !== null} earningsKnown={earningsKnown} />
      <WeekAhead r={r} earningsKnown={earningsKnown} />
    </>
  );
}

export const dynamic = "force-dynamic";
export const metadata = { title: "Radar" };

export default async function RadarPage({ searchParams }: { searchParams: Promise<{ d?: string | string[] }> }) {
  const raw = (await searchParams).d;
  const date = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  const [result, dates, now, optionsFirst, journal] = await Promise.all([loadRadar(date), listRadarDates(), pageTime(), loadOptions(date), loadJournal()]);
  return (
    <>
      <PageHeading
        title="Radar"
        intro="The pre-market brief: what kind of day it is, where SPY opens against its levels, and the names you trade. The swing research sits in the drawer below. Research only, published after each run; nothing here is an order."
      />
      {result.status !== "ok" ? (
        <NoRadar status={result.status} date={date} />
      ) : (
        <>
          <EditionPicker dates={dates} current={result.edition.edition_date} />
          {!date && radarStale(result.edition.edition_date, now) ? (
            <Notice tone="bad" size="sm" role="alert">
              This radar is from {weekDate(result.edition.edition_date)}. Today&apos;s session has opened and no newer edition has
              published (or the market is shut for a holiday), so its levels and notes may be out of date.
            </Notice>
          ) : null}
          <Brief r={result.edition} optionsFirst={optionsFirst} journal={journal} now={now} />
          <details className="group" id="swing">
            <summary className="text-muted-foreground cursor-pointer text-sm font-medium">
              Swing research: the radar&apos;s picks, lists, scorecard and notes
            </summary>
            <div className="mt-4 grid gap-5">
              <EditionPanel r={result.edition} />
              <ScorePanel r={result.edition} />
              <PicksPanel r={result.edition} />
              <AvoidPanel r={result.edition} />
              {(result.edition.lists ?? []).map((l) => (
                <WatchlistPanel key={l.name} r={result.edition} name={l.name} note={l.note} />
              ))}
              <TickerCards r={result.edition} />
            </div>
          </details>
          {result.edition.footnote ? <p className="text-muted-foreground max-w-prose text-xs">{result.edition.footnote}</p> : null}
        </>
      )}
    </>
  );
}
