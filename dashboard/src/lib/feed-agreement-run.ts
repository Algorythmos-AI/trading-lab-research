// The feed agreement's runner (docs/runbooks/feed-agreement.md), started by hand after a session:
//
//   make feed-agreement DAY=2026-11-12 EDITION=var/feed-agreement/editions/2026-11-12.json
//   make feed-agreement-summary
//   make feed-agreement-edition DAY=2026-11-12      (between the close and the evening edition)
//   make feed-agreement-recheck DAY=2026-11-12 EDITION=...   (once, the next day: how much the history drifts)
//
// It reads the session's edition from a local file, the session's 2-minute bars for the focus names from IEX and
// from SIP (read-only GETs of historical bars), replays both through the server's evaluation (feed-agreement.ts) and
// writes the report as JSON and a short table, plus one row of the running summary, to a git-ignored folder. It sends
// nothing anywhere. When it cannot make a faithful report it prints why, exits non-zero and writes nothing.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { focusSymbols, sessionBounds, SYMBOL_RE } from "./desk-eval";
import { type Feed, feedAgreement, FEEDS, parseStoredReport, readSummary, recheck, recheckText, reportText, type SessionReport, summaryRow, summaryText } from "./feed-agreement";
import { CallLimiter, type Clock, DEFAULT_DATA_URL, fetchSessionBars, FetchStop, KEY_SOURCE_WORDS, type KeySource, type StopKind } from "./feed-agreement-fetch";
import type { Options } from "./options";
import { sign } from "./hmac";
import { alpacaKeys } from "./quote";
import type { Bar2 } from "./trade-state";

export const EXIT = { ok: 0, usage: 2, refused: 3, noKeys: 4, plan: 5, noBars: 6, budget: 7, upstream: 8, write: 9, failed: 10, sipPlan: 11 } as const;
const STOP_EXIT: Record<StopKind, number> = {
  "sip-not-entitled": EXIT.plan,
  "sip-plan": EXIT.sipPlan,
  "iex-refused": EXIT.plan,
  "no-bars": EXIT.noBars,
  "time-budget": EXIT.budget,
  upstream: EXIT.upstream,
};

/** The hard time budget for the whole run's upstream reads, by default. */
export const DEFAULT_BUDGET_S = 120;
/** The runner waits this long after the close, so the session's historical bars have settled (half days included). */
export const AFTER_CLOSE_MS = 20 * 60_000;
export const SUMMARY_FILE = "summary.jsonl";
/** The signed read the pipeline check makes (edition-route.ts editionSigned("options")). */
export const EDITION_SIGNED = "GET /api/editions/options";
const EDITION_TIMEOUT_MS = 15_000;

