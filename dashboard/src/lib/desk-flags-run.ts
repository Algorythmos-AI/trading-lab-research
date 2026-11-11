import "server-only";
import { PreconditionFailed, readForUpdate, readText, writeText, type StoredText } from "./blob";
import { DESK_FLAGS_PATH, EMPTY_FLAGS, flagsView, isDoneToday, markDone, parseDeskFlags, undo, type DeskFlagsDoc, type FlagsView } from "./desk-flags";
import { logEvent } from "./log";
import { fixtureMode } from "./snapshot";

// GET and POST /api/desk/flags: the owner's "done for today" flag (desk-flags.ts), the first thing on the site the
// browser writes. What protects it:
//  * Vercel Authentication, on every deployment and every path, /api included, as on the pages: only the owner's
//    Vercel login (or the publisher's automation bypass) reaches the site at all. proxy.ts gates nothing; it only
//    sets the pages' script policy, which is why it skips /api.
//  * Same origin only: a write must carry an Origin whose host is the request's own (or, with no Origin,
//    Sec-Fetch-Site: same-origin), and JSON; there are no CORS headers, so no other site can send one or read one.
//  * A fixed path, a body of at most MAX_BODY bytes, one key, an enum value; nothing from the request is echoed.
//  * A request carrying the deployment-protection bypass header is refused: that secret is the publisher's, and it
//    must never set or clear the owner's flag.

export const MAX_BODY = 256;
const ALLOW = "GET, HEAD, POST";
/** Vercel's deployment-protection bypass header (the publisher's automation secret). */
export const BYPASS_HEADER = "x-vercel-protection-bypass";

/** Everything a request touches, injectable so tests run the real logic with no store. */
export interface DeskFlagsDeps {
  /** The stored document, one read, for display (GET and the page). Null when there is none yet. */
  readView(): Promise<{ text: string } | null>;
  /** The stored document with the store's own etag (for a conditional write), or null when there is none yet. */
  read(): Promise<StoredText | null>;
  write(body: string, opts: { ifMatch?: string; createOnly?: boolean }): Promise<{ etag: string }>;
  now(): Date;
  /** Fixture mode or anywhere but production: the flag lives in this process's memory and the store is never touched. */
  memory: boolean;
}

// The in-memory flag for fixture mode and local runs. On globalThis so the page's render and the route, which Next
// may bundle apart, share one value in a process. It is never written to the store and is lost on restart.
const MEMORY_KEY = Symbol.for("wt.desk-flags.memory");
type MemoryHolder = { [MEMORY_KEY]?: DeskFlagsDoc };
const memoryGet = (): DeskFlagsDoc => (globalThis as MemoryHolder)[MEMORY_KEY] ?? EMPTY_FLAGS;
const memorySet = (d: DeskFlagsDoc) => {
  (globalThis as MemoryHolder)[MEMORY_KEY] = d;
};
/** For tests: forget the in-memory flag. */
export function resetMemoryFlags(): void {
  delete (globalThis as MemoryHolder)[MEMORY_KEY];
}

/** The deployed dependencies: the private store in production, memory everywhere else. */
export function defaultDeps(): DeskFlagsDeps {
  return {
    readView: () => readText(DESK_FLAGS_PATH),
    read: () => readForUpdate(DESK_FLAGS_PATH),
    write: (body, opts) => writeText(DESK_FLAGS_PATH, body, opts),
    now: () => new Date(),
    memory: fixtureMode() || process.env.VERCEL_ENV !== "production",
  };
}

/** A read of the flag: the document, or "could not read" (the store failed, or held something that is not it). */
export type FlagsRead = { status: "ok"; doc: DeskFlagsDoc; memory: boolean } | { status: "error" };

export async function readFlags(deps: DeskFlagsDeps): Promise<FlagsRead> {
  if (deps.memory) return { status: "ok", doc: memoryGet(), memory: true };
  try {
    const cur = await deps.readView();
    if (!cur) return { status: "ok", doc: EMPTY_FLAGS, memory: false };
    const doc = parseDeskFlags(cur.text);
    if (!doc) {
      logEvent("desk-flags.read", { outcome: "malformed" });
      return { status: "error" };
    }
    return { status: "ok", doc, memory: false };
  } catch (e) {
    logEvent("desk-flags.read", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return { status: "error" };
  }
}

/**
 * For the server's alerts (DEC-0044, section 4): may an entry alert go out? A read that failed counts as done, so no
 * alert is ever sent because the flag could not be read. The page says "could not check" instead (readFlags' status).
 */
export function doneForAlerts(result: FlagsRead, now: Date): boolean {
  return result.status !== "ok" || isDoneToday(result.doc, now);
}

/** The flag as the page's server render reads it: the view, or null when it could not be read. */
export async function loadFlagsView(deps: DeskFlagsDeps = defaultDeps()): Promise<FlagsView | null> {
  const r = await readFlags(deps);
  return r.status === "ok" ? flagsView(r.doc, deps.now()) : null;
}

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...extra } });
}

