// The Trades page under its heading: the jump bar, then four groups (Today, the record, history and the clone).
// Server-rendered. Apart from the page file so a test can render it and check every link in the bar has its target.
import {
  BreakdownPanel,
  CalendarPanel,
  CurvePanel,
  DayList,
  JournalFilters,
  JournalTiles,
  LessonsPanel,
  LossSizePanel,
  MoneyPanel,
  MonthsPanel,
  NoJournal,
  TodayPanel,
  TradesPanel,
} from "@/components/journal";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { Empty } from "@/components/empty";
import { ClonePanel } from "@/components/options-clone";
import { TradeRulesFor } from "@/components/trade-rules";
import { jumpLinks, TradesGroup, TradesJumpBar } from "@/components/trades-jump-bar";
import { Notice } from "@/components/ui/notice";
import { newYork } from "@/lib/format";
import { OWNER_FEES } from "@/lib/owner-positions";
import {
  contractLabel,
  filterHref,
  groupBy,
  journalStale,
  lessons,
  marketState,
  moneyView,
  parseFilter,
  readableJournal,
  sessionView,
  shortDay,
  skippedLine,
  yearsOf,
  type Filter,
  type JournalDoc,
} from "@/lib/journal";
import type { JournalResult, OptionsCloneResult } from "@/lib/snapshot";
import { tradesView, type TradesView } from "@/lib/trades-view";

type Query = Record<string, string | string[] | undefined>;

export function TradesBody({ result, clone, q, now }: { result: JournalResult; clone: OptionsCloneResult; q: Query; now: Date }) {
  return (
    <>
      {result.status !== "ok" ? (
        <>
          <TradesJumpBar links={jumpLinks({ journal: false })} />
          <NoJournal status={result.status} />
        </>
      ) : (
        <JournalBody doc={result.doc} q={q} now={now} />
      )}
      <TradesGroup group="clone" hideHeading intro="The paper bot that trades by your rules with its own paper money, apart from your own account.">
        {/* The clone's own pane, apart from the journal: it draws whether or not the journal is there, and a fault in
            it stays in it. */}
        <PaneBoundary name="The clone">
          <ClonePanel result={clone} />
        </PaneBoundary>
        {result.status === "ok" ? <JournalSource doc={readableJournal(result.doc).doc} /> : null}
      </TradesGroup>
    </>
  );
}

/** The view under the filters, worked out once per journal, filter and clock however many groups ask for it. */
const views = new WeakMap<JournalDoc, Map<string, TradesView>>();
function viewOf(doc: JournalDoc, filter: Filter, now: Date): TradesView {
  const key = `${filterHref(filter)}|${now.getTime()}`;
  let byKey = views.get(doc);
  if (!byKey) views.set(doc, (byKey = new Map()));
  let v = byKey.get(key);
  if (!v) byKey.set(key, (v = tradesView(doc, filter, now)));
  return v;
}

/** The money panel's view, or null without a money record. */
const moneyOf = (doc: JournalDoc) => (doc.money ? moneyView(doc.money, doc.trades.reduce((sum, t) => sum + t.pnl, 0)) : null);

/** What the jump bar needs; a fault here leaves the bar with the groups only, never the page down. */
function barLinks(doc: JournalDoc, filter: Filter, now: Date) {
  try {
    return jumpLinks({ journal: true, record: !viewOf(doc, filter, now).empty, money: moneyOf(doc) !== null });
  } catch {
    return jumpLinks({ journal: true });
  }
}

/**
 * The journal's three groups. Each group's panels sit behind a pane boundary of their own and work their figures out
 * inside it, so a fault in one leaves the others and the clone standing. The journal is read row by row first: a row
 * that cannot be read is left out and counted (readableJournal), and the record and the money panel say how many.
 */
export function JournalBody({ doc: raw, q, now }: { doc: JournalDoc; q: Query; now: Date }) {
  const filter = parseFilter(q);
  const { doc, skipped } = readableJournal(raw);
  const money = (() => {
    try {
      return moneyOf(doc) !== null;
    } catch {
      return true;
    }
  })();
  const empty = (() => {
    try {
      return viewOf(doc, filter, now).empty;
    } catch {
      return false;
    }
  })();
  return (
    <>
      <TradesJumpBar links={barLinks(doc, filter, now)} />
      <TradesGroup group="today" intro="Where you stand right now: the rules and the room left, then this session's trades as they close.">
        <PaneBoundary name="Today">
          <TodayGroup doc={doc} now={now} />
        </PaneBoundary>
      </TradesGroup>
      <TradesGroup group="record" intro="Every closed trade in the period, kind and ticker you pick here: the totals, loss size, patterns and the full list.">
        <PaneBoundary name="The record">
          <RecordGroup doc={doc} filter={filter} now={now} skipped={skipped} />
        </PaneBoundary>
      </TradesGroup>
      {!empty || money ? (
        <TradesGroup group="history" intro="The record laid out over time, and the money moved in and out of the account.">
          <PaneBoundary name="History">
            <HistoryGroup doc={doc} filter={filter} now={now} />
          </PaneBoundary>
        </TradesGroup>
      ) : null}
    </>
  );
}

