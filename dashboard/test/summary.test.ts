import { describe, expect, it } from "vitest";
import { summarize } from "@/lib/summary";
import { cleanSnapshot, fixture } from "./helpers";

describe("summarize", () => {
  it("describes the fixture night", () => {
    expect(summarize(fixture())).toBe(
      "Tonight: routine failed (exit 1), forward test recorded 1 session, the kill switch is on. 4 things need you.",
    );
  });

  it("produces the documented example sentence", () => {
    const s = fixture();
    s.ops!.forward!.sessions = 3;
    s.overview!.needs_you = s.overview!.needs_you!.slice(0, 1);
    expect(summarize(s)).toBe(
      "Tonight: routine failed (exit 1), forward test recorded 3 sessions, the kill switch is on. 1 thing needs you.",
    );
  });

  it("reads a quiet night", () => {
    const s = cleanSnapshot();
    expect(summarize(s)).toBe("Tonight: routine finished normally, Gap Hunter finished normally. Nothing needs you.");
  });

  it("mentions extra jobs only when they went wrong", () => {
    const s = cleanSnapshot({
      jobs: { last: { dashboard: { status: "timeout" }, weekly: { status: "ok" }, forward: { status: "refused", exit: 3 } } },
    });
    expect(summarize(s)).toBe("Tonight: forward test was refused (exit 3), dashboard publish timed out. Nothing needs you.");
  });

  it("says nothing of the retired rule's job when it finished, names it when it failed, and never says Robot B or sleeve", () => {
    const s = cleanSnapshot({ jobs: { last: { routine: { status: "ok" }, "paper-b": { status: "ok" }, "paper-s": { status: "refused", exit: 1 } } } });
    expect(summarize(s)).toBe("Tonight: routine finished normally, Gap Hunter was refused (exit 1). Nothing needs you.");
    const failed = cleanSnapshot({ jobs: { last: { routine: { status: "ok" }, "paper-b": { status: "failed", exit: 2 } } } });
    expect(summarize(failed)).toBe("Tonight: routine finished normally, the retired QQQ rule failed (exit 2). Nothing needs you.");
    for (const x of [s, failed, fixture()]) expect(summarize(x)).not.toMatch(/Robot B|sleeve|paper-[bs]/i);
  });

  it("notes the kill switch", () => {
    const s = cleanSnapshot({ kill: { on: true }, jobs: { last: { routine: { status: "ok" } } } });
    expect(summarize(s)).toBe("Tonight: routine finished normally, the kill switch is on. Nothing needs you.");
  });

  it("handles missing sections", () => {
    expect(summarize(null)).toBe("No status snapshot has been received yet.");
    expect(summarize({ schema: null, schema_version: null, run_id: null, as_of: null })).toBe(
      "No job results in this snapshot. Nothing needs you.",
    );
  });

  it("never mentions money", () => {
    expect(summarize(fixture())).not.toMatch(/\$|USD|US\$/);
  });
});
