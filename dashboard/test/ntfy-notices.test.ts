// Every page the dashboard can send goes to an ntfy topic that anyone with its name can read. This drives every
// notice builder there is (the snapshot watchdog's: late, stopped, no readable snapshot, recovered, offline, with and
// without the assumed-window note, with each desk's prefix and the drill's; the feed watch's: late, cannot be checked,
// refused, back on time, for every row of the feed table, with and without the assumed-calendar note) and holds each
// title and message to an allowlist grammar: plain ASCII letters, digits and a little punctuation (no "$", no "/", no
// "@", no quotes: no amount, no URL, no host, no address), and words from a fixed vocabulary, numbers, HH:MM times and
// YYYY-MM-DD dates only. And no name the options desk trades (config/options_desk.yaml and the dashboard's own list)
// may appear. A new word in a page is a decision: add it here. Every kind in NOTICE_KINDS (ntfy.ts) must be driven
// here: a new kind without a builder below fails "drives every notice kind there is". Hostile inputs carry every name
// the desks trade (read from config), a price, a dollar amount, an error with a path and a URL, and a very long string.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESK_LABEL } from "@/lib/desk";
import {
  evaluateStamped,
  FEED_ASSUMED_NOTE,
  FEEDS,
  type FeedView,
  lateNotice,
  recoveredNotice,
  refusedNotice,
  type StampedInputs,
  unreadableNotice,
  summaryNotice,
  storeNotice,
  lateThenBackNotice,
} from "@/lib/feed-watch";
import { OPTIONS_NAMES } from "@/lib/market-calendar";
import { NOTICE_KINDS, type Notice } from "@/lib/ntfy";
import { evaluate, INITIAL_STATE } from "@/lib/watchdog";
import { cleanSnapshot } from "./helpers";

const VOCAB = new Set(
  `a after alert alive and apply are arrived at alive back be because blob by calendar can can't cannot card check checked
   checks clear cleared clock clone close copy dashboard data day days deadline did during earlier economic edition for
   format fresh from has have host host's in inside is it its jobs journal late latest ledger live loaded match min missed
   missing morning most new newer no not nothing nightly of offline old on once or out outside over page pages pre-open
   published publisher radar readable read record recovered refresh refused reminder repeats row rows run runs running
   schedule server session snapshot so status stopped store stored than that the them there this time to trade trading
   up update was weekday window windows york yet record written unknown been checked ahead were arrived sent good again
   assumed market job may say past could an accepted unknown feed alerts each sends own when already checkable watch write state until answers now about
   current`.split(/\s+/).filter(Boolean),
);
// The desks' prefixes and the drill's, and the feed table's names, are part of the grammar: they are fixed words too.
for (const label of Object.values(DESK_LABEL)) VOCAB.add(label.toLowerCase());
VOCAB.add("desk");
VOCAB.add("drill");
for (const f of FEEDS) for (const w of f.name.toLowerCase().split(/[\s,]+/)) if (w) VOCAB.add(w);

