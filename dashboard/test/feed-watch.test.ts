// The feed watch's table, calendar and evaluator (src/lib/feed-watch.ts): pure, the clock passed in. Every date here
// is checked against src/lib/market-calendar.json: 2026-11-26 is Thanksgiving, 2026-11-27 a half day (13:00), Good
// Friday is 2026-04-03, New York changes its clocks on 2026-03-08 and 2026-11-01, and the file ends 2027-12-31.
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
} from "@/lib/feed-watch";
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
    expect(RANGE.end).toBe("2027-12-31");
    expect(marketDay("2028-01-04")).toEqual({ open: true, assumed: true });
    expect(marketDay("2028-01-08")).toEqual({ open: false, assumed: true });
  });

  it("the next and the last session come from the session list", () => {
    expect(adjacentSession("2026-11-25", 1)).toEqual({ day: "2026-11-27", assumed: false });
    expect(adjacentSession("2026-04-02", 1)).toEqual({ day: "2026-04-06", assumed: false });
    expect(adjacentSession("2026-04-06", -1)).toEqual({ day: "2026-04-02", assumed: false });
    expect(adjacentSession("2027-12-31", 1).assumed).toBe(true);
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
    const v = view("options-edition", { "options-edition": ok("2028-01-04", "2028-01-03T22:00:00Z") }, "2028-01-04T23:30:00Z");
    expect(v).toMatchObject({ state: "late", assumed: true, alerting: true, for_session: "2028-01-05" });
    expect(lateNotice(v, new Date("2028-01-04T23:30:00Z")).message.endsWith(FEED_ASSUMED_NOTE)).toBe(true);
    expect(view("options-edition", { "options-edition": ok("2028-01-10", "2028-01-07T22:00:00Z") }, "2028-01-08T15:00:00Z")).toMatchObject({ state: "on_time", assumed: true });
  });
  it("a refusal that still stands makes it failed, and leaves the page to the refusal's own row", () => {
    const r = { refusals: { options: refused("2026-11-12T22:05:00Z") } };
    expect(view("options-edition", forThursday, "2026-11-12T23:00:00Z", r)).toMatchObject({ state: "failed", reason: "refused", alerting: false });
    expect(view("refusal-options", {}, "2026-11-12T23:00:00Z", r)).toMatchObject({ state: "failed", reason: "refusal-current", alerting: true, episode: "2026-11-12" });
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
  it("on time with a read in this run; the evening sync is due 21:38 UTC with an hour's grace and an hour's early slack", () => {
    expect(view("journal", { journal: ok(null, "2026-11-12T16:30:00Z") }, "2026-11-12T16:40:00Z").state).toBe("on_time");
    const evening = { journal: ok(null, "2026-11-12T20:40:00Z") };
    expect(view("journal", evening, "2026-11-12T22:38:00Z").state).toBe("on_time"); // 20:40 is within 60 min before 21:38
    expect(view("journal", { journal: ok(null, "2026-11-12T20:30:00Z") }, "2026-11-12T22:39:00Z")).toMatchObject({ state: "late", misses: 1 });
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

  it("display only: nothing is sent, the state still advances, and switching on does not page an incident under way", () => {
    const off = tick(EMPTY_FEED_STATE, stale, at(0), false);
    expect(off.notices).toEqual([]);
    expect(off.next.feeds["options-edition"]).toMatchObject({ open: true, sent: false, episode: "2026-11-12" });
    // Switched on ten minutes later: the same incident, already under way. Nothing is sent.
    const on1 = tick(off.next, stale, at(10), true);
    expect(on1.notices).toEqual([]);
    // Its recovery is not announced either: nobody received the page.
    const rec = tick(on1.next, fresh, at(60), true);
    expect(rec.notices).toEqual([]);
    expect(rec.next.feeds["options-edition"]).toBeUndefined();
    // The first page after switch-on is the next new incident.
    expect(tick(rec.next, fresh, new Date("2026-11-13T23:00:00Z"), true).notices.map((n) => n.kind)).toEqual(["feed-late"]);
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