export interface RunDeps {
  env: Record<string, string | undefined>;
  clock: Clock;
  fetchImpl: typeof fetch;
  /** The file's text, or null when it does not exist or cannot be read. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file; never throws. */
  remove(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  print(line: string): void;
  /** Where the reports go when --out is not given. */
  defaultOut: string;
}

export interface Args {
  mode: "run" | "recheck" | "summary" | "save-edition";
  day: string | null;
  edition: string | null;
  out: string | null;
  budgetS: number;
  /** The env file whose Alpaca key pair, when it defines one, wins over the inherited environment's. */
  envFile: string | null;
}

const USAGE =
  "usage: feed-agreement [--recheck] --day YYYY-MM-DD --edition <file> [--env-file <file>] [--out <dir>] [--budget-s <seconds>] | --summary [--out <dir>] | --save-edition --day YYYY-MM-DD [--out <dir>]";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The arguments, or null when they are malformed. */
export function parseArgs(argv: readonly string[]): Args | null {
  const a: Args = { mode: "run", day: null, edition: null, out: null, budgetS: DEFAULT_BUDGET_S, envFile: null };
  const modes: Record<string, Args["mode"]> = { "--summary": "summary", "--save-edition": "save-edition", "--recheck": "recheck" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (modes[k]) {
      if (a.mode !== "run") return null;
      a.mode = modes[k]!;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return null;
    i++;
    if (k === "--day") a.day = v;
    else if (k === "--edition") a.edition = v;
    else if (k === "--out") a.out = v;
    else if (k === "--env-file") a.envFile = v;
    else if (k === "--budget-s") {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 600) return null;
      a.budgetS = n;
    } else return null;
  }
  if (a.day !== null && !DAY_RE.test(a.day)) return null;
  if (a.mode === "summary") return a.day === null && a.edition === null ? a : null;
  if (a.mode === "save-edition") return a.day !== null && a.edition === null ? a : null;
  return a.day !== null && a.edition ? a : null;
}

/** The edition file read: an object with the session's day, tickers and at least one focus name, every one a ticker. */
export function readEdition(text: string | null, day: string): { ok: true; edition: Options } | { ok: false; line: string } {
  if (text === null) return { ok: false, line: "refused: the edition file cannot be read" };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, line: "refused: the edition file is not JSON" };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, line: "refused: the edition file is not an edition" };
  const e = v as Partial<Options>;
  if (typeof e.session !== "string" || !Array.isArray(e.tickers)) return { ok: false, line: "refused: the edition file is not an edition (no session or tickers)" };
  if (e.session !== day) return { ok: false, line: `refused: the edition is for ${DAY_RE.test(e.session) ? e.session : "another day"}, not ${day}` };
  const items = Array.isArray(e.focus?.items) ? e.focus.items : [];
  if (items.length === 0) return { ok: false, line: `refused: the ${day} edition has no focus names` };
  if (items.some((i) => typeof i?.symbol !== "string" || !SYMBOL_RE.test(i.symbol) || typeof i.rank !== "number")) return { ok: false, line: "refused: a focus name in the edition is not a ticker" };
  return { ok: true, edition: v as Options };
}

/**
 * Every file written to a temporary name, then renamed into place in the order given (the summary last). On any
 * failure the temporary files and the files already renamed by this call are removed: no partial file is left.
 */
export async function writeAll(deps: RunDeps, dir: string, files: readonly { path: string; text: string }[]): Promise<string | null> {
  const tag = `.${deps.clock.now()}.tmp`;
  const temps = files.map((f) => `${f.path}${tag}`);
  const placed: string[] = [];
  try {
    await deps.mkdirp(dir);
    for (const [i, f] of files.entries()) await deps.writeText(temps[i]!, f.text);
    for (const [i, f] of files.entries()) {
      await deps.rename(temps[i]!, f.path);
      placed.push(f.path);
    }
    return null;
  } catch (e) {
    for (const t of temps) await deps.remove(t);
    for (const p of placed) await deps.remove(p);
    return `write failed: ${e instanceof Error ? e.name : "unknown"}; nothing was left behind`;
  }
}

/**
 * The Alpaca keys: the env file's pair when the file is named and defines one (a shell profile can export a dead
 * pair, and Node's --env-file never overrides it), else the environment's. Read with Node's own env-file parser.
 */
export async function resolveKeys(deps: RunDeps, envFile: string | null): Promise<{ keys: { id: string; secret: string }; source: KeySource } | null> {
  if (envFile) {
    const text = await deps.readText(envFile);
    if (text !== null) {
      const fromFile = alpacaKeys(parseEnv(text));
      if (fromFile) return { keys: fromFile, source: "env-file" };
    }
  }
  const fromEnv = alpacaKeys(deps.env);
  return fromEnv ? { keys: fromEnv, source: "environment" } : null;
}

type Fetched = { ok: true; edition: Options; bars: Record<Feed, Record<string, Bar2[]>>; report: SessionReport } | { ok: false; code: number };

