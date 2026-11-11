// The feed watch's table, calendar and evaluator (src/lib/feed-watch.ts): pure, the clock passed in. Every date here
// is checked against src/lib/market-calendar.json: 2026-11-26 is Thanksgiving, 2026-11-27 a half day (13:00), Good
// Friday is 2026-04-03, New York changes its clocks on 2026-03-08 and 2026-11-01, and the file ends 2029-12-24 (Alpaca's calendar stops there).
import { describe, expect, it } from "vitest";
import {
  adjacentSession,
  decideFeedAlerts,
  EMPTY_FEED_STATE,
  evaluateStamped,
  FEED_ASSUMED_NOTE,
  type FeedAlertState,
  FEEDS,
  type FeedView,
  lateNotice,
  marketDay,
  parseFeedState,
  polledState,
  type Read,
  type RefusalRead,
  rollbackFeeds,
  serializeFeedState,
  type ShadowRead,
  slotsAround,
  type StampRead,
  type StampedInputs,
  UNKNOWN_RUNS_TO_ALERT,
  type DocFeed,
  SUMMARY_ID,
  shadowWindow,
  journalShown,
  summaryNotice,
  refusedNotice,
  claimOutbox,
  type FeedDecision,
  type Outgoing,
  unsentFeeds,
  withOutbox,
} from "@/lib/feed-watch";
import { journalCurrent } from "@/lib/trade-rules";
import { DAILY_GRACE_MIN, INTRADAY_MAX_AGE_MIN, JOURNAL_SLOT_UTC, OPTIONS_SLOT_UTC, RADAR_SLOT_UTC } from "@/lib/feeds";
import { INGEST_REJECT_KINDS } from "@/lib/ingest-reject";
import { RANGE } from "@/lib/market-calendar";

const T = (iso: string) => Date.parse(iso);
const ok = (session: string | null, at: string | null): StampRead => ({ status: "ok", value: { session, at: at === null ? null : T(at) } });

interface Extra {
  refusals?: StampedInputs["refusals"];
  shadow?: Read<ShadowRead> | null;
}
function inputs(stamps: Record<string, StampRead>, extra: Extra = {}): StampedInputs {
  return { stamps, refusals: extra.refusals ?? {}, shadow: extra.shadow ?? null };
}
function view(id: string, stamps: Record<string, StampRead>, now: string, extra: Extra = {}): FeedView {
  const v = evaluateStamped(inputs(stamps, extra), T(now)).find((x) => x.id === id);
  if (!v) throw new Error(`no view ${id}`);
  return v;
}
const doc = (id: string) => FEEDS.find((f): f is DocFeed => f.id === id && f.type === "doc")!;
const refused = (at: string, current = true): Read<RefusalRead> => ({ status: "ok", value: { current, at, outcome: "invalid" } });

describe("the table", () => {
  it("has unique ids, and a refusal row for every kind ingest records", () => {
    const ids = FEEDS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = FEEDS.flatMap((f) => (f.type === "refusal" ? [f.kind] : []));
    expect([...kinds].sort()).toEqual([...INGEST_REJECT_KINDS].sort());
  });

  it("takes the routines' times from the same constants as the old panel (feeds.ts), and the zones from the runbook", () => {
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    expect(doc("options-edition").schedules).toEqual([{ zone: "UTC", times: [hm(OPTIONS_SLOT_UTC)], grace_min: DAILY_GRACE_MIN }]);
    expect(doc("radar").schedules[0]).toMatchObject({ zone: "UTC", times: [hm(RADAR_SLOT_UTC)] });
    expect(doc("journal").schedules[1]).toMatchObject({ zone: "UTC", times: [hm(JOURNAL_SLOT_UTC)] });
    expect(doc("journal").schedules[0]).toMatchObject({ zone: "America/New_York", grace_min: INTRADAY_MAX_AGE_MIN, in_session: true });
    expect(doc("journal").schedules[0]!.times).toEqual(["09:24", "10:24", "11:24", "12:24", "13:24", "14:24", "15:24"]);
    expect(doc("pre-open").schedules).toEqual([{ zone: "America/New_York", times: ["08:50"], grace_min: 15, until: "close" }]);
  });

  it("the ledger's two routines are not in the runbook: assumed and display only", () => {
    for (const id of ["ledger-morning", "ledger-afternoon"]) expect(doc(id)).toMatchObject({ verified: false, severity: "display", misses_to_alert: 2 });
    expect(doc("journal").misses_to_alert).toBe(2);
  });
});

describe("the calendar", () => {
  it("knows sessions, holidays and weekends, and assumes weekdays outside its range", () => {
    expect(marketDay("2026-11-26")).toEqual({ open: false, assumed: false });
    expect(marketDay("2026-11-27")).toEqual({ open: true, assumed: false });
    expect(marketDay("2026-11-14")).toEqual({ open: false, assumed: false });
    expect(RANGE.end).toBe("2029-12-24");
    expect(marketDay("2029-12-24")).toEqual({ open: true, assumed: false });
    expect(marketDay("2029-12-25")).toEqual({ open: true, assumed: true }); // Christmas, but past the file: assumed
    expect(marketDay("2030-01-08")).toEqual({ open: true, assumed: true });
    expect(marketDay("2030-01-12")).toEqual({ open: false, assumed: true });
  });

  it("the next and the last session come from the session list", () => {
    expect(adjacentSession("2026-11-25", 1)).toEqual({ day: "2026-11-27", assumed: false });
    expect(adjacentSession("2026-04-02", 1)).toEqual({ day: "2026-04-06", assumed: false });
    expect(adjacentSession("2026-04-06", -1)).toEqual({ day: "2026-04-02", assumed: false });
    expect(adjacentSession("2027-12-31", 1)).toEqual({ day: "2028-01-03", assumed: false });
    expect(adjacentSession("2029-12-21", 1)).toEqual({ day: "2029-12-24", assumed: false });
    expect(adjacentSession("2029-12-24", 1).assumed).toBe(true);
  });

  it("no run is due on a weekend or a holiday, for any feed", () => {
    for (const f of FEEDS) {
      if (f.type !== "doc") continue;
      const days = new Set(slotsAround(f, T("2026-11-26T15:00:00Z")).map((s) => s.day));
      for (const d of ["2026-11-21", "2026-11-22", "2026-11-26"]) expect(days.has(d)).toBe(false);
    }
  });

  it("a half day has live journal runs only before its 13:00 close", () => {
    const runs = slotsAround(doc("journal"), T("2026-11-27T15:00:00Z")).filter((s) => s.day === "2026-11-27" && s.schedule.zone !== "UTC");
    expect(runs.map((s) => new Date(s.due).toISOString())).toEqual([
      "2026-11-27T14:24:00.000Z",
      "2026-11-27T15:24:00.000Z",
      "2026-11-27T16:24:00.000Z",
      "2026-11-27T17:24:00.000Z",
    ]);
  });
});

