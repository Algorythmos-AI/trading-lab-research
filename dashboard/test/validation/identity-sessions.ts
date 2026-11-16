// The replay side of DEC-0051 section 8's engine identity check over logged sessions (the collector is
// scripts/identity-collect.mjs; the steps are in docs/runbooks/engine-identity-sessions.md).
//
// For every server record of a collected session it rebuilds the slot's EvalInput from what was stored, and runs it
// through two or more engines, each the whole engine code (desk-eval.ts's import closure) of one git commit, extracted
// into a temporary folder. Every engine reads the same inputs, so a row that differs differs because the engine does.
//
// What the record cannot give back is chosen the same way for every engine, and counted:
// - the journal: only its latest copy is kept, so none is passed. It sets the day's flags only (journal current, a
//   break today, the day's limit); a slot whose record had the day's limit used is counted;
// - the snapshot's high and low: unknown, so only the bars' are used (settledQuote takes the more extreme of the two,
//   which can only move a state toward missed). The snapshot's last trade time is the record's own when its probe holds
//   the trade's age, else a print inside the slot;
// - the bars: read again from Alpaca after the session; a record written on another feed is skipped and counted.
// What this half therefore does not exercise, and the report says so: the day's flags from the journal, the bad-data
// guards' pauses (the rebuilt snapshot has none of what they read), and the snapshot's own high and low. A label
// change in that code needs the fixture half, or a review, for its answer.
// The first engine run on the records it wrote is also compared with what it wrote: how faithful the rebuilt inputs
// are. That count is reported beside the answer, never in place of it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normaliseBar } from "@/lib/bars";
import type { EvalInput, Evaluation } from "@/lib/desk-eval";
import { parseEditionCopy } from "@/lib/edition-copy";
import { isHalfDay, type LiveQuote, type Options } from "@/lib/options";
import type { Bar2, NameState, SideState } from "@/lib/trade-state";

type RawBar = { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown };

export interface CollectedSession {
  day: string;
  /** The server records, as stored, by file name (HHMM.json). */
  records: { name: string; text: string }[];
  /** The edition copies, as stored. */
  copies: { name: string; text: string }[];
  bars: { feed: string; bars: Record<string, RawBar[]> };
}

export interface EngineRun {
  evaluation: Evaluation;
  states: NameState[];
}
export type EvaluateStates = (input: EvalInput) => EngineRun;

export interface Engine {
  ref: string;
  sha: string;
  label: string;
  evaluateSlotStates: EvaluateStates;
}

/** Why a record's slot could not be rebuilt. */
export type SkipWhy = "unreadable-record" | "no-edition" | "feed-differs" | "wrong-day-edition" | "edition-not-kept";

export interface BuiltInput {
  input: EvalInput;
  /** The engine label the record was written under. */
  engine: string;
  /** The rows the record holds, as symbol/side/state. */
  loggedRows: string[];
  loggedStatus: string;
  dayLimitUsed: boolean;
  /** How many focus names took their last trade time from the record's probe. */
  tradeFromProbe: number;
  /** Of those, how many could be either side of the slot's end (the probe's clock is the run's start; PROBE_CLOCK_SLACK_MS). */
  tradeTimeUncertain: number;
  /** A bad-data guard was switched on. The rebuilt snapshot cannot trip one, so its pauses are not replayed. */
  guardsOn: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const ms = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : Number.NaN);

/** Reads a collected folder (the collector's layout): every session it holds, oldest first. */
export function readBundle(dir: string): CollectedSession[] {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { sessions: { day: string }[] };
  const files = (sub: string) => {
    try {
      return readdirSync(join(dir, sub))
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((name) => ({ name, text: readFileSync(join(dir, sub, name), "utf8") }));
    } catch {
      return [];
    }
  };
  return manifest.sessions
    .map((s) => s.day)
    .sort()
    .map((day) => ({
      day,
      records: files(`${day}/records`),
      copies: files(`${day}/copies`),
      bars: JSON.parse(readFileSync(join(dir, day, "bars.json"), "utf8")) as CollectedSession["bars"],
    }));
}

/** The session's 2-minute bars per name, as bars.ts builds them from Alpaca's answer: normalised, one per start, oldest first. */
export function sessionBars(raw: Record<string, RawBar[]>, halfDay: boolean): Record<string, Bar2[]> {
  const out: Record<string, Bar2[]> = {};
  for (const [sym, list] of Object.entries(raw)) {
    const bySlot = new Map<number, Bar2>();
    for (const r of list) {
      const b = normaliseBar(r, halfDay);
      if (b) bySlot.set(b.start, b);
    }
    out[sym] = [...bySlot.values()].sort((a, b) => a.start - b.start);
  }
  return out;
}

