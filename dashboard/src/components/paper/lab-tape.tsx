// The options lab's tape, as a daily line on the Paper page (DEC-0060, DEC-0067): is each session saved, is it
// trustworthy, and does it count for EXP-0052. Counts, rates and statuses only, from the host's `lab` block; no name,
// no price. Colour first: green counts, amber is shadow or partial, red does not count; the reason is in words.
import { Database } from "lucide-react";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LabSession, PaperOptions } from "@/lib/paper-options.types";
import { cn } from "@/lib/utils";

/** What each failed counting rule means, in words (EXP-0052 counting.session_counts_when). */
export const WHY: Record<LabSession["why_not"][number], string> = {
  v1: "recorded before the v2 recorder",
  no_focus: "no focus list for the day",
  opening: "a name was missing from the opening set",
  fresh_coverage: "fresh coverage under 99%",
  stale_run: "a name was stale for over 5 minutes",
  clock: "the host clock was off by over 250 ms",
  crossed: "over 0.5% of quotes were crossed",
  not_recorded: "nothing recorded",
};

const STOPPED: Record<NonNullable<LabSession["stopped"]>, string> = {
  off_switch: "stopped by the off switch",
  stopped: "stopped from outside",
  memory: "stopped at its memory limit",
  disk: "stopped on low disk",
  errors: "stopped after repeated errors",
  never_finished: "never finished",
  other: "stopped early",
};

/** One session's state: what the colour says. */
export function verdict(s: LabSession): { tone: "good" | "warn" | "bad"; label: string } {
  if (!s.recorded) return { tone: "bad", label: "Not recorded" };
  if (!s.counts) return { tone: "bad", label: "Does not count" };
  if (s.shadow) return { tone: "warn", label: s.partial ? "Shadow, partial" : "Shadow" };
  return s.partial ? { tone: "warn", label: "Counts, partial" } : { tone: "good", label: "Counts" };
}

/** The recorder backs off when under 30% of Alpaca's minute is left (wt.lab.recorder Settings.back_off_share). */
export const LOW_HEADROOM = 0.3;
/** DEC-0060 point 4: the upload is finished by close plus 110 minutes. */
export const UPLOAD_WITHIN_MIN = 110;