describe("the options edition (after the close, 21:52 UTC, an hour's grace)", () => {
  // Thursday 12 November 2026 (New York on standard time): due 21:52 UTC, late after 22:52 UTC.
  const forFriday = { "options-edition": ok("2026-11-13", "2026-11-12T22:10:00Z") };
  const forThursday = { "options-edition": ok("2026-11-12", "2026-11-11T22:10:00Z") };

  it("on time once the edition for the next session is in", () => {
    expect(view("options-edition", forFriday, "2026-11-12T22:20:00Z")).toMatchObject({ state: "on_time", reason: "arrived", for_session: "2026-11-13", age_min: 10 });
  });
  it("waiting until its deadline, inclusive; late a minute after", () => {
    expect(view("options-edition", forThursday, "2026-11-12T22:00:00Z").state).toBe("waiting");
    expect(view("options-edition", forThursday, "2026-11-12T22:52:00Z").state).toBe("waiting");
    const late = view("options-edition", forThursday, "2026-11-12T22:53:00Z");
    expect(late).toMatchObject({ state: "late", reason: "wrong-session", late_min: 1, misses: 1, alerting: true, episode: "2026-11-12", for_session: "2026-11-13" });
  });
  it("after recovery it is on time again", () => {
    expect(view("options-edition", forFriday, "2026-11-12T23:30:00Z").state).toBe("on_time");
  });
  it("an edition for the wrong session is late the next morning too, with the same incident", () => {
    expect(view("options-edition", forThursday, "2026-11-13T15:00:00Z")).toMatchObject({ state: "late", reason: "wrong-session", episode: "2026-11-12" });
  });
  it("nothing stored is late with its own reason; a read that failed is unknown, not late", () => {
    expect(view("options-edition", { "options-edition": { status: "missing" } }, "2026-11-12T23:00:00Z")).toMatchObject({ state: "late", reason: "no-document" });
    expect(view("options-edition", { "options-edition": { status: "unreadable" } }, "2026-11-12T23:00:00Z")).toMatchObject({ state: "late", reason: "unreadable" });
    expect(view("options-edition", { "options-edition": { status: "error" } }, "2026-11-12T23:00:00Z")).toMatchObject({ state: "unknown", reason: "storage-error", alerting: false });
    expect(view("options-edition", {}, "2026-11-12T23:00:00Z")).toMatchObject({ state: "unknown", reason: "not-read" });
  });
  it("over a weekend the Friday build is in force: Monday's edition is on time all weekend", () => {
    for (const now of ["2026-11-14T12:00:00Z", "2026-11-15T20:00:00Z", "2026-11-16T14:00:00Z"])
      expect(view("options-edition", { "options-edition": ok("2026-11-16", "2026-11-13T22:10:00Z") }, now).state).toBe("on_time");
  });
  it("on Thanksgiving Wednesday's build for the Friday half day is in force, and no run is expected", () => {
    const v = view("options-edition", { "options-edition": ok("2026-11-27", "2026-11-25T22:10:00Z") }, "2026-11-26T18:00:00Z");
    expect(v).toMatchObject({ state: "on_time", for_session: "2026-11-27" });
    expect(new Date(v.due!).toISOString()).toBe("2026-11-25T21:52:00.000Z");
    expect(new Date(v.next_due!).toISOString()).toBe("2026-11-27T21:52:00.000Z");
  });
  it("the half day itself still has its after-close build, for the Monday", () => {
    expect(view("options-edition", { "options-edition": ok("2026-11-27", "2026-11-25T22:10:00Z") }, "2026-11-27T23:00:00Z")).toMatchObject({ state: "late", for_session: "2026-11-30" });
  });
  it("the Monday after Good Friday reads Thursday's build, for Monday", () => {
    const v = view("options-edition", { "options-edition": ok("2026-04-06", "2026-04-02T22:10:00Z") }, "2026-04-06T14:00:00Z");
    expect(v).toMatchObject({ state: "on_time", for_session: "2026-04-06" });
    expect(new Date(v.due!).toISOString()).toBe("2026-04-02T21:52:00.000Z");
  });
  it("its UTC deadline is the same instant either side of a clock change; the New York time in the page moves", () => {
    const stale = { "options-edition": ok("2026-03-06", "2026-03-05T22:00:00Z") };
    const before = view("options-edition", stale, "2026-03-06T23:00:00Z"); // Friday, standard time
    const after = view("options-edition", { "options-edition": ok("2026-03-09", "2026-03-06T22:00:00Z") }, "2026-03-09T23:00:00Z"); // Monday, daylight time
    expect(new Date(before.deadline!).toISOString()).toBe("2026-03-06T22:52:00.000Z");
    expect(new Date(after.deadline!).toISOString()).toBe("2026-03-09T22:52:00.000Z");
    expect(lateNotice(before, new Date("2026-03-06T23:00:00Z")).message).toContain("17:52 New York deadline");
    expect(lateNotice(after, new Date("2026-03-09T23:00:00Z")).message).toContain("18:52 New York deadline");
  });
  it("outside the calendar's range a weekday is assumed, said so, and still pages", () => {
    const v = view("options-edition", { "options-edition": ok("2030-01-08", "2030-01-07T22:00:00Z") }, "2030-01-08T23:30:00Z");
    expect(v).toMatchObject({ state: "late", assumed: true, alerting: true, for_session: "2030-01-09" });
    expect(lateNotice(v, new Date("2030-01-08T23:30:00Z")).message.endsWith(FEED_ASSUMED_NOTE)).toBe(true);
    expect(view("options-edition", { "options-edition": ok("2030-01-14", "2030-01-11T22:00:00Z") }, "2030-01-12T15:00:00Z")).toMatchObject({ state: "on_time", assumed: true });
  });
  it("a refusal of this run's edition makes it failed, and leaves the page to the refusal's own row", () => {
    const r = { refusals: { options: refused("2026-11-12T22:05:00Z") } };
    expect(view("options-edition", forThursday, "2026-11-12T23:00:00Z", r)).toMatchObject({ state: "failed", reason: "refused", alerting: false });
    expect(view("refusal-options", {}, "2026-11-12T23:00:00Z", r)).toMatchObject({
      state: "failed",
      reason: "refusal-current",
      alerting: true,
      episode: "refusal:2026-11-12T22:05:00.000Z",
    });
  });
  it("a refusal from before this run (the morning's refresh) does not quieten it: it is late and pages", () => {
    const r = { refusals: { options: refused("2026-11-12T13:52:00Z") } };
    expect(view("options-edition", forThursday, "2026-11-12T23:00:00Z", r)).toMatchObject({ state: "late", reason: "wrong-session", alerting: true });
    // ...and the next morning's refresh, missed too, is late in its own right.
    expect(view("pre-open", { "pre-open": ok(null, null) }, "2026-11-13T14:06:00Z", r)).toMatchObject({ state: "late", alerting: true });
    // The morning it was refused, the refresh itself is failed and quiet: the refusal pages.
    expect(view("pre-open", { "pre-open": ok(null, null) }, "2026-11-12T14:06:00Z", r)).toMatchObject({ state: "failed", alerting: false });
  });
});

