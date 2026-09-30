import { ChartSpline, ScrollText } from "lucide-react";
import { DataDetails } from "@/components/data-details";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { Panel } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fracPct, num, rMult, shortDate, signed, txt } from "@/lib/format";
import { list, type Snapshot } from "@/lib/types";
import { profitFactorText, sectionState, suppressedReason } from "@/lib/v3";
import { V3Missing, V3Pending } from "./pending";
import { Sparkline } from "./sparkline";

/** Strategy B's paper results, honest at small samples: statistics that would mislead stay blank, with the reason. */
export function PerformancePanel({ s }: { s: Snapshot }) {
  const p = s.perf;
  const st = p?.stats;
  const curve = list(p?.curve);
  const bins = list(p?.histogram);
  const maxBin = Math.max(1, ...bins.map((b) => b.count ?? 0));
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
            <div className="grid gap-1">
              <p className="text-muted-foreground text-xs">Cumulative R, trade by trade</p>
              <Sparkline values={curve.map((c) => c.cum_r ?? 0)} label="Cumulative R by trade" />
            </div>
          ) : null}
          {p?.band?.available === false ? (
            <p className="text-muted-foreground text-xs">Expectation band: {txt(p.band.reason)}.</p>
          ) : null}
          <DataDetails summary="Show the R distribution">
            <div className="grid gap-2">
              {bins.map((b) => (
                <Meter key={b.bin} label={`${txt(b.bin)} R`} value={b.count} max={maxBin} valueText={num(b.count)} />
              ))}
            </div>
          </DataDetails>
        </div>
      )}
    </Panel>
  );
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
      )}
    </Panel>
  );
}
