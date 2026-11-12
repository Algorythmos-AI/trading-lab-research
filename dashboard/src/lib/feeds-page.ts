import "server-only";
import { readCompareReports } from "./feed-compare-report";
import { type Entitlement, entitlement, entitlementShort, entitlementWords } from "./entitlement";
import { type BoardFeedDay, nextOpenAfter, readBoardFeedDay } from "./board-feed-stamp";
import { bodyHash, type ChainReason, type JudgeStamp, sessionEnds, verifyChain } from "./board-feed-judge";
import { FEEDS_FX_COOKIE, feedsFixtureClock, parseFeedsFx } from "./feeds-live";
import { addDays, nyNow, sessionOf } from "./market-calendar";
import { nyInstant } from "./options";
import { fixtureMode, pageTime } from "./snapshot";

// The Feeds page (/options/feeds, DEC-0050): which feed is authoritative, today's board-feed stamps, and after a
// session's close the stored feed comparisons as counts and differences only. Server only.
//
// DEC-0050 point 5 binds what is drawn: no IEX state or label per symbol and slot, ever, and nothing from the
// comparison during a session. ComparedSession holds exactly what the table shows; toComparedSession copies only
// those fields, so a report's per-slot lists can never reach the page.

/** A median-style figure with the count it rests on; each null when the report does not give it. */
export interface Stat {
  value: number | null;
  n: number | null;
}

