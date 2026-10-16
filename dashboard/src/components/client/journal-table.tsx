"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface JournalRow {
  id: string;
  /** "16 Oct 26 · 14:07" in New York. */
  when: string;
  /** Milliseconds, for sorting. */
  at: number;
  symbol: string;
  what: string;
  kind: "call" | "put" | "stock";
  qty: number;
  entry: number;
  exit: number;
  pnl: number;
  /** "3 min" */
  held: string;
  holdMin: number;
  expired: boolean;
}

type SortKey = "at" | "pnl" | "holdMin" | "qty";

const usd2 = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PAGE = 50;

/** Every closed trade in the filter, newest first, with a search box, sorting and a "show more". Read only. */
export function JournalTable({ rows }: { rows: JournalRow[] }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "at", dir: -1 });
  const [shown, setShown] = useState(PAGE);
  const [only, setOnly] = useState<"all" | "win" | "loss">("all");

  const list = useMemo(() => {
    const needle = q.trim().toUpperCase();
    const kept = rows.filter((r) => {
      if (only === "win" && r.pnl <= 0) return false;
      if (only === "loss" && r.pnl >= 0) return false;
      return !needle || r.what.toUpperCase().includes(needle) || r.when.toUpperCase().includes(needle);
    });
    return kept.sort((a, b) => (a[sort.key] - b[sort.key]) * sort.dir);
  }, [rows, q, sort, only]);

  const head = (key: SortKey, label: string, className?: string) => (
    <TableHead className={className} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className="hover:text-foreground inline-flex items-center gap-1"
        onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 }))}
      >
        {label}
        <span aria-hidden className="text-[0.625rem]">
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
            setShown(PAGE);
          }}
          placeholder="Find a ticker, strike or date"
          aria-label="Find a trade"
          className="bg-background h-8 w-full max-w-64 rounded-md border px-2.5 text-sm"
        />
        <div className="flex gap-1" role="group" aria-label="Show">
          {(["all", "win", "loss"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={only === k}
              onClick={() => {
                setOnly(k);
                setShown(PAGE);
              }}
              className={cn("h-8 rounded-md border px-2.5 text-xs", only === k ? "bg-secondary text-foreground font-medium" : "text-muted-foreground")}
            >
              {k === "all" ? "All" : k === "win" ? "Winners" : "Losers"}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground ml-auto text-xs">
          {list.length.toLocaleString("en-US")} trade{list.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {head("at", "Closed (New York)")}
              <TableHead>Contract</TableHead>
              {head("qty", "Qty", "text-right")}
              <TableHead className="text-right">In → out</TableHead>
              {head("holdMin", "Held", "text-right")}
              {head("pnl", "Result", "text-right")}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.slice(0, shown).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">{r.when}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="font-medium">{r.what}</span>
                  {r.expired ? (
                    <Badge variant="warn" className="ml-1.5">
                      Expired
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">{r.qty.toLocaleString("en-US")}</TableCell>
                <TableCell className="text-right font-mono text-xs whitespace-nowrap">
                  {r.entry.toFixed(2)} → {r.exit.toFixed(2)}
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-xs whitespace-nowrap">{r.held}</TableCell>
                <TableCell className={cn("text-right font-mono text-xs font-semibold whitespace-nowrap", r.pnl > 0 ? "text-good" : r.pnl < 0 ? "text-bad" : "")}>{usd2(r.pnl)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {shown < list.length ? (
        <button type="button" onClick={() => setShown((n) => n + PAGE * 4)} className="text-muted-foreground hover:text-foreground mx-auto h-8 rounded-md border px-3 text-xs">
          Show more ({(list.length - shown).toLocaleString("en-US")} left)
        </button>
      ) : null}
    </div>
  );
}
