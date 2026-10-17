import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FocusStrip } from "@/components/options-focus";
import type { Options } from "@/lib/options";
import { validateOptionsEdition } from "@/lib/validate";
import optionsJson from "./fixtures/options.v1.json";

// The focus block: a few names with one level to break and one to hold, and an optional pre-market line. It is
// optional, so an edition without it must keep validating and must draw nothing.
const v1 = optionsJson as unknown as Options;

function withFocus(): Options {
  const e = structuredClone(v1);
  e.focus = {
    picked_at: "2026-10-16T21:56:00Z",
    method: "test",
    items: [
      {
        symbol: "QQQ",
        rank: 2,
        bias: "support",
        resistance: { price: 712.5, name: "PDH" },
        support: { price: 704.1, name: "PWL" },
        close: 709.82,
        atr: 9.1,
      },
      {
        symbol: "SPY",
        rank: 1,
        bias: "breakout",
        why: "Closed just under a heavy zone.",
        breakout_above: 773.25,
        hold_above: 760.64,
      },
    ],
    premarket: {
      as_of: "2026-10-19T12:45:00Z",
      items: [{ symbol: "SPY", price: 765.1, gap_pct: 0.2, where: "between" }],
    },
  };
  return e;
}

describe("today's focus", () => {
  it("validates an edition with a focus block, and one without", () => {
    expect(validateOptionsEdition(withFocus())).toMatchObject({ ok: true });
    expect(validateOptionsEdition(v1)).toMatchObject({ ok: true });
  });

  it("refuses an unknown bias", () => {
    const e = withFocus() as unknown as {
      focus: { items: { bias: string }[] };
    };
    e.focus.items[0]!.bias = "moon";
    expect(validateOptionsEdition(e)).toMatchObject({ ok: false });
  });

  it("draws the names in rank order with their levels and the pre-market line", () => {
    const html = renderToStaticMarkup(createElement(FocusStrip, { e: withFocus() }));
    expect(html.indexOf("SPY")).toBeLessThan(html.indexOf("QQQ"));
    expect(html).toContain("773.25");
    expect(html).toContain("704.10");
    expect(html).toContain("Between the levels pre-market");
    expect(html).toContain("Hold support");
  });

  it("draws nothing without a focus block", () => {
    expect(renderToStaticMarkup(createElement(FocusStrip, { e: v1 }))).toBe("");
  });
});
