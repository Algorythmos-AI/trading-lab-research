import Link from "next/link";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { PaneBoundary } from "@/components/client/pane-boundary";
import {
  BoardFeedLine,
  FeedsLiveProvider,
  FeedsLiveRows,
  FreshPanel,
  HideAtOpen,
  PageRefresh,
} from "@/components/client/feeds-live";
import { LiveQuotes } from "@/components/client/live-layer";
import { nextOpenAfter } from "@/lib/board-feed-stamp";
import { ageText } from "@/lib/feed-provenance";
import {
  type ChainStatus,
  type ComparedSession,
  feedsPageTime,
  loadComparedSessions,
  loadStampPanel,
  type Stat,
  type StampPanel,
} from "@/lib/feeds-page";
import { weekDate } from "@/lib/format";
import { nyNow, sessionOf } from "@/lib/market-calendar";
import { nyInstant } from "@/lib/options";
import { loadOptions } from "@/lib/snapshot";

// PRIVATE: behind the owner's Vercel login like every page here. Advisory and read-only: nothing on it can place an
// order. DEC-0050 point 5 sets what is drawn: during a session the board's own feed only; after the close the stored
// comparisons as counts and differences, never an IEX state per name and slot.

export const dynamic = "force-dynamic";
export const metadata = { title: "Feeds" };

const INTRO =
  "Which stock feed the board reads, whether the production stamps say it read it, and after the close how the two feeds compared. Research only; nothing here is an order.";

const DASH = "—";
const n0 = (v: number | null) => (v === null ? DASH : String(v));
const n1 = (v: number | null) => (v === null ? DASH : v.toFixed(1));
const withN = (s: Stat, f: (v: number | null) => string) =>
  s.value === null ? DASH : `${f(s.value)} (n ${n0(s.n)})`;

const CHAIN_WORDS: Record<ChainStatus, { text: string; good: boolean }> = {
  ok: { text: "manifest present, chain intact", good: true },
  no_manifest: { text: "no manifest stored", good: false },
  late_manifest: { text: "manifest written after the next open", good: false },
  prev_mismatch: {
    text: "chain broken (a stamp does not link to the one before)",
    good: false,
  },
  misplaced: { text: "a stamp's time does not match its minute", good: false },
  count_mismatch: {
    text: "manifest count does not match the stamps",
    good: false,
  },
  unreadable: {
    text: "not available: the store could not be read",
    good: false,
  },
};