describe("the pre-open refresh (08:50 New York, in by 09:05)", () => {
  const today = (now: string, at: string) => view("pre-open", { "pre-open": ok(null, at) }, now);
  it("on time with today's prices", () => {
    expect(view("pre-open", { "pre-open": ok("2026-11-12", "2026-11-12T13:52:00Z") }, "2026-11-12T14:10:00Z").state).toBe("on_time");
  });
  it("yesterday's refresh is waiting up to 09:05 and late a minute after", () => {
    const y = { "pre-open": ok("2026-11-11", "2026-11-11T13:52:00Z") };
    expect(view("pre-open", y, "2026-11-12T14:05:00Z").state).toBe("waiting");
    expect(view("pre-open", y, "2026-11-12T14:06:00Z")).toMatchObject({ state: "late", reason: "wrong-session", late_min: 1, alerting: true });
  });
  it("no refresh at all in the edition: late, no time to read", () => {
    expect(view("pre-open", { "pre-open": ok(null, null) }, "2026-11-12T15:00:00Z")).toMatchObject({ state: "late", reason: "no-stamp" });
  });
  it("lapses at the close, and before 08:50 yesterday's miss is not carried into today", () => {
    const y = { "pre-open": ok("2026-11-11", "2026-11-11T13:52:00Z") };
    expect(view("pre-open", y, "2026-11-12T21:30:00Z").state).toBe("not_expected");
    expect(view("pre-open", { "pre-open": ok("2026-11-10", "2026-11-10T13:52:00Z") }, "2026-11-12T13:00:00Z").state).toBe("not_expected");
    expect(view("pre-open", y, "2026-11-12T13:55:00Z")).toMatchObject({ state: "waiting", misses: 0 });
  });
  it("a half day lapses at 13:00; a holiday and a weekend never expect it", () => {
    expect(view("pre-open", { "pre-open": ok("2026-11-26", "2026-11-26T13:52:00Z") }, "2026-11-27T18:10:00Z").state).toBe("not_expected");
    expect(view("pre-open", {}, "2026-11-26T15:00:00Z").state).toBe("not_expected");
    expect(view("pre-open", {}, "2026-11-14T15:00:00Z").state).toBe("not_expected");
  });
  it("New York's 09:05 is 14:05 UTC in standard time and 13:05 UTC in daylight time, in March and in November", () => {
    const deadline = (now: string, at: string) => new Date(today(now, at).deadline!).toISOString();
    expect(deadline("2026-03-06T14:00:00Z", "2026-03-05T13:52:00Z")).toBe("2026-03-06T14:05:00.000Z"); // Friday, EST
    expect(deadline("2026-03-09T13:00:00Z", "2026-03-06T13:52:00Z")).toBe("2026-03-09T13:05:00.000Z"); // Monday, EDT
    expect(deadline("2026-10-30T13:00:00Z", "2026-10-29T12:52:00Z")).toBe("2026-10-30T13:05:00.000Z"); // Friday, EDT
    expect(deadline("2026-11-02T14:00:00Z", "2026-10-30T12:52:00Z")).toBe("2026-11-02T14:05:00.000Z"); // Monday, EST
    expect(today("2026-03-09T13:06:00Z", "2026-03-06T13:52:00Z").state).toBe("late");
    expect(today("2026-11-02T14:05:00Z", "2026-10-30T12:52:00Z").state).toBe("waiting");
  });
});

