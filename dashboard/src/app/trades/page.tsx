import {
  BreakdownPanel,
  CalendarPanel,
  CurvePanel,
  DayList,
  JournalFilters,
  JournalTiles,
  LessonsPanel,
  MonthsPanel,
  NoJournal,
  TradesPanel,
} from "@/components/journal";
import { Empty } from "@/components/empty";
import { PageHeading } from "@/components/page-heading";
import { Notice } from "@/components/ui/notice";
import { newYork } from "@/lib/format";
import { applyFilter, contractLabel, daily, groupBy, journalStale, lessons, parseFilter, summarize, yearsOf, type JournalDoc } from "@/lib/journal";
import { loadJournal, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trades" };

export default async function TradesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [q, result, now] = await Promise.all([searchParams, loadJournal(), pageTime()]);
  return (
    <>
      <PageHeading
        title="Trades"
        intro="Every trade from your own brokerage account, past and new: what each one made or lost, where the money was made and lost, and the patterns worth learning from. A record only; nothing here can trade."
      />
      {result.status !== "ok" ? (
        <NoJournal status={result.status} />
      ) : (
        <JournalBody doc={result.doc} q={q} now={now} />
      )}
    </>
  );
}

function JournalBody({ doc, q, now }: { doc: JournalDoc; q: Record<string, string | string[] | undefined>; now: Date }) {
  const filter = parseFilter(q);
  const all = doc.trades;
  const trades = applyFilter(all, filter, now);
  const s = summarize(trades);
  const days = daily(trades);
  // The tickers worth a chip: the twelve most traded, plus the one in the address.
  const symbols = groupBy(all, (t) => t.symbol)
    .sort((a, b) => b.trades - a.trades)
    .slice(0, 12)
    .map((g) => g.key);
  if (filter.symbol && !symbols.includes(filter.symbol)) symbols.push(filter.symbol);
  const gaps = doc.gaps ?? [];
  return (
    <>
      {journalStale(doc, now) ? (
        <Notice tone="warn" size="sm" role="status">
          This journal was last read from the broker on {newYork(doc.as_of)} New York time. Trades since then are not in it yet.
        </Notice>
      ) : null}
      <JournalFilters filter={filter} years={yearsOf(all)} symbols={symbols.sort()} />
      {trades.length === 0 ? (
        <Empty title="No trades in this view">Pick another period, ticker or kind.</Empty>
      ) : (
        <>
          <JournalTiles s={s} />
          <CurvePanel days={days} />
          <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <MonthsPanel trades={trades} />
            <DayList days={days} />
          </div>
          <CalendarPanel days={days} />
          <LessonsPanel lessons={lessons(trades)} />
          <BreakdownPanel trades={trades} />
          <TradesPanel trades={trades} />
        </>
      )}
      {(doc.open ?? []).length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Still open, at cost: {(doc.open ?? []).map((l) => `${l.qty.toLocaleString("en-US")} × ${contractLabel(l)} at ${l.entry.toFixed(2)}`).join("; ")}.
        </p>
      ) : null}
      <p className="text-muted-foreground max-w-prose text-xs">
        Read from the broker ({doc.source === "webull-au" ? "Webull Australia" : doc.source}) on {newYork(doc.as_of)} New York time
        {doc.history_from ? `, history from ${doc.history_from}` : ""}. {doc.fills ? `${doc.fills.toLocaleString("en-US")} filled orders were matched first in, first out. ` : ""}
        Results are in US dollars{doc.fees_included === false ? " and before commissions and fees, which the broker's history does not carry" : ""}. Days are New York trading days.
        {gaps.length > 0
          ? ` ${gaps.length} close${gaps.length === 1 ? "" : "s"} had no matching open in the broker's history (${gaps
              .slice(0, 4)
              .map((g) => `${g.symbol} on ${g.date}`)
              .join(", ")}${gaps.length > 4 ? ", …" : ""}); each is counted as its whole credit.`
          : ""}
      </p>
    </>
  );
}