function StampFacts({ p }: { p: StampPanel }) {
  const rows: { k: string; v: string; warn?: boolean }[] = [];
  if (p.phase === "outside") {
    rows.push({
      k: "Today",
      v: "Outside a session: no stamps are written now.",
    });
  } else if (!p.read) {
    rows.push({
      k: "Today's stamps",
      v: "not available: the store could not be read",
      warn: true,
    });
  } else {
    const r = p.read;
    rows.push({
      k:
        p.phase === "closed"
          ? "Stamps today (session closed)"
          : "Stamps so far",
      v: `${r.count} over ${r.elapsed} minutes since the open`,
      warn: r.count < r.elapsed,
    });
    rows.push({
      k: "Last stamp",
      v:
        r.lastAgeMs === null
          ? "not available: no stamp yet today"
          : `${ageText(r.lastAgeMs)} ago`,
      warn:
        r.lastAgeMs === null ||
        (p.phase === "session" && r.lastAgeMs > 3 * 60_000),
    });
    rows.push({
      k: "Answered ok",
      v:
        r.count === 0
          ? "not available: no stamp yet today"
          : `${Math.round((r.ok / r.count) * 100)}% (${r.ok} of ${r.count})`,
      warn: r.count === 0 || r.ok < r.count,
    });
    const feeds = Object.entries(r.feeds)
      .map(([f, c]) => `${f} ${c}`)
      .join(", ");
    rows.push({
      k: "Feed in the stamps",
      v: feeds || "not available: no stamp yet today",
      warn: !feeds || Object.keys(r.feeds).some((f) => f !== "sip"),
    });
    if (r.ends === null)
      rows.push({
        k: "Session checks",
        v: "not available: no stamp yet today",
        warn: true,
      });
    else {
      rows.push({
        k: "Every stamp on SIP",
        v: r.ends.not_sip ? "No: a stamp reads iex or refused" : "Yes",
        warn: r.ends.not_sip,
      });
      rows.push({
        k: "Build change in a gap",
        v: r.ends.hidden_change
          ? "Yes: two stamps over 10 minutes apart on different builds"
          : "None seen",
        warn: r.ends.hidden_change,
      });
    }
    if (r.malformed)
      rows.push({
        k: "Unreadable objects",
        v: String(r.malformed),
        warn: true,
      });
  }
  if (p.previous) {
    const w = CHAIN_WORDS[p.previous.status];
    rows.push({
      k: `Previous session (${weekDate(p.previous.day)})`,
      v: w.text,
      warn: !w.good,
    });
  } else
    rows.push({
      k: "Previous session",
      v: "not available: none in the calendar",
      warn: true,
    });
  return (
    <dl
      data-stamp-panel={p.phase}
      className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]"
    >
      {rows.map((r) => (
        <div key={r.k} className="contents">
          <dt className="text-muted-foreground">{r.k}</dt>
          <dd className={r.warn ? "text-warn font-medium" : undefined}>
            {r.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const COLUMNS = [
  "Day",
  "Status",
  "Engine",
  "Minutes sampled",
  "Identical states",
  "Enter-zone SIP / IEX / matched",
  "Price diff median / p95 bp",
  "Volume ratio SIP/IEX median",
  "Spread median SIP bp",
  "Spread median IEX bp",
  "Trade age p95 SIP s",
  "Trade age p95 IEX s",
  "Not comparable",
];

function cells(s: ComparedSession): string[] {
  return [
    s.day ? weekDate(s.day) : DASH,
    s.signalsStatus === null
      ? DASH
      : s.signalsWhy
        ? `${s.signalsStatus} (${s.signalsWhy})`
        : s.signalsStatus,
    s.engine ?? DASH,
    s.minutes === null && s.expected === null
      ? DASH
      : `${n0(s.minutes)} / ${n0(s.expected)}`,
    s.identicalPct === null ? DASH : `${s.identicalPct.toFixed(1)}%`,
    `${n0(s.enterSip)} / ${n0(s.enterIex)} / ${n0(s.enterMatched)}`,
    s.priceDiffMedianBp === null && s.priceDiffP95Bp === null
      ? DASH
      : `${n1(s.priceDiffMedianBp)} / ${n1(s.priceDiffP95Bp)} (n ${n0(s.priceDiffN)})`,
    withN(s.volumeRatio, n1),
    withN(s.spreadSip, n1),
    withN(s.spreadIex, n1),
    withN(s.tradeAgeP95Sip, n1),
    withN(s.tradeAgeP95Iex, n1),
    n0(s.notComparable),
  ];
}

function ComparedTable({
  got,
}: {
  got: { rows: ComparedSession[]; bad: number } | null;
}) {
  if (got === null)
    return (
      <p data-compared-off className="text-warn text-sm">
        Sessions compared: not available, the report store did not answer.
      </p>
    );
  const { rows, bad } = got;
  const badLine = bad ? (
    <p data-compared-bad className="text-warn text-sm">
      {bad} {bad === 1 ? "report" : "reports"} could not be read.
    </p>
  ) : null;
  if (!rows.length)
    return bad ? (
      <p data-compared-bad className="text-warn text-sm">
        Sessions compared: not available, none of the {bad} stored{" "}
        {bad === 1 ? "report" : "reports"} could be read.
      </p>
    ) : (
      <p className="text-muted-foreground text-sm">No compared sessions yet.</p>
    );
  return (
    <div className="grid gap-2">
      {badLine}
      <div
        className="max-w-full overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Sessions compared, scrolls sideways"
      >
        <table data-compared className="w-full text-left text-xs">
          <thead>
            <tr className="border-b">
              {COLUMNS.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="px-2 py-1.5 font-medium whitespace-nowrap"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr
                key={s.day ?? `row-${i}`}
                data-compared-day={s.day ?? undefined}
                className="border-b last:border-0"
              >
                {cells(s).map((c, j) => (
                  <td
                    key={j}
                    className="px-2 py-1.5 font-mono whitespace-nowrap tabular-nums"
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const NY_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** The next regular-session open at or after `now` (epoch ms), or null past the calendar's end. */
function nextOpen(now: Date): number | null {
  const { day, minute } = nyNow(now);
  const s = sessionOf(day);
  if (s.open !== null && minute < s.open) return nyInstant(day, s.open);
  return nextOpenAfter(day);
}

export default async function FeedsPage() {
  const now = await feedsPageTime();
  const [panel, compared, options] = await Promise.all([
    loadStampPanel(now),
    loadComparedSessions(),
    loadOptions(),
  ]);
  const focus =
    options.status === "ok"
      ? [...(options.edition.focus?.items ?? [])]
          .sort((a, b) => a.rank - b.rank)
          .slice(0, 4)
          .map((i) => i.symbol)
      : [];
  const symbols = [...new Set([...focus, "SPY"])];
  const session = options.status === "ok" ? options.edition.session : "";
  // The edition's rows for these names: the board's per-name read (liveRead) needs each name's levels.
  const tickers = options.status === "ok" ? options.edition.tickers.filter((t) => symbols.includes(t.symbol)) : [];
  return (
    <LiveQuotes symbols={symbols.join(",")} session={session} enabled>
      <PageRefresh />
      <PageHeading title="Feeds" intro={INTRO} />
      <p className="text-xs">
        <Link
          className="text-muted-foreground hover:text-foreground underline"
          href="/options"
        >
          Back to Options
        </Link>
      </p>
      <FeedsLiveProvider symbols={symbols.join(",")}>
        <PaneBoundary name="Authoritative feed">
          <Panel
            title="Authoritative feed"
            means="The board's stock feed, as its live answer names it, and the production stamps that record it once a minute (DEC-0050)."
          >
            <div className="grid gap-4">
              <BoardFeedLine />
              <p className="text-muted-foreground text-xs">
                Option chain feed: not shown here; the contract pane names it
                with each answer.
              </p>
              <FreshPanel key={panel.at}>
                <p data-stamp-as-of className="text-muted-foreground text-xs">
                  Stamps as of {NY_TIME.format(new Date(panel.at))} NY (server)
                </p>
                <StampFacts p={panel} />
              </FreshPanel>
            </div>
          </Panel>
        </PaneBoundary>
        <PaneBoundary name="Live board feed">
          <Panel
            title="Live board feed"
            means={`The board's own feed only, for ${focus.length ? "the focus names and SPY" : "SPY (no focus names in the latest edition)"}. Price and last trade are the board's own live prices; quote and bars, read every 5 s. Every number is labelled with the feed it came from.`}
          >
            <FeedsLiveRows symbols={symbols.join(",")} tickers={tickers} />
          </Panel>
        </PaneBoundary>
        <PaneBoundary name="Sessions compared">
          <Panel
            title="Sessions compared"
            means="After the close only: the stored comparisons of the board feed and IEX, as counts and differences. Never a state per name and slot."
          >
            {panel.phase === "session" ? (
              <p className="text-muted-foreground text-sm">
                Shown after the close: during a session only the board&apos;s
                own feed is drawn (DEC-0050).
              </p>
            ) : (
              <HideAtOpen key={now.getTime()} serverNow={now.getTime()} hideAt={nextOpen(now)}>
                <ComparedTable got={compared} />
              </HideAtOpen>
            )}
          </Panel>
        </PaneBoundary>
      </FeedsLiveProvider>
    </LiveQuotes>
  );
}
