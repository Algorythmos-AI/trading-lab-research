import type { Snapshot } from "./snapshot.types";

export type { Snapshot };

type NN<T> = NonNullable<T>;
/** The non-null element type of a nullable array field. */
type Item<T> = NN<NN<T> extends readonly (infer U)[] ? U : never>;

export type Collector = NN<Snapshot["collector"]>;
export type CollectorSource = NN<NN<Collector["sources"]>[string]>;
export type Market = NN<Snapshot["market"]>;
export type DstChange = Item<Snapshot["dst"]>;

export type Overview = NN<Snapshot["overview"]>;
export type Kpi = Item<Overview["kpis"]>;
export type NeedsYou = Item<Overview["needs_you"]>;
export type Gate = Item<Overview["gates"]>;

export type Research = NN<Snapshot["research"]>;
export type ScoreRow = Item<Research["scoreboard"]>;
export type Round3 = Item<Research["round3"]>;
export type Decision = Item<Research["decisions"]>;
export type Hypothesis = Item<Research["hypotheses"]>;

export type Spec = NN<Snapshot["spec"]>;
export type SpecArea = Item<Spec["by_area"]>;

export type Platform = NN<Snapshot["platform"]>;
export type Milestone = Item<Platform["milestones"]>;
export type Release = Item<Platform["releases"]>;
export type CiRun = Item<Platform["runs"]>;
export type RoadmapItem = Item<Platform["roadmap"]>;

export type Ops = NN<Snapshot["ops"]>;
export type Deployed = NN<Ops["deployed"]>;
export type Paper = NN<Ops["paper"]>;
export type PaperEvent = Item<Paper["recent"]>;
export type Forward = NN<Ops["forward"]>;
export type ForwardStrategy = Item<Forward["strategies"]>;
export type Host = NN<Ops["host"]>;
export type HostJob = Item<Host["jobs"]>;
export type ScheduleEntry = Item<Host["schedule"]>;
export type Account = NN<Ops["account"]>;
export type Position = Item<Account["positions"]>;
export type LogInfo = NN<Paper["log"]>;

export type Jobs = NN<Snapshot["jobs"]>;
export type JobResult = NN<NN<Jobs["last"]>[string]>;
export type JobRun = Item<Jobs["runs"]>;
export type FiringAlert = Item<NN<Snapshot["alerts"]>["firing"]>;
export type Kill = NN<Snapshot["kill"]>;
export type Deploy = NN<Snapshot["deploy"]>;
export type PreflightCheck = Item<Snapshot["preflight"]>;
export type ExpectedWindow = Item<Snapshot["expected_windows"]>;
export type ForwardPoint = Item<NN<Snapshot["series"]>["forward"]>;
export type PaperPoint = Item<NN<Snapshot["series"]>["paper"]>;
export type TimelineEvent = Item<NN<Snapshot["history"]>["timeline"]>;

/** Drops null/undefined items from an optional array; never throws. */
export function list<T>(xs: readonly (T | null | undefined)[] | null | undefined): T[] {
  if (!Array.isArray(xs)) return [];
  return xs.filter((x): x is T => x !== null && x !== undefined);
}

/** Non-null entries of an optional string-keyed map. */
export function entries<T>(
  m: { [k: string]: T | null | undefined } | null | undefined,
): [string, T][] {
  if (!m || typeof m !== "object") return [];
  return Object.entries(m).filter((e): e is [string, T] => e[1] !== null && e[1] !== undefined);
}
