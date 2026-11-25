// What the Research records pages draw from an index: pure, no I/O, unit-tested (test/registry-view.test.ts).
import type { Tone } from "./labels";
import type { RegistryIndex } from "./registry.types";

export type Rec = RegistryIndex["records"][number];
export type Tomb = RegistryIndex["tombstones"][number];
export type EdgeType = Rec["edges"][number]["type"];
export type RecKind = Rec["kind"];
export type RecStatus = Rec["status"];

export const KIND_LABEL: Record<RecKind, string> = { dec: "Decision", hyp: "Hypothesis", exp: "Experiment", ll: "Lesson" };
export const KIND_PLURAL: Record<RecKind, string> = { dec: "Decisions", hyp: "Hypotheses", exp: "Experiments", ll: "Lessons" };
export const KINDS: readonly RecKind[] = ["dec", "hyp", "exp", "ll"];

export const STATUS_LABEL: Record<RecStatus, string> = {
  accepted: "Accepted",
  proposed: "Proposed",
  withdrawn: "Withdrawn",
  superseded: "Superseded",
  not_used: "Not used",
  in_effect: "In effect",
  recorded: "Recorded",
  pre_registered: "Pre-registered",
  falsified: "Falsified",
  supported: "Supported",
  closed: "Closed",
  registered: "Registered",
  running: "Running",
  complete: "Complete",
  no_status: "No status in config",
  no_config: "No config",
  unparsed: "Status not read",
};

export const STATUS_TONE: Record<RecStatus, Tone> = {
  accepted: "good",
  in_effect: "good",
  registered: "good",
  complete: "good",
  supported: "good",
  pre_registered: "info",
  running: "info",
  proposed: "warn",
  falsified: "bad",
  unparsed: "bad",
  withdrawn: "neutral",
  superseded: "neutral",
  not_used: "neutral",
  closed: "neutral",
  recorded: "neutral",
  no_status: "neutral",
  no_config: "neutral",
};

/** Three plain groups for the analytics: still in play, finished one way or another, and the rest. */
export type Phase = "active" | "pending" | "done" | "other";
export const PHASE_LABEL: Record<Phase, string> = { active: "Active", pending: "Proposed", done: "Closed", other: "Other" };
export const STATUS_PHASE: Record<RecStatus, Phase> = {
  accepted: "active",
  in_effect: "active",
  registered: "active",
  running: "active",
  pre_registered: "active",
  proposed: "pending",
  falsified: "done",
  supported: "done",
  complete: "done",
  withdrawn: "done",
  superseded: "done",
  not_used: "done",
  closed: "done",
  recorded: "other",
  no_status: "other",
  no_config: "other",
  unparsed: "other",
};
export const PHASES: readonly Phase[] = ["active", "pending", "done", "other"];
export const PHASE_TONE: Record<Phase, Tone> = { active: "good", pending: "warn", done: "neutral", other: "info" };

export const EDGE_LABEL: Record<EdgeType, { out: string; in: string }> = {
  depends_on: { out: "Depends on", in: "Depended on by" },
  amends: { out: "Amends", in: "Amended by" },
  supersedes: { out: "Supersedes", in: "Superseded by" },
  superseded_by: { out: "Superseded by", in: "Supersedes" },
  experiment: { out: "Experiments", in: "Named as experiment by" },
  evidence: { out: "Evidence", in: "Evidence for" },
  hypothesis: { out: "Hypotheses", in: "Named as hypothesis by" },
  decision: { out: "Decision", in: "Decision for" },
  base: { out: "Built on", in: "Base of" },
  family: { out: "Trial family", in: "In family" },
  mentions: { out: "Mentions", in: "Mentioned by" },
};
/** The order relations are listed in: the strong ones first, mentions last. */
export const EDGE_ORDER: readonly EdgeType[] = ["supersedes", "superseded_by", "amends", "depends_on", "decision", "hypothesis", "experiment", "base", "evidence", "family", "mentions"];

export const ISSUE_LABEL: Record<RegistryIndex["issues"][number]["code"], string> = {
  "duplicate-id": "Two files claim this id",
  "id-mismatch": "The id inside the file differs from its name",
  "yaml-error": "The file is not valid YAML or JSON",
  unreadable: "The file could not be read",
  "unparsed-status": "Its status line names no known status",
  "history-unavailable": "The job could not read git history",
  "dangling-ref": "Links to an id no record has",
};

export function kindOf(id: string): RecKind | null {
  const p = id.split("-", 1)[0];
  return p === "DEC" ? "dec" : p === "HYP" ? "hyp" : p === "EXP" ? "exp" : p === "LL" ? "ll" : null;
}

