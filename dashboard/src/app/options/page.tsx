import { PageHeading } from "@/components/page-heading";
import { BoardTable, EditionPanel, HowToRead, NoOptions, PaperPanel, RulesPanel, StructurePanel, TickerCards } from "@/components/options";
import { FocusScope, LiveQuotes } from "@/components/client/live-layer";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { OptionsGlance } from "@/components/client/options-glance";
import { EditionPicker } from "@/components/radar";
import { requestTime } from "@/lib/now";
import { listOptionsDates, loadOptions } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Options" };

export default async function OptionsPage({ searchParams }: { searchParams: Promise<{ d?: string | string[] }> }) {
  const raw = (await searchParams).d;
  const date = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  const [result, dates] = await Promise.all([loadOptions(date), listOptionsDates()]);
  const now = requestTime();
  return (
    <>
      <PageHeading
        title="Options"
        intro="Where each name sits against its support and resistance, rebuilt after every close. Research only; nothing here is an order."
      />
      {result.status !== "ok" ? (
        <NoOptions status={result.status} date={date} />
      ) : (
        <LiveQuotes symbols={result.edition.tickers.map((t) => t.symbol).join(",")} session={result.edition.session} enabled={!date}>
          <FocusScope>
            <EditionPicker dates={dates} current={result.edition.session} base="/options" />
            {/* Each pane sits behind its own boundary: one that cannot be drawn says so and the rest keep working. */}
            <div data-explain className="contents">
              <PaneBoundary name="Edition">
                <EditionPanel e={result.edition} now={now} />
              </PaneBoundary>
            </div>
            <PaneBoundary name="At a glance">
              <OptionsGlance tickers={result.edition.tickers} live={!date}>
                <BoardTable e={result.edition} />
              </OptionsGlance>
            </PaneBoundary>
            <PaneBoundary name="Close strength vs option price">
              <StructurePanel e={result.edition} />
            </PaneBoundary>
            <div data-explain className="contents">
              <PaneBoundary name="Entry rules">
                <RulesPanel e={result.edition} />
              </PaneBoundary>
            </div>
            <TickerCards e={result.edition} />
            <div data-explain className="contents">
              <PaneBoundary name="Paper scorecard">
                <PaperPanel e={result.edition} />
              </PaneBoundary>
              <PaneBoundary name="What the testing found">
                <HowToRead e={result.edition} />
              </PaneBoundary>
            </div>
          </FocusScope>
        </LiveQuotes>
      )}
    </>
  );
}
