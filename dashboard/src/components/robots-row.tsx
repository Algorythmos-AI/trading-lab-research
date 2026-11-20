// The three robots in one row: the options clone, Gap Hunter and the research arms, each with its state in a word and
// a link to its own page. Every page that sums up "the robots" draws this, so they always read as the same three.
// States only: no money is shown here, so the row needs no evidence frame.
import { Bot } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/status";
import type { RobotLine } from "@/lib/programme";
import { cn } from "@/lib/utils";

export function RobotsRow({ lines, id = "robots", note, className }: { lines: RobotLine[]; id?: string; note?: React.ReactNode; className?: string }) {
  return (
    <section aria-labelledby={`${id}-title`} className={cn("grid gap-2", className)} data-robots={lines.length}>
      <h2 id={`${id}-title`} className="text-muted-foreground flex items-center gap-2 text-sm font-semibold">
        <Bot aria-hidden className="size-4" />
        The three robots (paper)
      </h2>
      <ul className="bg-border grid gap-px overflow-hidden rounded-lg border sm:grid-cols-3">
        {lines.map((r) => (
          <li key={r.key} className="bg-card grid">
            <Link href={r.href} className="hover:bg-muted/40 grid content-start gap-1.5 p-3 transition-colors" data-robot={r.key}>
              <span className="text-sm font-semibold">{r.name}</span>
              <span className="text-muted-foreground text-xs">{r.what}</span>
              <StatusBadge tone={r.tone} className="justify-self-start whitespace-normal">
                {r.state}
              </StatusBadge>
            </Link>
          </li>
        ))}
      </ul>
      {note ? <p className="text-muted-foreground max-w-prose text-xs">{note}</p> : null}
    </section>
  );
}