export const RECORD_ID_RE = /^(DEC|HYP|EXP|LL)-(DEBUG-\d{4}|\d{4}[a-z]?)$/;

export interface Inbound {
  type: EdgeType;
  from: string;
}

/** Every record's incoming links, from the other records' outgoing ones. */
export function inbound(doc: RegistryIndex): Map<string, Inbound[]> {
  const out = new Map<string, Inbound[]>();
  for (const r of doc.records) {
    for (const e of r.edges) {
      if (e.type === "family") continue;
      const list = out.get(e.to) ?? [];
      list.push({ type: e.type, from: r.id });
      out.set(e.to, list);
    }
  }
  return out;
}

/** Outgoing (or incoming) links grouped by type in EDGE_ORDER, each list of ids sorted. */
export function grouped<T extends { type: EdgeType }>(items: readonly T[], key: (t: T) => string): { type: EdgeType; ids: string[] }[] {
  return EDGE_ORDER.map((type) => ({ type, ids: [...new Set(items.filter((i) => i.type === type).map(key))].sort() })).filter((g) => g.ids.length > 0);
}

/** How the integration branch's record stands against main's index: there too, there but changed since, or not yet. */
export type MainState = "on_main" | "changed" | "not_on_main" | "unknown";
export function mainState(r: Rec, main: RegistryIndex | null): MainState {
  if (!main) return "unknown";
  const m = main.records.find((x) => x.id === r.id);
  if (!m) return "not_on_main";
  if (r.last_changed && m.last_changed && r.last_changed.sha !== m.last_changed.sha) return "changed";
  return "on_main";
}
export const MAIN_LABEL: Record<MainState, string> = { on_main: "On main", changed: "Changed since main", not_on_main: "Not on main yet", unknown: "Main not known" };

export interface Counts {
  byKind: Record<RecKind, number>;
  byKindPhase: Record<RecKind, Record<Phase, number>>;
  byStatus: { kind: RecKind; status: RecStatus; n: number }[];
  newIn7d: number;
  changedIn7d: number;
  conflicts: number;
}

export function counts(doc: RegistryIndex, nowMs: number): Counts {
  const blankPhase = (): Record<Phase, number> => ({ active: 0, pending: 0, done: 0, other: 0 });
  const byKind = { dec: 0, hyp: 0, exp: 0, ll: 0 };
  const byKindPhase = { dec: blankPhase(), hyp: blankPhase(), exp: blankPhase(), ll: blankPhase() };
  const st = new Map<string, number>();
  const week = nowMs - 7 * 86_400_000;
  let newIn7d = 0;
  let changedIn7d = 0;
  let conflicts = 0;
  for (const r of doc.records) {
    byKind[r.kind]++;
    byKindPhase[r.kind][STATUS_PHASE[r.status]]++;
    st.set(`${r.kind}|${r.status}`, (st.get(`${r.kind}|${r.status}`) ?? 0) + 1);
    if (r.first_seen && Date.parse(r.first_seen.at) >= week) newIn7d++;
    if (r.last_changed && Date.parse(r.last_changed.at) >= week) changedIn7d++;
    if (r.conflict) conflicts++;
  }
  const byStatus = [...st.entries()]
    .map(([k, n]) => {
      const [kind, status] = k.split("|") as [RecKind, RecStatus];
      return { kind, status, n };
    })
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || b.n - a.n);
  return { byKind, byKindPhase, byStatus, newIn7d, changedIn7d, conflicts };
}

/** Records first seen per month, by kind, oldest month first: the timeline's columns. */
export function timeline(doc: RegistryIndex): { month: string; byKind: Record<RecKind, number>; total: number }[] {
  const m = new Map<string, Record<RecKind, number>>();
  for (const r of doc.records) {
    if (!r.first_seen) continue;
    const month = r.first_seen.at.slice(0, 7);
    const row = m.get(month) ?? { dec: 0, hyp: 0, exp: 0, ll: 0 };
    row[r.kind]++;
    m.set(month, row);
  }
  const months = [...m.keys()].sort();
  if (months.length === 0) return [];
  // Fill the months with nothing, so the gaps read as gaps.
  const out: { month: string; byKind: Record<RecKind, number>; total: number }[] = [];
  const first = months[0] ?? "";
  let y = Number(first.slice(0, 4));
  let mo = Number(first.slice(5, 7));
  const last = months[months.length - 1];
  for (let i = 0; i < 240; i++) {
    const key = `${y}-${String(mo).padStart(2, "0")}`;
    const row = m.get(key) ?? { dec: 0, hyp: 0, exp: 0, ll: 0 };
    out.push({ month: key, byKind: row, total: row.dec + row.hyp + row.exp + row.ll });
    if (key === last) break;
    mo++;
    if (mo > 12) {
      mo = 1;
      y++;
    }
  }
  return out;
}