const pct = (v: number | null, digits = 2) => (v === null ? "—" : `${(v * 100).toFixed(digits)}%`);
const TONE = { good: "bg-good-soft text-good", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad" } as const;
const DOT = { good: "bg-good-fill", warn: "bg-warn-fill", bad: "bg-bad-fill" } as const;

/** A stale run's length: seconds under two minutes (2026-11-24's 25 s read "0 min"), minutes above. */
export function staleSpan(sec: number | null): string {
  const v = sec ?? 0;
  return v < 120 ? `${Math.round(v)} s` : `${Math.round(v / 60)} min`;
}

/** Where the stale name-ticks fell, from recorder manifests that carry the split (schema 6); "" before them. */
export function staleSplit(s: LabSession): string {
  const start = s.stale_slow_start ?? null;
  const mid = s.stale_mid_session ?? null;
  if (start === null || mid === null) return "";
  return ` (${start} name-${start === 1 ? "tick" : "ticks"} before first fresh, ${mid} mid-session)`;
}

export function notes(s: LabSession): string {
  const out = [...s.why_not.filter((w) => w !== "not_recorded").map((w) => WHY[w])];
  if (s.stopped) out.push(STOPPED[s.stopped]);
  if (s.ticks_down) out.push(`${s.ticks_down} ${s.ticks_down === 1 ? "tick" : "ticks"} not run`);
  if (s.stale_names) out.push(`${s.stale_names} ${s.stale_names === 1 ? "name" : "names"} stale for ${staleSpan(s.longest_stale_s)} at most${staleSplit(s)}`);
  if (s.recorded && !s.after_close_ok) out.push("after-close pull incomplete");
  if (s.recorded && !s.archived) out.push("not archived yet");
  if (s.upload_late && s.upload_after_close_min != null) out.push(`uploaded ${(s.upload_after_close_min / 60).toFixed(1)} h after the close (due within 110 min)`);
  if (s.rate_limit_429) out.push(`${s.rate_limit_429} ${s.rate_limit_429 === 1 ? "request" : "requests"} refused by Alpaca's rate limit`);
  if (s.budget_refused) out.push(`${s.budget_refused} sweep ${s.budget_refused === 1 ? "batch" : "batches"} skipped by the lab's own request budget`);
  if (s.rate_limit_low) out.push(`rate limit under 30% left ${s.rate_limit_low} ${s.rate_limit_low === 1 ? "time" : "times"}`);
  return out.join("; ");
}

export function LabTape({ doc }: { doc: PaperOptions | null }) {
  const lab = doc?.lab ?? null;
  if (!lab || lab.sessions.length === 0) {
    return (
      <Empty icon={Database} title="The lab's tape status is not being sent yet">
        Once the trading host sends it, one line a session shows whether the day was saved, whether its quotes were fresh, and whether it counts.
      </Empty>
    );
  }
  const rows = [...lab.sessions].reverse();
  const shadowLeft = Math.max(0, lab.shadow_needed - lab.shadow_done);
  const unarchived = lab.recorded - lab.archived;
  const late = lab.uploads_late ?? 0;
  return (
    <Panel
      id="lab-tape"
      title="Options lab tape"
      icon={Database}
      means="The lab records the focus names' option quotes every 5 seconds to measure real fills and costs later. One line a session: was it saved, were the quotes fresh, and does it count."
    >
      <div className="mb-4 flex flex-wrap gap-2 text-sm" data-lab-summary>
        <span className={cn("rounded-md px-2 py-1 font-medium", shadowLeft ? TONE.warn : TONE.good)}>
          {shadowLeft ? `Shadow ${lab.shadow_done} of ${lab.shadow_needed}` : "Shadow period done"}
        </span>
        <span className={cn("rounded-md px-2 py-1 font-medium", lab.counted ? TONE.good : "bg-muted text-muted-foreground")}>
          {lab.counted} counted {lab.counted === 1 ? "session" : "sessions"}
        </span>
        <span className={cn("rounded-md px-2 py-1 font-medium", unarchived ? TONE.bad : TONE.good)}>
          {unarchived ? `${unarchived} of ${lab.recorded} not archived` : `All ${lab.recorded} archived`}
        </span>
        {late ? (
          <span className={cn("rounded-md px-2 py-1 font-medium", TONE.warn)} data-lab-late>
            {late} {late === 1 ? "upload" : "uploads"} past close + 110 min
          </span>
        ) : null}
      </div>
      <Table label="Options lab tape, one row a session, newest first">
        <TableHeader>
          <TableRow>
            <TableHead>Day</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="text-right">Fresh coverage</TableHead>
            <TableHead className="text-right max-sm:hidden">Contracts</TableHead>
            <TableHead className="text-right max-sm:hidden">Crossed</TableHead>
            <TableHead className="text-right max-sm:hidden" title="The lowest share of Alpaca's per-minute request limit left during the session">Rate-limit low</TableHead>
            <TableHead className="text-right max-sm:hidden" title="From the close to the verified upload">Upload</TableHead>
            <TableHead className="max-sm:hidden">Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => {
            const v = verdict(s);
            const fresh = s.recorder === 2 ? s.coverage_fresh : s.coverage;
            return (
              <TableRow key={s.date} data-lab-session={s.date} data-tone={v.tone}>
                <TableCell className="font-mono">{s.date}</TableCell>
                <TableCell>
                  <span className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium", TONE[v.tone])}>
                    <span aria-hidden className={cn("size-2 rounded-full", DOT[v.tone])} />
                    {v.label}
                  </span>
                  {notes(s) ? <p className="text-muted-foreground mt-1 max-w-56 text-xs whitespace-normal sm:hidden">{notes(s)}</p> : null}
                </TableCell>
                <TableCell className={cn("text-right font-mono", fresh !== null && fresh < 0.99 ? "text-bad" : "")}>
                  {pct(fresh)}
                  {s.recorder === 1 ? <span className="text-muted-foreground" title="Recorded before freshness was checked: this is plain coverage"> v1</span> : null}
                </TableCell>
                <TableCell className="text-right font-mono max-sm:hidden">{(s.tier1 + s.tier2).toLocaleString("en-US")}</TableCell>
                <TableCell className={cn("text-right font-mono max-sm:hidden", s.crossed_share !== null && s.crossed_share > 0.005 ? "text-bad" : "")}>{pct(s.crossed_share)}</TableCell>
                <TableCell
                  className={cn("text-right font-mono max-sm:hidden", s.rate_limit_min_share != null && s.rate_limit_min_share < LOW_HEADROOM ? "text-warn" : "")}
                  data-lab-headroom
                >
                  {pct(s.rate_limit_min_share ?? null, 0)}
                </TableCell>
                <TableCell className={cn("text-right font-mono max-sm:hidden", s.upload_late ? "text-warn" : "")} data-lab-upload>
                  {s.upload_after_close_min == null ? "—" : `${(s.upload_after_close_min / 60).toFixed(1)} h`}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs whitespace-normal max-sm:hidden">{notes(s) || "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-muted-foreground mt-3 max-w-prose text-xs">
        The first {lab.shadow_needed} sessions from {lab.first_v2} are a shadow period and count for nothing; tables start after that. A session counts when its quotes were fresh
        for at least 99% of the samples, no name was stale for more than 5 minutes, the host clock was within 250 ms and crossed quotes were at most 0.5% (DEC-0067).
        Rate-limit low is the least of Alpaca&apos;s per-minute request allowance left during the session (the recorder slows down under 30%); Upload is the time from the close until
        the day was verified in the archive, due within 110 minutes (DEC-0060). The rate-limit figures stop at the close, before the after-close pull.
      </p>
    </Panel>
  );
}
