import { TableProperties } from "lucide-react";

/** Collapsible table twin for a chart, so no value is reachable only by hover. */
export function DataDetails({ summary = "Show the numbers", children }: { summary?: string; children: React.ReactNode }) {
  return (
    <details className="group mt-3">
      <summary className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer list-none items-center gap-1.5 text-xs select-none">
        <TableProperties aria-hidden className="size-3.5" />
        <span className="group-open:hidden">{summary}</span>
        <span className="hidden group-open:inline">Hide the numbers</span>
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
