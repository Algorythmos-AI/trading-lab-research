// The browser tests' server-error check (test/e2e/server-errors.ts): a throw on a request that asked for damaged
// data is the one its test is about; any other fails the run, and so does a line that cannot be read.
import { describe, expect, it } from "vitest";
import { expected, unexpectedServerErrors } from "./e2e/server-errors";

const line = (fx: string | null, error = "TypeError: Cannot read properties of null (reading 'r')") =>
  JSON.stringify({ path: "/options", route: "/options", fx, error });

describe("unexpectedServerErrors", () => {
  it("passes over throws on requests that damage a document on purpose", () => {
    expect(expected({ fx: "poison" })).toBe(true);
    expect(expected({ fx: "frozen.journal-poison" })).toBe(true);
    expect(unexpectedServerErrors([line("poison"), line("frozen.journal-poison"), ""].join("\n"))).toEqual([]);
  });

  it("keeps every other throw, with no cookie, other flags or a flag that only looks alike", () => {
    expect(expected({ fx: null })).toBe(false);
    expect(expected({ fx: "calendar-poison" })).toBe(false);
    expect(expected({ fx: "frozen.registry-poison" })).toBe(false);
    const out = unexpectedServerErrors([line(null), line("frozen.gap-flat"), line("poison")].join("\n"));
    expect(out.map((e) => e.fx)).toEqual([null, "frozen.gap-flat"]);
  });

  it("counts a line it cannot read as an error rather than dropping it", () => {
    const out = unexpectedServerErrors("{not json\n");
    expect(out).toHaveLength(1);
    expect(out[0]!.error).toMatch(/^unreadable line/);
  });
});
