import { PageHeading } from "@/components/page-heading";
import { BoardTable, EditionPanel, HowToRead, NoOptions, PaperPanel, RulesPanel, StructurePanel, TickerCards } from "@/components/options";
import { FocusScope, LiveQuotes } from "@/components/client/live-layer";
import { OptionsDesk } from "@/components/client/options-desk";
import { OptionsGlance } from "@/components/client/options-glance";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { EditionPicker } from "@/components/radar";
import { sydney, weekDate } from "@/lib/format";
import { requestTime } from "@/lib/now";
import { editionState, isDeskView, isHalfDay, viewForClock, type DeskPane, type Options } from "@/lib/options";
import { listOptionsDates, loadOptions, loadOptionsLive } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Options" };

const INTRO = "Where each name sits against its support and resistance, rebuilt after every close. Research only; nothing here is an order.";

/** The page as it was before the desk: one long column of panels. Kept at ?view=classic for one release. */
function ClassicOptions({ e, dates, date, now }: { e: Options; dates: string[]; date: string | undefined; now: Date }) {
  return (
    <>
      <PageHeading title="Options" intro={INTRO} />
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

type Params = Record<"d" | "view" | "s" | "pane", string | string[] | undefined>;

export default async function OptionsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const rawDate = one(sp.d);
  const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined;
  // The paper positions are a view of now, so an older edition is drawn without them.
  const [result, dates, positions] = await Promise.all([loadOptions(date), listOptionsDates(), date ? null : loadOptionsLive()]);
  const now = requestTime();
  if (result.status !== "ok") {
    return (
      <>
        <PageHeading title="Options" intro={INTRO} />
        <NoOptions status={result.status} date={date} />
      </>
    );
  }
  const e = result.edition;
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
            positions={positions?.status === "ok" ? positions.doc : null}
            stale={stale}
          />
        </PaneBoundary>
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs">
          <p className="max-w-prose">
            Levels for {weekDate(e.session)}, built from the {weekDate(e.built_from)} close. Source: {e.source ?? "not stated"}. Published{" "}
            {sydney(e.as_of)} Sydney. Research only; nothing here is an order.
          </p>
          <EditionPicker dates={dates} current={e.session} base="/options" />
        </div>
        <section aria-label="Evidence and paper record" className="grid gap-5 lg:grid-cols-2">
          <PaneBoundary name="Entry rules">
            <RulesPanel e={e} />
          </PaneBoundary>
          <PaneBoundary name="Paper scorecard">
            <PaperPanel e={e} />
          </PaneBoundary>
          <PaneBoundary name="Close strength vs option price">
            <StructurePanel e={e} />
          </PaneBoundary>
          <PaneBoundary name="What the testing found">
            <HowToRead e={e} />
          </PaneBoundary>
        </section>
      </LiveQuotes>
    </>
  );
}