/** The records most changed lately, newest first. */
export function recentlyChanged(doc: RegistryIndex, n = 8): Rec[] {
  return [...doc.records].filter((r) => r.last_changed).sort((a, b) => Date.parse(b.last_changed!.at) - Date.parse(a.last_changed!.at) || a.id.localeCompare(b.id)).slice(0, n);
}

/** The records others lean on most: incoming links that are not mere mentions. */
export function mostDependedOn(doc: RegistryIndex, n = 8): { id: string; n: number }[] {
  const tally = new Map<string, number>();
  for (const r of doc.records) for (const e of r.edges) if (e.type !== "mentions" && e.type !== "family") tally.set(e.to, (tally.get(e.to) ?? 0) + 1);
  return [...tally.entries()].filter(([id]) => doc.records.some((r) => r.id === id)).map(([id, k]) => ({ id, n: k })).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id)).slice(0, n);
}

export interface Filters {
  kind: RecKind | null;
  phase: Phase | null;
  status: RecStatus | null;
  family: string | null;
  q: string;
  issues: boolean;
}

export function parseFilters(sp: Record<string, string | string[] | undefined>): Filters {
  const one = (k: string) => {
    const v = sp[k];
    return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
  };
  const kind = one("k");
  const phase = one("p");
  const status = one("s");
  const family = one("f");
  return {
    kind: kind && (KINDS as readonly string[]).includes(kind) ? (kind as RecKind) : null,
    phase: phase && (PHASES as readonly string[]).includes(phase) ? (phase as Phase) : null,
    status: status && status in STATUS_LABEL ? (status as RecStatus) : null,
    family: family && /^[A-Za-z0-9_-]{1,12}$/.test(family) ? family : null,
    q: (one("q") ?? "").trim().toUpperCase().slice(0, 40),
    issues: one("i") === "1",
  };
}

export function filterRecords(doc: RegistryIndex, f: Filters): Rec[] {
  const withIssue = new Set(doc.issues.map((i) => i.id).filter(Boolean));
  return doc.records.filter(
    (r) =>
      (!f.kind || r.kind === f.kind) &&
      (!f.phase || STATUS_PHASE[r.status] === f.phase) &&
      (!f.status || r.status === f.status) &&
      (!f.family || r.family === f.family || r.edges.some((e) => e.type === "family" && e.to === f.family)) &&
      (!f.q || r.id.includes(f.q) || r.edges.some((e) => e.to.toUpperCase() === f.q)) &&
      (!f.issues || withIssue.has(r.id) || r.conflict),
  );
}

/** A record's one-hop neighbourhood for the drill-down graph: each neighbour once, with every way it is linked. */
export function neighbours(doc: RegistryIndex, id: string, cap = 24): { id: string; out: EdgeType[]; in: EdgeType[] }[] {
  const rec = doc.records.find((r) => r.id === id);
  const m = new Map<string, { out: Set<EdgeType>; in: Set<EdgeType> }>();
  const at = (k: string) => {
    const v = m.get(k) ?? { out: new Set<EdgeType>(), in: new Set<EdgeType>() };
    m.set(k, v);
    return v;
  };
  for (const e of rec?.edges ?? []) if (e.type !== "family" && e.to !== id) at(e.to).out.add(e.type);
  for (const r of doc.records) for (const e of r.edges) if (e.to === id && r.id !== id && e.type !== "family") at(r.id).in.add(e.type);
  const strength = (v: { out: Set<EdgeType>; in: Set<EdgeType> }) => [...v.out, ...v.in].filter((t) => t !== "mentions").length;
  return [...m.entries()]
    .map(([k, v]) => ({ id: k, out: [...v.out], in: [...v.in], s: strength(v) }))
    .sort((a, b) => b.s - a.s || a.id.localeCompare(b.id))
    .slice(0, cap)
    .map(({ id: k, out, in: inn }) => ({ id: k, out, in: inn }));
}

/** GitHub links that carry no record text: a commit by its SHA, and a code search for the id's file. */
export function commitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}
export function searchUrl(repo: string, id: string): string {
  const k = kindOf(id);
  const dir = k === "dec" ? "research/decisions" : k === "hyp" ? "research/hypotheses" : k === "exp" ? "research/experiments" : "research/lessons_learned";
  return `https://github.com/search?type=code&q=${encodeURIComponent(`repo:${repo} path:${dir}/${id}`)}`;
}

export const recordHref = (id: string, branch: "integration" | "main") => `/research/records/${id}${branch === "main" ? "?b=main" : ""}`;

/** "4 min ago", "3 h ago", "2 days ago": how long before `nowMs` an instant was. Null for no instant. */
export function ago(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
