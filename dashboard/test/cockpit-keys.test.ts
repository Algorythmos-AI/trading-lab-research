import { describe, expect, it } from "vitest";
import { cockpitShortcut, type KeyFacts } from "@/lib/cockpit-keys";

const k = (over: Partial<KeyFacts> = {}): KeyFacts => ({ key: "c", ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false, typing: false, menuOpen: false, ...over });

describe("the cockpit's C shortcut", () => {
  it("fires on C, either case", () => {
    expect(cockpitShortcut(k())).toBe(true);
    expect(cockpitShortcut(k({ key: "C" }))).toBe(true);
  });
  it("never with a modifier (Cmd+C still copies), on repeats, or for another key", () => {
    expect(cockpitShortcut(k({ metaKey: true }))).toBe(false);
    expect(cockpitShortcut(k({ ctrlKey: true }))).toBe(false);
    expect(cockpitShortcut(k({ altKey: true }))).toBe(false);
    expect(cockpitShortcut(k({ repeat: true }))).toBe(false);
    expect(cockpitShortcut(k({ key: "x" }))).toBe(false);
  });
  it("never while typing, composing, when another handler took the key, or with a rail menu open", () => {
    expect(cockpitShortcut(k({ typing: true }))).toBe(false);
    expect(cockpitShortcut(k({ isComposing: true }))).toBe(false);
    expect(cockpitShortcut(k({ defaultPrevented: true }))).toBe(false);
    expect(cockpitShortcut(k({ menuOpen: true }))).toBe(false);
  });
});
