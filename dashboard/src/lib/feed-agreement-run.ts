// The feed agreement's runner (docs/runbooks/feed-agreement.md), started by hand after a session:
//
//   make feed-agreement DAY=2026-11-12 EDITION=var/feed-agreement/editions/2026-11-12.json
//   make feed-agreement-summary
//
// It reads the session's edition from a local file, the session's 2-minute bars for the focus names from IEX and
// from SIP (read-only GETs of historical bars), replays both through the server's evaluation (feed-agreement.ts) and
// writes the report as JSON and a short table, plus one row of the running summary, to a git-ignored folder. It sends
// nothing anywhere. When it cannot make a faithful report it prints why, exits non-zero and writes nothing.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { focusSymbols, sessionBounds, SYMBOL_RE } from "./desk-eval";
import { type Feed, feedAgreement, FEEDS, readSummary, reportText, summaryRow, summaryText } from "./feed-agreement";
import { CallLimiter, type Clock, DEFAULT_DATA_URL, fetchSessionBars, FetchStop, type StopKind } from "./feed-agreement-fetch";
import type { Options } from "./options";
import { alpacaKeys } from "./quote";
import { type Bar2, SERVER_SETTLE_MS } from "./trade-state";

export const EXIT = { ok: 0, usage: 2, refused: 3, noKeys: 4, plan: 5, noBars: 6, budget: 7, upstream: 8 } as const;
const STOP_EXIT: Record<StopKind, number> = { "sip-not-entitled": EXIT.plan, "iex-refused": EXIT.plan, "no-bars": EXIT.noBars, "time-budget": EXIT.budget, upstream: EXIT.upstream };

/** The hard time budget for the whole run's upstream reads, by default. */
export const DEFAULT_BUDGET_S = 120;
export const SUMMARY_FILE = "summary.jsonl";

export interface RunDeps {
  env: Record<string, string | undefined>;
  clock: Clock;
  fetchImpl: typeof fetch;
  /** The file's text, or null when it does not exist or cannot be read. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  appendText(path: string, text: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  print(line: string): void;
  /** Where the reports go when --out is not given. */
  defaultOut: string;
}

export interface Args {
  day: string | null;
  edition: string | null;
  out: string | null;
  budgetS: number;
  summary: boolean;
}

const USAGE = "usage: feed-agreement --day YYYY-MM-DD --edition <file> [--out <dir>] [--budget-s <seconds>] | --summary [--out <dir>]";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The arguments, or null when they are malformed. */
export function parseArgs(argv: readonly string[]): Args | null {
  const a: Args = { day: null, edition: null, out: null, budgetS: DEFAULT_BUDGET_S, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--summary") {
      a.summary = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return null;
    i++;
    if (k === "--day") a.day = v;
    else if (k === "--edition") a.edition = v;
    else if (k === "--out") a.out = v;
    else if (k === "--budget-s") {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 600) return null;
      a.budgetS = n;
    } else return null;
  }
  if (a.summary) return a.day === null && a.edition === null ? a : null;
  if (!a.day || !DAY_RE.test(a.day) || !a.edition) return null;
  return a;
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

/** One run. Returns the exit code. */
export async function main(argv: readonly string[], deps: RunDeps): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    deps.print(USAGE);
    return EXIT.usage;
  }
  const out = args.out ?? deps.defaultOut;
  const summaryPath = join(out, SUMMARY_FILE);
  if (args.summary) {
    deps.print(summaryText(readSummary((await deps.readText(summaryPath))?.split("\n") ?? [])));
    return EXIT.ok;
  }
  const day = args.day!;
  const bounds = sessionBounds(day);
  if (!bounds) {
    deps.print(`refused: ${day} is not a session day (weekend or exchange holiday)`);
    return EXIT.refused;
  }
  const started = deps.clock.now();
  if (started < bounds.close + SERVER_SETTLE_MS) {
    deps.print(`refused: the ${day} session has not closed yet`);
    return EXIT.refused;
  }
  const ed = readEdition(await deps.readText(args.edition!), day);
  if (!ed.ok) {
    deps.print(ed.line);
    return EXIT.refused;
  }
  const keys = alpacaKeys(deps.env);
  if (!keys) {
    deps.print("no keys: set APCA_API_KEY_ID and APCA_API_SECRET_KEY (or ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY) in the environment");
    return EXIT.noKeys;
  }
  const symbols = focusSymbols(ed.edition);
  const opts = {
    keys,
    clock: deps.clock,
    deadline: started + args.budgetS * 1000,
    limiter: new CallLimiter(),
    fetchImpl: deps.fetchImpl,
    baseUrl: deps.env.ALPACA_DATA_URL || DEFAULT_DATA_URL,
  };
  const bars = {} as Record<Feed, Record<string, Bar2[]>>;
  try {
    for (const feed of FEEDS) bars[feed] = await fetchSessionBars(feed, symbols, bounds, opts);
  } catch (e) {
    if (e instanceof FetchStop) {
      deps.print(e.line);
      return STOP_EXIT[e.kind];
    }
    deps.print(`upstream: the bars could not be read (${e instanceof Error ? e.name : "unknown"}); no report written`);
    return EXIT.upstream;
  }

  const report = feedAgreement(ed.edition, day, bars);
  const text = reportText(report);
  await deps.mkdirp(out);
  await deps.writeText(join(out, `${day}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await deps.writeText(join(out, `${day}.txt`), `${text}\n`);
  await deps.appendText(summaryPath, `${JSON.stringify(summaryRow(report, deps.clock.now()))}\n`);
  deps.print(text);
  deps.print("");
  deps.print(summaryText(readSummary((await deps.readText(summaryPath))?.split("\n") ?? [])));
  return EXIT.ok;
}

/** The real dependencies: the process's environment and clock, global fetch, the local disk. */
export function nodeDeps(defaultOut: string): RunDeps {
  return {
    env: process.env,
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    fetchImpl: fetch,
    readText: (p) => readFile(p, "utf8").catch(() => null),
    writeText: (p, t) => writeFile(p, t, "utf8"),
    appendText: (p, t) => appendFile(p, t, "utf8"),
    mkdirp: async (p) => {
      await mkdir(p, { recursive: true });
    },
    print: (line) => console.log(line),
    defaultOut,
  };
}
