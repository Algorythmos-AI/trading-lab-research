// How a trial's verdict is worked out (DEC-0030 section 6, as `wt.options.arms_verdict` runs it), drawn as a flow
// with no data on it: nothing here is a result or looks like one. The method's own constants (5,000 draws, 95%, 30
// and 20) are the only numbers. Beside it, the descriptive band of DEC-0080, switched off until that record is
// accepted (research-arms-band.ts).
import { BOOTSTRAP, COUNT } from "@/lib/research-arms";

const STEPS = [
  { title: "Group by session", body: "Each trade sits in the New York session it was taken in." },
  { title: "Draw sessions again", body: `Whole sessions are drawn at random, with replacement, ${BOOTSTRAP.draws.toLocaleString("en-US")} times.` },
  { title: "Mean of each draw", body: "The trial's quantity is worked out on every draw." },
  { title: `The ${Math.round(BOOTSTRAP.level * 100)}% range`, body: "The middle of those means: from the 2.5th to the 97.5th percentile." },
];

export function VerdictTest() {
  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
      <figure className="grid content-start gap-3">
        <ol className="grid gap-2 sm:grid-cols-4" aria-label="The session bootstrap, step by step">
          {STEPS.map((s, i) => (
            <li key={s.title} className="bg-muted/40 relative grid content-start gap-1 rounded-lg border px-3 py-2.5">
              <span className="text-muted-foreground font-mono text-xs">{i + 1}</span>
              <span className="text-sm font-medium">{s.title}</span>
              <span className="text-muted-foreground text-[0.8125rem] leading-snug">{s.body}</span>
            </li>
          ))}
        </ol>
        <figcaption className="text-muted-foreground text-xs">
          The method only. No arm reached its count, so no verdict range exists for any of them; the page shows no made-up example.
        </figcaption>
      </figure>
      <div className="grid content-start gap-3 text-sm">
        <div className="bg-muted/50 rounded-md border px-3 py-2.5">
          <p className="font-medium">Before any test</p>
          <p className="text-muted-foreground text-[0.8125rem]">
            At least {COUNT.units} trades (for a tag arm, in each group) and {COUNT.sessions} sessions. Fewer by the close date, and the trial closes with no verdict.
          </p>
        </div>
        <p className="text-muted-foreground text-xs font-medium tracking-wide">FALSIFIED IF EITHER HOLDS</p>
        <ol className="grid gap-2">
          <li className="border-bad/40 bg-bad-soft rounded-md border px-3 py-2">
            <span className="font-medium">The range reaches zero.</span>{" "}
            <span className="text-muted-foreground text-[0.8125rem]">Its lower end is at or below 0.</span>
          </li>
          <li className="border-bad/40 bg-bad-soft rounded-md border px-3 py-2">
            <span className="font-medium">Either half fails.</span>{" "}
            <span className="text-muted-foreground text-[0.8125rem]">The quantity is at or below 0 in the first or the second half of the trades, taken in order.</span>
          </li>
        </ol>
        <p className="text-muted-foreground text-[0.8125rem]">
          Passing changes no rule: it earns a new record, with new trials. The arms ended with at most 9 sessions, so none of them can reach {COUNT.sessions}.
        </p>
      </div>
    </div>
  );
}
