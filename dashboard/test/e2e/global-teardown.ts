import { readServerErrors } from "./server-errors";

// Fail the run on a server error that no test asked for (test/e2e/server-errors.ts), even when every page passed.
export default function globalTeardown(): void {
  const errors = readServerErrors(Number(process.env.E2E_PORT ?? 3100));
  if (errors.length === 0) return;
  const lines = errors.slice(0, 20).map((e) => `  ${e.path} (fx=${e.fx ?? "none"}): ${e.error}`);
  const more = errors.length > 20 ? [`  … and ${errors.length - 20} more`] : [];
  throw new Error(
    [`The server threw ${errors.length} error(s) that no fixture flag explains (a pane boundary may have hidden them):`, ...lines, ...more].join("\n"),
  );
}
