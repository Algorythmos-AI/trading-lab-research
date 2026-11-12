import Link from "next/link";
import { PageHeading } from "@/components/page-heading";
import { TradeRulesFor } from "@/components/trade-rules";
import { BoardTable, EditionPanel, HowToRead, NoOptions, PaperPanel, RulesPanel, StructurePanel, TickerCards } from "@/components/options";
import { FocusScope, LiveQuotes } from "@/components/client/live-layer";
import { BoardProvider, TradeNow, TradeNowNotices } from "@/components/client/trade-now";
import { DoneTodayProvider } from "@/components/client/done-today";
import { DrawingGuide, FocusStrip, focusOnly, RulesStrip } from "@/components/options-focus";
import { LadderMini, LevelLadder } from "@/components/level-ladder";
import { CockpitLadders, CockpitShell } from "@/components/client/cockpit";
import { BoardChip, FocusGlance, GlanceTile } from "@/components/client/focus-glance";
import { NowHero } from "@/components/client/now-hero";
import { StatusRail } from "@/components/client/status-rail";
import { FeedStrip } from "@/components/client/feed-strip";
import { LedgerReview } from "@/components/ledger";
import { OptionsDesk } from "@/components/client/options-desk";
import { OptionsGlance } from "@/components/client/options-glance";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { EditionPicker } from "@/components/radar";
import { OldCloseNotice } from "@/components/old-close-notice";
import { sydney, weekDate } from "@/lib/format";
import { hourlyBySymbol } from "@/lib/hourly";
import { interestBySymbol } from "@/lib/oi";
import { builtFromWords, editionState, isDeskView, isHalfDay, mapView, viewForClock, type DeskPane, type Options } from "@/lib/options";
import { showReview } from "@/lib/ledger";
import { withLeaders } from "@/lib/entry-checks";
import { boardDay } from "@/lib/trade-now";
import { readableJournal, sessionView } from "@/lib/journal";
import { dayJournal } from "@/lib/manage-stop";
import { dayFacts, railDay, unreadLine, withUnread } from "@/lib/session-timeline";
import { dayCheck } from "@/lib/trade-rules";
import { loadFlagsView } from "@/lib/desk-flags-run";
import { loadGuardSwitches } from "@/lib/desk-guards-run";
import { loadEvalSwitch } from "@/lib/desk-page-run";
import { loadPageFeeds } from "@/lib/feed-watch-run";
import { STRIP_FEED_IDS } from "@/lib/feed-watch";
import { JOURNAL_PATHS, OPTIONS_PATHS } from "@/lib/desk";
import { listOptionsDates, loadJournal, loadLedger, loadOptions, loadOptionsLive, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Options" };

const INTRO = "Where each name sits against its support and resistance, rebuilt after every close. Research only; nothing here is an order.";

/** The page as it was before the desk: one long column of panels. Kept at ?view=classic for one release. */
function ClassicOptions({ e, dates, date, now }: { e: Options; dates: string[]; date: string | undefined; now: Date }) {
  return (
    <>
      <PageHeading title="Options" intro={INTRO} />
      <OldCloseNotice e={e} />
      <LiveQuotes symbols={withLeaders(e.tickers.map((t) => t.symbol)).join(",")} session={e.session} enabled={!date}>
        <FocusScope>
          <EditionPicker dates={dates} current={e.session} base="/options" />
          {/* Each pane sits behind its own boundary: one that cannot be drawn says so and the rest keep working. */}
          <div data-explain className="contents">
            <PaneBoundary name="Edition">
              <EditionPanel e={e} now={now} />
            </PaneBoundary>
          </div>
          <PaneBoundary name="At a glance">
            <OptionsGlance tickers={e.tickers} live={!date} focus={e.focus ?? null}>
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
  // The owner's "done for today" flag, read with the page for a live edition (null when it could not be read).
  // The server's shadow check's switch (DEC-0044): off unless the store says "log"; while off the page asks nothing about it.
  // The bad-data guards' switches (desk/guards.json): every guard off unless the store turns it on; none for an older edition.
  const [result, dates, positions, journal, ledger, flags, evalSwitch, guardSwitches] = await Promise.all([loadOptions(date), listOptionsDates(), date ? null : loadOptionsLive(), loadJournal(), date ? null : loadLedger(), date ? null : loadFlagsView(), date ? "off" : loadEvalSwitch(), date ? null : loadGuardSwitches()]);
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
  // The feed health strip's server-known feeds, from the documents read above (a past edition has no strip).
  const feeds = date
    ? null
    : await loadPageFeeds({ ids: STRIP_FEED_IDS, loaded: { [OPTIONS_PATHS.latest]: result, [JOURNAL_PATHS.latest]: journal } }, now);
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
  // Only the rows that can be read: one written wrong is left out rather than thrown on (readableJournal), so it can
  // never take the board down.
  const read = journal.status === "ok" ? readableJournal(journal.doc) : null;
  const doc = read?.doc ?? null;
  // Rows left out can hide a trade or a loss from today's count: the day is then not judged (no room, no trades left),
  // and the rail says why.
  const skipped = read?.skipped ?? 0;
  // The board's day: rules 7 and 8 from the journal, and whether a trade has closed green today.
  const day = boardDay(doc, now);
  // The rail's short day line, from the same check as the rules (the day bar it replaces).
  const check = withUnread(dayCheck(doc ? sessionView(doc, now) : null, { asOf: doc?.as_of ?? null, now }), skipped);
  const rail = { ...railDay(check), unread: unreadLine(skipped) };
  // What the browser needs to count its own notes and to say the room after a stop; null without a journal.
  const facts = doc ? dayFacts(check, doc.as_of, now, doc.open ?? []) : null;
  const halfDay = isHalfDay(full);
  // The four focus names, in the card's order: the glance, and the cockpit's large ladders.
  const four = [...(full.focus?.items ?? [])].sort((a, b) => a.rank - b.rank).slice(0, 4);
  const pre = (s: string) => full.focus?.premarket?.items.find((p) => p.symbol === s)?.price ?? null;
  const tick = (s: string) => full.tickers.find((t) => t.symbol === s);
  // The browser gets the session's own closed pieces and the open lots, never the whole history: the board renders
  // every second, and everything that needs the history (the day's rules, the room, the rail) is worked out above.
  const board = doc ? dayJournal(doc.trades, doc.open, full.session) : null;
  const review = ledger?.status === "ok" && showReview(now, ledger.edition.session, full.session) ? ledger.edition : null;

  return (
    <>
      <h1 className="sr-only">Options</h1>
      <LiveQuotes symbols={withLeaders(e.tickers.map((t) => t.symbol)).join(",")} session={e.session} enabled={!date}>
        <DoneTodayProvider initial={flags}>
          <BoardProvider e={full} live={!date} {...day} openLots={board?.lots ?? []} closedTrades={board?.closed ?? []} journalAsOf={doc?.as_of ?? null} dayFacts={facts} evalOn={evalSwitch === "log"} guardsOn={guardSwitches?.on ?? []} guardsRead={guardSwitches?.status ?? "missing"}>
            {/* Top to bottom: what the day allows and the clock, the one name that matters now, the four at a glance, what
                to act on, the cards, the rules strip, then the desk. Cockpit keeps only the rail, the hero and the four
                ladders (everything else carries data-cockpit-hide). The parts share the page's one live feed and board. */}
            <CockpitShell>
              <PaneBoundary name="Status rail">
                <StatusRail day={rail} facts={facts} />
              </PaneBoundary>
              {feeds ? (
                <PaneBoundary name="Feed health">
                  <FeedStrip stamps={feeds} serverNow={now.getTime()} evalOn={evalSwitch === "log"} />
                  {/* Which feed is authoritative and how the feeds compared (DEC-0050): its own page. */}
                  <p data-feeds-link className="-mt-1 text-right text-xs">
                    <Link className="text-muted-foreground hover:text-foreground underline" href="/options/feeds">
                      Feeds
                    </Link>
                  </p>
                </PaneBoundary>
              ) : null}
              <div data-cockpit-hide className="contents">
                <OldCloseNotice e={e} />
              </div>
              <PaneBoundary name="Now">
                <NowHero room={rail.room} />
              </PaneBoundary>
              {four.length ? (
                <PaneBoundary name="Cockpit ladders">
                  <CockpitLadders>
                    {four.map((i) => (
                      <div key={i.symbol} className="bg-card grid content-start gap-2 rounded-lg border p-3">
                        <p className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-price font-mono">{i.symbol}</span>
                          <BoardChip symbol={i.symbol} />
                        </p>
                        <LevelLadder item={i} ticker={tick(i.symbol)} session={full.session} halfDay={halfDay} closeDate={full.built_from ?? null} premarket={pre(i.symbol)} size="desktop" live={!date} idScope="cockpit" />
                      </div>
                    ))}
                  </CockpitLadders>
                </PaneBoundary>
              ) : null}
              <div data-cockpit-hide className="contents">
                {four.length && !date ? (
                  <PaneBoundary name="At a glance">
                    <FocusGlance>
                      {four.map((i) => (
                        <GlanceTile key={i.symbol} symbol={i.symbol}>
                          <LadderMini item={i} ticker={tick(i.symbol)} session={full.session} halfDay={halfDay} closeDate={full.built_from ?? null} premarket={pre(i.symbol)} />
                        </GlanceTile>
                      ))}
                    </FocusGlance>
                  </PaneBoundary>
                ) : null}
                <PaneBoundary name="Trade now">
                  <TradeNow />
                </PaneBoundary>
              </div>
              {/* The notices (an entry, SELL HALF, EXIT) and the spoken line sit outside the cockpit's hidden parts: the
                  cockpit hides the board, never what tells the owner a state has changed. Drawn once, straight under the
                  board, so on a phone they follow it in the page's flow. */}
              <PaneBoundary name="Trade now notices">
                <TradeNowNotices />
              </PaneBoundary>
              <div data-cockpit-hide className="contents">
                <PaneBoundary name="Today's focus">
                  <FocusStrip e={full} />
                </PaneBoundary>
                <PaneBoundary name="Rules strip">
                  <RulesStrip session={full.session} halfDay={halfDay} />
                </PaneBoundary>
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
                {full.focus?.items.length ? (
                  <p className="text-xs">
                    <a className="text-muted-foreground hover:text-foreground underline" href={showAll ? "/options" : "/options?all=1"}>
                      {showAll ? "Show only the focus names" : `Show all ${full.tickers.length} names`}
                    </a>
                  </p>
                ) : null}
                <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs">
                  <p className="max-w-prose">
                    Levels for {weekDate(e.session)}, built from {builtFromWords(e.built_from)}. Source: {e.source ?? "not stated"}. Published{" "}
                    {sydney(e.as_of)} Sydney. Research only; nothing here is an order.
                  </p>
                  <EditionPicker dates={dates} current={e.session} base="/options" />
                </div>
                {/* Folded at the bottom: the last scored card's review (outside market hours only), the drawing guide, the
                    9 rules and the research behind them. None is needed to trade. */}
                {/* Outside market hours, with the last card's review: the owner's own day against his rules. */}
                {review ? (
                  <p className="text-xs">
                    <a className="text-muted-foreground hover:text-foreground underline" href="/review">
                      Day review: your last day against your rules
                    </a>
                  </p>
                ) : null}
                {review ? (
                  <details className="rounded-lg border" data-review-fold>
                    <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Yesterday&apos;s review · how the card did</summary>
                    <div className="p-2">
                      <PaneBoundary name="How the card did">
                        <LedgerReview e={review} />
                      </PaneBoundary>
                    </div>
                  </details>
                ) : null}
                <PaneBoundary name="Drawing guide">
                  <DrawingGuide />
                </PaneBoundary>
                <details className="rounded-lg border">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Rules before every trade (9)</summary>
                  <div className="p-2">
                    <TradeRulesFor doc={doc} now={now} />
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
              </div>
            </CockpitShell>
          </BoardProvider>
        </DoneTodayProvider>
      </LiveQuotes>
    </>
  );
}
