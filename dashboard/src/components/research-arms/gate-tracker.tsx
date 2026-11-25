// The lab's road from recording (stage 1) to its first tables (stage 2): each shadow session (would it have counted?),
// each later session (counted or not), and one empty cell per counted session still needed, from the document's lab
// block. Then EXP-0052's four tables, locked until the first read point. Counts and statuses only.
import { Lock } from "lucide-react";
import { Empty } from "@/components/empty";
import { WHY } from "@/components/paper/lab-tape";
import { FIRST_READ, NEXT_TABLES, type GateCell, type GateTrack } from "@/lib/research-arms";
import { cn } from "@/lib/utils";

const CELL: Record<GateCell["state"], { cls: string; word: string }> = {
  counted: { cls: "bg-good-fill border-good-fill", word: "Counted" },
  "would-count": { cls: "bg-good-soft border-good-fill border-dashed", word: "Shadow, would have counted" },
  failed: { cls: "bg-bad-soft border-bad-fill", word: "Did not count" },
  pending: { cls: "bg-transparent border-border border-dashed", word: "Still to come" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (ymd: string) => `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;

function title(c: GateCell): string {
  const why = c.why.filter((w) => w in WHY).map((w) => WHY[w as keyof typeof WHY]);
  return `${c.date ? `${day(c.date)}: ` : ""}${CELL[c.state].word}${why.length ? ` (${why.join("; ")})` : ""}`;
}

/** The counted session the owner's lab plan builds the stage-2 tables at: an operational step, not a rule of any record. */
export const PLAN_BUILD_AT = 10;

function Cells({ cells, label, marks = false }: { cells: GateCell[]; label: string; marks?: boolean }) {
  // The nth slot toward the count: a counted session or a pending one, never a session that did not count.
  let slot = 0;
  return (
    <ol className="flex flex-wrap gap-1" aria-label={label}>
      {cells.map((c, i) => {
        const n = marks && c.state !== "failed" ? ++slot : 0;
        const plan = n === PLAN_BUILD_AT;
        const read = n === FIRST_READ;
        const note = plan ? `; counted session ${PLAN_BUILD_AT}: stage 2 tables built (owner plan, not a record)` : read ? `; counted session ${FIRST_READ}: first read point (EXP-0052)` : "";
        return (
          <li
            key={i}
            title={title(c) + note}
            className={cn("size-5 rounded border-2 sm:size-6", CELL[c.state].cls, plan && "ring-info-fill ring-2 ring-offset-1", read && "ring-foreground ring-2 ring-offset-1")}
            data-gate={c.state}
            data-gate-mark={plan ? "plan" : read ? "read" : undefined}
          >
            <span className="sr-only">{title(c) + note}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function GateTracker({ track, unread = false }: { track: GateTrack | null; unread?: boolean }) {
  return (
    <div className="grid gap-5">
      {track ? (
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <p className="text-muted-foreground text-xs font-medium">Stage 1 · shadow sessions ({track.shadow.filter((c) => c.state !== "pending").length} of {track.shadow.length})</p>
            <Cells cells={track.shadow} label="Shadow sessions" />
          </div>
          <div className="grid gap-1.5">
            <p className="text-muted-foreground text-xs font-medium">
              Stage 1 · toward {FIRST_READ} counted sessions ({track.counting.filter((c) => c.state === "counted").length} counted)
            </p>
            <Cells cells={track.counting} label={`Sessions toward the first ${FIRST_READ} counted`} marks />
            <p className="text-muted-foreground text-xs">
              Ringed in black: counted session {FIRST_READ}, the first read point (EXP-0052, <span className="font-mono">read_points_counted_sessions</span>). Ringed in blue: counted session{" "}
              {PLAN_BUILD_AT}, where the owner&apos;s lab plan builds the stage-2 tables; a plan step, not a rule of any record.
            </p>
          </div>
          <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="What the cells mean">
            {(Object.keys(CELL) as GateCell["state"][]).map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <span aria-hidden className={cn("inline-block size-3 rounded-sm border-2", CELL[k].cls)} />
                {CELL[k].word}
              </li>
            ))}
          </ul>
          {track.partial ? <p className="text-muted-foreground text-xs">The document lists the newest 20 sessions; older ones are in the counts, not drawn.</p> : null}
        </div>
      ) : (
        <Empty title={unread ? "The lab's sessions could not be read" : "The lab's sessions are not being sent yet"}>
          {unread ? "Storage did not answer. Reload in a minute." : "Once the trading host sends the lab block, each session shows here as a cell."}
        </Empty>
      )}
      <div className="grid gap-2">
        <p className="text-muted-foreground text-xs font-medium">Stage 2 · the first tables, at {FIRST_READ} counted sessions</p>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {NEXT_TABLES.map((t) => (
            <li key={t.key} className="bg-muted/30 grid content-start gap-1 rounded-lg border border-dashed px-3 py-2.5" data-next-table={t.key}>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Lock aria-hidden className="text-muted-foreground size-3.5" />
                {t.title}
              </span>
              <span className="text-muted-foreground text-[0.8125rem] leading-snug">{t.what}</span>
              <span className="text-muted-foreground text-xs">Locked until {FIRST_READ} counted sessions</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
