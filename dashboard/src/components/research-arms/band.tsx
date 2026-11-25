// DEC-0080 / EXP-0056: the descriptive session-bootstrap band on two shadow arms' own trades. Not a verdict. While
// DEC-0080 is only proposed (`BAND_ACCEPTED` false) this draws no number: it says what the band will show and why
// it waits. Accepted, it draws each banded arm's range against zero from the document's real trades.
import { Lock } from "lucide-react";
import { Empty } from "@/components/empty";
import { EnvFrame } from "@/components/ui/env-chip";
import type { ArmBook } from "@/lib/paper";
import { BAND_ACCEPTED, BANDED, armBand, type Band } from "@/lib/research-arms-band";
import { COUNT, recordHref } from "@/lib/research-arms";

export const BAND_FRAME = "Shadow arms, descriptive band";

const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)}%`);

function BandRow({ hyp, b }: { hyp: string; b: Band | null }) {
  if (!b) return <Empty title={`${hyp}: no trade in its window`}>No band can be drawn without a trade.</Empty>;
  const lo = Math.min(0, b.range?.[0] ?? b.mean, b.mean);
  const hi = Math.max(0, b.range?.[1] ?? b.mean, b.mean);
  const span = hi - lo || 1;
  const x = (v: number) => 8 + ((v - lo) / span) * 384;
  return (
    <div className="grid gap-1.5" data-band={hyp}>
      <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <a href={recordHref(hyp)} className="font-mono underline decoration-dotted underline-offset-2">
          {hyp}
        </a>
        <span className="text-muted-foreground text-xs">
          {b.units} of {COUNT.units} trades · {b.sessions} of {COUNT.sessions} sessions
        </span>
      </p>
      <svg viewBox="0 0 400 34" className="h-9 w-full" role="img" aria-label={`${hyp}: mean ${pct(b.mean)}, range ${b.range ? `${pct(b.range[0])} to ${pct(b.range[1])}` : "not drawn, fewer than 2 sessions"}`}>
        <line x1={x(0)} x2={x(0)} y1={2} y2={32} stroke="var(--foreground)" strokeDasharray="3 3" />
        {b.range ? <rect x={x(b.range[0])} y={11} width={Math.max(2, x(b.range[1]) - x(b.range[0]))} height={12} rx={6} fill="var(--chart-1)" fillOpacity={0.35} /> : null}
        <circle cx={x(b.mean)} cy={17} r={4.5} fill="var(--chart-1)" />
      </svg>
      <p className="text-muted-foreground text-xs">
        Mean on the premium {pct(b.mean)} · range {b.range ? `${pct(b.range[0])} to ${pct(b.range[1])}` : "—"} · first half {pct(b.firstHalf)} · second half {pct(b.secondHalf)}
      </p>
    </div>
  );
}

export function DescriptiveBand({ books }: { books: ArmBook[] | null }) {
  if (!BAND_ACCEPTED) {
    return (
      <div className="bg-muted/40 grid gap-2 rounded-lg border border-dashed px-4 py-3" data-band-off="">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Lock aria-hidden className="text-muted-foreground size-4" />
          The band on real trades is switched off
        </p>
        <p className="text-muted-foreground text-[0.8125rem]">
          The same method, run on the real simulated trades of <span className="font-mono">{BANDED.join(" and ")}</span> from 5 to 17 Nov, is a new way of looking at a result. It waits for{" "}
          <a href={recordHref("DEC-0080")} className="font-mono underline decoration-dotted underline-offset-2">
            DEC-0080
          </a>
          , proposed. Accepting that record turns it on. Even then it is descriptive and not a verdict: 9 of 20 sessions at most.
        </p>
      </div>
    );
  }
  return (
    <EnvFrame env="shadow" label={BAND_FRAME} className="grid gap-4">
      <p className="text-sm font-medium">Descriptive, not a verdict: 9 of 20 sessions at most</p>
      {books === null ? (
        <Empty title="The arms' simulated trades are not being sent yet" />
      ) : (
        BANDED.map((hyp) => <BandRow key={hyp} hyp={hyp} b={armBand(books.find((b) => b.hyp === hyp))} />)
      )}
      <p className="text-muted-foreground text-xs">
        Each trade&apos;s result on the premium as the paper options document carries it. HYP-0044 and HYP-0045 have no band: they are paired with the control&apos;s own trades, and the document does not say which.
      </p>
    </EnvFrame>
  );
}