/**
 * The edition the record read: a copy whose `as_of` is the record's `edition_as_of` (the same instant); of several,
 * the latest received at or before `evaluatedAt` (production read latest.json at run time).
 */
export function editionFor(copies: CollectedSession["copies"], asOf: unknown, evaluatedAt = Number.POSITIVE_INFINITY): Options | null {
  const want = ms(asOf);
  if (!Number.isFinite(want)) return null;
  const matches: { receivedAt: number; edition: Options }[] = [];
  for (const c of copies) {
    const parsed = parseEditionCopy(c.text);
    const e = parsed?.edition;
    if (isObj(e) && ms(e.as_of) === want) matches.push({ receivedAt: ms(parsed?.receivedAt), edition: e as unknown as Options });
  }
  return pickCopy(matches, evaluatedAt);
}

/**
 * The most the probe's clock can be before `evaluated_at`: the probe measures ages from the run's time when it started
 * its reads (desk-run.ts runAt), the record is stamped after them; the reads take at most TIMEOUT_MS.reads (3 s), and
 * the ages are floored to 0.1 s.
 */
export const PROBE_CLOCK_SLACK_MS = 3_100;

/** The record's last trade time per name from its probe (evaluated_at minus the trade's age), where it holds one. */
function probeTradeTimes(record: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  const at = ms(record.evaluated_at);
  const probe = record.probe;
  if (!Number.isFinite(at) || !isObj(probe) || !Array.isArray(probe.names)) return out;
  for (const n of probe.names) {
    if (isObj(n) && typeof n.symbol === "string" && n.source === "fetched" && isNum(n.trade_age_s)) out.set(n.symbol, at - n.trade_age_s * 1000);
  }
  return out;
}

/** Of the copies that hold this edition, the latest the store received by the time the record was written. */
function pickCopy(matches: { receivedAt: number; edition: Options }[], evaluatedAt: number): Options | null {
  if (matches.length === 0) return null;
  const before = matches.filter((m) => Number.isFinite(m.receivedAt) && m.receivedAt <= evaluatedAt);
  const pool = before.length > 0 ? before : matches;
  return [...pool].sort((a, b) => a.receivedAt - b.receivedAt)[pool.length - 1]!.edition;
}

/** Rebuilds a record's slot input from the session's collected files. */
export function buildInput(recordText: string, session: CollectedSession): BuiltInput | { skip: SkipWhy } {
  let record: unknown;
  try {
    record = JSON.parse(recordText);
  } catch {
    return { skip: "unreadable-record" };
  }
  if (!isObj(record) || typeof record.session !== "string" || !Number.isFinite(ms(record.slot_end)) || typeof record.engine !== "string") return { skip: "unreadable-record" };
  if (record.edition_as_of === null || record.edition_as_of === undefined) return { skip: "no-edition" };
  if (typeof record.feed === "string" && record.feed !== session.bars.feed) return { skip: "feed-differs" };
  if (typeof record.edition_session === "string" && record.edition_session !== record.session) return { skip: "wrong-day-edition" };
  const edition = editionFor(session.copies, record.edition_as_of, ms(record.evaluated_at));
  if (!edition) return { skip: "edition-not-kept" };

  const end = ms(record.slot_end);
  const evaluatedAt = ms(record.evaluated_at);
  const day = isObj(record.day) ? record.day : {};
  const focus = (Array.isArray(edition.focus?.items) ? edition.focus.items : []).map((i) => i.symbol);
  const bars = sessionBars(session.bars.bars, isHalfDay(edition));
  const trades = probeTradeTimes(record);
  const noSnapshot = new Set(
    (Array.isArray(record.degraded_names) ? record.degraded_names : []).filter((d): d is { symbol: string; reason: string } => isObj(d) && d.reason === "snapshot-missing" && typeof d.symbol === "string").map((d) => d.symbol),
  );
  const snapshots: Record<string, LiveQuote> = {};
  const fetchedAt: Record<string, number> = {};
  let tradeFromProbe = 0;
  let tradeTimeUncertain = 0;
  for (const sym of focus) {
    fetchedAt[sym] = end + 3_600_000;
    const mine = (bars[sym] ?? []).filter((b) => b.end <= end);
    const last = mine[mine.length - 1];
    if (record.snapshot_ok !== true || noSnapshot.has(sym) || !last) continue;
    const t = trades.get(sym);
    if (t !== undefined) {
      tradeFromProbe++;
      // The true time is up to PROBE_CLOCK_SLACK_MS earlier than this: uncertain when that range holds the slot's end.
      if (t - PROBE_CLOCK_SLACK_MS < end && t >= end) tradeTimeUncertain++;
    }
    // Without the probe's time, a time at or after the slot's end: settledQuote then applies its own rule (a print in the
    // slot's bar when it has one, else the last bar's start), as production did for a name that had printed since.
    const at = t ?? (Number.isFinite(evaluatedAt) ? Math.max(evaluatedAt, end) : end);
    snapshots[sym] = { price: last.c, at: new Date(at).toISOString(), open: null, high: null, low: null, day: record.session, prev_close: null, vwap: null } as LiveQuote;
  }
  const guardsOn = isObj(record.guards) && Array.isArray(record.guards.on) ? (record.guards.on as EvalInput["guardsOn"]) : [];
  const rows = Array.isArray(record.rows) ? record.rows : [];
  return {
    input: { slot: { day: record.session, end }, edition, journal: null, done: day.done === true, bars, fetchedAt, snapshots, guardsOn },
    engine: record.engine,
    loggedRows: rows.filter(isObj).map((r) => `${String(r.symbol)}/${String(r.side)}/${String(r.state)}`),
    loggedStatus: typeof record.status === "string" ? record.status : "unknown",
    dayLimitUsed: day.day_limit_used === true,
    tradeFromProbe,
    tradeTimeUncertain,
    guardsOn: (guardsOn ?? []).length > 0,
  };
}

