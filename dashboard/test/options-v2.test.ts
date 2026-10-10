import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OptionsDay } from "@/components/options-day";
import { optionsHealth } from "@/lib/editions";
import { partialOptions, v2Options } from "@/lib/fixture-variants";
import { dayContext, earningsWhen, EVENT_HORIZON_DAYS, eventLabel, eventTime, isHalfDay, OTHER_EVENT, sessionHours, volRead, type Options, type OptionsEvent } from "@/lib/options";
import { validateOptionsEdition } from "@/lib/validate";
import optionsJson from "./fixtures/options.v1.json";

// The edition's second format: the day's context, scheduled events, and each name's volatility block. Every part
// of it is optional, so an edition in the first format must keep validating and must draw none of it.
const v1 = optionsJson as unknown as Options;
const v2 = v2Options(v1);
const SESSION = v1.session; // 2026-10-12

describe("the site's contract for the second format", () => {
  it("tells a publisher, through the health report, that the fixture's second format is one it accepts", () => {
    expect(optionsHealth({ status: "ok", edition: v2, source: "fixture" }).accepts).toBeGreaterThanOrEqual(v2.schema_version!);
  });

  it("validates an edition in the second format, and still validates the first", () => {
    expect(validateOptionsEdition(v2)).toMatchObject({ ok: true });
    expect(validateOptionsEdition(v1)).toMatchObject({ ok: true });
    expect(validateOptionsEdition(partialOptions(v2))).toMatchObject({ ok: true });
  });

  it("validates one with every new part empty or null", () => {
    const bare = structuredClone(v1) as Options;
    bare.market = null;
    bare.events = [];
    bare.tickers[0]!.vol = null;
    bare.tickers[1]!.vol = {};
    expect(validateOptionsEdition(bare)).toMatchObject({ ok: true });
    const hollow = structuredClone(v1) as Options;
    hollow.market = { vix: null, session: null, calendar: null };
    expect(validateOptionsEdition(hollow)).toMatchObject({ ok: true });
  });

  it.each([
    ["a percentile of exactly 0", (e: Options) => (e.market!.vix!.pct_52w = 0)],
    ["a percentile of exactly 1", (e: Options) => (e.tickers[0]!.vol!.iv_pct_13w = 1)],
    ["a fall in implied vol and in the VIX", (e: Options) => ((e.tickers[0]!.vol!.iv_change_1d = -0.03), (e.market!.vix!.change = -2.4))],
    ["a time with one digit for the hour", (e: Options) => (e.events![0]!.time_et = "9:30")],
    ["a time with seconds", (e: Options) => (e.events![0]!.time_et = "08:30:00")],
    ["an earnings row with a time", (e: Options) => Object.assign(e.events!.find((ev) => ev.kind === "earnings")!, { time_et: "16:05" })],
    ["a code in capitals or with a hyphen", (e: Options) => ((e.events![0]!.type = "FOMC-decision"), (e.events![1]!.type = "CPI"))],
    ["a code for when a company reports that this build does not know", (e: Options) => (e.events!.find((ev) => ev.kind === "earnings")!.when = "tns")],
    ["a calendar marked partial", (e: Options) => (e.market!.calendar = "partial")],
    ["a few hundred events", (e: Options) => (e.events = Array.from({ length: 400 }, () => ({ date: SESSION, kind: "macro" as const, type: "cpi" })))],
  ])("accepts %s", (_what, change) => {
    const e = structuredClone(v2) as Options;
    change(e);
    expect(validateOptionsEdition(e)).toMatchObject({ ok: true });
  });

  it.each([
    ["an unknown key under market", (e: Options) => Object.assign(e.market!, { regime: "risk-on" })],
    ["a headline on an event", (e: Options) => Object.assign(e.events![0]!, { headline: "Fed holds" })],
    ["an event type with spaces in it", (e: Options) => (e.events![0]!.type = "Fed holds rates steady")],
    ["session hours spelt out, which would be a second source for them", (e: Options) => Object.assign(e.market!.session!, { close: "13:00" })],
    ["implied vol sent as a percentage", (e: Options) => (e.tickers[0]!.vol!.iv30 = 11.92)],
    ["realised vol sent as a percentage", (e: Options) => (e.tickers[0]!.vol!.hv30 = 9.03)],
    ["a change in implied vol sent in points", (e: Options) => (e.tickers[0]!.vol!.iv_change_1d = 1.2)],
    ["a second 52-week percentile, beside the one the edition already has", (e: Options) => Object.assign(e.tickers[0]!.vol!, { iv_pct_52w: 0.5 })],
    ["findings, which this format does not carry yet", (e: Options) => Object.assign(e, { evidence: [{ id: "x", value: 1 }] })],
    ["an event kind this build does not know", (e: Options) => ((e.events![0] as { kind: string }).kind = "rumour")],
    ["an event date that is not a date", (e: Options) => (e.events![0]!.date = "next Tuesday")],
    ["a time that is not a time", (e: Options) => (e.events![0]!.time_et = "2pm")],
    ["an hour that does not exist", (e: Options) => (e.events![0]!.time_et = "24:00")],
    ["a percentile sent as 34 instead of 0.34", (e: Options) => (e.tickers[0]!.vol!.iv_pct_13w = 34)],
    ["a negative option volume", (e: Options) => (e.tickers[0]!.vol!.opt_volume = -1)],
    ["an unknown key in a volatility block", (e: Options) => Object.assign(e.tickers[0]!.vol!, { skew: 0.1 })],
    ["a VIX below zero", (e: Options) => (e.market!.vix!.close = -1)],
  ])("refuses %s", (_what, damage) => {
    const e = structuredClone(v2) as Options;
    damage(e);
    expect(validateOptionsEdition(e).ok).toBe(false);
  });
});