/** One stored comparison report as the "Sessions compared" table draws it, and nothing more. */
export interface ComparedSession {
  day: string | null;
  engine: string | null;
  minutes: number | null;
  expected: number | null;
  /** signals.identical_pct: the share of comparable slots whose state words were identical, in percent. */
  identicalPct: number | null;
  enterSip: number | null;
  enterIex: number | null;
  enterMatched: number | null;
  priceDiffMedianBp: number | null;
  priceDiffP95Bp: number | null;
  priceDiffN: number | null;
  volumeRatio: Stat;
  spreadSip: Stat;
  spreadIex: Stat;
  tradeAgeP95Sip: Stat;
  tradeAgeP95Iex: Stat;
  /** The sum of prices.not_comparable's counts; null when it is missing or any count is not a whole number. */
  notComparable: number | null;
  /** signals.status ("ok", "no_edition", "no_bars"), and its why for no_bars: a word, never a slot list. */
  signalsStatus: string | null;
  signalsWhy: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const at = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => obj(o)?.[k], v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A status word: lower-case letters and underscores, short; anything else is not shown. */
const word = (v: unknown): string | null => (typeof v === "string" && /^[a-z_]{1,32}$/.test(v) ? v : null);

/**
 * A stored report (the feed comparison's v1 JSON) read defensively: any field missing or of the wrong type becomes
 * null and is drawn as a dash. Null for anything that is not a v1 report at all.
 */
export function toComparedSession(report: unknown): ComparedSession | null {
  const r = obj(report);
  if (!r || r.v !== 1) return null;
  const day = typeof r.day === "string" && DAY.test(r.day) ? r.day : null;
  const nc = obj(at(r, "prices", "not_comparable"));
  let notComparable: number | null = null;
  if (nc) {
    const parts = Object.values(nc).map(count);
    notComparable = parts.every((x) => x !== null) ? parts.reduce<number>((a, b) => a + b!, 0) : null;
  }
  const stat = (value: unknown, n: unknown): Stat => ({ value: num(value), n: count(n) });
  return {
    day,
    engine: typeof r.engine === "string" && r.engine.length <= 40 ? r.engine : null,
    minutes: count(at(r, "samples", "minutes")),
    expected: count(at(r, "samples", "expected")),
    identicalPct: num(at(r, "signals", "identical_pct")),
    enterSip: count(at(r, "signals", "events_sip")),
    enterIex: count(at(r, "signals", "events_iex")),
    enterMatched: count(at(r, "signals", "matched")),
    priceDiffMedianBp: num(at(r, "prices", "diff_bp", "median")),
    priceDiffP95Bp: num(at(r, "prices", "diff_bp", "p95")),
    priceDiffN: count(at(r, "prices", "diff_bp", "n")),
    volumeRatio: stat(at(r, "bars", "volume_ratio_sip_over_iex", "median"), at(r, "bars", "volume_ratio_sip_over_iex", "n")),
    spreadSip: stat(at(r, "spread", "sip_bp", "median"), at(r, "spread", "sip_bp", "n")),
    spreadIex: stat(at(r, "spread", "iex_bp", "median"), at(r, "spread", "iex_bp", "n")),
    tradeAgeP95Sip: stat(at(r, "freshness", "sip_trade_age_s", "p95"), at(r, "freshness", "sip_trade_age_s", "n")),
    tradeAgeP95Iex: stat(at(r, "freshness", "iex_trade_age_s", "p95"), at(r, "freshness", "iex_trade_age_s", "n")),
    notComparable,
    signalsStatus: word(at(r, "signals", "status")),
    signalsWhy: word(at(r, "signals", "why")),
  };
}

/** The table's rows: newest day first (a report with no day last), at most MAX_COMPARED. */
export const MAX_COMPARED = 20;
export function comparedRows(reports: readonly unknown[]): ComparedSession[] {
  return reports
    .map(toComparedSession)
    .filter((x): x is ComparedSession => x !== null)
    .sort((a, b) => (b.day ?? "").localeCompare(a.day ?? ""))
    .slice(0, MAX_COMPARED);
}

/** Two synthetic v1 reports for fixture mode, so the table can be pictured. Made-up numbers, no real session. */
export function fixtureReports(): unknown[] {
  const one = (day: string, k: number) => ({
    v: 1,
    day,
    engine: "e-fixture00000",
    rules: "r-fixture",
    built_at: `${day}T21:10:00Z`,
    board_feed: { sip: 0, iex: 390, refused: 0 },
    samples: { minutes: 390 - k, expected: 390 },
    signals: { status: "ok", comparable: 1560 - 4 * k, identical: 1520 - 5 * k, identical_pct: 97.4 - k / 10, events_sip: 3 + k, events_iex: 5, matched: 3, sip_only: k, iex_only: 2 },
    prices: { pairs: 1550, not_comparable: { no_iex_trade: 6 + k, no_sip_trade: 1 }, diff_bp: { median: 0.8, p95: 3.9 + k / 10, max: 12.1, n: 1550 }, quote_mid_diff_bp: { median: 0.4, p95: 2.2, n: 1540 } },
    bars: { aligned: 780, only_sip: 4, only_iex: 0, volume_ratio_sip_over_iex: { median: 38.5 + k, p10: 22.1, p90: 61.4, n: 780 } },
    spread: { sip_bp: { median: 0.6, p95: 2.1, n: 1550 }, iex_bp: { median: 2.4, p95: 9.8, n: 1550 } },
    freshness: { sip_trade_age_s: { median: 0.4, p95: 1.6, n: 1550 }, iex_trade_age_s: { median: 4.1, p95: 31 + k, n: 1550 } },
  });
  return [one("2026-10-08", 2), one("2026-10-09", 0)];
}

/**
 * The stored session reports, newest first, as table rows. Read through the compare's own reader, which already
 * strips the replay's per-slot list (DEC-0050 point 5); a store that cannot be read gives no table and never an
 * error page: null, which the page shows as not available. Fixture mode shows two synthetic sessions.
 */
export async function loadComparedSessions(): Promise<{ rows: ComparedSession[]; bad: number } | null> {
  if (fixtureMode()) return { rows: comparedRows(fixtureReports()), bad: 0 };
  try {
    const { reports, bad } = await readCompareReports(MAX_COMPARED);
    return { rows: comparedRows(reports), bad };
  } catch {
    // Not "none yet": the store did not answer, and the page says so.
    return null;
  }
}

// ---- today's board-feed stamps ---------------------------------------------------------------------------------------

export type ChainStatus = ChainReason | "unreadable";

export interface StampPanel {
  /** "session": today's regular session is under way; "closed": today's has ended; "outside": no session today or not yet open. */
  phase: "session" | "closed" | "outside";
  /** The New York day the counts are for (today), when it is a session day. */
  day: string | null;
  /** The server time the panel was worked out at (epoch ms). */
  at: number;
  /** null when the stamps could not be read. */
  read: null | {
    count: number;
    /** Whole minutes from the open to now (to the close once closed). */
    elapsed: number;
    lastAgeMs: number | null;
    ok: number;
    malformed: number;
    ends: { not_sip: boolean; hidden_change: boolean } | null;
    feeds: Record<string, number>;
  };
  /** The previous session's chain check; null when there is no previous session in the calendar. */
  previous: { day: string; status: ChainStatus } | null;
}

/** The session day before `day` within two weeks, or null. */
export function previousSessionDay(day: string): string | null {
  for (let d = addDays(day, -1), i = 0; i < 15; d = addDays(d, -1), i++) {
    const s = sessionOf(d);
    if (s.kind === "out_of_range") return null;
    if (s.open !== null) return d;
  }
  return null;
}

/** The panel from today's stamps (null when unreadable) and the previous session's check, at server time `now`. */
export function stampPanel(now: Date, today: BoardFeedDay | null, previous: { day: string; status: ChainStatus } | null): StampPanel {
  const { day, minute } = nyNow(now);
  const s = sessionOf(day);
  const t = now.getTime();
  if (s.open === null || s.close === null || minute < s.open) return { phase: "outside", day: s.open === null ? null : day, at: t, read: null, previous };
  const phase = minute < s.close ? "session" : "closed";
  if (!today) return { phase, day, at: t, read: null, previous };
  const stamps: JudgeStamp[] = today.stamps;
  const last = stamps.reduce<number | null>((m, x) => {
    const v = Date.parse(x.at);
    return Number.isFinite(v) && (m === null || v > m) ? v : m;
  }, null);
  const feeds: Record<string, number> = {};
  for (const x of stamps) feeds[x.feed] = (feeds[x.feed] ?? 0) + 1;
  return {
    phase,
    day,
    at: t,
    read: {
      count: stamps.length,
      elapsed: Math.min(minute, s.close) - s.open,
      lastAgeMs: last === null ? null : Math.max(0, t - last),
      ok: stamps.filter((x) => x.answered === "ok").length,
      malformed: today.malformed,
      // With no stamp there is nothing to judge: never "no change" on no evidence.
      ends: stamps.length ? sessionEnds(stamps) : null,
      feeds,
    },
    previous,
  };
}

/** The previous session's chain: verifyChain over its stored stamps and manifest. */
export function chainStatus(d: BoardFeedDay | null): ChainStatus {
  if (!d) return "unreadable";
  if (d.nextOpen === null) return "unreadable";
  return verifyChain(d.bodies, d.manifest, d.nextOpen).reason;
}

/** A made-up, correctly chained day of stamps for fixture mode, to `untilMs` (the whole session when past its close). */
export function fixtureDay(day: string, untilMs: number, manifest: boolean): BoardFeedDay {
  const s = sessionOf(day);
  const stamps: BoardFeedDay["stamps"] = [];
  const bodies: BoardFeedDay["bodies"] = [];
  if (s.open === null || s.close === null) return { stamps, malformed: 0, bodies, manifest: null, nextOpen: nextOpenAfter(day) };
  let prev: string | null = null;
  for (let m = s.open; m < s.close; m++) {
    const minute = nyInstant(day, m)!;
    const at = new Date(minute + 5_000).toISOString();
    if (minute + 5_000 > untilMs) break;
    const answered = m % 97 === 50 ? "stale" : "ok";
    const text = JSON.stringify({ v: 1, feed: "sip", answered, at, deployment: "dpl_fixture", commit: "fixture00000", prev });
    prev = bodyHash(text);
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}`;
    stamps.push({ minute, hhmm, feed: "sip", answered, deployment: "dpl_fixture", at });
    bodies.push({ minute, text });
  }
  const close = nyInstant(day, s.close)!;
  return {
    stamps,
    malformed: 0,
    bodies,
    manifest: manifest ? { v: 1, count: bodies.length, last: prev, at: new Date(close + 3 * 60_000).toISOString() } : null,
    nextOpen: nextOpenAfter(day),
  };
}

/** The page's clock: pageTime, and in fixture mode the page's own `after-close` switch (feeds-live.ts). */
export async function feedsPageTime(): Promise<Date> {
  const base = await pageTime();
  if (!fixtureMode()) return base;
  const { cookies } = await import("next/headers");
  return feedsFixtureClock(parseFeedsFx((await cookies()).get(FEEDS_FX_COOKIE)?.value), base);
}

/** Today's stamps and the previous session's chain, read from the store (fixture mode: made up, no store). */
export async function loadStampPanel(now: Date, read: (day: string) => Promise<BoardFeedDay> = (d) => readBoardFeedDay(d)): Promise<StampPanel> {
  const { day } = nyNow(now);
  const prevDay = previousSessionDay(day);
  if (fixtureMode()) {
    return stampPanel(now, fixtureDay(day, now.getTime(), false), prevDay ? { day: prevDay, status: chainStatus(fixtureDay(prevDay, Infinity, true)) } : null);
  }
  const today = sessionOf(day).open === null ? null : await read(day).catch(() => null);
  let previous: StampPanel["previous"] = null;
  if (prevDay) {
    const got = await read(prevDay).catch(() => null);
    previous = { day: prevDay, status: chainStatus(got) };
  }
  return stampPanel(now, today, previous);
}

// ---- the keys' entitlement --------------------------------------------------------------------------------------------

/** The Feeds page's one row on what the site's keys are entitled to: its label, its words, and whether it warns. */
export interface EntitlementRow {
  label: string;
  text: string;
  warn: boolean;
}

const NY_HMS = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });

/** The row from the probe's answer: null is no keys on the site (nothing was asked). */
export function entitlementRow(e: Entitlement | null): EntitlementRow {
  if (!e) return { label: "Alpaca data plan", text: "not available: the site has no Alpaca keys", warn: true };
  const at = Date.parse(e.checked_at);
  return {
    label: `Alpaca data plan${Number.isFinite(at) ? ` (checked ${NY_HMS.format(new Date(at))} NY)` : ""}`,
    text: entitlementWords(e),
    warn: entitlementShort(e),
  };
}

/** The probe for the page (entitlement.ts: at most once per 10 minutes per instance; fixed in fixture mode). Never throws. */
export async function loadEntitlementRow(now: Date): Promise<EntitlementRow> {
  try {
    return entitlementRow(await entitlement({ now }));
  } catch {
    return { label: "Alpaca data plan", text: "not available: the check failed", warn: true };
  }
}