describe("the trade journal (hourly live runs, the evening sync; pages after two missed runs)", () => {
  // Thursday 12 November 2026, standard time: live runs at 14:24, 15:24 ... 20:24 UTC, 45 minutes each.
  it("one missed run is late on the page and does not page; two do", () => {
    const j = { journal: ok(null, "2026-11-12T14:30:00Z") };
    expect(view("journal", j, "2026-11-12T16:09:00Z")).toMatchObject({ state: "waiting", misses: 0 });
    expect(view("journal", j, "2026-11-12T16:10:00Z")).toMatchObject({ state: "late", misses: 1, alerting: false });
    expect(view("journal", j, "2026-11-12T17:10:00Z")).toMatchObject({ state: "late", misses: 2, alerting: true, late_min: 61 });
  });
  it("on time with a read in this run; the evening sync is due 21:38 UTC with an hour's grace", () => {
    expect(view("journal", { journal: ok(null, "2026-11-12T16:30:00Z") }, "2026-11-12T16:40:00Z").state).toBe("on_time");
    expect(view("journal", { journal: ok(null, "2026-11-12T21:45:00Z") }, "2026-11-12T22:38:00Z").state).toBe("on_time");
    expect(view("journal", { journal: ok(null, "2026-11-12T20:30:00Z") }, "2026-11-12T22:39:00Z")).toMatchObject({ state: "late", misses: 1 });
  });
  // Only the evening routine's own read counts for 21:38 UTC: at most 10 minutes early. The last live run's reads
  // (until about 16:20:30 New York) and anything up to 21:28 UTC are not it, in winter and in summer.
  for (const [season, day, liveEnd, five] of [
    ["winter", "2026-11-12", "21:20:30", "21:25:00"], // 16:20:30 and 16:25 New York, standard time
    ["summer", "2026-10-29", "20:20:30", "20:25:00"], // the same, daylight time
  ] as const)
    it(`a dead evening sync is noticed in ${season}: 16:20:30 and 16:25 New York do not count, the evening run's read does`, () => {
      const at = (t: string) => view("journal", { journal: ok(null, `${day}T${t}Z`) }, `${day}T22:39:00Z`);
      expect(at(liveEnd)).toMatchObject({ state: "late", misses: 1 });
      expect(at(five)).toMatchObject({ state: "late", misses: 1 });
      expect(at("21:27:59").state).toBe("late");
      expect(at("21:28:00").state).toBe("on_time");
      expect(at("21:40:00").state).toBe("on_time");
    });
  it("the evening sync is 16:38 New York in winter and 17:38 in summer, at the same UTC time", () => {
    const due = (now: string, at: string) => new Date(view("journal", { journal: ok(null, at) }, now).due!).toISOString();
    expect(due("2026-10-30T22:00:00Z", "2026-10-30T21:40:00Z")).toBe("2026-10-30T21:38:00.000Z");
    expect(due("2026-11-02T22:00:00Z", "2026-11-02T21:40:00Z")).toBe("2026-11-02T21:38:00.000Z");
  });
  it("is quiet on a weekend: the Friday evening sync stays in force until Monday's first run", () => {
    expect(view("journal", { journal: ok(null, "2026-11-13T21:40:00Z") }, "2026-11-15T12:00:00Z").state).toBe("on_time");
    expect(view("journal", { journal: ok(null, "2026-11-13T21:40:00Z") }, "2026-11-16T14:30:00Z").state).toBe("waiting");
  });
});

describe("the card ledger (assumed times, display only)", () => {
  it("two missed afternoons are late but never page, and say they are assumed", () => {
    const v = view("ledger-afternoon", { "ledger-afternoon": ok("2026-11-10", "2026-11-10T21:30:00Z") }, "2026-11-12T23:00:00Z");
    expect(v).toMatchObject({ state: "late", misses: 2, alerting: false, assumed: true, severity: "display" });
  });
  it("the morning wants the last session scored", () => {
    expect(view("ledger-morning", { "ledger-morning": ok("2026-11-11", "2026-11-11T21:30:00Z") }, "2026-11-12T15:00:00Z").state).toBe("on_time");
    expect(view("ledger-morning", { "ledger-morning": ok("2026-04-02", "2026-04-02T21:30:00Z") }, "2026-04-06T15:00:00Z").state).toBe("on_time");
  });
});

describe("the server check's heartbeat (a record every slot while the switch is exactly on)", () => {
  const sh = (on: boolean, last: string | null, switched: string | null = null): Read<ShadowRead> => ({
    status: "ok",
    value: { on, switched_at: switched === null ? null : T(switched), last_slot_end: last === null ? null : T(last) },
  });
  it("switch off: not expected", () => {
    expect(view("shadow", {}, "2026-11-12T16:00:00Z", { shadow: sh(false, null) })).toMatchObject({ state: "not_expected", reason: "switch-off" });
    expect(view("shadow", {}, "2026-11-12T16:00:00Z", { shadow: { status: "missing" } }).state).toBe("not_expected");
  });
  it("on and silent for over ten minutes: late; a recent record: on time", () => {
    expect(view("shadow", {}, "2026-11-12T16:00:00Z", { shadow: sh(true, "2026-11-12T15:40:00Z") })).toMatchObject({ state: "late", reason: "no-record", alerting: true, episode: "2026-11-12" });
    expect(view("shadow", {}, "2026-11-12T16:00:00Z", { shadow: sh(true, "2026-11-12T15:58:00Z") })).toMatchObject({ state: "on_time", age_min: 2 });
    expect(view("shadow", {}, "2026-11-12T16:00:00Z", { shadow: sh(true, null) }).state).toBe("late");
  });
  it("before the first slot of the day has settled: not expected; just after, waiting", () => {
    expect(view("shadow", {}, "2026-11-12T14:32:00Z", { shadow: sh(true, null) })).toMatchObject({ state: "not_expected", reason: "before-first-slot" });
    expect(view("shadow", {}, "2026-11-12T14:40:00Z", { shadow: sh(true, null) }).state).toBe("waiting");
    expect(view("shadow", {}, "2026-11-12T14:43:00Z", { shadow: sh(true, null) }).state).toBe("waiting");
    expect(view("shadow", {}, "2026-11-12T14:44:00Z", { shadow: sh(true, null) }).state).toBe("late");
  });
  it("a switch turned on mid-session starts its own clock", () => {
    // No record since the morning, but the switch went on at 18:00: waiting, not late, for ten minutes.
    expect(view("shadow", {}, "2026-11-12T18:05:00Z", { shadow: sh(true, null, "2026-11-12T18:00:00Z") }).state).toBe("waiting");
    expect(view("shadow", {}, "2026-11-12T18:10:00Z", { shadow: sh(true, null, "2026-11-12T18:00:00Z") }).state).toBe("waiting");
    expect(view("shadow", {}, "2026-11-12T18:11:00Z", { shadow: sh(true, null, "2026-11-12T18:00:00Z") }).state).toBe("late");
  });
  it("outside the session, on a holiday and after a half day's close: not expected; a failed read in the session: unknown", () => {
    expect(view("shadow", {}, "2026-11-12T22:00:00Z", { shadow: sh(true, null) }).state).toBe("not_expected");
    expect(view("shadow", {}, "2026-11-26T16:00:00Z", { shadow: sh(true, null) }).state).toBe("not_expected");
    expect(view("shadow", {}, "2026-11-27T18:05:00Z", { shadow: sh(true, null) }).state).toBe("not_expected");
    expect(view("shadow", {}, "2026-11-12T16:00:00Z", { shadow: { status: "error" } })).toMatchObject({ state: "unknown", alerting: false });
  });
});