const CHARS = /^[A-Za-z0-9 :;.,()'-]*$/;
const TOKEN_OK = (t: string) =>
  VOCAB.has(t.toLowerCase()) || /^\d+$/.test(t) || /^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{4}-W\d{2}$/.test(t);

/** The options desk's names, from the repository's own config and the dashboard's calendar file: never hard-coded. */
function deskNames(): string[] {
  const yaml = readFileSync(fileURLToPath(new URL("../../config/options_desk.yaml", import.meta.url)), "utf8");
  const line = /^names:\s*\[([^\]]*)\]/m.exec(yaml);
  const fromYaml = line ? line[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return [...new Set([...fromYaml, ...OPTIONS_NAMES])];
}

/** What the page would actually carry (sendNtfy scrubs money) checked for every hostile marker and the caps. */
function leaks(n: Notice): string[] {
  const out: string[] = [];
  if (n.title.length > TITLE_MAX) out.push(`title length ${n.title.length}`);
  if (n.message.length > MESSAGE_MAX) out.push(`message length ${n.message.length}`);
  if (!n.title.trim() || !n.message.trim()) out.push("empty");
  for (const text of [n.title, n.message]) {
    for (const m of MARKERS) if (m.test(text)) out.push(`carries ${m}`);
    for (const name of deskNames()) if (new RegExp(`\\b${name}\\b`).test(text)) out.push(`names ${name}`);
  }
  return out;
}

function badTokens(n: Notice): string[] {
  const out: string[] = [];
  for (const text of [n.title, n.message]) {
    if (!CHARS.test(text)) out.push(`chars:${text}`);
    for (const t of text.split(/[\s:;.,()]+/).filter(Boolean)) if (!TOKEN_OK(t)) out.push(t);
  }
  return out;
}

// ---- every builder, driven ----------------------------------------------------------------------------------------

function watchdogNotices(): Notice[] {
  const out: Notice[] = [];
  const at = (iso: string) => new Date(iso);
  const snap = (asOf: string, windows = cleanSnapshot().expected_windows) => cleanSnapshot({ as_of: asOf, expected_windows: windows });
  const lateD = evaluate(snap("2026-09-29T12:00:00Z"), INITIAL_STATE, at("2026-09-29T12:40:00Z"));
  const stopD = evaluate(snap("2026-09-29T12:00:00Z"), INITIAL_STATE, at("2026-09-29T14:00:00Z"));
  const none = evaluate(null, INITIAL_STATE, at("2026-09-29T14:00:00Z"));
  const rec = evaluate(snap("2026-09-29T14:00:00Z"), lateD.next, at("2026-09-29T14:05:00Z"));
  const off = evaluate(snap("2026-09-20T12:00:00Z", []), INITIAL_STATE, at("2026-09-27T12:00:00Z"));
  // Every published window ended: the weekday window is assumed and the page says so.
  const assumed = evaluate(snap("2026-09-29T12:00:00Z", [{ session: "2026-09-28", start: "2026-09-28T11:30:00Z", end: "2026-09-28T22:00:00Z" }]), INITIAL_STATE, at("2026-09-29T14:00:00Z"));
  const assumedLate = evaluate(snap("2026-09-29T13:20:00Z", [{ session: "2026-09-28", start: "2026-09-28T11:30:00Z", end: "2026-09-28T22:00:00Z" }]), INITIAL_STATE, at("2026-09-29T14:00:00Z"));
  for (const d of [lateD, stopD, none, rec, off, assumed, assumedLate]) out.push(...d.notices);
  return out;
}

function feedNotices(): Notice[] {
  const now = new Date("2026-11-12T23:00:00Z");
  const empty: StampedInputs = {
    stamps: Object.fromEntries(FEEDS.flatMap((f) => (f.type === "doc" ? [[f.id, { status: "missing" as const }]] : []))),
    refusals: Object.fromEntries(FEEDS.flatMap((f) => (f.type === "refusal" ? [[f.kind, { status: "ok" as const, value: { current: true, at: "2026-11-12T22:30:00Z", outcome: "invalid" as const } }]] : []))),
    shadow: { status: "ok", value: { on: true, switched_at: null, last_slot_end: Date.parse("2026-11-12T19:00:00Z") } },
  };
  const views: FeedView[] = [
    ...evaluateStamped(empty, now.getTime()),
    ...evaluateStamped(empty, Date.parse("2026-11-12T20:00:00Z")), // in the session: the server check is late
    ...evaluateStamped(empty, Date.parse("2030-01-08T23:30:00Z")), // outside the calendar: assumed
    ...evaluateStamped(empty, Date.parse("2029-12-31T23:30:00Z")), // the last session: its next one is past the calendar
  ];
  const out: Notice[] = [storeNotice(now)];
  for (const v of views) {
    out.push(lateNotice(v, now), unreadableNotice(v, 3, now), recoveredNotice(v, now));
    out.push(summaryNotice([v.id], now), lateThenBackNotice(v.id, 37, now));
    if (v.type === "refusal") {
      out.push(refusedNotice(v, now));
      out.push(refusedNotice({ ...v, outcome: "ahead-of-clock" }, now), refusedNotice({ ...v, outcome: null, due: null }, now));
    }
  }
  return out;
}

const withPrefixes = (ns: Notice[]): Notice[] => [
  ...ns,
  ...ns.map((n) => ({ ...n, title: `DRILL: ${n.title}` })),
  ...Object.values(DESK_LABEL).flatMap((label) => ns.map((n) => ({ ...n, title: `${label} desk: ${n.title}` }))),
];

const TITLE_MAX = 120;
const MESSAGE_MAX = 1000;
/** Everything a page must never carry, in one string: every desk name, a price, an amount, an error with a path and
 * a URL, and a very long tail. */
const HOSTILE = `${deskNames().join(" ")} broke 123.45 for US$1,234.56; TypeError: ENOENT: no such file, open '/home/wt/trading/var/x.json' https://lab.example/api?token=sekrit ${"Z".repeat(4000)}`;
const MARKERS = [/123\.45/, /1,234/, /\$/, /\/home\//, /:\/\//, /lab\.example/, /sekrit/, /ENOENT/, /TypeError/, /Z{20}/, /NaN|Infinity|undefined|null/];

/** A view whose every field carries something that must never be sent: a ticker, a price, a URL, an error text. */
function hostile(base: FeedView): FeedView {
  return {
    ...base,
    id: HOSTILE,
    name: HOSTILE,
    short: HOSTILE,
    reason: HOSTILE as FeedView["reason"],
    for_session: HOSTILE,
    outcome: HOSTILE as FeedView["outcome"],
    late_min: Number.NaN,
    age_min: Number.POSITIVE_INFINITY,
    deadline: Number.NaN,
    due: Number.NaN,
    misses: Number.NaN,
    assumed: "yes" as unknown as boolean,
  };
}

describe("ntfy notices", () => {
  it("every value a page carries comes from a closed set: hostile views cannot put anything else in", () => {
    const now = new Date("2026-11-12T23:00:00Z");
    const base = evaluateStamped({ stamps: {}, refusals: {}, shadow: null }, now.getTime());
    const ns: Notice[] = [];
    for (const v of base) {
      const h = hostile(v);
      ns.push(lateNotice(h, now), unreadableNotice(h, Number.NaN, now), recoveredNotice(h, now), refusedNotice(h, now), summaryNotice([h.id, ...deskNames()], now), lateThenBackNotice(h.id, Number.NaN, now));
      ns.push(unreadableNotice(h, 123.45, now), lateThenBackNotice(h.id, 123.45, now));
      // The same views with their own id: the name is the table's, never the view's text.
      const own = { ...h, id: v.id };
      ns.push(lateNotice(own, now), recoveredNotice(own, now), refusedNotice(own, now), summaryNotice([v.id], now));
    }
    const bad = ns.flatMap((n) => badTokens(n).map((t) => `${n.kind}: ${t}`));
    expect([...new Set(bad)]).toEqual([]);
    for (const n of ns) expect(leaks(n)).toEqual([]);
  });

  it("the snapshot watchdog's pages carry nothing a hostile snapshot holds", () => {
    const at = (iso: string) => new Date(iso);
    const windows = [{ session: HOSTILE, start: HOSTILE, end: "2026-09-29T22:00:00Z" }];
    const windows2 = [{ session: "", start: "2026-09-29T11:30:00Z", end: "2026-09-29T22:00:00Z" }];
    const windows3 = [{ session: "2026-W40", start: "2026-09-29T11:30:00Z", end: "2026-09-29T22:00:00Z" }];
    const ns: Notice[] = [];
    for (const w of [windows, windows2, windows3]) {
      for (const asOf of ["2026-09-29T12:00:00Z", HOSTILE]) {
        for (const t of ["2026-09-29T12:40:00Z", "2026-09-29T14:00:00Z"]) {
          const d = evaluate(cleanSnapshot({ as_of: asOf, expected_windows: w }), INITIAL_STATE, at(t));
          ns.push(...d.notices);
        }
      }
    }
    expect(ns.length).toBeGreaterThan(0);
    for (const n of ns) expect([...badTokens(n), ...leaks(n)]).toEqual([]);
  });

  const all = withPrefixes([...watchdogNotices(), ...feedNotices()]);

  it("drives every notice kind there is (the kinds come from ntfy.ts, not from this test)", () => {
    const kinds = new Set(all.map((n) => n.kind));
    expect([...kinds].sort()).toEqual([...NOTICE_KINDS].sort());
    expect(all.some((n) => n.message.includes("weekday window is assumed"))).toBe(true);
    expect(all.some((n) => n.message.endsWith(FEED_ASSUMED_NOTE))).toBe(true);
  });

  it("every title and message keeps to the allowlist grammar and the length caps", () => {
    const bad = all.flatMap((n) => [...badTokens(n), ...leaks(n)].map((t) => `${n.kind}: ${t}`));
    expect([...new Set(bad)]).toEqual([]);
  });

  it("no name from the options desk can appear, in the table or in any page", () => {
    const names = deskNames();
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const f of FEEDS) for (const name of names) expect(`${f.name} ${f.short}`).not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
    for (const n of all) for (const name of names) expect(`${n.title} ${n.message}`).not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
    for (const name of names) expect(VOCAB.has(name.toLowerCase())).toBe(false);
  });

  it("the grammar refuses what must never be sent", () => {
    const bad = (message: string) => badTokens({ kind: "feed-late", title: "Options edition late", message, priority: 4, tags: [] }).length > 0;
    expect(bad("Options edition is late: 5 min.")).toBe(false);
    expect(bad("price $512.40")).toBe(true);
    expect(bad("see https://lab.example/api")).toBe(true);
    expect(bad("SPY broke 512")).toBe(true);
    expect(bad("TypeError: cannot read")).toBe(true);
    expect(bad("host wt-gcp-1")).toBe(true);
  });
});
