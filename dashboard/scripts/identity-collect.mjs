#!/usr/bin/env node
// The collector for DEC-0051 section 8's engine identity check over logged sessions (EXP-0034's README, "Engine
// identity checks"): it copies, read-only, what the replay needs for the last N logged sessions into a private folder
// outside the repo. The replay is test/validation/engine-identity-sessions.test.ts; the steps are in
// docs/runbooks/engine-identity-sessions.md.
//
// Per session (a New York day with at least one server record under desk/log/<day>/):
//   records/<HHMM>.json   every server record of the session, as stored (DEC-0044; never the .page.json ones)
//   copies/<file>.json    every edition copy of the session, as stored (options/copies/<day>/, edition-copy.ts)
//   bars.json             the session's 2-minute bars of every focus name those editions hold, as Alpaca answered
//                         them (feed, timeframe and adjustment as bars.ts asks)
// and manifest.json at the top: the sessions, the counts, the feed, and the SHA-256 of every file written.
//
// It only lists and reads the store (list, get) and only reads Alpaca's bars: it never writes, copies or deletes in
// the store, and it places nothing anywhere. What it writes is PRIVATE (AGENTS.md data classes): it refuses a folder
// inside the repo, creates it owner-only, and prints counts only.
//
// Usage (the runbook has the full steps):
//   node --no-warnings scripts/identity-collect.mjs --out <folder outside the repo> [--sessions 10] [--until YYYY-MM-DD]
// Environment: BLOB_READ_WRITE_TOKEN (the production store's), the Alpaca data keys (ALPACA_API_KEY_ID and
// ALPACA_API_SECRET_KEY, or APCA_API_KEY_ID and APCA_API_SECRET_KEY), ALPACA_FEED (sip, as production), and
// optionally ALPACA_DATA_URL.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_VERSION = 1;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATA_URL = "https://data.alpaca.markets";
const PAGE_LIMIT = 50;

/** The repo's root: two levels above this file (dashboard/scripts). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** True when `out` is outside `root` (and is not `root` itself). */
export function outsideRepo(out, root = REPO_ROOT) {
  const rel = relative(resolve(root), resolve(out));
  return rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel);
}

/** `p` with its nearest existing ancestor's symlinks resolved (the folder itself may not exist yet). */
export function realOut(p) {
  let base = resolve(p);
  const rest = [];
  while (!existsSync(base)) {
    rest.unshift(basename(base));
    const up = dirname(base);
    if (up === base) break;
    base = up;
  }
  return join(realpathSync(base), ...rest);
}

