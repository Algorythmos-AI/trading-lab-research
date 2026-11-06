import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContractIvLine, ivCap, ivLine } from "@/components/client/contract-iv";
import { IV_CAP_INDEX, IV_CAP_SINGLE } from "@/lib/entry-checks";

// The Contract pane's one line on an expensive option: the picked contract's own IV above the cap for its name.
describe("the contract's IV line", () => {
  it("uses the index cap for the index names and the single-name cap for the rest", () => {
    expect(ivCap("SPY")).toBe(IV_CAP_INDEX);
    expect(ivCap("QQQ")).toBe(IV_CAP_INDEX);
    expect(ivCap("NVDA")).toBe(IV_CAP_SINGLE);
  });

  it("says so above the cap, never at it, and says nothing when the IV is unknown", () => {
    expect(ivLine("SPY", 0.42)).toBe("IV 0.42 is above 0.35 for SPY: this option is expensive");
    expect(ivLine("SPY", IV_CAP_INDEX)).toBeNull();
    expect(ivLine("SPY", 0.3)).toBeNull();
    expect(ivLine("NVDA", 0.42)).toBeNull();
    expect(ivLine("NVDA", 0.81)).toBe("IV 0.81 is above 0.70 for NVDA: this option is expensive");
    expect(ivLine("SPY", null)).toBeNull();
    expect(ivLine("SPY", undefined)).toBeNull();
    expect(ivLine("SPY", Number.NaN)).toBeNull();
  });

  it("draws a warn line with the Testing tag, and nothing below the cap", () => {
    const html = renderToStaticMarkup(createElement(ContractIvLine, { symbol: "SPY", iv: 0.42 }));
    expect(html).toContain("data-contract-iv");
    expect(html).toContain("text-warn");
    expect(html).toContain("data-testing-tag");
    expect(html).not.toMatch(/\(testing\)/i);
    expect(renderToStaticMarkup(createElement(ContractIvLine, { symbol: "SPY", iv: 0.2 }))).toBe("");
  });
});
