import "server-only";
import { listPaths, readText } from "./blob";
import { OPTIONS_PATHS } from "./desk";
import { editionCopyPath, parseEditionCopy } from "./edition-copy";
import type { Options } from "./options";
import { validateOptionsEdition } from "./validate";

// The reader of the Options edition copies (./edition-copy) for the labeller's replay, which takes
// `editions: {edition, receivedAt}[]` (owner-labels.ts ReplayInput). PRIVATE: the private store only. Nothing calls
// it yet: no route, page or cron may import this module until the release that first writes labels
// (test/edition-copies.test.ts checks that).

/** One copy as the replay takes it (structurally owner-labels.ts's EditionCopy, which this module does not import). */
export interface StoredEditionCopy {
  edition: Options;
  /** The store's receipt time, ISO 8601 with ms and Z. */
  receivedAt: string;
}

export interface EditionCopiesRead {
  /** The session's copies, in receipt order (ties by path); the editions' as_of plays no part in it. */
  copies: StoredEditionCopy[];
  /** Copies listed for the session that could not be used: gone, not a copy, not a valid edition, or not agreeing
   * with their own path. Counted, never dropped silently. */
  unreadable: number;
}

/** What the reader needs from the store; the private Blob store by default. */
export interface EditionCopyStore {
  list(prefix: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
}

const blobStore: EditionCopyStore = {
  list: async (prefix) => (await listPaths(prefix)).map((p) => p.pathname),
  read: async (path) => (await readText(path))?.text ?? null,
};

/** The copy at `path` as the replay takes it, or null when it is not a usable copy for `session`. */
function usable(path: string, text: string | null, prefix: string, session: string): StoredEditionCopy | null {
  if (text === null) return null;
  const c = parseEditionCopy(text);
  if (!c || c.session !== session) return null;
  const v = validateOptionsEdition(c.edition);
  if (!v.ok || v.edition.session !== session || v.edition.run_id !== c.runId) return null;
  // The path is fixed by the envelope's three fields: a copy that disagrees with it was not written by the ingest.
  if (editionCopyPath(prefix, session, c.receivedAt, c.runId) !== path) return null;
  return { edition: v.edition, receivedAt: c.receivedAt };
}

/**
 * The Options edition copies kept for `session` (YYYY-MM-DD), in receipt order. One list and one read per copy; a
 * storage failure is thrown, so a caller can tell "no copies" from "could not look".
 */
export async function optionsEditionCopies(session: string, store: EditionCopyStore = blobStore): Promise<EditionCopiesRead> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(session)) throw new Error("edition copies: session is not a date");
  const prefix = OPTIONS_PATHS.copies;
  const paths = (await store.list(`${prefix}${session}/`)).filter((p) => p.endsWith(".json")).sort();
  const read: { path: string; copy: StoredEditionCopy | null }[] = [];
  for (const path of paths) read.push({ path, copy: usable(path, await store.read(path), prefix, session) });
  const copies = read
    .filter((r): r is { path: string; copy: StoredEditionCopy } => r.copy !== null)
    .sort((a, b) => Date.parse(a.copy.receivedAt) - Date.parse(b.copy.receivedAt) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((r) => r.copy);
  return { copies, unreadable: read.length - copies.length };
}