/** True when the folder's nearest existing ancestor is inside any git checkout (this repo's other checkouts too). */
function insideGitCheckout(p) {
  let base = resolve(p);
  while (!existsSync(base) && dirname(base) !== base) base = dirname(base);
  try {
    return execFileSync("git", ["-C", base, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}

/** A server record's path for its slot (desk-eval.ts serverLogPath): desk/log/<day>/<HHMM>.json, never .page.json. */
export function isServerRecordPath(p) {
  return /^desk\/log\/\d{4}-\d{2}-\d{2}\/\d{4}\.json$/.test(p);
}

/** The days from desk/log/'s folders, sorted, at or before `until` (when given). */
export function logDays(folders, until) {
  const days = folders
    .map((f) => /^desk\/log\/(\d{4}-\d{2}-\d{2})\/$/.exec(f)?.[1])
    .filter((d) => typeof d === "string" && DAY_RE.test(d) && (!until || d <= until));
  return [...new Set(days)].sort();
}

/** The UTC instant (ms) of a New York wall-clock time on `day`, DST included. */
export function nyInstant(day, minutes) {
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const offsetAt = (t) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return t;
}

/** The focus names an edition holds (desk-eval.ts focusSymbols), plain tickers only. */
export function focusSymbolsOf(edition) {
  const items = Array.isArray(edition?.focus?.items) ? edition.focus.items : [];
  return items.map((i) => i?.symbol).filter((s) => typeof s === "string" && /^[A-Z][A-Z0-9.]{0,9}$/.test(s));
}

/** The feed asked for: exactly "sip" or "iex", as alpaca-feed.ts reads ALPACA_FEED; anything else stops the run. */
export function feedOf(env) {
  const f = (env.ALPACA_FEED ?? "").trim().toLowerCase();
  if (f !== "sip" && f !== "iex") throw new Error("ALPACA_FEED must be sip or iex (production reads sip)");
  return f;
}

function alpacaKeys(env) {
  for (const [id, secret] of [
    [env.ALPACA_API_KEY_ID, env.ALPACA_API_SECRET_KEY],
    [env.APCA_API_KEY_ID, env.APCA_API_SECRET_KEY],
  ]) {
    if (id && secret) return { id, secret };
  }
  return null;
}

function parseArgs(argv) {
  const a = { out: null, sessions: 10, until: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--out") a.out = v;
    else if (k === "--sessions") a.sessions = Number(v);
    else if (k === "--until") a.until = v;
    else throw new Error(`unknown argument ${k}`);
    i++;
  }
  if (!a.out) throw new Error("--out <folder outside the repo> is required");
  if (!Number.isInteger(a.sessions) || a.sessions < 1 || a.sessions > 30) throw new Error("--sessions must be 1 to 30");
  if (a.until !== null && !DAY_RE.test(a.until)) throw new Error("--until must be YYYY-MM-DD");
  return a;
}

async function listAll(blob, opts) {
  const blobs = [];
  const folders = [];
  let cursor;
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const r = await blob.list({ ...opts, cursor, limit: 1000 });
    blobs.push(...(r.blobs ?? []));
    folders.push(...(r.folders ?? []));
    if (!r.hasMore) return { blobs, folders };
    cursor = r.cursor;
  }
  throw new Error(`more than ${PAGE_LIMIT} pages under ${opts.prefix}`);
}

async function readText(blob, pathname) {
  const res = await blob.get(pathname, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) throw new Error(`could not read a stored file (status ${res?.statusCode ?? "none"})`);
  return await new Response(res.stream).text();
}

async function fetchBars(day, symbols, feed, keys, baseUrl) {
  const out = Object.fromEntries(symbols.map((s) => [s, []]));
  if (symbols.length === 0) return out;
  // The repo's one builder of Alpaca data URLs, which refuses a request without a feed (B9). Node loads the .ts
  // directly (type stripping, Node 22.18 or later); it imports nothing.
  const { alpacaDataUrl } = await import("../src/lib/alpaca-data-url.ts");
  const start = new Date(nyInstant(day, 9 * 60 + 30)).toISOString();
  const end = new Date(nyInstant(day, 16 * 60)).toISOString();
  let token = null;
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const q = { symbols: symbols.join(","), timeframe: "2Min", start, end, feed, limit: "10000", adjustment: "raw", ...(token ? { page_token: token } : {}) };
    const res = await fetch(alpacaDataUrl(baseUrl, "/v2/stocks/bars", q), { headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca bars answered HTTP ${res.status}`);
    const body = await res.json();
    for (const [s, bars] of Object.entries(body.bars ?? {})) if (out[s]) out[s].push(...bars);
    token = body.next_page_token ?? null;
    if (!token) return out;
  }
  throw new Error(`more than ${PAGE_LIMIT} pages of bars`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = realOut(args.out);
  if (!outsideRepo(out, realpathSync(REPO_ROOT)) || insideGitCheckout(out)) throw new Error("--out must be outside the repo and any git checkout: what it writes is private");
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error("--out must be a new or empty folder");
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is not set");
  const keys = alpacaKeys(process.env);
  if (!keys) throw new Error("the Alpaca data keys are not set");
  const feed = feedOf(process.env);
  const baseUrl = process.env.ALPACA_DATA_URL || DATA_URL;
  const blob = await import("@vercel/blob");

  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  const files = {};
  const write = (rel, text) => {
    const p = join(out, rel);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, text, { mode: 0o600 });
    files[rel] = createHash("sha256").update(text).digest("hex");
  };

  const days = logDays((await listAll(blob, { prefix: "desk/log/", mode: "folded" })).folders, args.until);
  const sessions = [];
  for (const day of days.reverse()) {
    if (sessions.length >= args.sessions) break;
    const records = (await listAll(blob, { prefix: `desk/log/${day}/` })).blobs.map((b) => b.pathname).filter(isServerRecordPath).sort();
    if (records.length === 0) continue;
    for (const p of records) write(`${day}/records/${p.split("/").pop()}`, await readText(blob, p));
    const copies = (await listAll(blob, { prefix: `options/copies/${day}/` })).blobs.map((b) => b.pathname).sort();
    const symbols = new Set();
    for (const p of copies) {
      const text = await readText(blob, p);
      write(`${day}/copies/${p.split("/").pop()}`, text);
      try {
        for (const s of focusSymbolsOf(JSON.parse(text).edition)) symbols.add(s);
      } catch {
        // an unreadable copy is kept as stored; the replay reports it
      }
    }
    const bars = await fetchBars(day, [...symbols].sort(), feed, keys, baseUrl);
    write(`${day}/bars.json`, JSON.stringify({ feed, timeframe: "2Min", adjustment: "raw", fetched_at: new Date().toISOString(), bars }));
    sessions.push({ day, records: records.length, copies: copies.length, names: symbols.size, bars: Object.values(bars).reduce((n, b) => n + b.length, 0) });
    console.log(`${day}: ${records.length} records, ${copies.length} edition copies, ${symbols.size} names`);
  }
  sessions.sort((a, b) => a.day.localeCompare(b.day));
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ tool: "identity-collect", version: TOOL_VERSION, created_at: new Date().toISOString(), feed, sessions, files }, null, 2), { mode: 0o600 });
  console.log(`${sessions.length} sessions collected${sessions.length < args.sessions ? ` (fewer than the ${args.sessions} asked for)` : ""}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`identity-collect: ${e instanceof Error ? e.message : "failed"}`);
    process.exit(1);
  });
}
