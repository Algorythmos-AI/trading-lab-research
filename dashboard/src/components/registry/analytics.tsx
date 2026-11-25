import { Activity, BookOpen, CalendarClock, FlaskConical, GitCommitVertical, Lightbulb, Network, Scale, Sparkles, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Panel } from "@/components/panel";
import { StatTile } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status";
import { sydney } from "@/lib/format";
import type { RegistryIndex } from "@/lib/registry.types";
import {
  KIND_LABEL,
  KIND_PLURAL,
  KINDS,
  PHASE_LABEL,
  PHASES,
  STATUS_LABEL,
  STATUS_TONE,
  ago,
  counts,
  mostDependedOn,
  recentlyChanged,
  recordHref,
  timeline,
  type RecKind,
} from "@/lib/registry-view";

/** One colour per kind, from the site's categorical palette (globals.css), the same in every chart here. */
export const KIND_COLOUR: Record<RecKind, string> = { dec: "var(--chart-1)", hyp: "var(--chart-7)", exp: "var(--chart-3)", ll: "var(--chart-4)" };
// "Other" (recorded, no status, not read) is hatched so it never reads as one of the kind colours.
const PHASE_COLOUR = {
  active: "var(--good-fill)",
  pending: "var(--warn-fill)",
  done: "var(--neutral-fill)",
  other: "repeating-linear-gradient(135deg, var(--chart-na) 0 3px, transparent 3px 6px)",
} as const;
const KIND_ICON = { dec: Scale, hyp: Lightbulb, exp: FlaskConical, ll: BookOpen } as const;

export function KindDot({ kind }: { kind: RecKind }) {
  return <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: KIND_COLOUR[kind] }} />;
}

export function Headline({ doc, nowMs, base }: { doc: RegistryIndex; nowMs: number; base: string }) {
  const c = counts(doc, nowMs);
  const issues = doc.issues.length;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {KINDS.map((k) => {
        const p = c.byKindPhase[k];
        return (
          <Link key={k} href={`${base}${base.includes("?") ? "&" : "?"}k=${k}#records`} className="rounded-lg focus-visible:ring-2 focus-visible:outline-none">
            <StatTile
              label={KIND_PLURAL[k]}
              icon={KIND_ICON[k]}
              tone="info"
              value={c.byKind[k]}
              hint={k === "ll" ? "lessons learned" : `${p.active} active · ${p.pending} proposed · ${p.done} closed`}
            />
          </Link>
        );
      })}
      <StatTile label="New or changed, 7 days" icon={Sparkles} tone={c.newIn7d + c.changedIn7d > 0 ? "good" : "neutral"} value={`${c.newIn7d} / ${c.changedIn7d}`} hint="first seen / last changed" />
      <Link href={`${base}${base.includes("?") ? "&" : "?"}i=1#records`} className="rounded-lg focus-visible:ring-2 focus-visible:outline-none">
        <StatTile label="Need a look" icon={TriangleAlert} tone={issues > 0 ? "warn" : "good"} value={issues} hint={issues > 0 ? "files the job could not read cleanly" : "every file read cleanly"} />
      </Link>
    </div>
  );
}

