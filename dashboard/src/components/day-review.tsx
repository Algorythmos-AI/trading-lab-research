// The Day review page: one New York day of the owner's option positions against his own rules, on one screen.
// Server-rendered, no script. Every figure comes from lib/day-review.ts, which takes them from the Trades page's own
// functions. What it may show is DEC-0045 point 8 and DEC-0049 point 5: the day's positions together, never grouped
// by a label, and no exit that was not taken beyond the −25% figure.
import { ChevronLeft, ChevronRight, ListOrdered, Ruler, ShieldCheck, Wallet } from "lucide-react";
import Link from "next/link";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { Empty } from "@/components/empty";
import { EST, feeLabel, NoJournal } from "@/components/journal";
import { Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BOARD_LABEL_LINE, reviewView, type DayReview, type ReviewRow, type ReviewView } from "@/lib/day-review";
import { newYork, weekDate } from "@/lib/format";
import { skippedLine, type JournalDoc } from "@/lib/journal";
import { rOf, usd2 } from "@/lib/journal-list";
import type { JournalResult } from "@/lib/snapshot";
import { MAX_TRADES_PER_DAY, money, RULES } from "@/lib/trade-rules";
import { cn } from "@/lib/utils";

type Query = Record<string, string | string[] | undefined>;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const tone = (v: number | null) => (v === null || v === 0 ? "" : v > 0 ? "text-good" : "text-bad");
const time = (iso: string | null) => (iso ? newYork(iso, false) : "—");

/**
 * "Rule 5" or "Rules 5, 7", as the Trades page's rules strip writes them; "Rules kept" with none. A position still held
 * is never given the all-clear: with no break yet it reads "Open".
 */
export function rulesText(rules: readonly number[], open = false): string {
  return rules.length ? `${rules.length > 1 ? "Rules" : "Rule"} ${rules.join(", ")}` : open ? "Open" : "Rules kept";
}
const rulesTone = (row: Pick<ReviewRow, "rules" | "open">) => (row.rules.length ? "text-bad" : row.open ? "text-muted-foreground" : "text-good");

/** Dollars beyond the plan, to the cent as the rows write money; under a cent is $0.00, never "−$0.00". */
export const beyondText = (v: number) => (Math.round(v * 100) >= 1 ? usd2(-v) : "$0.00");

/**
 * The Loss size tile's line, over the positions its figures count: the dollars' meaning first, then the losers past
 * the −25% stop and over the $50 risk; losers left out are said, and with any the day is never given the all-clear.
 */
export function lossHint(loss: DayReview["loss"], isToday: boolean): string {
  if (loss.pastStop === 0 && loss.overRisk === 0 && loss.leftOut === 0) return loss.losers > 0 ? "Every loss at plan size." : isToday ? "No losers today." : "No losers this day.";
  return `beyond −25% · ${loss.pastStop} past the stop · ${loss.overRisk} over $50${loss.leftOut ? ` · ${loss.leftOut} left out` : ""}`;
}

/** The day in words, with the year when it is not this New York year: "Wed 9 Oct", "Wed 9 Oct 2024". */
export const dayWords = (day: string, today: string) => (day.slice(0, 4) === today.slice(0, 4) ? weekDate(day) : `${weekDate(day)} ${day.slice(0, 4)}`);

/** The Rules kept tile's line: the day's cap and its loss limit, kept or broken, or as last read when today cannot be judged. */
export function dayLine(r: Pick<DayReview, "rules" | "sessionOpen">): string {
  const x = r.rules;
  const cap = `${MAX_TRADES_PER_DAY}`;
  if (!x.current)
    return `Trades ${x.entries} of ${cap}${x.entriesKept ? "" : " (broken)"} · Day result ${money(x.dayNet)}${x.dayLossKept ? "" : " (past the loss limit)"}, as last read ${x.readAt}`;
  const trades = x.heldOpen ? `Trades ${x.entries} of ${cap} closed · ${x.heldOpen} still open${x.entriesKept ? "" : ": broken"}` : `Trades ${x.entries} of ${cap}: ${x.entriesKept ? "kept" : "broken"}`;
  const limit = r.sessionOpen ? (x.dayLossKept ? "Inside the loss limit so far" : "Past the loss limit") : x.dayLossKept ? "Day closed inside the loss limit" : "Day closed past the loss limit";
  return `${trades} · ${limit}`;
}

/** The rules broken on the day, each once, in number order, with their own short titles: numbers alone do not read. */
export function rulesLegend(rows: readonly Pick<ReviewRow, "rules">[]): string[] {
  const broken = new Set(rows.flatMap((r) => r.rules));
  return RULES.filter((r) => broken.has(r.n)).map((r) => `Rule ${r.n}: ${r.title}`);
}

/** The rules' own titles, for a reader that wants the words behind the numbers. */
const rulesTitle = (rules: readonly number[]) => RULES.filter((r) => rules.includes(r.n)).map((r) => `${r.n}. ${r.title}`).join("; ");

