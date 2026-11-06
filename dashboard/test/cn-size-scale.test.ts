import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

// The page's size scale is a font size: cn must keep a colour written beside it, and replace another size.
describe("cn and the size scale", () => {
  it("keeps the colour beside a size token", () => {
    expect(cn("text-price text-good")).toBe("text-price text-good");
    expect(cn("text-decision", "text-bad")).toBe("text-decision text-bad");
  });
  it("lets a size token replace another size", () => {
    expect(cn("text-sm text-live")).toBe("text-live");
    expect(cn("text-explain text-level")).toBe("text-level");
  });
});
