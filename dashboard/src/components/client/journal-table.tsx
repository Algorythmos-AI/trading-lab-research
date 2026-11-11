"use client";

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type JournalRow, listRows, nextSort, type Only, rowWords, type RowWords, type Sort, SORT_CHOICES, sortOf, sortValue, type SortKey } from "@/lib/journal-list";
import { cn } from "@/lib/utils";

const TONE: Record<RowWords["tone"], string> = { good: "text-good", bad: "text-bad", flat: "" };

export type { JournalRow } from "@/lib/journal-list";

const PAGE = 50;
/** Cards a phone shows at first and adds with each "Show more": a card is about 100 px, the table's row about 40. */
const CARD_PAGE = 15;

/** A trade of several pieces, in the table: the pieces under its contract, in a native disclosure. */
function Pieces({ r, className }: { r: JournalRow; className?: string }) {
  if (!r.pieces.length) return null;
  return (
    <details className={cn("text-muted-foreground text-xs", className)}>
      <summary className="hover:text-foreground cursor-pointer">{r.pieces.length} pieces</summary>
      <ul className="mt-1 grid gap-0.5">
        {r.pieces.map((p) => (
          <li key={p.id} className="font-mono text-[0.6875rem]">
            {p.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * One trade as a card, for a phone, in three lines: the contract and the result after fees, large, coloured and
 * signed; when, how long, how many and in → out; the result on the premium and in R25, the Expired badge, and a
 * "More" fold with the rest (before fees, R50, fees, the pieces). The same row and the same words as the table.
 */
function TradeCard({ r }: { r: JournalRow }) {
  const w = rowWords(r);
  return (
    <li data-trade-card={r.id} className="grid rounded-lg border px-3 pt-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 text-sm font-medium break-words">{r.what}</p>
        <p className={cn("shrink-0 font-mono text-lg leading-tight font-semibold whitespace-nowrap", TONE[w.tone])}>
          <span className="sr-only">Result </span>
          {w.result}
        </p>
      </div>
      <p className="text-muted-foreground text-[0.8125rem] tabular-nums">
        <span className="sr-only">Closed </span>
        <span className="whitespace-nowrap">{r.when}</span> · <span className="whitespace-nowrap">held {r.held}</span> ·{" "}
        <span className="whitespace-nowrap">
          {w.qty} × {w.inOut}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-x-3 text-[0.8125rem] tabular-nums">
        <span className="whitespace-nowrap">
          <span className="font-mono">{w.onPremium}</span> <span className="text-muted-foreground">on premium</span>
        </span>
        <span className="whitespace-nowrap">
          <span className="text-muted-foreground">R25</span> <span className="font-mono">{w.r25}</span>
        </span>
        {r.expired ? <Badge variant="warn">Expired</Badge> : null}
        <details className="group/more ml-auto open:ml-0 open:basis-full">
          <summary className="text-muted-foreground hover:text-foreground ml-auto flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
            More
            <ChevronDown aria-hidden className="size-4 transition-transform group-open/more:rotate-180" />
          </summary>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 pb-2">
            {w.beforeFees ? (
              <>
                <dt className="text-muted-foreground">Before fees</dt>
                <dd className="font-mono">{w.beforeFees.replace(" before fees", "")}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Fees</dt>
            <dd className="font-mono">{w.fees}</dd>
            <dt className="text-muted-foreground">R50</dt>
            <dd className="font-mono">{w.r50}</dd>
            {r.pieces.length ? (
              <>
                <dt className="text-muted-foreground">{r.pieces.length} pieces</dt>
                <dd>
                  <ul className="grid gap-0.5">
                    {r.pieces.map((p) => (
                      <li key={p.id} className="font-mono text-xs">
                        {p.text}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
          </dl>
        </details>
      </div>
    </li>
  );
}

/**
 * Every closed trade in the filter, newest first, with a search box, sorting and a "show more". Read only. A trade of
 * several pieces lists them under its contract in a native disclosure. From sm up a table; on a phone a card per
 * trade, with a sort menu in place of the column headers: one list and one state, drawn twice, one of them hidden.
 */
export function JournalTable({ rows }: { rows: JournalRow[] }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "at", dir: -1 });
  const [shown, setShown] = useState(PAGE);
  const [cardsShown, setCardsShown] = useState(CARD_PAGE);
  const [only, setOnly] = useState<Only>("all");

  const list = useMemo(() => listRows(rows, q, only, sort), [rows, q, sort, only]);
  // Both renderings come from the one sorted list; each draws only its own page of it (CSS shows one of them). Both
  // counts start the same on the server and in the browser, so nothing differs at hydration.
  const page = list.slice(0, shown);
  const cards = list.slice(0, cardsShown);
  const reset = () => {
    setShown(PAGE);
    setCardsShown(CARD_PAGE);
  };

  const head = (key: SortKey, label: string, className?: string) => (
    <TableHead className={className} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className="hover:text-foreground inline-flex items-center gap-1"
        onClick={() => setSort((s) => nextSort(s, key))}
      >
        {label}
        <span aria-hidden className="text-[0.625rem] max-sm:text-xs">
          {sort.key === key ? (sort.dir === 1 ? "▲" : "▼") : ""}
        </span>
      </button>
    </TableHead>
  );

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            reset();
          }}
          placeholder="Find a ticker, strike or date"
          aria-label="Find a trade"
          className="bg-background h-8 w-full max-w-64 rounded-md border px-2.5 text-sm max-sm:h-11 max-sm:max-w-none max-sm:text-base"
        />
        <div className="flex gap-1" role="group" aria-label="Show">
          {(["all", "win", "loss"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={only === k}
              onClick={() => {
                setOnly(k);
                reset();
              }}
              className={cn("h-8 rounded-md border px-2.5 text-xs max-sm:h-11 max-sm:px-3 max-sm:text-sm", only === k ? "bg-secondary text-foreground font-medium" : "text-muted-foreground")}
            >
              {k === "all" ? "All" : k === "win" ? "Winners" : "Losers"}
            </button>
          ))}
        </div>
        {/* The table's column sorts, as one menu: a phone has no column headers to press. */}
        <label className="text-muted-foreground flex items-center gap-1.5 text-sm sm:hidden">
          Sort
          <select
            value={sortValue(sort)}
            onChange={(e) => {
              const next = sortOf(e.target.value);
              if (next) setSort(next);
              setCardsShown(CARD_PAGE);
            }}
            className="bg-background text-foreground h-11 rounded-md border px-2 text-base"
          >
            {SORT_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-muted-foreground ml-auto text-xs max-sm:text-sm">
          {list.length.toLocaleString("en-US")} trade{list.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul aria-label="Every trade" className="grid gap-2 sm:hidden">
        {cards.map((r) => (
          <TradeCard key={r.id} r={r} />
        ))}
      </ul>
      <div className="overflow-x-auto max-sm:hidden">
        <Table>
          <TableHeader>
            <TableRow>
              {head("at", "Closed (New York)")}
              <TableHead>Contract</TableHead>
              {head("qty", "Qty", "text-right")}
              <TableHead className="text-right">In → out</TableHead>
              {head("holdMin", "Held", "text-right")}
              <TableHead className="text-right">Fees</TableHead>
              {head("pnl", "Result", "text-right")}
              <TableHead className="text-right">On premium</TableHead>
              <TableHead className="text-right">
                R25<span className="sr-only">: the result after fees in quarters of the premium, where −1 is the −25% stop</span>
              </TableHead>
              <TableHead className="text-right">
                R50<span className="sr-only">: the result after fees in units of $50, the most one trade may risk</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.map((r) => {
              const w = rowWords(r);
              return (
                <TableRow key={r.id}>
                  <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">{r.when}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span className="font-medium">{r.what}</span>
                    {r.expired ? (
                      <Badge variant="warn" className="ml-1.5">
                        Expired
                      </Badge>
                    ) : null}
                    <Pieces r={r} className="mt-0.5" />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{w.qty}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{w.inOut}</TableCell>
                  <TableCell className="text-muted-foreground text-right text-xs whitespace-nowrap">{r.held}</TableCell>
                  <TableCell className="text-muted-foreground text-right font-mono text-xs whitespace-nowrap">{w.fees}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <span className={cn("block font-mono text-xs font-semibold", TONE[w.tone])}>{w.result}</span>
                    {w.beforeFees ? <span className="text-muted-foreground block font-mono text-[0.6875rem] max-sm:text-xs">{w.beforeFees}</span> : null}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{w.onPremium}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{w.r25}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{w.r50}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground text-xs max-sm:text-[0.8125rem]">
        R25 is the result after fees in quarters of the premium, so −1 is the −25% stop; R50 is the result in units of $50, the most one trade may risk.
      </p>
      {cardsShown < list.length ? (
        <button
          type="button"
          onClick={() => setCardsShown((n) => n + CARD_PAGE)}
          className="text-muted-foreground hover:text-foreground min-h-11 w-full rounded-md border px-3 text-sm sm:hidden"
        >
          Show more ({(list.length - cardsShown).toLocaleString("en-US")} left)
        </button>
      ) : null}
      {shown < list.length ? (
        <button type="button" onClick={() => setShown((n) => n + PAGE * 4)} className="text-muted-foreground hover:text-foreground mx-auto h-8 rounded-md border px-3 text-xs max-sm:hidden">
          Show more ({(list.length - shown).toLocaleString("en-US")} left)
        </button>
      ) : null}
    </div>
  );
}
