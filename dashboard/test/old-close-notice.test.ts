import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OldCloseNotice } from "@/components/old-close-notice";

const html = (session: string, built_from: string | null | undefined) => renderToStaticMarkup(createElement(OldCloseNotice, { e: { session, built_from } }));

describe("OldCloseNotice", () => {
  it("draws nothing for an edition built from the session just before it", () => {
    expect(html("2026-10-14", "2026-10-13")).toBe("");
    expect(html("2026-10-12", "2026-10-09")).toBe("");
  });

  it("an earlier close: an alert naming the last close before the session", () => {
    const out = html("2026-10-14", "2026-10-09");
    expect(out).toContain('role="alert"');
    expect(out).toContain("built from the Fri 9 Oct close, but the last close before Wed 14 Oct was Tue 13 Oct.");
    expect(out).toContain("At least one session&#x27;s bars are missing, so check them before use.");
  });

  it("one alert for each other kind", () => {
    const cases: [string, string | null | undefined, string][] = [
      ["2026-10-14", null, "These levels do not say which close they were built from. Check them against your platform before use."],
      ["2026-10-14", undefined, "These levels do not say which close they were built from."],
      ["2026-10-14", "2026-10-14", "are stamped with Wed 14 Oct, which is not before that session."],
      ["2026-10-12", "2026-10-10", "are stamped with Sat 10 Oct, which is not a session."],
      ["2026-01-02", "2026-01-01", "are stamped with Thu 1 Jan, which is not a session."],
      ["2026-11-26", "2026-11-25", "These levels are stamped for Thu 26 Nov, a day the market is closed."],
      ["2026-10-14", "2026-13-40", "These levels carry a date that cannot be read"],
      ["2030-03-11", "2030-03-01", "built from the Fri 1 Mar close, more than 4 days earlier."],
    ];
    for (const [session, from, text] of cases) {
      const out = html(session, from);
      expect(out, `${session} from ${from}`).toContain('role="alert"');
      expect(out.replaceAll("&#x27;", "'"), `${session} from ${from}`).toContain(text);
    }
  });
});
