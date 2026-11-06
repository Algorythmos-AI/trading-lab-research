import { TriangleAlert } from "lucide-react";
import { INDEX_NAMES, IV_CAP_INDEX, IV_CAP_SINGLE } from "@/lib/entry-checks";
import { TestingTag } from "./trade-now";

/** The IV cap for a name: the index names' own, or the single names'. */
export const ivCap = (symbol: string) => (INDEX_NAMES.includes(symbol) ? IV_CAP_INDEX : IV_CAP_SINGLE);

/**
 * The Contract pane's one line on an expensive option. It reads the picked contract's own implied volatility (`iv`,
 * from that option's quote). The board's IV caution (entry-checks) reads the name's IV from the edition instead
 * (`expected_move.annual_iv`). Both are held against the same caps (IV_CAP_INDEX for the index names, IV_CAP_SINGLE
 * for the rest), and at the cap is not above it, so the two differ only because they read different IVs. Null when
 * the IV is unknown or within the cap.
 */
export function ivLine(symbol: string, iv: number | null | undefined): string | null {
  if (typeof iv !== "number" || !Number.isFinite(iv) || iv <= 0) return null;
  const cap = ivCap(symbol);
  if (!(iv > cap)) return null;
  return `IV ${iv.toFixed(2)} is above ${cap.toFixed(2)} for ${symbol}: this option is expensive`;
}

/** The line as drawn: a warn icon, the sentence, and the Testing tag (never the word in the sentence). */
export function ContractIvLine({ symbol, iv }: { symbol: string; iv: number | null | undefined }) {
  const line = ivLine(symbol, iv);
  if (!line) return null;
  return (
    <p data-contract-iv className="text-warn flex flex-wrap items-center gap-1.5 text-xs font-medium">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      <span>{line}</span>
      <TestingTag />
    </p>
  );
}