describe("ingest refusals", () => {
  it("a current refusal is failed and pages; one a good edition replaced is on time; none recorded is on time", () => {
    expect(view("refusal-journal", {}, "2026-11-12T16:00:00Z", { refusals: { journal: refused("2026-11-12T15:30:00Z") } })).toMatchObject({ state: "failed", alerting: true, late_min: 30 });
    expect(view("refusal-journal", {}, "2026-11-12T16:00:00Z", { refusals: { journal: refused("2026-11-12T15:30:00Z", false) } })).toMatchObject({ state: "on_time", reason: "refusal-replaced" });
    expect(view("refusal-journal", {}, "2026-11-12T16:00:00Z", { refusals: { journal: { status: "missing" } } })).toMatchObject({ state: "on_time", reason: "no-refusal" });
    expect(view("refusal-journal", {}, "2026-11-12T16:00:00Z", { refusals: { journal: { status: "error" } } }).state).toBe("unknown");
  });
  it("a display-only kind is shown failed but does not page", () => {
    expect(view("refusal-calendar", {}, "2026-11-12T16:00:00Z", { refusals: { calendar: refused("2026-11-12T15:30:00Z") } })).toMatchObject({ state: "failed", alerting: false });
  });
});

describe("the episodes (one page per incident, one recovery, no repeats)", () => {
  const stale = { "options-edition": ok("2026-11-12", "2026-11-11T22:10:00Z") };
  const fresh = { "options-edition": ok("2026-11-13", "2026-11-12T23:40:00Z") };
  const tick = (state: FeedAlertState, stamps: Record<string, StampRead>, now: Date, on = true, extra: Extra = {}) => {
    const views = evaluateStamped(inputs(stamps, extra), now.getTime()).filter((v) => v.id === "options-edition" || v.id === "refusal-options");
    return decideFeedAlerts(views, state, now, on);
  };
  const at = (min: number) => new Date(T("2026-11-12T22:53:00Z") + min * 60_000);

  it("pages once across twenty runs, recovers once, and opens a new incident only after the recovery", () => {
    let s: FeedAlertState = EMPTY_FEED_STATE;
    const kinds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const d = tick(s, stale, at(i * 10));
      kinds.push(...d.notices.map((n) => n.kind));
      s = d.next;
    }
    expect(kinds).toEqual(["feed-late"]);
    const rec = tick(s, fresh, at(200));
    expect(rec.notices.map((n) => n.kind)).toEqual(["feed-recovered"]);
    s = rec.next;
    expect(tick(s, fresh, at(210)).notices).toEqual([]);
    // The next evening's edition is late again: a new incident.
    const again = tick(s, fresh, new Date("2026-11-13T23:00:00Z"));
    expect(again.notices.map((n) => n.kind)).toEqual(["feed-late"]);
  });

  it("a new session day is a new incident even without a recovery", () => {
    const d1 = tick(EMPTY_FEED_STATE, stale, at(0));
    expect(d1.notices).toHaveLength(1);
    expect(tick(d1.next, stale, new Date("2026-11-13T15:00:00Z")).notices).toEqual([]);
    expect(tick(d1.next, stale, new Date("2026-11-13T23:00:00Z")).notices.map((n) => n.kind)).toEqual(["feed-late"]);
  });

  it("display only: nothing is sent and the state still advances; switch-on sends one summary, then recoveries as usual", () => {
    const off = tick(EMPTY_FEED_STATE, stale, at(0), false);
    expect(off.notices).toEqual([]);
    expect(off.next.alerts).toBe("off");
    expect(off.next.feeds["options-edition"]).toMatchObject({ open: true, sent: false, episode: "2026-11-12" });
    // Switched on ten minutes later with the incident under way: one summary, naming it; it is now marked sent.
    const on1 = tick(off.next, stale, at(10), true);
    expect(on1.notices.map((n) => n.title)).toEqual(["Feed alerts on: 1 not on time"]);
    expect(on1.notices[0]!.message).toContain("Already late, refused or not checkable: Options edition.");
    expect(on1.noticeFeeds).toEqual([SUMMARY_ID]);
    expect(on1.next).toMatchObject({ alerts: "on", feeds: { "options-edition": { open: true, sent: true } } });
    // No repeat on the next run; the recovery is announced like any other.
    expect(tick(on1.next, stale, at(20), true).notices).toEqual([]);
    const rec = tick(on1.next, fresh, at(60), true);
    expect(rec.notices.map((n) => n.kind)).toEqual(["feed-recovered"]);
  });

  it("switch-on with nothing open sends nothing", () => {
    const off = tick(EMPTY_FEED_STATE, fresh, at(30), false);
    expect(tick(off.next, fresh, at(40), true).notices).toEqual([]);
  });

  it("switch-on with three incidents open sends one summary naming all three", () => {
    const now = new Date("2026-11-12T23:00:00Z");
    const views = evaluateStamped(
      inputs(
        { "options-edition": ok("2026-11-12", "2026-11-11T22:10:00Z"), radar: ok(null, "2026-11-11T10:45:00Z") },
        { refusals: { journal: refused("2026-11-12T22:30:00Z") } },
      ),
      now.getTime(),
    ).filter((v) => ["options-edition", "radar", "refusal-journal", "pre-open"].includes(v.id));
    const off = decideFeedAlerts(views, EMPTY_FEED_STATE, now, false);
    expect(off.notices).toEqual([]);
    const on = decideFeedAlerts(views, off.next, new Date(now.getTime() + 600_000), true);
    expect(on.notices).toHaveLength(1);
    expect(on.notices[0]!.title).toBe("Feed alerts on: 3 not on time");
    expect(on.notices[0]!.message).toContain("Options edition, Radar edition, Trade journal");
    expect(on.summaryFeeds).toEqual(["options-edition", "radar", "refusal-journal"]);
    // A failed summary is put back: the next run sends it again.
    const back = rollbackFeeds(off.next, on.next, [SUMMARY_ID], on.summaryFeeds);
    expect(back.alerts).toBe("off");
    expect(back.feeds["radar"]).toMatchObject({ open: true, sent: false });
    expect(decideFeedAlerts(views, back, new Date(now.getTime() + 1_200_000), true).notices).toHaveLength(1);
  });

  it("off and on again later: one summary of what opened meanwhile, nothing for what was already paged", () => {
    const on = tick(EMPTY_FEED_STATE, stale, at(0), true);
    expect(on.notices.map((n) => n.kind)).toEqual(["feed-late"]); // the first state has no flag: paged on its own
    const off = tick(on.next, stale, at(10), false);
    expect(off.next.alerts).toBe("off");
    expect(tick(off.next, stale, at(20), true).notices).toEqual([]); // already sent before: no summary
    // Off overnight; Friday's edition is late while off: on again, one summary for it.
    const offFri = tick(off.next, stale, new Date("2026-11-13T23:00:00Z"), false);
    expect(offFri.notices).toEqual([]);
    const onFri = tick(offFri.next, stale, new Date("2026-11-13T23:10:00Z"), true);
    expect(onFri.notices.map((n) => n.title)).toEqual(["Feed alerts on: 1 not on time"]);
  });

  it("an outage after a late page: late, then cannot be checked, then nothing until it truly recovers once", () => {
    let s: FeedAlertState = EMPTY_FEED_STATE;
    const pages: string[] = [];
    const run = (stamps: Record<string, StampRead>, min: number) => {
      const d = tick(s, stamps, at(min));
      pages.push(...d.notices.map((n) => n.title));
      s = d.next;
    };
    run(stale, 7); // 23:00 UTC: late
    for (const m of [17, 27, 37]) run({ "options-edition": { status: "error" } }, m); // three unreadable runs
    run(stale, 47); // readable again, still late
    run(stale, 57);
    expect(pages).toEqual(["Options edition late by 8 min", "Options edition cannot be checked"]);
    run(fresh, 67);
    run(fresh, 77);
    expect(pages.slice(2)).toEqual(["Options edition back on time"]);
  });

  it("an incident under way on a new day after switch-on pages once", () => {
    const off = tick(EMPTY_FEED_STATE, stale, at(0), false);
    expect(tick(off.next, stale, new Date("2026-11-13T23:00:00Z"), true).notices).toHaveLength(1);
  });

  it("unknown is not late: it pages only after UNKNOWN_RUNS_TO_ALERT runs in a row, once", () => {
    expect(UNKNOWN_RUNS_TO_ALERT).toBe(3);
    let s: FeedAlertState = EMPTY_FEED_STATE;
    const sent: number[] = [];
    for (let i = 0; i < 6; i++) {
      const d = tick(s, { "options-edition": { status: "error" } }, at(i * 10));
      sent.push(d.notices.length);
      s = d.next;
    }
    expect(sent).toEqual([0, 0, 1, 0, 0, 0]);
    expect(s.feeds["options-edition"]!.unknown_runs).toBe(UNKNOWN_RUNS_TO_ALERT); // capped: no new state each run
    expect(tick(s, fresh, at(70)).notices.map((n) => n.kind)).toEqual(["feed-recovered"]);
  });

  it("a read that works again resets the count", () => {
    let s = tick(EMPTY_FEED_STATE, { "options-edition": { status: "error" } }, at(0)).next;
    s = tick(s, { "options-edition": { status: "error" } }, at(10)).next;
    s = tick(s, fresh, at(20)).next;
    expect(s.feeds["options-edition"]).toBeUndefined();
    expect(tick(s, { "options-edition": { status: "error" } }, at(30)).notices).toEqual([]);
  });

  it("a refused edition pages once (the refusal), and a good one closes it once", () => {
    // (See the trace below for a refusal that outlives its run.)
    const r = { refusals: { options: refused("2026-11-12T22:30:00Z") } };
    const d = tick(EMPTY_FEED_STATE, stale, at(0), true, r);
    expect(d.notices.map((n) => n.kind)).toEqual(["rejected"]);
    const rec = tick(d.next, fresh, at(30), true, { refusals: { options: refused("2026-11-12T22:30:00Z", false) } });
    expect(rec.notices.map((n) => n.kind)).toEqual(["feed-recovered"]);
  });

  it("the state round-trips, sorted, and a rollback puts one feed back", () => {
    const d = tick(EMPTY_FEED_STATE, stale, at(0));
    expect(parseFeedState(serializeFeedState(d.next))).toEqual(d.next);
    expect(parseFeedState("not json")).toEqual(EMPTY_FEED_STATE);
    expect(d.next.feeds["options-edition"]).toMatchObject({ open: true, sent: true });
    expect(rollbackFeeds(EMPTY_FEED_STATE, d.next, ["options-edition"]).feeds["options-edition"]).toBeUndefined();
    // A row that can never page on "unknown" keeps no count (refusal-options is unread here).
    expect(d.next.feeds["refusal-options"]).toBeUndefined();
  });
});

