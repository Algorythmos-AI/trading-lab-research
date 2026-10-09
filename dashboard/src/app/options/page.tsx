import { PageHeading } from "@/components/page-heading";
import { BoardPanel, EditionPanel, HowToRead, NoOptions, PaperPanel, RulesPanel, TickerCards } from "@/components/options";
import { OptionsLive } from "@/components/client/options-live";
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
        intro="Support and resistance for calls and puts: yesterday's, last week's and last month's highs and lows, the 52-week range, the key averages and supply and demand zones, rebuilt after every close for the next session. Research only; nothing here is an order."
      />
      {result.status !== "ok" ? (
        <NoOptions status={result.status} date={date} />
      ) : (
        <>
          <EditionPicker dates={dates} current={result.edition.session} base="/options" />
          <EditionPanel e={result.edition} now={now} />
          {!date ? (
            <OptionsLive tickers={result.edition.tickers} session={result.edition.session} />
          ) : null}
          <BoardPanel e={result.edition} />
          <RulesPanel e={result.edition} />
          <TickerCards e={result.edition} />
          <PaperPanel e={result.edition} />
          <HowToRead e={result.edition} />
        </>
      )}
    </>
  );
}
