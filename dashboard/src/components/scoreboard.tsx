import { humanize, verdictTone } from "@/lib/labels";
import { fracPct, num, rMult, txt } from "@/lib/format";
import type { ScoreRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { StatusBadge, ToneIcon } from "./status";

const DSR_BAR = 0.95;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function CiBar({ row, span }: { row: ScoreRow; span: number }) {
  const pos = (v: number) => `${((v + span) / (2 * span)) * 100}%`;
  const lo = row.ci_low;
  const hi = row.ci_high;
  const mid = row.expectancy_r;
  const clearsZero = isNum(lo) && lo > 0;
  const belowZero = isNum(hi) && hi < 0;
  return (
    <div className="bg-track relative h-3 rounded-full" aria-hidden>
      <span className="bg-muted-foreground/60 absolute top-[-3px] bottom-[-3px] left-1/2 w-px" />
      {isNum(lo) && isNum(hi) ? (
        <span
          className={cn(
            "absolute top-0.5 bottom-0.5 rounded-full",
            clearsZero ? "bg-good-fill" : belowZero ? "bg-bad-fill" : "bg-neutral-fill",
          )}
          style={{ left: pos(Math.max(-span, lo)), width: `${((Math.min(span, hi) - Math.max(-span, lo)) / (2 * span)) * 100}%` }}
        />
      ) : null}
      {isNum(mid) ? (
        <span
          className="bg-foreground ring-card absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
          style={{ left: pos(Math.max(-span, Math.min(span, mid))) }}
        />
      ) : null}
    </div>
  );
}

/**
 * G1 scoreboard. Each row shows expectancy with its 95% interval around zero: an edge is only
 * credible when the whole interval sits right of zero and the deflated Sharpe clears 0.95.
 */
export function Scoreboard({ rows }: { rows: ScoreRow[] }) {
  const extent = Math.max(
    0.05,
    ...rows.flatMap((r) => [r.ci_low, r.ci_high, r.expectancy_r].filter(isNum).map(Math.abs)),
  );
  const span = extent * 1.1;
  const cols = "md:grid-cols-[minmax(11rem,1.3fr)_minmax(9rem,1.6fr)_4rem_3.5rem_4.5rem_3.5rem_7rem]";
  return (
    <div className="text-[0.8125rem]">
      <div className={cn("text-muted-foreground hidden gap-3 border-b pb-2 text-xs md:grid", cols)}>
        <span>Candidate</span>
        <span className="flex justify-between">
          <span>Expectancy, 95% interval</span>
          <span>0 at centre</span>
        </span>
        <span className="text-right">Trades</span>
        <span className="text-right">PF</span>
        <span className="text-right">DSR</span>
        <span className="text-right">Win</span>
        <span className="text-right">Verdict</span>
      </div>
      <ul className="divide-border divide-y">
        {rows.map((r, i) => {
          const dsrOk = isNum(r.dsr) && r.dsr >= DSR_BAR;
          return (
            <li key={`${r.label}-${i}`} className={cn("grid gap-x-3 gap-y-2 py-3 md:items-center md:py-2.5", cols)}>
              <div className="min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{txt(r.label)}</span>
                  <StatusBadge tone={verdictTone(r.verdict)} className="md:hidden">
                    {humanize(r.verdict)}
                  </StatusBadge>
                </div>
                <div className="text-muted-foreground mt-0.5 text-xs">
                  {humanize(r.span)}
                  {r.ref ? <span className="font-mono"> {r.ref}</span> : null}
                </div>
                {r.note ? <div className="text-muted-foreground mt-0.5 text-xs">{r.note}</div> : null}
                {r.error ? <div className="text-bad mt-0.5 text-xs">{r.error}</div> : null}
              </div>
              <div className="grid gap-1">
                <CiBar row={r} span={span} />
                <div className="text-xs">
                  <span className="font-medium">{rMult(r.expectancy_r)}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    ({rMult(r.ci_low)} to {rMult(r.ci_high)})
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 md:contents">
                <Stat label="Trades" value={num(r.n)} />
                <Stat label="PF" value={num(r.profit_factor, 2)} />
                <Stat
                  label="DSR"
                  value={
                    <span className="inline-flex items-center gap-1">
                      {isNum(r.dsr) ? <ToneIcon tone={dsrOk ? "good" : "warn"} className="size-3.5" label={dsrOk ? "Passes 0.95" : "Below 0.95"} /> : null}
                      {num(r.dsr, 2)}
                    </span>
                  }
                />
                <Stat label="Win" value={fracPct(r.win_rate, 0)} />
              </div>
              <div className="hidden justify-end md:flex">
                <StatusBadge tone={verdictTone(r.verdict)}>{humanize(r.verdict)}</StatusBadge>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="md:text-right">
      <div className="text-muted-foreground text-xs md:hidden">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