/** Per kind, one bar split by phase, then each status as a chip that filters the list. */
export function StatusMix({ doc, nowMs, base }: { doc: RegistryIndex; nowMs: number; base: string }) {
  const c = counts(doc, nowMs);
  const sep = base.includes("?") ? "&" : "?";
  return (
    <Panel title="Status by kind" icon={Activity} means="How many records are in play, proposed, closed or other, per kind. Every chip opens the list filtered to it.">
      <div className="grid gap-4">
        <ul aria-label="Phases" className="text-muted-foreground flex flex-wrap gap-3 text-xs">
          {PHASES.map((p) => (
            <li key={p} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: PHASE_COLOUR[p] }} />
              {PHASE_LABEL[p]}
            </li>
          ))}
        </ul>
        {KINDS.map((k) => {
          const total = c.byKind[k];
          if (total === 0) return null;
          return (
            <div key={k} className="grid gap-1.5">
              <div className="flex items-baseline justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <KindDot kind={k} />
                  {KIND_PLURAL[k]}
                </span>
                <span className="text-muted-foreground tabular-nums">{total}</span>
              </div>
              <div role="img" aria-label={PHASES.map((p) => `${PHASE_LABEL[p]} ${c.byKindPhase[k][p]}`).join(", ")} className="bg-muted flex h-2.5 overflow-hidden rounded-full">
                {PHASES.map((p) =>
                  c.byKindPhase[k][p] > 0 ? <span key={p} style={{ width: `${(100 * c.byKindPhase[k][p]) / total}%`, background: PHASE_COLOUR[p] }} className="h-full border-r border-[var(--card)] last:border-0" /> : null,
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {c.byStatus
                  .filter((s) => s.kind === k)
                  .map((s) => (
                    <Link key={s.status} href={`${base}${sep}k=${k}&s=${s.status}#records`} className="rounded-md focus-visible:ring-2 focus-visible:outline-none">
                      <StatusBadge tone={STATUS_TONE[s.status]}>
                        {STATUS_LABEL[s.status]} <span className="tabular-nums">{s.n}</span>
                      </StatusBadge>
                    </Link>
                  ))}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** Records first seen per month, stacked by kind. */
export function Timeline({ doc }: { doc: RegistryIndex }) {
  const rows = timeline(doc);
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <Panel title="Timeline" icon={CalendarClock} means="Records first added to the repository, per month, by kind (from git history).">
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No history in this index.</p>
      ) : (
        <div className="grid gap-3">
          <div className="flex h-40 items-end gap-1 overflow-x-auto" role="img" aria-label={rows.map((r) => `${r.month}: ${r.total}`).join("; ")}>
            {rows.map((r) => (
              <div key={r.month} className="flex h-full max-w-16 min-w-6 flex-1 flex-col items-center justify-end gap-1">
                <span className="text-muted-foreground text-[10px] tabular-nums">{r.total || ""}</span>
                <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: `${(100 * r.total) / max}%` }}>
                  {KINDS.map((k) => (r.byKind[k] > 0 ? <span key={k} style={{ flexGrow: r.byKind[k], background: KIND_COLOUR[k] }} className="min-h-px w-full" /> : null))}
                </div>
                <span className="text-muted-foreground text-[10px] whitespace-nowrap">{r.month.slice(2)}</span>
              </div>
            ))}
          </div>
          <ul aria-label="Kinds" className="text-muted-foreground flex flex-wrap gap-3 text-xs">
            {KINDS.map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <KindDot kind={k} />
                {KIND_PLURAL[k]}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

export function Recent({ doc, nowMs, branch }: { doc: RegistryIndex; nowMs: number; branch: "integration" | "main" }) {
  const rows = recentlyChanged(doc);
  return (
    <Panel title="Recently changed" icon={GitCommitVertical} means="The records whose files changed most recently, by commit time.">
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No history in this index.</p>
      ) : (
        <ol className="grid gap-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
              <Link href={recordHref(r.id, branch)} className="flex min-w-0 items-center gap-2 font-mono underline-offset-2 hover:underline">
                <KindDot kind={r.kind} />
                {r.id}
              </Link>
              <span className="flex shrink-0 items-center gap-2">
                <StatusBadge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusBadge>
                <span className="text-muted-foreground text-xs tabular-nums" title={sydney(r.last_changed?.at)}>
                  {ago(r.last_changed?.at, nowMs)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

export function DependedOn({ doc, branch }: { doc: RegistryIndex; branch: "integration" | "main" }) {
  const rows = mostDependedOn(doc);
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <Panel title="Most depended on" icon={Network} means="The records other records name as a dependency, amendment, decision, hypothesis, experiment or base (mentions not counted).">
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No links in this index.</p>
      ) : (
        <ol className="grid gap-2">
          {rows.map((r) => {
            const kind = doc.records.find((x) => x.id === r.id)?.kind ?? "dec";
            return (
              <li key={r.id} className="grid grid-cols-[7.5rem_1fr_2rem] items-center gap-2 text-sm">
                <Link href={recordHref(r.id, branch)} className="flex items-center gap-2 font-mono underline-offset-2 hover:underline">
                  <KindDot kind={kind} />
                  {r.id}
                </Link>
                <span aria-hidden className="bg-muted h-2 overflow-hidden rounded-full">
                  <span className="block h-full rounded-full" style={{ width: `${(100 * r.n) / max}%`, background: KIND_COLOUR[kind] }} />
                </span>
                <span className="text-muted-foreground text-right tabular-nums" aria-label={`${r.n} records link to ${KIND_LABEL[kind]} ${r.id}`}>
                  {r.n}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