export function DayReviewBody({ result, q, now }: { result: JournalResult; q: Query; now: Date }) {
  if (result.status !== "ok")
    return (
      <div data-day-review data-ready="true" className="grid gap-5">
        <Heading view={null} />
        <NoJournal status={result.status} />
      </div>
    );
  return <ReviewBody doc={result.doc} q={q} now={now} carried={result.skipped ?? 0} />;
}

function ReviewBody({ doc, q, now, carried }: { doc: JournalDoc; q: Query; now: Date; carried: number }) {
  const v = reviewView(doc, q.day, now, carried);
  const r = v.review;
  return (
    <div data-day-review data-ready="true" className="grid gap-5">
      <Heading view={v} />
      <PaneBoundary name="Day review">
        {r === null ? (
          <Empty title="No option positions yet">The review fills in once the journal has a closed call or put.</Empty>
        ) : r.rows.length === 0 ? (
          <Empty title="No option positions on this day">{v.days.length ? "Use the previous and next links to move to a day with positions." : "The review fills in once the journal has a closed call or put."}</Empty>
        ) : (
          <div className="grid gap-5">
            <Summary r={r} />
            <Positions r={r} dayName={dayWords(r.day, v.today)} />
          </div>
        )}
      </PaneBoundary>
    </div>
  );
}

/** The day, the way to the days either side, and when the journal was read. */
function Heading({ view }: { view: ReviewView | null }) {
  const unread = view ? skippedLine(view.skipped) : null;
  return (
    <header className="grid gap-1">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Day review</h1>
          {view?.day ? <p className="text-sm font-medium">{dayWords(view.day, view.today)}</p> : null}
        </div>
        {view?.day ? <DayNav prev={view.prev} next={view.next} /> : null}
      </div>
      {view ? <p className="text-muted-foreground text-xs">Journal read {newYork(view.asOf)} New York.</p> : null}
      {view?.review?.sessionOpen ? (
        <p role="status" className="text-warn text-xs font-medium">
          Session still open: this is the day so far.
        </p>
      ) : null}
      {unread ? (
        <p data-journal-skipped={view!.skipped} className="text-warn text-xs font-medium">
          {unread}
        </p>
      ) : null}
    </header>
  );
}

const NAV_LINK =
  "hover:bg-muted text-muted-foreground hover:text-foreground inline-flex h-11 items-center gap-1 rounded-md border px-3 text-sm font-medium whitespace-nowrap sm:h-8 sm:px-2.5 sm:text-xs";

/** The nearest days with positions either side; a side with none has no link. */
function DayNav({ prev, next }: { prev: string | null; next: string | null }) {
  if (!prev && !next) return null;
  return (
    <nav aria-label="Days with positions" className="flex items-center gap-1.5">
      {prev ? (
        <Link href={`/review?day=${prev}`} className={NAV_LINK} aria-label={`Previous day with positions, ${weekDate(prev)}`}>
          <ChevronLeft aria-hidden className="size-4 sm:size-3.5" />
          {weekDate(prev)}
        </Link>
      ) : null}
      {next ? (
        <Link href={`/review?day=${next}`} className={NAV_LINK} aria-label={`Next day with positions, ${weekDate(next)}`}>
          {weekDate(next)}
          <ChevronRight aria-hidden className="size-4 sm:size-3.5" />
        </Link>
      ) : null}
    </nav>
  );
}

/** Four tiles, the rules first and the money third on purpose. */
function Summary({ r }: { r: DayReview }) {
  const { rules, loss, result, trades } = r;
  const allKept = rules.kept === rules.of && rules.entriesKept && rules.dayLossKept;
  const anyBroken = rules.kept < rules.of || !rules.entriesKept || !rules.dayLossKept;
  const included = result?.feesIncluded ?? false;
  return (
    <section aria-label="The day in four figures">
      <StatTiles className="lg:grid-cols-4">
        <StatTile
          label="Rules kept"
          icon={ShieldCheck}
          tone={anyBroken ? "bad" : rules.of === 0 || !rules.current ? "neutral" : allKept ? "good" : "neutral"}
          value={`${rules.kept} of ${plural(rules.of, "position")}`}
          hint={dayLine(r)}
        />
        <StatTile
          label="Loss size"
          icon={Ruler}
          tone={loss.pastStop > 0 || loss.overRisk > 0 ? "bad" : loss.leftOut > 0 ? "warn" : "neutral"}
          value={beyondText(loss.beyondStop)}
          hint={lossHint(loss, r.isToday)}
        />
        <StatTile
          label={feeLabel("Result", included)}
          icon={Wallet}
          tone={result === null || result.net === 0 ? "neutral" : result.net > 0 ? "good" : "bad"}
          value={result ? money(result.net) : "—"}
          hint={
            result
              ? `R50 ${rOf(result.r50)}${included ? "" : ` · before fees ${money(result.gross)}`}${result.carried ? " · counts all sold this day" : ""}`
              : "Nothing sold this day"
          }
        />
        <StatTile
          label="Trades"
          icon={ListOrdered}
          value={trades.taken.toLocaleString("en-US")}
          hint={`${trades.winners} won · ${trades.losers} lost${trades.open ? ` · ${trades.open} open` : ""}`}
        />
      </StatTiles>
    </section>
  );
}

