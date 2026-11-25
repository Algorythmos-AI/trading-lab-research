import { ChevronRight, Ghost, Layers, ListTree, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { shortSha, sydney } from "@/lib/format";
import type { RegistryIndex } from "@/lib/registry.types";
import {
  EDGE_LABEL,
  ISSUE_LABEL,
  KIND_LABEL,
  KINDS,
  MAIN_LABEL,
  PHASE_LABEL,
  PHASES,
  STATUS_LABEL,
  STATUS_TONE,
  ago,
  commitUrl,
  filterRecords,
  grouped,
  inbound,
  mainState,
  recordHref,
  searchUrl,
  type Filters,
  type Inbound,
  type MainState,
  type Rec,
} from "@/lib/registry-view";
import { KindDot } from "./analytics";

const MAIN_TONE: Record<MainState, "good" | "warn" | "info" | "neutral"> = { on_main: "good", changed: "warn", not_on_main: "info", unknown: "neutral" };

function IdLink({ id, branch, known }: { id: string; branch: "integration" | "main"; known: boolean }) {
  return known ? (
    <Link href={recordHref(id, branch)} className="font-mono underline-offset-2 hover:underline">
      {id}
    </Link>
  ) : (
    <span className="text-muted-foreground font-mono" title="No record with this id in the index">
      {id}
    </span>
  );
}

/** The relations of one record, out and in, grouped by kind of link. */
export function Relations({ rec, ins, ids, branch, compact = false }: { rec: Rec; ins: readonly Inbound[]; ids: ReadonlySet<string>; branch: "integration" | "main"; compact?: boolean }) {
  const out = grouped(rec.edges.filter((e) => e.type !== "family"), (e) => e.to);
  const inn = grouped(ins, (i) => i.from);
  const fams = rec.edges.filter((e) => e.type === "family").map((e) => e.to);
  const block = (title: string, groups: { type: Rec["edges"][number]["type"]; ids: string[] }[], dir: "out" | "in") =>
    groups.length === 0 ? null : (
      <div className="grid gap-1">
        <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</h4>
        <dl className="grid gap-1 text-sm">
          {groups.map((g) => (
            <div key={g.type} className="grid grid-cols-[8.5rem_1fr] gap-2 max-sm:grid-cols-1 max-sm:gap-0">
              <dt className="text-muted-foreground">{EDGE_LABEL[g.type][dir]}</dt>
              <dd className="flex flex-wrap gap-x-2 gap-y-0.5">
                {(compact && g.type === "mentions" ? g.ids.slice(0, 8) : g.ids).map((id) => (
                  <IdLink key={id} id={id} branch={branch} known={ids.has(id)} />
                ))}
                {compact && g.type === "mentions" && g.ids.length > 8 ? <span className="text-muted-foreground">+{g.ids.length - 8} more</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  return (
    <div className="grid gap-3">
      {fams.length > 0 ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Trial family: </span>
          {fams.map((f) => (
            <Badge key={f} variant="outline" className="mr-1 font-mono">
              {f}
            </Badge>
          ))}
        </p>
      ) : null}
      {block("Links out", out, "out")}
      {block("Links in", inn, "in")}
      {out.length === 0 && inn.length === 0 && fams.length === 0 ? <p className="text-muted-foreground text-sm">No links to or from other records.</p> : null}
    </div>
  );
}

export function History({ rec, repo, nowMs }: { rec: Rec; repo: string | null; nowMs: number }) {
  const at = (s: Rec["first_seen"]) =>
    s ? (
      <>
        {sydney(s.at)} <span className="text-muted-foreground">({ago(s.at, nowMs)})</span> ·{" "}
        {repo ? (
          <a className="font-mono underline-offset-2 hover:underline" href={commitUrl(repo, s.sha)}>
            {shortSha(s.sha)}
          </a>
        ) : (
          <span className="font-mono">{shortSha(s.sha)}</span>
        )}
      </>
    ) : (
      "not in the history read"
    );
  return (
    <dl className="grid grid-cols-[8.5rem_1fr] gap-x-2 gap-y-1 text-sm max-sm:grid-cols-1">
      <dt className="text-muted-foreground">First seen</dt>
      <dd>{at(rec.first_seen)}</dd>
      <dt className="text-muted-foreground">Last changed</dt>
      <dd>{at(rec.last_changed)}</dd>
      <dt className="text-muted-foreground">File renamed</dt>
      <dd>{rec.path_renames === 0 ? "never" : `${rec.path_renames} time${rec.path_renames === 1 ? "" : "s"}, same id`}</dd>
      {rec.status_date ? (
        <>
          <dt className="text-muted-foreground">Status dated</dt>
          <dd>{rec.status_date}</dd>
        </>
      ) : null}
    </dl>
  );
}

export function RecordFlags({ rec, main, issues }: { rec: Rec; main: MainState | null; issues: RegistryIndex["issues"] }) {
  const mine = issues.filter((i) => i.id === rec.id);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <StatusBadge tone={STATUS_TONE[rec.status]}>{STATUS_LABEL[rec.status]}</StatusBadge>
      {main && main !== "unknown" ? <StatusBadge tone={MAIN_TONE[main]}>{MAIN_LABEL[main]}</StatusBadge> : null}
      {rec.conflict ? <StatusBadge tone="bad">{rec.files} files, one id</StatusBadge> : null}
      {mine.length > 0 && !rec.conflict ? (
        <StatusBadge tone="warn" icon={TriangleAlert}>
          {mine.length} issue{mine.length === 1 ? "" : "s"}
        </StatusBadge>
      ) : null}
      {rec.has_results ? <Badge variant="outline">results</Badge> : null}
      {rec.has_report ? <Badge variant="outline">report</Badge> : null}
    </span>
  );
}

function FilterForm({ f, families, action, branch }: { f: Filters; families: string[]; action: string; branch: "integration" | "main" }) {
  const sel = "bg-card h-9 rounded-md border px-2 text-sm";
  return (
    <form method="get" action={action} className="flex flex-wrap items-end gap-2" role="search" aria-label="Filter the records">
      {branch === "main" ? <input type="hidden" name="b" value="main" /> : null}
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Id or linked id</span>
        <input name="q" defaultValue={f.q} placeholder="DEC-0079" className={`${sel} w-36 font-mono uppercase`} />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Kind</span>
        <select name="k" defaultValue={f.kind ?? ""} className={sel}>
          <option value="">All</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Phase</span>
        <select name="p" defaultValue={f.phase ?? ""} className={sel}>
          <option value="">All</option>
          {PHASES.map((p) => (
            <option key={p} value={p}>
              {PHASE_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Status</span>
        <select name="s" defaultValue={f.status ?? ""} className={sel}>
          <option value="">All</option>
          {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Family</span>
        <select name="f" defaultValue={f.family ?? ""} className={sel}>
          <option value="">All</option>
          {families.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
      <label className="flex h-9 items-center gap-1.5 text-sm">
        <input type="checkbox" name="i" value="1" defaultChecked={f.issues} />
        Issues only
      </label>
      <Button type="submit" size="sm" variant="secondary">
        Apply
      </Button>
      <Link href={branch === "main" ? `${action}?b=main#records` : `${action}#records`} className="text-muted-foreground h-9 px-1 text-sm leading-9 underline-offset-2 hover:underline">
        Clear
      </Link>
    </form>
  );
}

/** The records, filtered by the address, each a card that opens on its relations and history. */
export function RecordsExplorer({ doc, main, f, branch, nowMs, action }: { doc: RegistryIndex; main: RegistryIndex | null; f: Filters; branch: "integration" | "main"; nowMs: number; action: string }) {
  const rows = filterRecords(doc, f);
  const ins = inbound(doc);
  const ids = new Set([...doc.records.map((r) => r.id), ...doc.tombstones.map((t) => t.id)]);
  const families = doc.families.map((x) => x.id);
  const showMain = branch === "integration";
  return (
    <Panel id="records" title={`Records (${rows.length} of ${doc.records.length})`} icon={ListTree} means="Every decision, hypothesis, experiment and lesson in the index. Open a card for its links and history, or its page for the map.">
      <div className="grid gap-4">
        <FilterForm f={f} families={families} action={action} branch={branch} />
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{doc.records.length === 0 ? "This index holds no records." : "No record matches these filters."}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((r) => (
              <li key={r.id}>
                <details className="group">
                  <summary className="hover:bg-accent/40 flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                    <ChevronRight aria-hidden className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
                    <span className="flex min-w-[8.5rem] items-center gap-2 font-mono text-sm font-medium">
                      <KindDot kind={r.kind} />
                      {r.id}
                    </span>
                    <span className="text-muted-foreground w-20 text-xs">{KIND_LABEL[r.kind]}</span>
                    <RecordFlags rec={r} main={showMain ? mainState(r, main) : null} issues={doc.issues} />
                    <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                      {r.edges.filter((e) => e.type !== "mentions" && e.type !== "family").length} links out · {(ins.get(r.id) ?? []).filter((i) => i.type !== "mentions").length} in
                    </span>
                  </summary>
                  <div className="bg-muted/30 grid gap-4 border-t px-4 py-3 sm:grid-cols-2">
                    <Relations rec={r} ins={ins.get(r.id) ?? []} ids={ids} branch={branch} compact />
                    <div className="grid content-start gap-3">
                      <History rec={r} repo={doc.repo} nowMs={nowMs} />
                      <p className="flex flex-wrap gap-3 text-sm">
                        <Link href={recordHref(r.id, branch)} className="font-medium underline-offset-2 hover:underline">
                          Open the record&apos;s page and map
                        </Link>
                        <a href={searchUrl(doc.repo, r.id)} className="text-muted-foreground underline-offset-2 hover:underline">
                          Find the file on GitHub
                        </a>
                      </p>
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

export function Families({ doc, branch }: { doc: RegistryIndex; branch: "integration" | "main" }) {
  return (
    <Panel title="Trial families" icon={Layers} means="The trial counts of config/trial_registry.yaml: each row is the decision that moved a family's count, and whether it counts yet.">
      {doc.families.length === 0 ? (
        <p className="text-muted-foreground text-sm">No trial registry in this index.</p>
      ) : (
        <div className="grid gap-3">
          {doc.families.map((fam) => {
            const inForce = [...fam.rows].reverse().find((r) => r.status === "accepted");
            return (
              <details key={fam.id} className="rounded-md border px-3 py-2">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono font-medium">{fam.id === "global" ? "Global" : `Family ${fam.id}`}</span>
                  <span className="text-muted-foreground">
                    {inForce?.total ?? "—"} trials in force · {fam.rows.length} rows
                  </span>
                  {fam.rows.some((r) => r.status === "proposed") ? <StatusBadge tone="warn">a proposed row waits</StatusBadge> : null}
                </summary>
                <ol className="mt-2 grid gap-1 text-sm">
                  {fam.rows.map((r, i) => (
                    <li key={i} className="grid grid-cols-[7rem_4rem_1fr] items-center gap-2">
                      {r.decision ? <Link href={recordHref(r.decision, branch)} className="font-mono underline-offset-2 hover:underline">{r.decision}</Link> : <span>—</span>}
                      <span className="tabular-nums">{r.total ?? "—"}</span>
                      <span className="text-muted-foreground">{r.status}</span>
                    </li>
                  ))}
                </ol>
              </details>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function Tombstones({ doc, branch, nowMs }: { doc: RegistryIndex; branch: "integration" | "main"; nowMs: number }) {
  return (
    <Panel id="gone" title={`Deleted and renamed (${doc.tombstones.length})`} icon={Ghost} means="Records that no longer have a file on this branch, kept from git history so links to them still say where they went.">
      {doc.tombstones.length === 0 ? (
        <p className="text-muted-foreground text-sm">{doc.history === "complete" ? "No record has been deleted or renamed." : "History was not read, so deletions are not known."}</p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {doc.tombstones.map((t) => (
            <li key={t.id} id={`gone-${t.id}`} className="flex flex-wrap items-center gap-2">
              <span className="font-mono line-through decoration-1">{t.id}</span>
              {t.state === "renamed" && t.renamed_to ? (
                <>
                  <span className="text-muted-foreground">renamed to</span>
                  <Link href={recordHref(t.renamed_to, branch)} className="font-mono underline-offset-2 hover:underline">
                    {t.renamed_to}
                  </Link>
                </>
              ) : (
                <span className="text-muted-foreground">deleted</span>
              )}
              <span className="text-muted-foreground text-xs">
                {ago(t.at, nowMs)} in{" "}
                <a className="font-mono underline-offset-2 hover:underline" href={commitUrl(doc.repo, t.sha)}>
                  {shortSha(t.sha)}
                </a>
                ; it was {STATUS_LABEL[t.last_status].toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function Issues({ doc, branch }: { doc: RegistryIndex; branch: "integration" | "main" }) {
  if (doc.issues.length === 0) return null;
  const ids = new Set(doc.records.map((r) => r.id));
  return (
    <Panel id="issues" title={`Needs a look (${doc.issues.length})`} icon={TriangleAlert} means="What the job could not read cleanly. The record is still listed, with what could be read; fix the file and the next run clears it.">
      <ul className="grid gap-1.5 text-sm">
        {doc.issues.map((i, n) => (
          <li key={n} className="flex flex-wrap items-center gap-2">
            {i.id ? <IdLink id={i.id} branch={branch} known={ids.has(i.id)} /> : <span className="text-muted-foreground">The index</span>}
            <span>{ISSUE_LABEL[i.code]}</span>
            {i.to ? <span className="text-muted-foreground font-mono">{i.to}</span> : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
