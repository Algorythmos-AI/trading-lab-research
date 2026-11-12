import "server-only";
import { BlobError, BlobNotFoundError, BlobPreconditionFailedError, del, get, head, list, put } from "@vercel/blob";

// Every object is private; reads bypass the CDN so a write is visible to the next read.
export const LATEST_PATH = "snapshots/latest.json";
/** A non-primary host's latest snapshot (the OCI host during its shadow run). Never read by the pages or the watchdog. */
export const SHADOW_LATEST_PATH = "shadow/latest.json";
export const HISTORY_PREFIX = "snapshots/history/";
export const ALERT_STATE_PATH = "alerts/state.json";

export { DESK_PATHS, type DeskName, type DeskPaths } from "./desk";

export class PreconditionFailed extends Error {
  constructor() {
    super("blob etag changed since it was read");
    this.name = "PreconditionFailed";
  }
}

export interface StoredText {
  text: string;
  etag: string;
}

/** For display only. The etag here is the download response's header, which a conditional write rejects:
 *  use readForUpdate() for read-modify-write. */
export async function readText(pathname: string): Promise<StoredText | null> {
  const res = await get(pathname, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) return null;
  const text = await new Response(res.stream).text();
  return { text, etag: res.blob.etag };
}

/** Whether a blob is stored at `pathname`: one head(), the store's own metadata, no body. */
export async function exists(pathname: string): Promise<boolean> {
  try {
    await head(pathname);
    return true;
  } catch (e) {
    if (e instanceof BlobNotFoundError) return false;
    throw e;
  }
}

/**
 * When the blob at `pathname` was last written, from the store's own metadata (one head(), no body); null when there
 * is none. Every write replaces the blob, so for a latest.json this is when the last accepted document was stored.
 */
export async function storedAt(pathname: string): Promise<string | null> {
  try {
    return new Date((await head(pathname)).uploadedAt).toISOString();
  } catch (e) {
    if (e instanceof BlobNotFoundError) return null;
    throw e;
  }
}

/**
 * The store's own metadata for the blob at `pathname`, from one head(): its etag (the one put({ ifMatch }) compares)
 * and when it was written (uploadedAt, ISO with Z); null when there is none. Both come from the same response, so the
 * time is that of the very write the etag names: a caller that holds the etag its own put() returned can tell whether
 * the time is its write's. A missing or invalid time is thrown, never guessed.
 */
export async function storedMeta(pathname: string): Promise<{ etag: string; uploadedAt: string } | null> {
  try {
    const h = await head(pathname);
    return { etag: h.etag, uploadedAt: new Date(h.uploadedAt).toISOString() };
  } catch (e) {
    if (e instanceof BlobNotFoundError) return null;
    throw e;
  }
}

// The last text read per path on this instance, by its delivery etag, for readTextIfChanged. A warm instance asks
// the store "changed since?" and gets a bodiless 304 when it has not; a cold one reads it whole. Bounded: a handful
// of fixed paths only ever enter it.
const lastRead = new Map<string, StoredText>();
const LAST_READ_MAX = 8;

/** For tests: forget what readTextIfChanged has kept. */
export function resetReadCache(): void {
  lastRead.clear();
}

/**
 * For display, like readText, but a document read before on this instance is asked for again only if it changed
 * (ifNoneMatch on its etag): unchanged, the store answers 304 with no body and the kept text is returned. Still one
 * read of the store per call; what it saves is the body's transfer and parse. Null when there is no document.
 */
export async function readTextIfChanged(pathname: string): Promise<StoredText | null> {
  const kept = lastRead.get(pathname);
  const res = await get(pathname, { access: "private", useCache: false, ...(kept ? { ifNoneMatch: kept.etag } : {}) });
  if (!res) {
    lastRead.delete(pathname);
    return null;
  }
  if (res.statusCode === 304 && kept) return kept;
  if (res.statusCode !== 200) return null;
  const text = await new Response(res.stream).text();
  const read = { text, etag: res.blob.etag };
  lastRead.delete(pathname);
  lastRead.set(pathname, read);
  while (lastRead.size > LAST_READ_MAX) lastRead.delete(lastRead.keys().next().value!);
  return read;
}

/**
 * Read for a conditional write. The etag comes from head(), the store's own metadata, which is what
 * put({ ifMatch }) compares against; get()'s etag is the delivery header and never matches (the 503
 * "conflict" on every publish after the first). head() runs first: if a write lands between the two
 * calls we hold an older etag with newer text, so the conditional write fails and is retried. The
 * other order could pair older text with a newer etag and let an older snapshot overwrite a newer one.
 */
export async function readForUpdate(pathname: string): Promise<(StoredText & { uploadedAt?: string }) | null> {
  let etag: string;
  let uploadedAt: string | undefined;
  try {
    const h = await head(pathname);
    etag = h.etag;
    // The time of the write that etag names, when the store gives a valid one. Optional: a caller must pair it with
    // the text only once a write conditioned on this etag has succeeded (the text may be newer than the etag).
    const at = new Date(h.uploadedAt);
    uploadedAt = Number.isFinite(at.getTime()) ? at.toISOString() : undefined;
  } catch (e) {
    if (e instanceof BlobNotFoundError) return null;
    throw e;
  }
  const cur = await readText(pathname);
  return cur ? { text: cur.text, etag, ...(uploadedAt ? { uploadedAt } : {}) } : null;
}

export async function writeText(
  pathname: string,
  body: string,
  opts: { ifMatch?: string | null; createOnly?: boolean } = {},
): Promise<{ etag: string }> {
  try {
    const res = await put(pathname, body, {
      access: "private",
      allowOverwrite: !opts.createOnly,
      addRandomSuffix: false,
      contentType: "application/json",
      cacheControlMaxAge: 60,
      ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
    });
    return { etag: res.etag };
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError) throw new PreconditionFailed();
    // A create-only write that finds the blob already there lost a race, same as a stale etag.
    if (opts.createOnly && alreadyThere(e)) throw new PreconditionFailed();
    throw e;
  }
}

/**
 * A create-only put refused because the blob exists. The SDK has no class of its own for it: a precondition error, or a
 * BlobError whose code (when it carries one) or message says so; the message is the fallback.
 */
export function alreadyThere(e: unknown): boolean {
  if (e instanceof BlobPreconditionFailedError) return true;
  if (!(e instanceof BlobError)) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && /exist|conflict/i.test(code)) return true;
  return /exist/i.test(e.message);
}

export async function listPaths(prefix: string): Promise<{ pathname: string; url: string }[]> {
  const out: { pathname: string; url: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    out.push(...page.blobs.map((b) => ({ pathname: b.pathname, url: b.url })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

export async function deleteUrls(urls: string[]): Promise<void> {
  for (let i = 0; i < urls.length; i += 100) {
    await del(urls.slice(i, i + 100));
  }
}