/** What section 8 judges a name on: its state, each side's state and `brokeAt`, and the card numbers. */
const sideKey = (s: SideState | undefined) => (s ? { state: s.state, brokeAt: s.brokeAt ?? null } : null);
export function nameKey(s: NameState) {
  return { symbol: s.symbol, state: s.state, call: sideKey(s.call), put: sideKey(s.put), plan: s.plan ?? null };
}
export const rowKeys = (ev: Evaluation): string[] => ev.rows.map((r) => `${r.symbol}/${r.side}/${r.state}`);

export interface PairCount {
  old: string;
  new: string;
  slots: number;
  names: number;
  /** Names whose state, a side's state or brokeAt, or a card number differs. */
  namesDiffer: number;
  sideStateDiffer: number;
  brokeAtDiffer: number;
  cardDiffer: number;
  /** The evaluation's rows (symbol, side, state), as the record holds them. */
  rows: number;
  rowsDiffer: number;
  statusDiffer: number;
  /** Each side's state change, old → new, and how often. */
  transitions: Record<string, number>;
  /** Private detail: the slots and names that differ. Written to the collected folder only, never printed. */
  where: string[];
}

export function emptyPair(oldLabel: string, newLabel: string): PairCount {
  return { old: oldLabel, new: newLabel, slots: 0, names: 0, namesDiffer: 0, sideStateDiffer: 0, brokeAtDiffer: 0, cardDiffer: 0, rows: 0, rowsDiffer: 0, statusDiffer: 0, transitions: {}, where: [] };
}

/** Adds one slot's two runs to a pair's counts. */
export function addSlot(p: PairCount, at: string, a: EngineRun, b: EngineRun): void {
  p.slots++;
  if (a.evaluation.status !== b.evaluation.status) p.statusDiffer++;
  // By name and its place among that name's states, so a name listed twice is compared twice, never hidden.
  const group = (states: NameState[]) => {
    const m = new Map<string, NameState[]>();
    for (const s of states) m.set(s.symbol, [...(m.get(s.symbol) ?? []), s]);
    return m;
  };
  const ga = group(a.states);
  const gb = group(b.states);
  const pairs: [string, NameState | undefined, NameState | undefined][] = [];
  for (const sym of new Set([...ga.keys(), ...gb.keys()])) {
    const xs = ga.get(sym) ?? [];
    const ys = gb.get(sym) ?? [];
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) pairs.push([sym, xs[i], ys[i]]);
  }
  for (const [sym, x, y] of pairs) {
    p.names++;
    const kx = x ? nameKey(x) : null;
    const ky = y ? nameKey(y) : null;
    if (JSON.stringify(kx) === JSON.stringify(ky)) continue;
    p.namesDiffer++;
    p.where.push(`${at}/${sym}`);
    if (JSON.stringify(kx?.plan ?? null) !== JSON.stringify(ky?.plan ?? null)) p.cardDiffer++;
    for (const side of ["call", "put"] as const) {
      const sx = kx?.[side] ?? null;
      const sy = ky?.[side] ?? null;
      if ((sx?.state ?? null) !== (sy?.state ?? null)) {
        p.sideStateDiffer++;
        const t = `${sx?.state ?? "none"} → ${sy?.state ?? "none"}`;
        p.transitions[t] = (p.transitions[t] ?? 0) + 1;
      }
      if ((sx?.brokeAt ?? null) !== (sy?.brokeAt ?? null)) p.brokeAtDiffer++;
    }
  }
  // The rows as a multiset: every row of either run that the other run lacks is counted.
  const ra = rowKeys(a.evaluation);
  const rb = rowKeys(b.evaluation);
  const left = new Map<string, number>();
  for (const r of ra) left.set(r, (left.get(r) ?? 0) + 1);
  let unmatched = 0;
  for (const r of rb) {
    const n = left.get(r) ?? 0;
    if (n > 0) left.set(r, n - 1);
    else unmatched++;
  }
  for (const n of left.values()) unmatched += n;
  p.rows += Math.max(ra.length, rb.length);
  p.rowsDiffer += unmatched;
}

