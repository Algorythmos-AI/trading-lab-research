import { CircleCheck, CloudOff, GitBranch, Loader, OctagonX, TriangleAlert, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/status";
import { Notice } from "@/components/ui/notice";
import { shortSha, sydney } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import type { RegistryState } from "@/lib/registry-run";
import type { SyncState } from "@/lib/registry-status";
import { ago, commitUrl } from "@/lib/registry-view";
import { cn } from "@/lib/utils";
import { RefreshButton } from "./refresh-button";

export const SYNC_TONE: Record<SyncState, Tone> = { synced: "good", syncing: "info", out_of_date: "warn", sync_failed: "bad", cant_check: "warn" };
const SYNC_ICON: Record<SyncState, LucideIcon> = { synced: CircleCheck, syncing: Loader, out_of_date: TriangleAlert, sync_failed: OctagonX, cant_check: CloudOff };

export function SyncBadge({ state, label, className }: { state: SyncState; label: string; className?: string }) {
  return (
    <StatusBadge tone={SYNC_TONE[state]} icon={SYNC_ICON[state]} className={className}>
      {label}
    </StatusBadge>
  );
}

/** The branch switch: two links, the current one marked. */
export function BranchSwitch({ branch, base }: { branch: "integration" | "main"; base: string }) {
  return (
    <nav aria-label="Branch" className="bg-muted inline-flex rounded-md p-0.5 text-sm">
      {(["integration", "main"] as const).map((b) => (
        <Link
          key={b}
          href={b === "main" ? `${base}?b=main` : base}
          aria-current={b === branch ? "page" : undefined}
          className={cn("flex items-center gap-1.5 rounded px-3 py-1", b === branch ? "bg-card shadow-sm font-medium" : "text-muted-foreground hover:text-foreground")}
        >
          <GitBranch aria-hidden className="size-3.5" />
          {b}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The GitHub sync card: the state, what it means, the last successful sync, the index's commit against the head,
 * and Refresh. `other` is the other branch's state, shown small so both are visible from either view.
 */
export function SyncPanel({ s, other, repo, nowMs }: { s: RegistryState; other: RegistryState | null; repo: string | null; nowMs: number }) {
  const st = s.status;
  const doc = s.load.status === "ok" ? s.load.doc : null;
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex min-w-0 flex-col">
      <dt className="text-muted-foreground text-xs">{k}</dt>
      <dd className="font-mono text-sm break-words tabular-nums">{v}</dd>
    </div>
  );
  const sha = (x: string | null) => (x && repo ? <a className="underline-offset-2 hover:underline" href={commitUrl(repo, x)}>{shortSha(x)}</a> : shortSha(x));
  return (
    <section aria-labelledby="sync-title" className="bg-card grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <h2 id="sync-title" className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            GitHub sync · <span className="font-mono">{s.branch}</span>
            <SyncBadge state={st.state} label={st.label} />
          </h2>
          <p className="text-muted-foreground max-w-prose text-sm">{s.sentence}</p>
        </div>
        <RefreshButton branch={s.branch} syncing={st.state === "syncing"} />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {row("Last successful sync", st.lastSync ? <>{sydney(st.lastSync)}<span className="text-muted-foreground block font-sans text-xs">{ago(st.lastSync, nowMs)}</span></> : "never")}
        {row("Index built from", sha(st.indexSha))}
        {row("Branch head", st.headSha ? sha(st.headSha) : "not checked")}
        {row("Commit time of index", doc ? sydney(doc.as_of) : "—")}
      </dl>
      {other ? (
        <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          The other branch, <span className="font-mono">{other.branch}</span>: <SyncBadge state={other.status.state} label={other.status.label} />
          {other.status.lastSync ? `last synced ${ago(other.status.lastSync, nowMs)}` : "never synced"}
        </p>
      ) : null}
      {doc && doc.history === "unavailable" ? <Notice>The job could not read git history: first-seen dates, renames and deletions are missing from this index.</Notice> : null}
    </section>
  );
}

/** The banner every view shows when what it draws is not the branch head. */
export function StaleBanner({ s, nowMs }: { s: RegistryState; nowMs: number }) {
  if (s.status.state === "synced" || s.load.status !== "ok") return null;
  const doc = s.load.doc;
  return (
    <div role="status" className="border-warn/40 bg-warn-soft text-warn rounded-lg border px-4 py-3 text-sm">
      <p className="flex items-start gap-2 font-medium">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        {s.status.state === "cant_check"
          ? `Not confirmed current. These records are as of commit ${shortSha(doc.sha)} (${ago(doc.as_of, nowMs)}); GitHub could not be asked whether the branch has moved since.`
          : `Not current. These records are as of commit ${shortSha(doc.sha)} (${ago(doc.as_of, nowMs)}), not the head of ${s.branch}${s.status.headSha ? ` (${shortSha(s.status.headSha)})` : ""}.`}
      </p>
    </div>
  );
}
