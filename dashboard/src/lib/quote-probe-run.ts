import "server-only";
import { listPaths, readText } from "./blob";
import { presentsBypass } from "./desk-flags-run";
import { logEvent } from "./log";
import { nyClock } from "./options";
import { type ProbeSummary, summariseProbe } from "./quote-probe";
import { fixtureMode } from "./snapshot";

// GET /api/desk/probe?day=YYYY-MM-DD: the owner's view of the snapshot probe (quote-probe.ts) for one New York day,
// read from the server check's own records (desk/log/<day>/HHMM.json, desk-run.ts), as counts per fact, per name
// and in total. Temporary evidence for the board's bad-data guards. Behind Vercel Authentication like every page,
// hardened like /api/desk/eval-status (GET and HEAD only, cross-site refused, Vercel's protection bypass refused in
// every documented form, no-store).
//
// It is read only when the owner opens it, never by a page or a cron: one listing of the day's folder and one read per
// server record (about 195 on a full session, at most MAX_RECORDS). A HEAD answers from validation alone and reads
// nothing. A past New York day's summary is kept in this instance's memory (at most CACHED_DAYS days), since its
// create-only records can no longer change; today's is never kept. It writes nothing. In fixture mode and anywhere
// but production it never touches the store and answers an empty summary with `"dry": true`.

/** A full session has 195 two-minute slots; the folder also holds the page's records, which are not read. */
export const MAX_RECORDS = 256;
/** Reads in flight at once. */
export const READ_CONCURRENCY = 8;
/** Past days whose summary this instance keeps; the oldest kept is dropped first. */
export const CACHED_DAYS = 5;
const pastDays = new Map<string, ProbeDay>();

/** For tests: forget the kept past days. */
export function resetProbeCache(): void {
  pastDays.clear();
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SERVER_RECORD_RE = /^desk\/log\/\d{4}-\d{2}-\d{2}\/\d{4}\.json$/;

export interface ProbeReadDeps {
  now(): number;
  dry: boolean;
  /** The pathnames under a prefix. */
  list(prefix: string): Promise<string[]>;
  /** One record's text, or null when it is gone. */
  read(path: string): Promise<string | null>;
}

const refuse = () => Promise.reject(new Error("dry run: the store is not touched"));

export function defaultProbeReadDeps(): ProbeReadDeps {
  if (fixtureMode() || process.env.VERCEL_ENV !== "production") return { now: () => Date.now(), dry: true, list: refuse, read: refuse };
  return {
    now: () => Date.now(),
    dry: false,
    list: async (prefix) => (await listPaths(prefix)).map((b) => b.pathname),
    read: async (path) => (await readText(path))?.text ?? null,
  };
}

const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
const fail = (status: number, error: string, extra?: Record<string, string>) => json(status, { error }, extra);
const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

/** A real calendar date in YYYY-MM-DD, or null. */
export function parseDay(v: string | null): string | null {
  if (v === null || !DAY_RE.test(v)) return null;
  const t = Date.parse(`${v}T12:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

export interface ProbeDay {
  day: string;
  /** Server records the listing found for the day (page records are not counted), and those that could not be read or parsed. */
  listed: number;
  unreadable: number;
  /** True when more records were listed than MAX_RECORDS: the rest were not read. */
  capped: boolean;
  summary: ProbeSummary;
}

/** One day's summary from the store: the server records only, read a few at a time, each failure counted, never thrown. */
export async function readProbeDay(deps: ProbeReadDeps, day: string): Promise<ProbeDay> {
  const paths = (await deps.list(`desk/log/${day}/`)).filter((p) => SERVER_RECORD_RE.test(p) && p.startsWith(`desk/log/${day}/`)).sort();
  const take = paths.slice(0, MAX_RECORDS);
  const records: unknown[] = [];
  let unreadable = 0;
  for (let i = 0; i < take.length; i += READ_CONCURRENCY) {
    const got = await Promise.all(
      take.slice(i, i + READ_CONCURRENCY).map(async (p) => {
        try {
          const text = await deps.read(p);
          return text === null ? undefined : (JSON.parse(text) as unknown);
        } catch {
          return undefined;
        }
      }),
    );
    for (const r of got) {
      if (r === undefined) unreadable++;
      else records.push(r);
    }
  }
  return { day, listed: paths.length, unreadable, capped: paths.length > take.length, summary: summariseProbe(records) };
}

/** GET and HEAD /api/desk/probe[?day=YYYY-MM-DD], today's New York day by default. */
export async function handleProbeSummary(req: Request, deps: ProbeReadDeps = defaultProbeReadDeps()): Promise<Response> {
  if (presentsBypass(req)) return fail(403, "forbidden");
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method-not-allowed", { allow: "GET, HEAD" });
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return fail(403, "forbidden");
  const today = nyClock(new Date(deps.now()).toISOString())?.day ?? null;
  const raw = new URL(req.url).searchParams.get("day");
  const day = raw === null ? today : parseDay(raw);
  if (day === null) return fail(400, "bad-day");
  // HEAD: the checks above are the whole answer; nothing is listed or read.
  if (req.method === "HEAD") return new Response(null, { status: 200, headers: NO_STORE });
  if (deps.dry) return json(200, { day, listed: 0, unreadable: 0, capped: false, summary: summariseProbe([]), dry: true });
  const kept = pastDays.get(day);
  if (kept) return json(200, { ...kept, cached: true });
  let got: ProbeDay;
  try {
    got = await readProbeDay(deps, day);
  } catch (e) {
    logEvent("desk-probe", { outcome: "error", error: errName(e) });
    return fail(503, "read-failed");
  }
  // Only a day before today in New York, read whole: a later read of it would find the same records.
  if (today !== null && day < today && got.unreadable === 0) {
    pastDays.set(day, got);
    while (pastDays.size > CACHED_DAYS) pastDays.delete(pastDays.keys().next().value!);
  }
  return json(200, { ...got, cached: false });
}
