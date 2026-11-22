// Display-only truth checks: when the Radar or the Options focus card on show is not today's, the page says so, and
// the Radar page's owner-record panel is named for what it is. Everything here is synthetic.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FocusStrip } from "@/components/options-focus";
import { RadarEditionNotice } from "@/components/radar-edition-notice";
import { YourNamesPanel } from "@/components/radar-brief";
import { focusStaleness, pickedForSession, radarNotTodayYet } from "@/lib/edition-truth";
import { focusOptions } from "@/lib/fixture-variants";
import type { Options } from "@/lib/options";
import optionsJson from "./fixtures/options.v1.json";

const at = (iso: string) => new Date(iso);

describe("the Radar before the open", () => {
  // 2026-10-14 is a Wednesday session; New York is UTC-4 in October.
  it("warns before 09:30 New York when the edition is from an earlier day", () => {
    expect(radarNotTodayYet("2026-10-13", at("2026-10-14T09:00:00Z"))).toBe(true); // 05:00 ET
    expect(radarNotTodayYet("2026-10-13", at("2026-10-14T13:29:00Z"))).toBe(true); // 09:29 ET
  });
  it("is quiet for today's edition, from 09:30 (the red notice takes over), and on a weekend", () => {
    expect(radarNotTodayYet("2026-10-14", at("2026-10-14T10:00:00Z"))).toBe(false);
    expect(radarNotTodayYet("2026-10-13", at("2026-10-14T13:30:00Z"))).toBe(false);
    expect(radarNotTodayYet("2026-10-09", at("2026-10-10T12:00:00Z"))).toBe(false); // Saturday
    expect(radarNotTodayYet("2026-11-25", at("2026-11-26T12:00:00Z"))).toBe(false); // Thanksgiving
  });
  it("draws one notice at a time, and none for an older edition opened on purpose", () => {
    const draw = (editionDate: string, now: string, live = true) => renderToStaticMarkup(createElement(RadarEditionNotice, { editionDate, now: at(now), live }));
    const early = draw("2026-10-13", "2026-10-14T10:00:00Z");
    expect(early).toContain("data-radar-not-today");
    expect(early).toContain("Not today&#x27;s edition");
    expect(early).toContain('role="status"');
    const late = draw("2026-10-13", "2026-10-14T15:00:00Z");
    expect(late).toContain('role="alert"');
    expect(late).not.toContain("data-radar-not-today");
    expect(draw("2026-10-13", "2026-10-14T10:00:00Z", false)).toBe("");
    expect(draw("2026-10-14", "2026-10-14T10:00:00Z")).toBe("");
  });
});

describe("the session a focus pick was made for", () => {
  it("an evening pick is for the next session, across a weekend", () => {
    expect(pickedForSession("2026-10-09T21:54:00Z")).toBe("2026-10-12"); // Fri 17:54 ET -> Mon
    expect(pickedForSession("2026-10-13T21:54:00Z")).toBe("2026-10-14");
  });
  it("a pick before the open is for that day's session", () => {
    expect(pickedForSession("2026-10-14T12:50:00Z")).toBe("2026-10-14"); // 08:50 ET
  });
  it("skips a holiday", () => {
    expect(pickedForSession("2026-11-25T22:00:00Z")).toBe("2026-11-27"); // Wed evening -> Fri after Thanksgiving
  });
  it("no time, no session", () => {
    expect(pickedForSession(null)).toBeNull();
    expect(pickedForSession("not a time")).toBeNull();
  });
});

describe("the focus card's staleness", () => {
  const live = at("2026-10-12T14:00:00Z"); // Mon 10:00 ET
  it("is quiet for a pick made for the board's session, on the board's day", () => {
    expect(focusStaleness("2026-10-09T21:54:00Z", "2026-10-12", live, true)).toBeNull();
    expect(focusStaleness(null, "2026-10-12", live, true)).toBeNull();
  });
  it("says when the pick was made for another session", () => {
    expect(focusStaleness("2026-10-12T21:54:00Z", "2026-10-12", live, true)).toEqual({ kind: "other_session", pickedFor: "2026-10-13" });
  });
  it("says when the edition is from an earlier session, but not for one opened on purpose", () => {
    const tue = at("2026-10-13T14:00:00Z");
    expect(focusStaleness("2026-10-09T21:54:00Z", "2026-10-12", tue, true)).toEqual({ kind: "stale_edition" });
    expect(focusStaleness("2026-10-09T21:54:00Z", "2026-10-12", tue, false)).toBeNull();
  });

  const v1 = optionsJson as unknown as Options;
  const strip = (e: Options, now?: Date, isLive = true) => renderToStaticMarkup(createElement(FocusStrip, { e, now, live: isLive }));
  it("the strip draws a badge only when it has a clock and something is off", () => {
    const e = focusOptions(v1);
    e.focus!.picked_at = `${v1.built_from}T21:54:00Z`; // after the close the edition was built from, as the real pick is
    const today = at(`${e.session}T14:00:00Z`);
    expect(strip(e, today)).not.toContain("data-focus-stale");
    expect(strip(e)).not.toContain("data-focus-stale");
    const wrong = structuredClone(e);
    wrong.focus!.picked_at = `${e.session}T21:54:00Z`;
    const other = strip(wrong, today);
    expect(other).toContain('data-focus-stale="other_session"');
    expect(other).toContain("Not this session&#x27;s pick");
    const later = strip(e, at("2026-10-14T14:00:00Z"));
    expect(later).toContain('data-focus-stale="stale_edition"');
    expect(strip(e, at("2026-10-14T14:00:00Z"), false)).not.toContain("data-focus-stale");
  });
});

describe("the Radar page's owner-record panel", () => {
  it("is named for the journal it comes from, not the Radar's research", () => {
    const html = renderToStaticMarkup(createElement(YourNamesPanel, { names: [], reads: [], earnings: [], year: "2026" }));
    expect(html).toContain("Names you trade most (your record)");
    expect(html).not.toContain("this morning");
  });
});