describe("the day's events", () => {
  it("are nothing at all for an edition in the first format, and a clear day for one with an empty list", () => {
    expect(dayContext(v1)).toBeNull();
    expect(dayContext({ ...v1, events: null })).toBeNull();
    expect(dayContext({ ...v1, events: [] })).toEqual({ onTheDay: [], ahead: [], earnings: [], complete: false });
  });

  it("puts the session's own releases in time order however the time was written, the untimed ones last", () => {
    expect(dayContext(v2)!.onTheDay.map((ev) => `${eventLabel(ev.type)} ${eventTime(ev) ?? "-"}`)).toEqual([
      "CPI inflation 08:30",
      "Fed minutes 14:00",
      `${OTHER_EVENT} -`,
      `${OTHER_EVENT} -`,
    ]);
    const mixed: Options = { ...v1, events: [{ date: SESSION, time_et: "14:00", kind: "macro", type: "fomc_minutes" }, { date: SESSION, time_et: "8:30", kind: "macro", type: "cpi" }] };
    expect(dayContext(mixed)!.onTheDay.map((ev) => ev.type)).toEqual(["cpi", "fomc_minutes"]);
  });

  it("reads a time as HH:MM whatever digits it came with", () => {
    const ev = (time_et: string | null): OptionsEvent => ({ date: SESSION, kind: "macro", type: "cpi", time_et });
    expect(eventTime(ev("8:30"))).toBe("08:30");
    expect(eventTime(ev("08:30:00"))).toBe("08:30");
    expect(eventTime(ev("14:00"))).toBe("14:00");
    expect(eventTime(ev(null))).toBeNull();
  });

  it("says a day is clear only when the edition says its calendar is complete", () => {
    expect(dayContext(v2)!.complete).toBe(true);
    expect(dayContext({ ...v2, market: { ...v2.market, calendar: "partial" } })!.complete).toBe(false);
    expect(dayContext({ ...v2, market: null })!.complete).toBe(false);
  });

  it("drops a date that does not exist, the same on every browser", () => {
    const e: Options = { ...v1, events: [{ date: "2026-10-12", kind: "macro", type: "cpi" }, { date: "2026-10-32", kind: "macro", type: "nfp" }, { date: "2026-02-30", kind: "macro", type: "nfp" }] };
    expect(dayContext(e)!.onTheDay.map((ev) => ev.type)).toEqual(["cpi"]);
    expect(dayContext(e)!.ahead).toEqual([]);
  });

  it("keeps the releases of the following days apart, and drops what is past or beyond the week", () => {
    const day = dayContext(v2)!;
    expect(day.ahead.map((ev) => ev.type)).toEqual(["fomc_decision"]);
    expect([...day.onTheDay, ...day.ahead].some((ev) => ev.type === "nfp")).toBe(false);
  });

  it("lists earnings only for the edition's own names, within the week, soonest first", () => {
    const [a, b] = v1.tickers.map((t) => t.symbol);
    expect(dayContext(v2)!.earnings.map((ev) => `${ev.symbol} ${ev.when}`)).toEqual([`${a} bmo`, `${b} amc`]);
  });

  it("counts the last day of the horizon in and the day after it out", () => {
    const on = (days: number) => new Date(Date.parse(`${SESSION}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const e: Options = {
      ...v1,
      events: [
        { date: on(EVENT_HORIZON_DAYS), kind: "macro", type: "cpi" },
        { date: on(EVENT_HORIZON_DAYS + 1), kind: "macro", type: "nfp" },
        { date: on(-1), kind: "macro", type: "fomc_minutes" },
      ],
    };
    expect(dayContext(e)!.ahead.map((ev) => ev.type)).toEqual(["cpi"]);
  });

  it("names the codes it knows, however they are cased, and never draws one it does not know as written", () => {
    expect(eventLabel("fomc_decision")).toBe("Fed decision");
    expect(eventLabel("FOMC-decision")).toBe("Fed decision");
    expect(eventLabel("nfp")).toBe("Jobs report");
    // A headline spelt with underscores passes the schema's pattern. It must not reach the page as words.
    expect(eventLabel("fed_holds_rates_powell_turns_hawkish")).toBe(OTHER_EVENT);
    // And a code is a key in a plain object: these must not reach into the object itself.
    for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(eventLabel(code)).toBe(OTHER_EVENT);
    expect(earningsWhen("amc")).toBe("after the close");
    for (const code of ["tns", "constructor", "__proto__", null, undefined]) expect(earningsWhen(code)).toBeNull();
  });
});

describe("the session's hours", () => {
  it("come from one answer: the edition's own when it gives one, else any name's", () => {
    expect(isHalfDay(v1)).toBe(false);
    expect(isHalfDay({ ...v1, tickers: v1.tickers.map((t, i) => ({ ...t, half_day: i === 0 })) })).toBe(true);
    expect(isHalfDay({ ...v2, market: { ...v2.market, session: { half_day: true } } })).toBe(true);
    // The edition's own answer wins over a name that disagrees.
    expect(isHalfDay({ ...v2, tickers: v2.tickers.map((t) => ({ ...t, half_day: true })) })).toBe(false);
    expect(sessionHours(v2)).toEqual({ open: "09:30", close: "16:00", halfDay: false });
    expect(sessionHours({ ...v2, market: { ...v2.market, session: { half_day: true } } })).toEqual({ open: "09:30", close: "13:00", halfDay: true });
  });
});

describe("the day's line on the desk", () => {
  const html = (e: Options) => renderToStaticMarkup(createElement(OptionsDay, { e }));

  it("draws nothing for an edition in the first format", () => {
    expect(html(v1)).toBe("");
    expect(html({ ...v1, market: null, events: null })).toBe("");
    expect(html({ ...v1, market: { vix: null, session: null, calendar: null } })).toBe("");
  });

  it("draws the whole of the second format, with every time marked as New York's", () => {
    const out = html(v2);
    expect(out).toContain("16.24");
    expect(out).toContain("CPI inflation 08:30 ET");
    expect(out).toContain("Fed minutes 14:00 ET");
    expect(out).toContain("Next 6 days: Fed decision Wed 14 Oct 14:00 ET");
    expect(out).toContain("Earnings, next 6 days: SPY Tue 13 Oct before the open, QQQ Thu 15 Oct after the close");
    expect(out).toContain("09:30 to 16:00");
    expect(out).not.toMatch(/NaN|undefined|Infinity|null|\[object/);
  });

  it("never draws an unknown code as written, and survives the same release listed twice", () => {
    const out = html(v2);
    expect(out).not.toMatch(/powell|hawkish|fed_holds|fed holds/i);
    expect(out.split(OTHER_EVENT).length - 1).toBe(2);
    const hostile: Options = { ...v1, events: [{ date: SESSION, kind: "macro", type: "__proto__" }, { date: SESSION, kind: "macro", type: "constructor" }] };
    expect(html(hostile).split(OTHER_EVENT).length - 1).toBe(2);
  });

  it("says it does not know a day's releases unless the calendar is complete, and says a clear day is clear when it is", () => {
    const none: Options = { ...v1, events: [], market: { calendar: "complete" } };
    expect(html(none)).toContain("no scheduled release");
    expect(html({ ...none, market: { calendar: "partial" } })).toContain("releases not known");
    expect(html({ ...none, market: null })).toContain("releases not known");
    // Earnings rows alone say nothing about the macro calendar.
    const onlyEarnings: Options = { ...v1, events: [{ date: SESSION, kind: "earnings", type: "earnings", symbol: "SPY", when: "amc" }] };
    expect(html(onlyEarnings)).toContain("releases not known");
    expect(html(onlyEarnings)).not.toContain("no scheduled release");
  });

  it("draws the parts it is given and no others", () => {
    const market: Options = { ...v1, market: { vix: { close: 20.5 }, session: { half_day: true } } };
    expect(html(market)).toContain("20.50");
    expect(html(market)).toContain("09:30 to 13:00");
    expect(html(market)).toContain("a half day");
    expect(html(market)).not.toMatch(/releases not known|no scheduled release|Next 6 days|Earnings,/);
    const flag: Options = { ...v1, market: { session: { half_day: true } } };
    expect(html(flag)).toContain("a half day");
    const events: Options = { ...v1, events: [{ date: SESSION, kind: "macro", type: "nfp", time_et: "08:30" }] };
    expect(html(events)).toContain("Jobs report 08:30 ET");
    expect(html(events)).not.toContain("VIX");
    expect(html(events)).not.toContain("Session");
  });
});

describe("a name's volatility block", () => {
  it("is nothing for a name without one", () => {
    expect(volRead(v1.tickers[0]!)).toBeNull();
    expect(volRead(v2.tickers[3]!)).toBeNull();
  });

  it("reads implied against realised, the day's change in points, the three percentiles and volume against its average", () => {
    const t = v2.tickers[0]!;
    const r = volRead(t)!;
    expect(r.ivOverHv).toBeCloseTo(t.vol!.iv30! / t.vol!.hv30!, 12);
    expect(r.ivOverHv).toBeCloseTo(1.32, 2);
    expect(r.changePts).toBeCloseTo(1.2, 9);
    expect(r.pcts).toEqual([t.vol!.iv_pct_13w, t.vol!.iv_pct_26w]);
    expect(r.volumeRatio).toBeCloseTo(1.2, 9);
  });

  it("gives blanks, not zeros or infinities, for a block of blanks or an average of nothing", () => {
    expect(volRead(v2.tickers[4]!)).toEqual({ ivOverHv: null, iv: null, hv: null, changePts: null, pcts: [null, null], volumeRatio: null });
    expect(volRead(v2.tickers[5]!)!.volumeRatio).toBeNull();
    const zero = { ...v2.tickers[0]!, vol: { ...v2.tickers[0]!.vol!, hv30: 0 } };
    expect(volRead(zero)!.ivOverHv).toBeNull();
    for (const t of v2.tickers) {
      const r = volRead(t);
      if (!r) continue;
      for (const n of [r.ivOverHv, r.changePts, r.volumeRatio, ...r.pcts]) if (n !== null) expect(Number.isFinite(n)).toBe(true);
    }
  });
});
