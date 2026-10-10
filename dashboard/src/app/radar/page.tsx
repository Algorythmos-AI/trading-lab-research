import { PageHeading } from "@/components/page-heading";
import {
  AvoidPanel,
  CalendarPanel,
  EditionPanel,
  EditionPicker,
  LinesPanel,
  NoRadar,
  PicksPanel,
  ScorePanel,
  TickerCards,
  WatchlistPanel,
} from "@/components/radar";
import { listRadarDates, loadRadar } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Radar" };

export default async function RadarPage({ searchParams }: { searchParams: Promise<{ d?: string | string[] }> }) {
  const raw = (await searchParams).d;
  const date = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  const [result, dates] = await Promise.all([loadRadar(date), listRadarDates()]);
  return (
    <>
      <PageHeading
        title="Radar"
        intro="The daily research radar: what each IBKR watchlist holds and why, the support and resistance levels, and the dated, sourced notes behind each name. Research only, published after each run; nothing here is an order."
      />
      {result.status !== "ok" ? (
        <NoRadar status={result.status} date={date} />
      ) : (
        <>
          <EditionPicker dates={dates} current={result.edition.edition_date} />
          <EditionPanel r={result.edition} />
          <ScorePanel r={result.edition} />
          <PicksPanel r={result.edition} />
          <LinesPanel r={result.edition} />
          <CalendarPanel r={result.edition} />
          <AvoidPanel r={result.edition} />
          <details className="group">
            <summary className="text-muted-foreground cursor-pointer text-sm">Every list as a table</summary>
            <div className="mt-4 grid gap-5">
              {(result.edition.lists ?? []).map((l) => (
                <WatchlistPanel key={l.name} r={result.edition} name={l.name} note={l.note} />
              ))}
            </div>
          </details>
          <TickerCards r={result.edition} />
          {result.edition.footnote ? <p className="text-muted-foreground max-w-prose text-xs">{result.edition.footnote}</p> : null}
        </>
      )}
    </>
  );
}