/** The day's positions in the order they were opened: cards on a phone, a table from sm up. */
function Positions({ r, dayName }: { r: DayReview; dayName: string }) {
  const after = r.result?.feesIncluded ? "after fees" : EST;
  const legend = rulesLegend(r.rows);
  return (
    <Panel id="positions" title="Positions" icon={ListOrdered} means={`In the order you opened them, New York time. Results ${after}.`}>
      <div className="grid gap-3">
        <ul aria-label="Positions, in the order opened" className="grid gap-2 sm:hidden">
          {r.rows.map((row) => (
            <PositionCard key={row.id} row={row} />
          ))}
        </ul>
        <div className="max-sm:hidden">
          <Table label={`Positions on ${dayName}`}>
            <TableHeader>
              <TableRow>
                <TableHead>Opened</TableHead>
                <TableHead>Closed</TableHead>
                <TableHead>Contract</TableHead>
                <TableHead className="text-right">Contracts</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Result</TableHead>
                <TableHead className="text-right">
                  R25<span className="sr-only">: the result {after} in quarters of the premium, where −1 is the −25% stop</span>
                </TableHead>
                <TableHead className="text-right">
                  R50<span className="sr-only">: the result {after} in units of $50, the most one trade may risk</span>
                </TableHead>
                <TableHead>Rules</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.rows.map((row) => (
                <TableRow key={row.id} data-review-row={row.id}>
                  <TableCell className="font-mono text-xs tabular-nums">{time(row.openedAt)}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs tabular-nums">{row.open ? "Open" : time(row.closedAt)}</TableCell>
                  <TableCell className="font-medium">{row.contract}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{row.contracts.toLocaleString("en-US")}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{usd2(row.cost).replace("+", "")}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.net === null ? (
                      <span className="text-muted-foreground text-xs">Still open</span>
                    ) : (
                      <span className={cn("block font-mono text-xs font-semibold", tone(row.net))}>{usd2(row.net)}</span>
                    )}
                    {row.pastStop ? <span className="text-bad block font-mono text-[0.6875rem]">{beyondText(row.beyondPlan)} beyond the plan</span> : null}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{rOf(row.r25)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{rOf(row.r50)}</TableCell>
                  <TableCell className={cn("text-xs font-medium", rulesTone(row))} title={rulesTitle(row.rules) || undefined}>
                    {rulesText(row.rules, row.open)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {legend.length ? (
          <ul aria-label="Rules broken this day" className="text-muted-foreground grid gap-0.5 text-xs max-sm:text-[0.8125rem]">
            {legend.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-muted-foreground text-xs max-sm:text-[0.8125rem]">
          R25 is the result in quarters of the premium, so −1 is the −25% stop; R50 is the result in units of $50, the most one trade may risk. The −25% test is on the price you sold at, before fees, so a result a little under −1 R25 can still be inside the stop.
        </p>
        {r.otherSold ? (
          <p className="text-muted-foreground text-xs max-sm:text-[0.8125rem]">
            {r.otherSold === 1 ? "1 stock or short trade this day is in the result but not listed here." : `${r.otherSold.toLocaleString("en-US")} stock or short trades this day are in the result but not listed here.`}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs max-sm:text-[0.8125rem]">{BOARD_LABEL_LINE}</p>
      </div>
    </Panel>
  );
}

/** One position on a phone, in three lines: the contract and its result; the times, contracts and cost; R and rules. */
function PositionCard({ row }: { row: ReviewRow }) {
  return (
    <li data-review-card={row.id} className="grid gap-0.5 rounded-lg border px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 text-sm font-medium break-words">{row.contract}</p>
        {row.net === null ? (
          <p className="text-muted-foreground shrink-0 text-sm">Still open</p>
        ) : (
          <p className={cn("shrink-0 font-mono text-lg leading-tight font-semibold whitespace-nowrap", tone(row.net))}>
            <span className="sr-only">Result </span>
            {usd2(row.net)}
          </p>
        )}
      </div>
      <p className="text-muted-foreground text-[0.8125rem] tabular-nums">
        <span className="whitespace-nowrap">
          {time(row.openedAt)} → {row.open ? "open" : time(row.closedAt)}
        </span>{" "}
        · <span className="whitespace-nowrap">{plural(row.contracts, "contract")}</span> · <span className="whitespace-nowrap">cost {usd2(row.cost).replace("+", "")}</span>
      </p>
      <p className="flex flex-wrap items-baseline gap-x-3 text-[0.8125rem] tabular-nums">
        <span className="whitespace-nowrap">
          <span className="text-muted-foreground">R25</span> <span className="font-mono">{rOf(row.r25)}</span>
        </span>
        <span className="whitespace-nowrap">
          <span className="text-muted-foreground">R50</span> <span className="font-mono">{rOf(row.r50)}</span>
        </span>
        <span className={cn("font-medium whitespace-nowrap", rulesTone(row))}>{rulesText(row.rules, row.open)}</span>
        {row.pastStop ? <span className="text-bad font-mono whitespace-nowrap">{beyondText(row.beyondPlan)} beyond the plan</span> : null}
      </p>
    </li>
  );
}
