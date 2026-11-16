// The owner's own money, as the pages that show their Webull account write it: "+$1,234", "−$40", "$0", whole dollars
// unless asked for cents. lib/format.ts's `usd` ("US$1,234.50") is for paper-account money only; the two look
// different on purpose, so a real figure never reads as a paper one. components/ui/money.tsx picks between them by
// evidence class (lib/env.ts).
//
// It is kept apart from lib/format.ts on purpose: format.ts is in the desk signal's and the engine's import closures
// (scripts/gen-signal.mjs, scripts/gen-engine.mjs), and this file is in neither.
import { DASH } from "./format";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The word joiner keeps a sign on the same line as its amount. */
const JOIN = "⁠";

/**
 * Real (Webull) US dollars, exactly as journal.tsx's and your-day.tsx's own `usd` have always written them: with
 * `signed`, "+⁠$125" for a gain, "−⁠$40" for a loss and "$0" for zero, the sign read from the value itself (so 0.4
 * shows "+⁠$0", as it always has). Without `signed` a gain has no "+"; a loss keeps its "−". "—" for a missing figure.
 * test/env.test.ts pins this against the old helpers, value by value.
 */
export function realUsd(v: number | null | undefined, { digits = 0, signed = false }: { digits?: number; signed?: boolean } = {}): string {
  if (!isNum(v)) return DASH;
  const body = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (v < 0) return `−${JOIN}$${body}`;
  return signed && v > 0 ? `+${JOIN}$${body}` : `$${body}`;
}