/** The checks, both feeds' bars and the replay; prints and returns the exit code when it cannot go on. */
async function fetchAndReplay(args: Args, deps: RunDeps): Promise<Fetched> {
  const day = args.day!;
  const bounds = sessionBounds(day);
  if (!bounds) {
    deps.print(`refused: ${day} is not a session day (weekend or exchange holiday)`);
    return { ok: false, code: EXIT.refused };
  }
  const started = deps.clock.now();
  if (started < bounds.close + AFTER_CLOSE_MS) {
    deps.print(`refused: run from 20 minutes after the ${day} close, when its bars have settled`);
    return { ok: false, code: EXIT.refused };
  }
  const ed = readEdition(await deps.readText(args.edition!), day);
  if (!ed.ok) {
    deps.print(ed.line);
    return { ok: false, code: EXIT.refused };
  }
  const got = await resolveKeys(deps, args.envFile);
  if (!got) {
    deps.print("no keys: set APCA_API_KEY_ID and APCA_API_SECRET_KEY (or ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY) in the env file or the environment");
    return { ok: false, code: EXIT.noKeys };
  }
  deps.print(KEY_SOURCE_WORDS[got.source]);
  const symbols = focusSymbols(ed.edition);
  const opts = {
    keys: got.keys,
    keySource: got.source,
    clock: deps.clock,
    deadline: started + args.budgetS * 1000,
    limiter: new CallLimiter(),
    fetchImpl: deps.fetchImpl,
    baseUrl: deps.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
  };
  const bars = {} as Record<Feed, Record<string, Bar2[]>>;
  const rateLimit: Record<Feed, number | null> = { iex: null, sip: null };
  try {
    for (const feed of FEEDS) {
      const r = await fetchSessionBars(feed, symbols, bounds, opts);
      bars[feed] = r.bars;
      rateLimit[feed] = r.rateLimit;
    }
  } catch (e) {
    if (e instanceof FetchStop) {
      deps.print(e.line);
      return { ok: false, code: STOP_EXIT[e.kind] };
    }
    deps.print(`upstream: the bars could not be read (${e instanceof Error ? e.name : "unknown"}); no report written`);
    return { ok: false, code: EXIT.upstream };
  }

  const report = feedAgreement(ed.edition, day, bars, undefined, { fetched_at: new Date(deps.clock.now()).toISOString(), rate_limit: rateLimit, keys: got.source });
  return { ok: true, edition: ed.edition, bars, report };
}

async function runSession(args: Args, deps: RunDeps, out: string): Promise<number> {
  const day = args.day!;
  const f = await fetchAndReplay(args, deps);
  if (!f.ok) return f.code;
  const report = f.report;
  const text = reportText(report);
  const summaryPath = join(out, SUMMARY_FILE);
  const before = (await deps.readText(summaryPath)) ?? "";
  const row = JSON.stringify(summaryRow(report, deps.clock.now()));
  const summary = `${before}${before && !before.endsWith("\n") ? "\n" : ""}${row}\n`;
  const failed = await writeAll(deps, out, [
    { path: join(out, `${day}.json`), text: `${JSON.stringify(report, null, 2)}\n` },
    { path: join(out, `${day}.txt`), text: `${text}\n` },
    { path: summaryPath, text: summary },
  ]);
  if (failed) {
    deps.print(failed);
    return EXIT.write;
  }
  deps.print(text);
  deps.print("");
  deps.print(summaryText(readSummary(summary.split("\n"))));
  return EXIT.ok;
}

/**
 * The same day fetched again and replayed; only how many units changed word (or set) against the stored report is
 * printed and written to <day>.recheck.json. The stored report and the summary are never touched.
 */
async function recheckSession(args: Args, deps: RunDeps, out: string): Promise<number> {
  const day = args.day!;
  const stored = parseStoredReport(await deps.readText(join(out, `${day}.json`)), day);
  if (!stored.ok) {
    deps.print(stored.line);
    return EXIT.refused;
  }
  const f = await fetchAndReplay(args, deps);
  if (!f.ok) return f.code;
  const r = recheck(stored.report, f.report);
  if ("refused" in r) {
    deps.print(r.refused);
    return EXIT.refused;
  }
  const failed = await writeAll(deps, out, [{ path: join(out, `${day}.recheck.json`), text: `${JSON.stringify(r, null, 2)}\n` }]);
  if (failed) {
    deps.print(failed);
    return EXIT.write;
  }
  deps.print(recheckText(r));
  return EXIT.ok;
}

