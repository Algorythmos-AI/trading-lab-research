import { freshness, LATE_MIN, parseTime, type FreshState } from "./freshness";
import { gapHunterBlock } from "./gap-hunter";
import { deskKills } from "./kill";
import type { Tone } from "./labels";
import type { OptionsClone } from "./options-clone.types";
import type { SnapshotExtra } from "./snapshot-extra.types";
import { list, type Snapshot } from "./types";

/**
 * The Today page's safety switches: every kill file and loss latch the site is sent, one tile each, so the owner
 * sees at a glance whether any desk is stopped from opening new trades. Read only; switching is done on the host.
 *
 * Each tile says where its state came from (the stocks snapshot or the options clone's document) and how old that
 * is, and a source that is late says so instead of passing an old "off" for a current one.
 */
export type SwitchKind = "kill" | "latch";
export type SwitchSource = "snapshot" | "clone";

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

function killTile(key: string, label: string, on: boolean | null, detail: string | null): SafetyTile {
  return {
    key,
    kind: "kill",
    label,
    on,
    word: on === true ? "On" : on === false ? "Off" : "Not sent",
    tone: on === true ? "bad" : on === false ? "good" : "neutral",
    detail: on === true ? (detail ?? "No new entries; exits still managed.") : null,
    source: "snapshot",
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

export function safetyView(s: Snapshot | null, clone: OptionsClone | null, nowMs: number): SafetyView {
  const tiles: SafetyTile[] = [];

  // The values come from deskKills (the Risk page's reading); the labels name the file, not what it stops, so they
  // stay true whichever desks a file reaches.
  for (const k of deskKills(s)) {
    const since = k.key === "root" && k.on === true && s?.kill?.since ? s.kill.since : null;
    const label = k.key === "root" ? "Root KILL file" : "Gap Hunter KILL file";
    tiles.push(killTile(`kill-${k.key}`, label, k.on, since ? `On since ${since.slice(0, 10)}; exits still managed.` : null));
  }

  const g = gapHunterBlock(s);
  // gap_hunter is typed apart from the frozen snapshot type (snapshot-extra.types.ts).
  const extra = s as (Snapshot & SnapshotExtra) | null;
  const xLatched = list(extra?.gap_hunter?.safety?.x_latched).filter((x): x is string => typeof x === "string" && /^X[1-9]$/.test(x));
  const gOn = g?.latched === true || xLatched.length > 0 ? true : g?.latched === false ? false : null;
  tiles.push(latchTile("latch-s", "Gap Hunter latch", gOn, gOn && xLatched.length ? `Safety stops: ${xLatched.join(", ")}` : null, "snapshot"));

  const cl = clone ? (clone.latch ?? null) : undefined;
  const cOn = cl === undefined ? null : cl !== null;
  // A document from an earlier session says so: its day latch no longer applies, and today's may differ.
  const today = nyDate(nowMs);
  const earlier = clone && typeof clone.session === "string" && clone.session < today ? clone.session : null;
  const cWhy = [cl ? (LATCH_WORDS[cl] ?? cl) : null, earlier ? `From the ${earlier} session` : null].filter(Boolean).join(" · ");
  tiles.push(latchTile("latch-clone", "Options clone latch", cOn, cWhy || null, "clone"));

  const sources: SourceStamp[] = [];
  {
    const f = freshness(s?.as_of ?? null, list(s?.expected_windows), nowMs);
    sources.push({ source: "snapshot", label: "Stocks snapshot", asOf: s?.as_of ?? null, ageMin: f.ageMin, stale: STALE.includes(f.state) });
  }
  {
    const t = parseTime(clone?.as_of ?? null);
    const ageMin = t === null ? null : Math.max(0, (nowMs - t) / 60_000);
    // The clone sends after every trade event and once at the close: a document that is not the close's and is
    // older than the late threshold may hide a latch set since.
    const stale = clone !== null && clone.final !== true && ageMin !== null && ageMin > LATE_MIN;
    sources.push({ source: "clone", label: earlier ? `Options clone (${earlier} session)` : "Options clone", asOf: clone?.as_of ?? null, ageMin, stale });
  }

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