describe("the page's own polls", () => {
  const inSession = T("2026-11-12T16:00:00Z");
  it("prices: waiting, on time, late past 30 s, failed when off or failing, not due outside the session", () => {
    const b = inSession;
    expect(polledState({ status: "loading", receivedAt: null }, b, inSession, 30_000, "failed").state).toBe("waiting");
    expect(polledState({ status: "ok", receivedAt: b - 3_000 }, b, inSession, 30_000, "failed")).toEqual({ state: "on_time", age_s: 3 });
    expect(polledState({ status: "ok", receivedAt: b - 31_000 }, b, inSession, 30_000, "failed").state).toBe("late");
    expect(polledState({ status: "off", receivedAt: null }, b, inSession, 30_000, "failed").state).toBe("failed");
    expect(polledState({ status: "error", receivedAt: null }, b, inSession, 30_000, "failed").state).toBe("failed");
    expect(polledState({ status: "ok", receivedAt: b }, b, T("2026-11-14T16:00:00Z"), 30_000, "failed").state).toBe("not_expected");
  });
  it("bars: a failed poll keeping old bars is late; off is not due", () => {
    expect(polledState({ status: "ok", receivedAt: inSession, failed: true }, inSession, inSession, 90_000, "not_expected").state).toBe("late");
    expect(polledState({ status: "off", receivedAt: null }, inSession, inSession, 90_000, "not_expected").state).toBe("not_expected");
  });
});