/** The pair's answer as section 8 asks it: do any rows differ (state, brokeAt or card numbers)? */
export const differs = (p: PairCount): boolean => p.namesDiffer > 0 || p.rowsDiffer > 0;

/** The SAFE lines: counts, labels and state words only; no symbol, price or level. */
export function reportLines(p: PairCount): string[] {
  const t = Object.entries(p.transitions)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}: ${n}`);
  return [
    `${p.old} → ${p.new}: ${differs(p) ? "yes, rows differ" : "no, no row differs"}`,
    `  slots ${p.slots}; names ${p.names}, of which differ ${p.namesDiffer} (a side's state ${p.sideStateDiffer}, brokeAt ${p.brokeAtDiffer}, card numbers ${p.cardDiffer})`,
    `  evaluation rows ${p.rows}, of which differ ${p.rowsDiffer}; evaluation status differs in ${p.statusDiffer} slots`,
    ...(t.length ? [`  side state changes: ${t.join("; ")}`] : []),
  ];
}

/**
 * The whole engine code of one commit: its src/lib, extracted from git into a temporary folder, with "@/lib/x"
 * imports pointed at its own copies, so every file it loads is that commit's. Its label is the commit's
 * engine-version.gen.ts.
 */
export async function loadEngine(ref: string, repo: string): Promise<Engine & { dir: string }> {
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(join(tmpdir(), `engine-${sha.slice(0, 8)}-`));
  const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", sha, "dashboard/src/lib"], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  const lib = join(dir, "dashboard/src/lib");
  for (const f of readdirSync(lib)) {
    if (!f.endsWith(".ts")) continue;
    const p = join(lib, f);
    const src = readFileSync(p, "utf8");
    const fixed = src.replace(/(from\s+|import\(\s*)"@\/lib\/([^"]+)"/g, (_m, pre: string, mod: string) => `${pre}"./${mod}"`);
    if (fixed !== src) writeFileSync(p, fixed);
  }
  const label = /e-[0-9a-f]{12}/.exec(readFileSync(join(lib, "engine-version.gen.ts"), "utf8"))?.[0];
  if (!label) throw new Error(`no engine label in ${ref}`);
  const mod = (await import(/* @vite-ignore */ pathToFileURL(join(lib, "desk-eval.ts")).href)) as { evaluateSlotStates?: EvaluateStates };
  if (typeof mod.evaluateSlotStates !== "function") throw new Error(`${ref} has no evaluateSlotStates`);
  return { ref, sha, label, evaluateSlotStates: mod.evaluateSlotStates, dir };
}

/** Removes the folders loadEngine extracted into (the Mac's disk is short). */
export function dropEngines(engines: readonly { dir: string }[]): void {
  for (const e of engines) rmSync(e.dir, { recursive: true, force: true });
}

/**
 * Whether a manifest's files are as the collector wrote them: the names of any file missing or changed since. The
 * replay refuses a folder with any.
 */
export function changedFiles(dir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { files?: Record<string, string> };
  const bad: string[] = [];
  for (const [rel, sha] of Object.entries(manifest.files ?? {})) {
    let text: string;
    try {
      text = readFileSync(join(dir, rel), "utf8");
    } catch {
      bad.push(rel);
      continue;
    }
    if (createHash("sha256").update(text).digest("hex") !== sha) bad.push(rel);
  }
  return bad;
}
