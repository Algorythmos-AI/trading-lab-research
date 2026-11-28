// The browser tests' check on the server's own errors (src/instrumentation.ts writes them down). A throw that a
// pane's boundary catches still lets the page pass, so without this a new one would only ever show in the log.
// A request whose `fx` cookie asks for damaged data on purpose is expected to throw in the pane it damages: those
// tests assert that the pane fails alone (states.spec.ts, desk.spec.ts). Every other server error fails the run.
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The fixture flags that damage a document on purpose, so that a pane reading it throws. */
export const EXPECTED_THROW_FLAGS: readonly string[] = ["poison", "journal-poison"];

export interface ServerError {
  path: string;
  route?: string;
  fx: string | null;
  error: string;
}

/** Where the server writes them: one file per port, so the config, the server and the teardown agree. */
export const serverErrorFile = (port: number) => join(tmpdir(), `dashboard-e2e-server-errors-${port}.jsonl`);

/** Whether the request asked for damaged data, so that its throw is the one the test is about. */
export function expected(e: Pick<ServerError, "fx">): boolean {
  const flags = new Set((e.fx ?? "").split("."));
  return EXPECTED_THROW_FLAGS.some((f) => flags.has(f));
}

/** The errors in the file's text that no fixture flag explains. A line that cannot be read counts as one. */
export function unexpectedServerErrors(text: string): ServerError[] {
  const out: ServerError[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: ServerError;
    try {
      e = JSON.parse(line) as ServerError;
    } catch {
      out.push({ path: "?", fx: null, error: `unreadable line: ${line.slice(0, 200)}` });
      continue;
    }
    if (!expected(e)) out.push(e);
  }
  return out;
}

export function clearServerErrors(port: number): void {
  rmSync(serverErrorFile(port), { force: true });
}

/** The unexpected errors written so far; none when the server wrote nothing (or was not started by this run). */
export function readServerErrors(port: number): ServerError[] {
  let text = "";
  try {
    text = readFileSync(serverErrorFile(port), "utf8");
  } catch {
    return [];
  }
  return unexpectedServerErrors(text);
}
