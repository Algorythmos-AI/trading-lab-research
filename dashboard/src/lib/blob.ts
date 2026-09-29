import "server-only";
import { BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";

// Every object is private; reads bypass the CDN so a write is visible to the next read.
export const LATEST_PATH = "snapshots/latest.json";
export const HISTORY_PREFIX = "snapshots/history/";
export const ALERT_STATE_PATH = "alerts/state.json";

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

export async function readText(pathname: string): Promise<StoredText | null> {
  const res = await get(pathname, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) return null;
  const text = await new Response(res.stream).text();
  return { text, etag: res.blob.etag };
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
