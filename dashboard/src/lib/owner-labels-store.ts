import "server-only";
import { PreconditionFailed, readText, writeText } from "./blob";
import { logEvent } from "./log";
import { LABEL_FORMAT, LABEL_ROW_KEYS, type LabelRow, type LabelRules } from "./owner-labels";

// Where a session's label rows are kept (DEC-0045 section 3: "written once per session and never worked out again").
// One PRIVATE document per experiment and New York session, desk/labels/<experiment id>/YYYY-MM-DD.json, written
// create-only: a second write for the same experiment and day never replaces the first, and says so. Two experiments
// never share a document. The rows are derived from the owner's journal: behind the login only.
//
// Anywhere but production the store is this process's memory and the Blob store is never touched (fixture mode is
// refused on production, so it is always memory too), as fill-check-run.ts does it.
//
// Wired to nothing in this release (DEC-0045 point 5).

export const LABELS_PREFIX = "desk/labels/";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (d: unknown): d is string => typeof d === "string" && DAY_RE.test(d) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;

type Experiment = LabelRules["experiment"];
const EXPERIMENTS: readonly Experiment[] = ["EXP-0031", "EXP-0033"];
const isExperiment = (v: unknown): v is Experiment => typeof v === "string" && (EXPERIMENTS as readonly string[]).includes(v);

/** The one place an experiment's rows for a session live. Throws for an unknown experiment or a day that is not real. */
export function labelsPath(experiment: Experiment, day: string): string {
  if (!isExperiment(experiment)) throw new RangeError("not a labelled experiment");
  if (!realDay(day)) throw new RangeError("not a session date");
  return `${LABELS_PREFIX}${experiment}/${day}.json`;
}

export interface LabelsDoc {
  format: typeof LABEL_FORMAT;
  experiment: Experiment;
  session: string;
  rows: LabelRow[];
}

export interface LabelStore {
  /** Fixture mode or anywhere but production. */
  memory: boolean;
  read(path: string): Promise<string | null>;
  /** Writes once; throws PreconditionFailed when something is already there. */
  createOnly(path: string, body: string): Promise<void>;
}

const MEMORY_KEY = Symbol.for("wt.owner-labels.memory");
type MemoryHolder = { [MEMORY_KEY]?: Map<string, string> };
const memory = (): Map<string, string> => ((globalThis as MemoryHolder)[MEMORY_KEY] ??= new Map());

/** For tests: forget the in-memory rows. */
export function resetMemoryLabels(): void {
  delete (globalThis as MemoryHolder)[MEMORY_KEY];
}

export function memoryLabelStore(): LabelStore {
  return {
    memory: true,
    read: async (path) => memory().get(path) ?? null,
    createOnly: async (path, body) => {
      if (memory().has(path)) throw new PreconditionFailed();
      memory().set(path, body);
    },
  };
}

/** The deployed store: the private Blob store in production, memory everywhere else. */
export function defaultLabelStore(env: Record<string, string | undefined> = process.env): LabelStore {
  if (env.VERCEL_ENV !== "production") return memoryLabelStore();
  return {
    memory: false,
    read: async (path) => (await readText(path))?.text ?? null,
    createOnly: async (path, body) => {
      await writeText(path, body, { createOnly: true });
    },
  };
}

const sameKeys = (r: unknown): boolean => !!r && typeof r === "object" && !Array.isArray(r) && Object.keys(r).join(",") === LABEL_ROW_KEYS.join(",");

/** The document, if it is one: the format, the experiment, a real session, and rows of exactly the row's keys, all of
 * that experiment and that session (a mixed document is rejected). */
export function parseLabels(text: string): LabelsDoc | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).join(",") !== "format,experiment,session,rows" || o.format !== LABEL_FORMAT || !isExperiment(o.experiment) || !realDay(o.session) || !Array.isArray(o.rows)) return null;
  if (!o.rows.every((r) => sameKeys(r) && (r as LabelRow).session === o.session && (r as LabelRow).experiment === o.experiment)) return null;
  return o as unknown as LabelsDoc;
}

export type WriteAnswer = { state: "written" } | { state: "exists" } | { state: "refused" } | { state: "error" };

/**
 * An experiment's rows for a session, written once. "exists" when that experiment and day already have a document: the
 * first is kept and nothing is written. "refused" when a row is not of that experiment and day, or not exactly a row.
 */
export async function writeSessionLabels(experiment: Experiment, day: string, rows: readonly LabelRow[], store: LabelStore = defaultLabelStore()): Promise<WriteAnswer> {
  if (!isExperiment(experiment) || !realDay(day) || !rows.every((r) => sameKeys(r) && r.session === day && r.experiment === experiment)) {
    logEvent("owner-labels.write", { outcome: "refused" });
    return { state: "refused" };
  }
  const doc: LabelsDoc = { format: LABEL_FORMAT, experiment, session: day, rows: [...rows] };
  try {
    await store.createOnly(labelsPath(experiment, day), JSON.stringify(doc));
  } catch (e) {
    const exists = e instanceof PreconditionFailed;
    logEvent("owner-labels.write", { outcome: exists ? "exists" : "error", memory: store.memory });
    return { state: exists ? "exists" : "error" };
  }
  logEvent("owner-labels.write", { outcome: "written", rows: rows.length, memory: store.memory });
  return { state: "written" };
}

export type ReadAnswer = { state: "ok"; doc: LabelsDoc } | { state: "missing" } | { state: "malformed" } | { state: "error" };

/** An experiment's stored rows for a session. */
export async function readSessionLabels(experiment: Experiment, day: string, store: LabelStore = defaultLabelStore()): Promise<ReadAnswer> {
  if (!isExperiment(experiment) || !realDay(day)) return { state: "error" };
  let text: string | null;
  try {
    text = await store.read(labelsPath(experiment, day));
  } catch {
    return { state: "error" };
  }
  if (text === null) return { state: "missing" };
  const doc = parseLabels(text);
  return doc && doc.session === day && doc.experiment === experiment ? { state: "ok", doc } : { state: "malformed" };
}
