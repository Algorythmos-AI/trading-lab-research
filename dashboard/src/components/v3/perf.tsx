import { ChartSpline, ScrollText } from "lucide-react";
import { Columns } from "@/components/charts/columns";
import { CumulativeChart } from "@/components/charts/cumulative-chart";
import { TradeBars } from "@/components/charts/trade-bars";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Panel } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fracPct, num, rMult, shortDate, signed, txt } from "@/lib/format";
import { list, type Snapshot } from "@/lib/types";
import { binSide, profitFactorText, sectionState, suppressedReason } from "@/lib/v3";
import { V3Missing, V3Pending } from "./pending";

/** Strategy B's paper results, honest at small samples: statistics that would mislead stay blank, with the reason. */
export function PerformancePanel({ s }: { s: Snapshot }) {
  const p = s.perf;
  const st = p?.stats;
  const curve = list(p?.curve);
  const bins = list(p?.histogram);
  const why = suppressedReason(st, p?.min_trades);
  const closedCount = list(s.blotter).length;
  const ci =
    st?.sample_ok === true && typeof st.ci_low === "number" && typeof st.ci_high === "number"
      ? `${rMult(st.ci_low, 2)} to ${rMult(st.ci_high, 2)}`
      : "—";
  return (
    <Panel
      id="performance"
      title="Paper B performance"
      icon={ChartSpline}
      means="Closed paper trades in R (1R = the amount risked to the stop). Trades whose exit price had to be estimated are left out. Paper results are evidence for the G2 gate, not a forecast."
    >
      {sectionState(s, p) === "v2" ? (
        <V3Pending what="The performance summary" />
      ) : sectionState(s, p) === "missing" ? (
        <V3Missing what="The performance summary" />
      ) : !st || (st.n ?? 0) === 0 ? (
        closedCount > 0 ? (
          <Empty title={`${num(closedCount)} closed trade${closedCount === 1 ? "" : "s"}, none countable yet`}>
            Trades with an estimated exit price, or positions adopted rather than opened by B, are left out of the
            statistics. They are listed in the blotter.
          </Empty>
        ) : (
          <Empty title="No closed trades yet">Statistics appear after paper B&rsquo;s first closed trade.</Empty>
        )
      ) : (
        <div className="grid gap-5">
          <KeyValues
            items={[
              { label: "Trades counted", value: `${num(st.n)}${st.excluded_estimated ? ` (+${num(st.excluded_estimated)} estimated, excluded)` : ""}` },
              { label: "Win rate", value: fracPct(st.win_rate) },
              { label: "Expectancy", value: rMult(st.expectancy_r, 2) },
              { label: "Total", value: rMult(st.total_r, 2) },
              { label: "Average win / loss", value: `${rMult(st.avg_win_r, 2)} / ${rMult(st.avg_loss_r, 2)}` },
              { label: "Max drawdown", value: `${signed(p?.max_dd_pct, 2)}% · ${rMult(p?.max_dd_r, 2)}` },
              { label: "95% interval of expectancy", value: ci },
              { label: "Profit factor", value: profitFactorText(st) ?? "—" },
              {
                label: "Sharpe (annualised, per session)",
                value: typeof st.sharpe === "number" ? st.sharpe.toFixed(2) : "—",
              },
            ]}
          />
          {why ? <p className="text-muted-foreground text-xs">{why}</p> : null}
          {p?.sessions != null && p.min_sessions != null && p.sessions < p.min_sessions ? (
            <p className="text-muted-foreground text-xs">
              Sharpe needs {num(p.min_sessions)} armed sessions (now {num(p.sessions)}).
            </p>
          ) : null}
          {curve.length >= 2 ? (
            <section className="grid gap-2">
              <h3 className="text-sm font-medium">Running total, trade by trade</h3>
              <CumulativeChart points={cumulativePoints(curve)} />
            </section>
          ) : null}
          {p?.band?.available === false ? (
            <p className="text-muted-foreground text-xs">Expectation band: {txt(p.band.reason)}.</p>
          ) : null}
          {bins.length > 0 ? (
            <section className="grid gap-2">
              <h3 className="text-sm font-medium">How the trades ended, in bands of R</h3>
              <Columns
                label="Number of trades per band of R"
                columns={bins.map((b) => ({ key: txt(b.bin), label: txt(b.bin), count: b.count ?? 0, side: binSide(b.bin) }))}
              />
              <p className="text-muted-foreground text-xs">Red bands lost, green bands gained. A healthy rule has its losses bunched near −1R and a tail to the right.</p>
            </section>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/** The published curve as chart points: one per counted trade, in order. */
export function cumulativePoints(curve: { date?: string | null; cum_r?: number | null; dd_r?: number | null }[]) {
  return curve.map((c, i) => ({ i: i + 1, day: shortDate(c.date), cum: c.cum_r ?? null, dd: c.dd_r ?? null }));
}

/** The last closed trades (newest first). Prices and R only. */
export function BlotterPanel({ s }: { s: Snapshot }) {
  const rows = list(s.blotter).slice().reverse();
  return (
    <Panel
      id="blotter"
      title="Trade blotter"
      icon={ScrollText}
      means="Every closed paper trade, newest first. 'Estimated' means no exit fill was found and the stop price stood in; those trades are excluded from the statistics."
    >
      {sectionState(s, s.blotter) === "v2" ? (
        <V3Pending what="The blotter" />
      ) : sectionState(s, s.blotter) === "missing" ? (
        <V3Missing what="The blotter" />
      ) : rows.length === 0 ? (
        <Empty title="No closed trades yet" />
      ) : (
        <div className="grid gap-4">
          <TradeBars
            label="Result of each closed paper trade in R, oldest first"
            whenLabel="Day"
            trades={list(s.blotter)
              .filter((r) => typeof r.r === "number")
              .map((r, i) => ({ i: i + 1, r: r.r as number, what: `${txt(r.symbol)} · ${txt(r.reason)}${r.estimated ? " (estimated)" : ""}`, when: shortDate(r.date) }))}
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Entry</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Exit</TableHead>
                <TableHead className="text-right">R</TableHead>
                <TableHead>Exit reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 30).map((r, i) => (
                <TableRow key={`${r.date}-${i}`}>
                  <TableCell className="whitespace-nowrap">{shortDate(r.date)}</TableCell>
                  <TableCell className="font-mono">{txt(r.symbol)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.qty)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{num(r.entry, 2)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{num(r.exit, 2)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {rMult(r.r, 2)}
                    {r.estimated ? <span className="text-muted-foreground font-normal"> (est.)</span> : null}
                  </TableCell>
                  <TableCell>
                    {txt(r.reason)}
                    {r.origin && r.origin !== "entry" ? <span className="text-muted-foreground"> · {r.origin}</span> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}