function TodayGroup({ doc, now }: { doc: JournalDoc; now: Date }) {
  // Lots of one contract bought in pieces read as one holding at its average cost.
  const open = new Map<string, { label: string; qty: number; cost: number }>();
  for (const l of doc.open ?? []) {
    const label = contractLabel(l);
    const o = open.get(label) ?? { label, qty: 0, cost: 0 };
    o.qty += l.qty;
    o.cost += l.qty * l.entry;
    open.set(label, o);
  }
  const session = sessionView(doc, now);
  return (
    <>
      {journalStale(doc, now) ? (
        <Notice tone="warn" size="sm" role="status">
          This journal was last read from the broker on {newYork(doc.as_of)} New York time. Trades since then are not in it yet.
        </Notice>
      ) : null}
      <TradeRulesFor doc={doc} now={now} />
      {session ? <TodayPanel view={session} asOf={doc.as_of} now={now} market={marketState(now)} feesIncluded={doc.fees_included} /> : null}
      {open.size > 0 ? (
        <p className="text-muted-foreground max-w-prose text-xs">
          Still open, at average cost:{" "}
          {[...open.values()].map((o) => `${o.qty.toLocaleString("en-US")} × ${o.label} at ${(o.cost / o.qty).toFixed(2)}`).join("; ")}.
        </p>
      ) : null}
    </>
  );
}

function RecordGroup({ doc, filter, now, skipped }: { doc: JournalDoc; filter: Filter; now: Date; skipped: number }) {
  const all = doc.trades;
  // Money figures add up the pieces sold in the view, after fees, each on its own close day; per-trade figures count
  // each trade once, a position for options, on the day it finished (see `tradesView`).
  const { trades, units: shown, positions, pieces, days, s, gross, fees, empty } = viewOf(doc, filter, now);
  // The tickers worth a chip: the twelve most traded, plus the one in the address.
  const symbols = groupBy(all, (t) => t.symbol)
    .sort((a, b) => b.trades - a.trades)
    .slice(0, 12)
    .map((g) => g.key);
  if (filter.symbol && !symbols.includes(filter.symbol)) symbols.push(filter.symbol);
  const unread = skippedLine(skipped);
  return (
    <>
      <JournalFilters filter={filter} years={yearsOf(all)} symbols={symbols.sort()} />
      {unread ? (
        <p data-journal-skipped={skipped} className="text-warn text-xs font-medium">
          {unread}
        </p>
      ) : null}
      {empty ? (
        <Empty title="No trades in this view">Pick another period, ticker or kind.</Empty>
      ) : (
        <>
          <JournalTiles s={s} gross={gross} fees={fees} />
          <LossSizePanel positions={positions} feesIncluded={fees.included} />
          <LessonsPanel lessons={lessons(trades)} feesIncluded={fees.included} />
          <CurvePanel days={days} feesIncluded={fees.included} />
          <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <MonthsPanel trades={pieces} feesIncluded={fees.included} />
            <DayList days={days} feesIncluded={fees.included} />
          </div>
          <BreakdownPanel trades={trades} feesIncluded={fees.included} />
          <TradesPanel units={shown} feesIncluded={fees.included} />
        </>
      )}
    </>
  );
}

function HistoryGroup({ doc, filter, now }: { doc: JournalDoc; filter: Filter; now: Date }) {
  const { days, fees, empty } = viewOf(doc, filter, now);
  const money = moneyOf(doc);
  const unread = money ? skippedLine(money.skipped) : null;
  return (
    <>
      {!empty ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground text-xs">The calendar follows the period, kind and ticker picked above.</p>
          <CalendarPanel days={days} feesIncluded={fees.included} />
        </div>
      ) : null}
      {money ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground text-xs">
            Money in and out covers the whole account, so the picks above do not apply to it. What the account is worth is the broker&apos;s own figure, after
            everything it was charged; only the closed-trades total quoted under the chart is before fees.
          </p>
          {unread ? (
            <p data-money-skipped={money.skipped} className="text-warn text-xs font-medium">
              {unread}
            </p>
          ) : null}
          <MoneyPanel m={money} />
        </div>
      ) : null}
    </>
  );
}

/** Where the journal came from and how it is counted: the page's footnote, under the clone. */
function JournalSource({ doc }: { doc: JournalDoc }) {
  // Gaps of one symbol on one day read as one.
  const gaps = new Map<string, number>();
  for (const g of doc.gaps ?? []) gaps.set(`${g.symbol} on ${shortDay(g.date)}`, (gaps.get(`${g.symbol} on ${shortDay(g.date)}`) ?? 0) + 1);
  const gapCount = (doc.gaps ?? []).length;
  return (
    <p className="text-muted-foreground max-w-prose text-xs">
      Read from the broker ({doc.source === "webull-au" ? "Webull Australia" : doc.source}) on {newYork(doc.as_of)} New York time
      {doc.history_from ? `, history from ${shortDay(doc.history_from)}` : ""}. {doc.fills ? `${doc.fills.toLocaleString("en-US")} filled orders were matched first in, first out. ` : ""}
      Results are in US dollars.{" "}
      {doc.fees_included === true
        ? "The broker's results already carry its fees."
        : `${doc.fees_included === false ? "The broker's history carries no commissions or fees" : "The broker's history is not known to include commissions or fees"}, so the trades above take off an estimate of your Webull fees per option contract: today's rates ($${OWNER_FEES.openPerContract.toFixed(2)} in, $${OWNER_FEES.closePerContract.toFixed(2)} out a contract) applied to every year, and older years may have differed. The day loss limit reads the result before fees.`}{" "}
      Days are New York trading days.
      {gapCount > 0
        ? ` ${gapCount} close${gapCount === 1 ? "" : "s"} had no matching open in the broker's history (${[...gaps]
            .slice(0, 4)
            .map(([where, n]) => (n > 1 ? `${n} on ${where}` : where))
            .join(", ")}${gaps.size > 4 ? ", …" : ""}); each is counted as its whole credit.`
        : ""}
    </p>
  );
}
