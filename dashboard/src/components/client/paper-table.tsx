"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Dollars } from "@/components/paper/dollars";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PaperRow } from "@/lib/paper";
import { cn } from "@/lib/utils";

type SortKey = "at" | "what" | "pnl" | "rop" | "holdMin";
type Result = "all" | "won" | "lost";

const PAGE = 25;

const valueOf = (r: PaperRow, key: SortKey): number | string => (key === "what" ? r.what : key === "rop" ? (r.rop ?? Number.NEGATIVE_INFINITY) : r[key]);

const tone = (v: number | null) => (v === null || v === 0 ? "" : v > 0 ? "text-good" : "text-bad");
const signed = (v: number, digits: number, unit: string) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}${unit}`;
const price = (v: number) => v.toFixed(2);

function SortHead({ label, k, sort, onSort, className }: { label: string; k: SortKey; sort: { key: SortKey; desc: boolean }; onSort: (k: SortKey) => void; className?: string }) {
  const on = sort.key === k;
  const Icon = on ? (sort.desc ? ArrowDown : ArrowUp) : ChevronsUpDown;
  return (
    <TableHead aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"} className={className}>
      <button type="button" onClick={() => onSort(k)} className="hover:text-foreground focus-visible:outline-ring inline-flex items-center gap-1 rounded focus-visible:outline-2 max-sm:min-h-11">
        {label}
        <Icon aria-hidden className={cn("size-3", on ? "text-foreground" : "opacity-50")} />
      </button>
    </TableHead>
  );
}

/**
 * Every closed trade of one paper source, newest first: sorted by a click on a heading, cut to wins or losses, and
 * searched by ticker. `env` is the evidence class of the frame it sits in; `detail` adds the clone's hypothesis and
 * rule window. Twenty-five rows at a time: "Show more" adds the next twenty-five.
 */
export function PaperTable({ rows, env, label, detail = false }: { rows: PaperRow[]; env: "paper" | "shadow"; label: string; detail?: boolean }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "at", desc: true });
  const [result, setResult] = useState<Result>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const view = useMemo(() => {
    const q = query.trim().toUpperCase();
    const kept = rows.filter((r) => (result === "all" || (result === "won" ? r.pnl > 0 : r.pnl < 0)) && (q === "" || r.symbol.includes(q) || r.what.toUpperCase().includes(q)));
    const dir = sort.desc ? -1 : 1;
    return [...kept].sort((a, b) => {
      const x = valueOf(a, sort.key);
      const y = valueOf(b, sort.key);
      const c = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x - y;
      return c * dir || b.at - a.at || a.id.localeCompare(b.id);
    });
  }, [rows, sort, result, query]);
  const onSort = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "what" }));
    setShown(PAGE);
  };
  const total = view.reduce((s, r) => s + r.pnl, 0);
  const page = view.slice(0, shown);
  return (
    <div className="grid gap-3" data-paper-table={label}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="bg-muted inline-flex rounded-md p-0.5" role="group" aria-label="Which results">
          {(["all", "won", "lost"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={result === k}
              onClick={() => {
                setResult(k);
                setShown(PAGE);
              }}
              className={cn(
                "focus-visible:outline-ring h-7 rounded px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 max-sm:h-11 max-sm:px-3.5 max-sm:text-sm",
                result === k ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "all" ? "All" : k === "won" ? "Won" : "Lost"}
            </button>
          ))}
        </div>
        <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span className="sr-only">Search {label} by ticker</span>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
            placeholder="Ticker"
            className="bg-background focus-visible:outline-ring h-7 w-28 rounded-md border px-2 text-xs focus-visible:outline-2 max-sm:h-11 max-sm:text-base"
          />
        </label>
        <p className="text-muted-foreground ml-auto text-xs" aria-live="polite">
          {view.length.toLocaleString("en-US")} trade{view.length === 1 ? "" : "s"} · <Dollars env={env} value={total} signed className={cn("font-mono font-medium", tone(total))} />
        </p>
      </div>
      {view.length === 0 ? (
        <p className="text-muted-foreground text-sm">No trades match.</p>
      ) : (
        <Table label={label}>
          <TableHeader>
            <TableRow>
              <SortHead label="Closed (New York)" k="at" sort={sort} onSort={onSort} />
              <SortHead label="Contract" k="what" sort={sort} onSort={onSort} />
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">In → out</TableHead>
              <SortHead label="Result" k="pnl" sort={sort} onSort={onSort} className="text-right [&>button]:flex-row-reverse" />
              <SortHead label="On premium" k="rop" sort={sort} onSort={onSort} className="text-right [&>button]:flex-row-reverse" />
              <SortHead label="Held" k="holdMin" sort={sort} onSort={onSort} className="text-right [&>button]:flex-row-reverse" />
              <TableHead>How it ended</TableHead>
              {detail ? <TableHead>Hypothesis · rules</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.map((r) => (
              <TableRow key={r.id} data-trade={r.id}>
                <TableCell>
                  <span className="font-medium">{r.day}</span>{" "}
                  <span className="text-muted-foreground font-mono text-xs">
                    {r.opened}–{r.closed}
                    {r.roughTime ? <span title="A time was missing from the trade's own record; the journal line's time stands in.">*</span> : null}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    <Badge variant={r.kind === "call" ? "info" : "neutral"}>{r.kind === "call" ? "Call" : "Put"}</Badge>
                    {r.what}
                    {r.short ? <Badge variant="outline">Sold first</Badge> : null}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono">{r.qty}</TableCell>
                <TableCell className="text-right font-mono">
                  {price(r.entry)} → {price(r.exit)}
                </TableCell>
                <TableCell className={cn("text-right font-mono font-semibold", tone(r.pnl))}>
                  <Dollars env={env} value={r.pnl} signed />
                </TableCell>
                <TableCell className={cn("text-right font-mono", tone(r.rop))}>
                  {r.rop === null ? "—" : signed(r.rop * 100, 1, "%")}
                  {r.r === null ? null : <span className="text-muted-foreground ml-1.5 text-xs">{signed(r.r, 2, "R")}</span>}
                </TableCell>
                <TableCell className="text-right font-mono">{r.held}</TableCell>
                <TableCell>{r.reason}</TableCell>
                {detail ? (
                  <TableCell className="text-muted-foreground text-xs">
                    {r.hyp ?? "—"}
                    {r.window ? ` · ${r.window}` : ""}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {view.length > shown ? (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="hover:bg-muted focus-visible:outline-ring h-8 justify-self-start rounded-md border px-3 text-xs font-medium focus-visible:outline-2 max-sm:h-11 max-sm:text-sm"
        >
          Show {Math.min(PAGE, view.length - shown)} more of {(view.length - shown).toLocaleString("en-US")}
        </button>
      ) : null}
    </div>
  );
}