const fail = (status: number, error: string, extra?: Record<string, string>) => json(status, { error }, extra);

/**
 * Same origin only. With an Origin header its host must be the request's own; without one the browser's
 * Sec-Fetch-Site must say same-origin. A Sec-Fetch-Site naming anything else refuses the request either way.
 */
export function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const origin = req.headers.get("origin");
  if (origin === null) return site === "same-origin";
  try {
    const o = new URL(origin);
    return (o.protocol === "https:" || o.protocol === "http:") && o.host === host;
  } catch {
    return false; // "null" and anything unparseable
  }
}

export const isJson = (ct: string | null) => !!ct && /^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(ct.trim());

/** The body as text; "too-large" once it passes `max` bytes (read no further); "bad" when it is not UTF-8. */
export async function readCapped(req: Request, max: number): Promise<{ text: string } | "too-large" | "bad"> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) return "too-large";
  if (!req.body) return { text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(all) };
  } catch {
    return "bad";
  }
}

export type Action = "done" | "undo";

/** Exactly `{ "action": "done" | "undo" }`, or null. */
export function parseAction(text: string): Action | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "action") return null;
  const a = (v as { action: unknown }).action;
  return a === "done" || a === "undo" ? a : null;
}

function view(doc: DeskFlagsDoc, now: Date, memory: boolean): Response {
  return json(200, { ...flagsView(doc, now), memory });
}

async function handleGet(req: Request, deps: DeskFlagsDeps): Promise<Response> {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return fail(403, "forbidden");
  const r = await readFlags(deps);
  if (r.status !== "ok") return fail(503, "read-failed");
  return view(r.doc, deps.now(), r.memory);
}

async function handlePost(req: Request, deps: DeskFlagsDeps): Promise<Response> {
  if (!sameOrigin(req)) return fail(403, "forbidden");
  if (!isJson(req.headers.get("content-type"))) return fail(415, "json-only");
  const body = await readCapped(req, MAX_BODY);
  if (body === "too-large") return fail(413, "too-large");
  const action = body === "bad" ? null : parseAction(body.text);
  if (!action) return fail(400, "bad-request");

  if (deps.memory) {
    const now = deps.now();
    const t = action === "done" ? markDone(memoryGet(), now) : undo(memoryGet(), now);
    if (!t.ok) return fail(409, t.reason);
    if (t.changed) memorySet(t.doc);
    return view(t.doc, now, true);
  }

  // Read, apply, write only if nobody wrote in between (the store's etag). A conflict (the other device's tap landed
  // first) re-reads and re-applies once; a second conflict is reported, and nothing is claimed saved.
  for (let attempt = 0; attempt < 2; attempt++) {
    let cur: StoredText | null;
    try {
      cur = await deps.read();
    } catch (e) {
      logEvent("desk-flags.write", { outcome: "read-error", error: e instanceof Error ? e.name : "unknown" });
      return fail(503, "read-failed");
    }
    // A stored document that is not this one is replaced by a mark (done), never "undone".
    const doc = cur ? (parseDeskFlags(cur.text) ?? EMPTY_FLAGS) : EMPTY_FLAGS;
    const now = deps.now();
    const t = action === "done" ? markDone(doc, now) : undo(doc, now);
    if (!t.ok) return fail(409, t.reason);
    if (!t.changed) return view(t.doc, now, false);
    try {
      await deps.write(JSON.stringify(t.doc), cur ? { ifMatch: cur.etag } : { createOnly: true });
      logEvent("desk-flags.write", { outcome: "saved", action, attempt });
      return view(t.doc, now, false);
    } catch (e) {
      if (e instanceof PreconditionFailed) continue;
      logEvent("desk-flags.write", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
      return fail(503, "write-failed");
    }
  }
  logEvent("desk-flags.write", { outcome: "conflict" });
  return fail(409, "conflict");
}

/** The route: GET reads, POST changes, every other method is refused. */
export async function handleDeskFlags(req: Request, deps: DeskFlagsDeps = defaultDeps()): Promise<Response> {
  if (req.headers.has(BYPASS_HEADER)) return fail(403, "forbidden");
  if (req.method === "GET") return handleGet(req, deps);
  if (req.method === "HEAD") {
    const res = await handleGet(req, deps);
    return new Response(null, { status: res.status, headers: res.headers });
  }
  if (req.method === "POST") return handlePost(req, deps);
  return fail(405, "method-not-allowed", { allow: ALLOW });
}