describe("a refusal outliving its run (the shared options kind)", () => {
  // Tuesday 10 November 2026: the pre-open refresh is refused at 08:52 New York (13:52 UTC); nothing is stored after
  // it, the evening build never runs, and Wednesday's refresh never comes either.
  const ids = ["options-edition", "pre-open", "refusal-options"];
  const mondayBuild = { "options-edition": ok("2026-11-10", "2026-11-09T22:10:00Z"), "pre-open": ok(null, null) };
  const r = { refusals: { options: refused("2026-11-10T13:52:00Z") } };
  const run = (s: FeedAlertState, now: string) => {
    const views = evaluateStamped(inputs(mondayBuild, r), T(now)).filter((v) => ids.includes(v.id));
    return decideFeedAlerts(views, s, new Date(now), true);
  };

  it("pages the refusal Tuesday morning, the late build Tuesday evening and the late refresh Wednesday morning", () => {
    let s: FeedAlertState = { ...EMPTY_FEED_STATE, alerts: "on" };
    const pages: string[] = [];
    for (let t = T("2026-11-10T14:00:00Z"); t <= T("2026-11-11T23:00:00Z"); t += 10 * 60_000) {
      const d = run(s, new Date(t).toISOString());
      pages.push(...d.notices.map((n) => `${new Date(t).toISOString().slice(0, 16)} ${n.title}`));
      s = d.next;
    }
    expect(pages).toEqual([
      "2026-11-10T14:00 Options edition or pre-open refresh refused",
      "2026-11-10T23:00 Options edition late by 8 min",
      "2026-11-11T14:10 Pre-open refresh late by 5 min",
      "2026-11-11T23:00 Options edition late by 1448 min", // a new day: a new page, late since Tuesday
    ]);
  });

  it("two refusals in one day page twice", () => {
    const one = decideFeedAlerts(evaluateStamped(inputs({}, { refusals: { journal: refused("2026-11-12T15:00:00Z") } }), T("2026-11-12T15:10:00Z")).filter((v) => v.id === "refusal-journal"), EMPTY_FEED_STATE, new Date("2026-11-12T15:10:00Z"), true);
    const two = decideFeedAlerts(evaluateStamped(inputs({}, { refusals: { journal: refused("2026-11-12T18:00:00Z") } }), T("2026-11-12T18:10:00Z")).filter((v) => v.id === "refusal-journal"), one.next, new Date("2026-11-12T18:10:00Z"), true);
    expect([...one.notices, ...two.notices].map((n) => n.kind)).toEqual(["rejected", "rejected"]);
  });

  it("a refusal and then a good store: recovered once", () => {
    const at = (now: string, current: boolean) =>
      evaluateStamped(inputs({}, { refusals: { journal: refused("2026-11-12T15:00:00Z", current) } }), T(now)).filter((v) => v.id === "refusal-journal");
    const a = decideFeedAlerts(at("2026-11-12T15:10:00Z", true), EMPTY_FEED_STATE, new Date("2026-11-12T15:10:00Z"), true);
    const b = decideFeedAlerts(at("2026-11-12T15:20:00Z", false), a.next, new Date("2026-11-12T15:20:00Z"), true);
    const c = decideFeedAlerts(at("2026-11-12T15:30:00Z", false), b.next, new Date("2026-11-12T15:30:00Z"), true);
    expect([a, b, c].map((d) => d.notices.map((n) => n.kind))).toEqual([["rejected"], ["feed-recovered"], []]);
  });
});

describe("past the calendar's end", () => {
  it("the session is assumed to be 09:30 to 16:00 New York on a weekday, and says so", () => {
    expect(shadowWindow(T("2030-01-08T15:00:00Z"))).toMatchObject({ day: "2030-01-08", assumed: true });
    expect(shadowWindow(T("2030-01-08T21:30:00Z"))).toBeNull();
    expect(shadowWindow(T("2030-01-12T15:00:00Z"))).toBeNull(); // a Saturday
    const v = view("shadow", {}, "2030-01-08T16:00:00Z", { shadow: { status: "ok", value: { on: true, switched_at: null, last_slot_end: T("2030-01-08T15:00:00Z") } } });
    expect(v).toMatchObject({ state: "late", assumed: true, alerting: true });
    expect(polledState({ status: "ok", receivedAt: T("2030-01-08T15:59:58Z") }, T("2030-01-08T16:00:00Z"), T("2030-01-08T16:00:00Z"), 30_000, "failed").state).toBe("on_time");
  });
});

describe("the page's own polls, failing", () => {
  it("never on time while the page is trying again or the board has paused", () => {
    const n = T("2026-11-12T16:00:00Z");
    expect(polledState({ status: "ok", receivedAt: n - 1_000, failing: true }, n, n, 30_000, "failed").state).toBe("late");
    expect(polledState({ status: "ok", receivedAt: n - 1_000, failing: false }, n, n, 30_000, "failed").state).toBe("on_time");
    expect(polledState({ status: "error", receivedAt: null, failing: true }, n, T("2026-11-14T16:00:00Z"), 30_000, "failed").state).toBe("late");
  });
});

describe("the journal as a page shows it agrees with the board's day check", () => {
  it("on time exactly when journalCurrent says so, over a grid of times and stamps", () => {
    const days = ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-26", "2026-11-27", "2026-03-09"];
    let checked = 0;
    for (const d of days)
      for (let h = 0; h < 24; h++)
        for (const back of [1, 10, 30, 44, 46, 60, 120, 600, 3000]) {
          const now = T(`${d}T${String(h).padStart(2, "0")}:20:00Z`);
          const stamp = ok(null, new Date(now - back * 60_000).toISOString());
          const v = evaluateStamped(inputs({ journal: stamp }), now).find((x) => x.id === "journal")!;
          const shown = journalShown(v, stamp, now);
          const current = journalCurrent(new Date(now - back * 60_000).toISOString(), new Date(now));
          expect(`${d} ${h} ${back} ${shown === "on_time"}`).toBe(`${d} ${h} ${back} ${current}`);
          checked++;
        }
    expect(checked).toBe(days.length * 24 * 9);
    // The case from the review: 10:20 New York, a stamp from 09:30. The day check says not current: neither is the chip.
    const now = T("2026-11-12T15:20:00Z");
    const stamp = ok(null, "2026-11-12T14:30:00Z");
    expect(journalShown(evaluateStamped(inputs({ journal: stamp }), now).find((x) => x.id === "journal")!, stamp, now)).toBe("late");
  }, 60_000); // 1,296 evaluations: slow on a loaded machine, so it has its own limit
});