/** The session's edition from the site's signed read, saved only when it is that session's. One read-only GET. */
async function saveEdition(day: string, deps: RunDeps, out: string): Promise<number> {
  const ingest = deps.env.DASHBOARD_INGEST_URL ?? "";
  const secret = deps.env.DASHBOARD_INGEST_SECRET;
  const url = ingest.replace(/\/api\/ingest\/?$/, "/api/editions/options");
  if (!secret || url === ingest || !/^https:\/\//.test(url)) {
    deps.print("no keys: DASHBOARD_INGEST_URL (ending /api/ingest, https) and DASHBOARD_INGEST_SECRET are needed in the env file");
    return EXIT.noKeys;
  }
  const ts = Math.floor(deps.clock.now() / 1000);
  const headers: Record<string, string> = { "x-wt-timestamp": String(ts), "x-wt-signature": sign(secret, ts, EDITION_SIGNED), accept: "application/json" };
  if (deps.env.DASHBOARD_KEY_ID) headers["x-wt-key-id"] = deps.env.DASHBOARD_KEY_ID;
  if (deps.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = deps.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  let body: unknown;
  try {
    const res = await deps.fetchImpl(url, { headers, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(EDITION_TIMEOUT_MS) });
    if (res.status !== 200) {
      deps.print(`upstream: the site answered HTTP ${res.status}; nothing saved`);
      return EXIT.upstream;
    }
    body = await res.json();
  } catch (e) {
    const name = e instanceof Error ? e.name : "unknown";
    if (name === "TimeoutError" || name === "AbortError") {
      deps.print("time budget: the site did not answer within 15 s; nothing saved");
      return EXIT.budget;
    }
    deps.print(`upstream: the site could not be read (${name}); nothing saved`);
    return EXIT.upstream;
  }
  const edition = body && typeof body === "object" ? (body as { edition?: unknown }).edition : undefined;
  const session = edition && typeof edition === "object" ? (edition as { session?: unknown }).session : undefined;
  if (session !== day) {
    deps.print(`refused: the site holds the ${typeof session === "string" && DAY_RE.test(session) ? session : "unknown"} edition, not ${day}; nothing saved`);
    return EXIT.refused;
  }
  const dir = join(out, "editions");
  const path = join(dir, `${day}.json`);
  const failed = await writeAll(deps, dir, [{ path, text: JSON.stringify(edition) }]);
  if (failed) {
    deps.print(failed);
    return EXIT.write;
  }
  deps.print(`saved ${path}`);
  return EXIT.ok;
}

/** One run. Returns the exit code; never throws, never prints a stack trace. */
export async function main(argv: readonly string[], deps: RunDeps): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (!args) {
      deps.print(USAGE);
      return EXIT.usage;
    }
    const out = args.out ?? deps.defaultOut;
    if (args.mode === "summary") {
      deps.print(summaryText(readSummary((await deps.readText(join(out, SUMMARY_FILE)))?.split("\n") ?? [])));
      return EXIT.ok;
    }
    if (args.mode === "save-edition") return await saveEdition(args.day!, deps, out);
    if (args.mode === "recheck") return await recheckSession(args, deps, out);
    return await runSession(args, deps, out);
  } catch (e) {
    deps.print(`failed: ${e instanceof Error ? e.name : "unknown"}; no report written`);
    return EXIT.failed;
  }
}

/** The real dependencies: the process's environment and clock, global fetch, the local disk. */
export function nodeDeps(defaultOut: string): RunDeps {
  return {
    env: process.env,
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    fetchImpl: fetch,
    readText: (p) => readFile(p, "utf8").catch(() => null),
    writeText: (p, t) => writeFile(p, t, { encoding: "utf8", flag: "wx" }),
    rename: (a, b) => rename(a, b),
    remove: (p) => rm(p, { force: true }).catch(() => undefined),
    mkdirp: async (p) => {
      await mkdir(p, { recursive: true });
    },
    print: (line) => console.log(line),
    defaultOut,
  };
}
