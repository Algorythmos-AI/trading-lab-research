import { PageHeading } from "@/components/page-heading";
import { TradeRulesFor } from "@/components/trade-rules";
import { BoardTable, EditionPanel, HowToRead, NoOptions, PaperPanel, RulesPanel, StructurePanel, TickerCards } from "@/components/options";
import { FocusScope, LiveQuotes } from "@/components/client/live-layer";
import { DayBar, FocusStrip, focusOnly } from "@/components/options-focus";
import { OptionsDesk } from "@/components/client/options-desk";
import { OptionsGlance } from "@/components/client/options-glance";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { EditionPicker } from "@/components/radar";
import { Notice } from "@/components/ui/notice";
import { sydney, weekDate } from "@/lib/format";
import { hourlyBySymbol } from "@/lib/hourly";
import { interestBySymbol } from "@/lib/oi";
import { builtFromOld, editionState, isDeskView, isHalfDay, mapView, viewForClock, type DeskPane, type Options } from "@/lib/options";
import { listOptionsDates, loadJournal, loadOptions, loadOptionsLive, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Options" };

const INTRO = "Where each name sits against its support and resistance, rebuilt after every close. Research only; nothing here is an order.";

/** Levels built from a close more than a weekend behind their session: a day's bars never arrived. */
function OldCloseNotice({ e }: { e: Options }) {
  if (!builtFromOld(e.session, e.built_from)) return null;
  return (
    <Notice tone="bad" size="sm" role="alert">
      These levels for {weekDate(e.session)} were built from the {weekDate(e.built_from)} close, more than a weekend earlier. A
      day&apos;s bars are missing, so check them before use.
    </Notice>
  );
}

/** The page as it was before the desk: one long column of panels. Kept at ?view=classic for one release. */
function ClassicOptions({ e, dates, date, now }: { e: Options; dates: string[]; date: string | undefined; now: Date }) {
  return (
    <>
      <PageHeading title="Options" intro={INTRO} />
      <OldCloseNotice e={e} />
      <LiveQuotes symbols={e.tickers.map((t) => t.symbol).join(",")} session={e.session} enabled={!date}>
        <FocusScope>
          <EditionPicker dates={dates} current={e.session} base="/options" />
          {/* Each pane sits behind its own boundary: one that cannot be drawn says so and the rest keep working. */}
          <div data-explain className="contents">
            <PaneBoundary name="Edition">
              <EditionPanel e={e} now={now} />
            </PaneBoundary>
          </div>
          <PaneBoundary name="At a glance">
            <OptionsGlance tickers={e.tickers} live={!date}>
              <BoardTable e={e} />
            </OptionsGlance>
          </PaneBoundary>
          <PaneBoundary name="Close strength vs option price">
            <StructurePanel e={e} />
          </PaneBoundary>
          <div data-explain className="contents">
            <PaneBoundary name="Entry rules">
              <RulesPanel e={e} />
            </PaneBoundary>
          </div>
          <TickerCards e={e} />
          <div data-explain className="contents">
            <PaneBoundary name="Paper scorecard">
              <PaperPanel e={e} />
            </PaneBoundary>
            <PaneBoundary name="What the testing found">
              <HowToRead e={e} />
            </PaneBoundary>
          </div>
        </FocusScope>
      </LiveQuotes>
    </>
  );
}

type Params = Record<"d" | "view" | "s" | "pane" | "all", string | string[] | undefined>;

export default async function OptionsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const rawDate = one(sp.d);
  const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined;
  // The paper positions are a view of now, so an older edition is drawn without them.
  const [result, dates, positions, journal] = await Promise.all([loadOptions(date), listOptionsDates(), date ? null : loadOptionsLive(), loadJournal()]);
  const now = await pageTime();
  const live = positions?.status === "ok" ? positions.doc : null;
  if (result.status !== "ok") {
    return (
      <>
        <PageHeading title="Options" intro={INTRO} />
        <NoOptions status={result.status} date={date} />
      </>
    );
  }
  const full = result.edition;
  // While trading the desk shows only the focus names; ?all=1 brings back the whole board.
  const showAll = one(sp.all) === "1";
  const e = showAll ? full : focusOnly(full);
  const viewParam = one(sp.view);
  if (viewParam === "classic") return <ClassicOptions e={e} dates={dates} date={date} now={now} />;

  // The view and the selected name come from the address when it names them; otherwise the view follows the New
  // York clock (an older edition opens on its review) and the first name is selected.
  const manualView = isDeskView(viewParam);
  const initialView = manualView ? viewParam : date ? "review" : viewForClock(e.session, isHalfDay(e), now);
  const wanted = one(sp.s)?.toUpperCase();
  const initialSymbol = e.tickers.find((t) => t.symbol === wanted)?.symbol ?? e.tickers[0]?.symbol ?? null;
  // Only a phone shows one pane at a time; the address remembers which, so a reload lands on the same one.
  const initialPane: DeskPane = one(sp.pane) === "name" ? "name" : "names";
  const stale = !date && editionState(e.session, now) === "stale";

  return (
    <>
      <h1 className="sr-only">Options</h1>
      <OldCloseNotice e={e} />
      {/* Top of the trading screen: the few names to watch, then the desk; the day's limits sit straight under it. */}
      <PaneBoundary name="Today's focus">
        <FocusStrip e={full} />
      </PaneBoundary>
      <LiveQuotes symbols={e.tickers.map((t) => t.symbol).join(",")} session={e.session} enabled={!date}>
        <PaneBoundary name="The options desk">
          {/* Keyed by edition: opening another edition starts the desk afresh, so a view or a sort chosen on one
              never carries over to another. */}
          <OptionsDesk
            key={`${e.session}:${date ?? "latest"}`}
            e={e}
            live={!date}
            initialView={initialView}
            manualView={manualView}
            initialSymbol={initialSymbol}
            initialPane={initialPane}
            // The pane needs the positions; the map needs a handful of marks. The contract-by-contract open interest
            // (over 100 KB) stays on the server.
            positions={live ? { ...live, open_interest: null, hourly: null } : null}
            interest={interestBySymbol(live, now.getTime(), (s) => {
              const t = e.tickers.find((x) => x.symbol === s);
              return t ? mapView(t) : null;
            })}
            hourly={hourlyBySymbol(live, e.tickers.map((t) => t.symbol), now.getTime())}
            stale={stale}
          />
        </PaneBoundary>
        <DayBar doc={journal.status === "ok" ? journal.doc : null} now={now} session={e.session} />
        {full.focus?.items.length ? (
          <p className="text-xs">
            <a className="text-muted-foreground hover:text-foreground underline" href={showAll ? "/options" : "/options?all=1"}>
              {showAll ? "Show only the focus names" : `Show all ${full.tickers.length} names`}
            </a>
          </p>
        ) : null}
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs">
          <p className="max-w-prose">
            Levels for {weekDate(e.session)}, built from the {weekDate(e.built_from)} close. Source: {e.source ?? "not stated"}. Published{" "}
            {sydney(e.as_of)} Sydney. Research only; nothing here is an order.
          </p>
          <EditionPicker dates={dates} current={e.session} base="/options" />
        </div>
        {/* Straight under the desk: the desk is built to fill one laptop screen, so nothing may sit above it. */}
        {/* Folded: the day's limits already sit at the top; the full rules and their evidence are one click away. */}
        <details className="rounded-lg border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Rules before every trade (9)</summary>
          <div className="p-2">
            <TradeRulesFor doc={journal.status === "ok" ? journal.doc : null} now={now} />
          </div>
        </details>
        <details className="rounded-lg border">
          <summary className="text-muted-foreground cursor-pointer px-4 py-3 text-sm">
            <span className="text-foreground font-semibold">Research and evidence</span> · entry rules on probation, paper scorecard, close strength,
            what the testing found. Not needed to trade.
          </summary>
          <section aria-label="Evidence and paper record" className="grid gap-5 p-4 pt-0 lg:grid-cols-2">
          <PaneBoundary name="Entry rules">
            <RulesPanel e={full} />
          </PaneBoundary>
          <PaneBoundary name="Paper scorecard">
            <PaperPanel e={full} />
          </PaneBoundary>
          <PaneBoundary name="Close strength vs option price">
            <StructurePanel e={full} />
          </PaneBoundary>
          <PaneBoundary name="What the testing found">
            <HowToRead e={full} />
          </PaneBoundary>
          </section>
        </details>
      </LiveQuotes>
    </>
  );
}
