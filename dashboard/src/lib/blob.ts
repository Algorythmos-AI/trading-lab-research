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

/**
 * Read for a conditional write. The etag comes from head(), the store's own metadata, which is what
 * put({ ifMatch }) compares against; get()'s etag is the delivery header and never matches (the 503
 * "conflict" on every publish after the first). head() runs first: if a write lands between the two
 * calls we hold an older etag with newer text, so the conditional write fails and is retried. The
 * other order could pair older text with a newer etag and let an older snapshot overwrite a newer one.
 */
export async function readForUpdate(pathname: string): Promise<StoredText | null> {
  let etag: string;
  try {
    etag = (await head(pathname)).etag;
  } catch (e) {
    if (e instanceof BlobNotFoundError) return null;
    throw e;
  }
  const cur = await readText(pathname);
  return cur ? { text: cur.text, etag } : null;
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
    if (opts.createOnly && e instanceof BlobError && /exist/i.test(e.message)) throw new PreconditionFailed();
    throw e;
  }
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
