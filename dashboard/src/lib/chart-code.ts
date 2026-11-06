// The owner's chart colour code in one place: the words (CHART_CODE, from focus-plan.ts), the Tailwind classes the
// focus card draws its balls and swatches with (LINE), and the same code as SVG strokes for the price ladder.
//
// The focus card (components/options-focus.tsx) and the ladder both read their styles from here, so a line looks the
// same everywhere (test/level-ladder.test.ts checks the ladder's strokes against these tones).
import { CHART_CODE, type LineKind } from "./focus-plan";

export { CHART_CODE };
export type { LineKind };

/** The focus card's ball and swatch classes per kind of line. */
export const LINE: Record<LineKind, { ball: string; swatch: string }> = {
  ceiling: {
    ball: "bg-bad-fill",
    swatch: "border-t-4 border-solid border-bad-fill",
  },
  floor: {
    ball: "bg-good-fill",
    swatch: "border-t-4 border-solid border-good-fill",
  },
  week: {
    ball: "bg-info-fill",
    swatch: "border-t-2 border-dashed border-info-fill",
  },
  month: {
    ball: "bg-chart-7",
    swatch: "border-t-2 border-dashed border-chart-7",
  },
  target: {
    ball: "bg-neutral",
    swatch: "border-t-2 border-dotted border-neutral",
  },
};

/** The same code as SVG strokes: colour token, width in px and dash pattern (none for solid). */
export const LINE_SVG: Record<LineKind, { stroke: string; text: string; width: number; dash?: string }> = {
  ceiling: { stroke: "var(--bad-fill)", text: "var(--bad)", width: 3 },
  floor: { stroke: "var(--good-fill)", text: "var(--good)", width: 3 },
  week: { stroke: "var(--info-fill)", text: "var(--info)", width: 2, dash: "6 4" },
  month: { stroke: "var(--chart-7)", text: "var(--chart-7)", width: 2, dash: "6 4" },
  target: { stroke: "var(--neutral)", text: "var(--foreground)", width: 1.5 },
};
