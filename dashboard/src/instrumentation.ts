// Server errors during the browser tests. A pane that throws on the server is drawn as "could not be drawn" by its
// boundary, so the page still passes and the throw shows only in the server's log. Under the browser tests
// (fixture mode, with E2E_SERVER_ERRORS naming a file) each one is written down with the request's `fx` cookie, and
// the run fails afterwards on any that the request's fixture flags do not explain (test/e2e/server-errors.ts).
// Outside that it does nothing: no file, no headers kept.
import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const file = process.env.E2E_SERVER_ERRORS;
  if (process.env.DASHBOARD_FIXTURE !== "1" || !file || process.env.NEXT_RUNTIME !== "nodejs") return;
  const cookie = request.headers.cookie;
  const fx = (Array.isArray(cookie) ? cookie.join("; ") : (cookie ?? "")).match(/(?:^|;\s*)fx=([^;]*)/)?.[1] ?? null;
  const line = {
    path: request.path,
    route: context.routePath,
    fx: fx === null ? null : decodeURIComponent(fx),
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
  const { appendFile } = await import("node:fs/promises");
  await appendFile(file, `${JSON.stringify(line)}\n`).catch(() => undefined);
};
