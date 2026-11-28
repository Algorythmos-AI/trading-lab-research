import { freshness, parseTime, type FreshState } from "./freshness";
import { freshnessOf, pickSource, readLive } from "./gap-hunter-now";
import type { Tone } from "./labels";
import type { OptionsClone } from "./options-clone.types";
import type { GapHunterLiveResult } from "./snapshot";
import { list, type Snapshot } from "./types";

/**
 * The Today page's safety switches: every kill file and loss latch the site is sent, one tile each, so the owner
 * sees at a glance whether any desk is stopped from opening new trades. Read only; switching is done on the host.
 *
 * Each tile says where its state came from and how old that is:
 * - the root KILL file from the stocks snapshot (late by its expected windows, `freshness`);
 * - Gap Hunter's file and latch from the newer of the snapshot's block and its per-minute live document, exactly as
 *   the Gap Hunter page reads them (`pickSource`, late by that copy's own rhythm, `freshnessOf`);
 * - the options clone's latch from its document, which the runner sends on every event, a latch included, so an old
 *   document on a quiet afternoon is normal: its age is shown, and only a document from an earlier session is named.
 * A late source says so on its tiles instead of passing an old "off" for a current one.
 */
export type SwitchKind = "kill" | "latch";
export type SwitchSource = "snapshot" | "gap" | "clone";

export interface SafetyTile {
  key: string;
  kind: SwitchKind;
  label: string;
  /** true = on (entries stopped), false = off, null = not sent. */
  on: boolean | null;
  /** The headline word: "Off", "On", "Latched", "Clear", "Not sent". */
  word: string;
  tone: Tone;
  /** A short line under the word, or null. */
  detail: string | null;
  source: SwitchSource;
}

export interface SourceStamp {
  source: SwitchSource;
  label: string;
  asOf: string | null;
  ageMin: number | null;
  /** True when the source is older than it should be: its "off" may no longer hold. */
  stale: boolean;
}

export interface SafetyView {
  tiles: SafetyTile[];
  sources: SourceStamp[];
  /** How many switches are on. */
  onCount: number;
  /** How many the site was not sent. */
  unknownCount: number;
  /** The panel's one word: any on; else any not sent; else any source late; else all clear. Never "clear" on a guess. */
  overall: "on" | "unknown" | "stale" | "clear";
}

/** The New York calendar date of an instant, YYYY-MM-DD. */
export function nyDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

const LATCH_WORDS: Record<string, string> = { day: "Day loss limit", week: "Week loss limit", drawdown: "Drawdown limit" };

function killTile(key: string, label: string, on: boolean | null, detail: string | null, source: SwitchSource): SafetyTile {
  return {
    key,
    kind: "kill",
    label,
    on,
    word: on === true ? "On" : on === false ? "Off" : "Not sent",
    tone: on === true ? "bad" : on === false ? "good" : "neutral",
    detail: on === true ? (detail ?? "No new entries; exits still managed.") : null,
    source,
  };
}

function latchTile(key: string, label: string, on: boolean | null, detail: string | null, source: SwitchSource): SafetyTile {
  return {
    key,
    kind: "latch",
    label,
    on,
    word: on === true ? "Latched" : on === false ? "Clear" : "Not sent",
    tone: on === true ? "bad" : on === false ? "good" : "neutral",
    detail,
    source,
  };
}

/** Stale states that mean "this may be out of date". "asleep" (outside every window) is not stale. */
const STALE: readonly FreshState[] = ["late", "stopped"];

const ageOf = (iso: string | null | undefined, nowMs: number) => {
  const t = parseTime(iso ?? null);
  return t === null ? null : Math.max(0, (nowMs - t) / 60_000);
};

export function safetyView(
  s: Snapshot | null,
  clone: OptionsClone | null,
  nowMs: number,
  gapLive: GapHunterLiveResult | null = null,
): SafetyView {
  const tiles: SafetyTile[] = [];
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

  // Gap Hunter: the copy the Gap Hunter page shows. Labels name the file, not which desks it stops.
  const gSrc = pickSource(s, gapLive);
  const g = readLive(gSrc.raw);
  tiles.push(killTile("kill-s", "Gap Hunter KILL file", g?.kill ?? null, null, "gap"));

  const rootOn = bool(s?.kill?.on);
  const since = rootOn === true ? (s?.kill?.since ?? null) : null;
  tiles.push(killTile("kill-root", "Root KILL file", rootOn, since ? `On since ${nyDate(Date.parse(since))}; exits still managed.` : null, "snapshot"));

  const xLatched = g?.xLatched ?? [];
  const gOn = g === null ? null : g.latched === true || xLatched.length > 0 ? true : g.latched === false ? false : null;
  tiles.push(latchTile("latch-s", "Gap Hunter latch", gOn, gOn && xLatched.length ? `Safety stops: ${xLatched.join(", ")}` : null, "gap"));

  const cl = clone ? (clone.latch ?? null) : undefined;
  const cOn = cl === undefined ? null : cl !== null;
  // A document from an earlier session says so: its day latch no longer applies, and today's may differ.
  const earlier = clone && typeof clone.session === "string" && clone.session < nyDate(nowMs) ? clone.session : null;
  const cWhy = [cl ? (LATCH_WORDS[cl] ?? cl) : null, earlier ? `From the ${earlier} session` : null].filter(Boolean).join(" · ");
  tiles.push(latchTile("latch-clone", "Options clone latch", cOn, cWhy || null, "clone"));

  const sf = freshness(s?.as_of ?? null, list(s?.expected_windows), nowMs);
  const gf = freshnessOf(gSrc, new Date(nowMs));
  const sources: SourceStamp[] = [
    { source: "snapshot", label: "Stocks snapshot", asOf: s?.as_of ?? null, ageMin: sf.ageMin, stale: STALE.includes(sf.state) },
    {
      source: "gap",
      label: gSrc.from === "live" ? "Gap Hunter (live document)" : "Gap Hunter (snapshot)",
      asOf: gSrc.asOf,
      ageMin: gf.ageMin,
      stale: STALE.includes(gf.state),
    },
    {
      source: "clone",
      label: earlier ? `Options clone (${earlier} session)` : "Options clone",
      asOf: clone?.as_of ?? null,
      ageMin: ageOf(clone?.as_of, nowMs),
      stale: false,
    },
  ];

  const onCount = tiles.filter((t) => t.on === true).length;
  const unknownCount = tiles.filter((t) => t.on === null).length;
  return {
    tiles,
    sources,
    overall: onCount > 0 ? "on" : unknownCount > 0 ? "unknown" : sources.some((x) => x.stale) ? "stale" : "clear",
    onCount,
    unknownCount,
  };
}