describe("review fixes", () => {
  it("a refusal of today's run never turns yesterday's still-missing edition into refused", () => {
    // Wednesday's build is missing (Thursday 22:30 UTC: Thursday's run is not past its deadline yet); a refusal
    // arrived at 22:05 UTC for Thursday's run. Wednesday's miss stays late and pages.
    const stale = { "options-edition": ok("2026-11-11", "2026-11-10T22:10:00Z") };
    const v = view("options-edition", stale, "2026-11-12T22:30:00Z", { refusals: { options: refused("2026-11-12T22:05:00Z") } });
    expect(v).toMatchObject({ state: "late", episode: "2026-11-11", alerting: true });
  });

  it("a failure beats not due: failing prices outside the session read failed or late, never not due", () => {
    const weekend = T("2026-11-14T16:00:00Z");
    expect(polledState({ status: "error", receivedAt: null }, weekend, weekend, 30_000, "failed").state).toBe("failed");
    expect(polledState({ status: "off", receivedAt: null }, weekend, weekend, 30_000, "failed").state).toBe("failed");
    expect(polledState({ status: "ok", receivedAt: weekend, failed: true }, weekend, weekend, 90_000, "not_expected").state).toBe("late");
    expect(polledState({ status: "off", receivedAt: null }, weekend, weekend, 90_000, "not_expected").state).toBe("not_expected");
    // A store that cannot be read is "can't check", even when no run is in force.
    expect(view("pre-open", { "pre-open": { status: "error" } }, "2026-11-14T15:00:00Z").state).toBe("unknown");
    expect(view("shadow", {}, "2026-11-14T15:00:00Z", { shadow: { status: "error" } }).state).toBe("unknown");
  });

  it("the switch-on summary counts distinct feeds and covers late, refused and not checkable", () => {
    const n = summaryNotice(["options-edition", "pre-open", "options-edition", "radar"], new Date("2026-11-12T23:00:00Z"));
    expect(n.title).toBe("Feed alerts on: 3 not on time");
    expect(n.message).toContain("Already late, refused or not checkable: Options edition, Pre-open refresh, Radar edition.");
  });

  it("an instant out of a Date's range is left out, not thrown on", () => {
    const v = { ...view("options-edition", { "options-edition": ok("2026-11-12", "2026-11-11T22:10:00Z") }, "2026-11-12T23:00:00Z"), deadline: 1e300, due: -1e300 };
    expect(() => lateNotice(v, new Date("2026-11-12T23:00:00Z"))).not.toThrow();
    expect(lateNotice(v, new Date("2026-11-12T23:00:00Z")).message).toContain("past its deadline");
    expect(refusedNotice({ ...v, type: "refusal" }, new Date("2026-11-12T23:00:00Z")).message).toContain("an unknown time");
  });
});

describe("the journal's evening sync is assumed (its stamping rule cannot be checked here)", () => {
  it("a missed evening sync is late on the page, assumed, and never pages; the next morning's verified runs do", () => {
    // Thursday 12 November: the 15:24 live run read at 20:30 UTC, then nothing.
    const j = { journal: ok(null, "2026-11-12T20:30:00Z") };
    const evening = view("journal", j, "2026-11-12T22:39:00Z");
    expect(evening).toMatchObject({ state: "late", assumed: true, alerting: false });
    // Friday morning: the 09:24 and 10:24 live runs missed too (verified): it pages.
    expect(view("journal", j, "2026-11-13T16:10:00Z")).toMatchObject({ state: "late", alerting: true, assumed: false });
  });
});

describe("the outbox rules", () => {
  const now = new Date("2026-11-12T23:10:00Z");
  const late: Outgoing = {
    key: "options-edition|2026-11-12|feed-late",
    feeds: ["options-edition"],
    notice: { kind: "feed-late", title: "Options edition late by 8 min", message: "x", priority: 4, tags: [] },
    attempts: 0,
    tries: 0,
    last_tick: null,
    tried: null,
    claimed_by: null,
    status: "pending",
    since: "2026-11-12T23:00:00.000Z",
  };
  const recovered: FeedDecision = {
    next: { ...EMPTY_FEED_STATE, alerts: "on" },
    notices: [{ kind: "feed-recovered", title: "Options edition back on time", message: "x", priority: 2, tags: [] }],
    noticeFeeds: ["options-edition"],
    summaryFeeds: [],
  };
  const withPrev = (o: Outgoing) => ({ ...recovered, next: { ...recovered.next, outbox: [o] } });
  it("a recovery of a late page never claimed drops both", () => {
    expect(withOutbox(withPrev(late).next, withPrev(late), now).outbox).toEqual([]);
  });
  it("a late page claimed (perhaps sent, perhaps by an overlapping run this tick) keeps both", () => {
    const claimed = { ...late, attempts: 1, last_tick: 2_942_946, claimed_by: "other" };
    const out = withOutbox(withPrev(claimed).next, withPrev(claimed), now).outbox;
    expect(out.map((o) => o.notice.kind)).toEqual(["feed-late", "feed-recovered"]);
  });
  it("a late page that could not be sent becomes one combined page", () => {
    const failed = { ...late, attempts: 3, tries: 3, status: "sent_failed" as const };
    const out = withOutbox(withPrev(failed).next, withPrev(failed), now).outbox;
    expect(out.map((o) => o.notice.title)).toEqual(["Options edition was late, now back on time"]);
  });
  it("a page past its age or its claims is marked sent_failed, never dropped silently", () => {
    const old = { ...late, since: "2026-11-12T20:00:00.000Z" };
    const r = claimOutbox({ ...EMPTY_FEED_STATE, outbox: [old] }, 1, true, "run", now.getTime());
    expect(r.gaveUp).toEqual([late.key]);
    expect(r.state.outbox[0]!.status).toBe("sent_failed");
    const capped = claimOutbox({ ...EMPTY_FEED_STATE, outbox: [{ ...late, attempts: 10 }] }, 1, true, "run", now.getTime());
    expect(capped.state.outbox[0]!.status).toBe("sent_failed");
    expect(unsentFeeds(capped.state)).toEqual(["options-edition"]);
  });
});
