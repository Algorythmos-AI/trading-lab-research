// The research arms' record lineage, by id only: which record registered, tested, ended, stopped and replaced them.
// A small typed module on purpose: the Reference Registry (its own pull request) builds the full graph of every
// record from the repository, and can replace this list when it lands. Each edge here was read from the records
// themselves (their "Depends on", "Amends", "Experiment" and "Replaces" lines) and from config/trial_registry.yaml.

export type LineageKind = "DEC" | "HYP" | "EXP";

export interface LineageNode {
  id: string;
  kind: LineageKind;
  /** A range of ids drawn as one node (the fourteen hypotheses). */
  until?: string;
  /** The column it sits in, left to right. */
  col: number;
  row: number;
}

export interface LineageEdge {
  from: string;
  to: string;
  /** What the later record does to the earlier, in a word or two. */
  says: string;
}

export const LINEAGE_NODES: readonly LineageNode[] = [
  { id: "DEC-0041", kind: "DEC", col: 0, row: 1 },
  { id: "HYP-0034", until: "HYP-0047", kind: "HYP", col: 1, row: 0 },
  { id: "EXP-0030", kind: "EXP", col: 1, row: 2 },
  { id: "DEC-0056", kind: "DEC", col: 2, row: 0 },
  { id: "DEC-0059", kind: "DEC", col: 2, row: 2 },
  { id: "DEC-0060", kind: "DEC", col: 3, row: 1 },
  { id: "DEC-0067", kind: "DEC", col: 4, row: 1 },
  { id: "EXP-0052", kind: "EXP", col: 5, row: 1 },
];

export const LINEAGE_EDGES: readonly LineageEdge[] = [
  { from: "DEC-0041", to: "HYP-0034", says: "registers 14 trials" },
  { from: "DEC-0041", to: "EXP-0030", says: "runs them" },
  { from: "HYP-0034", to: "DEC-0056", says: "ended by" },
  { from: "EXP-0030", to: "DEC-0059", says: "booking stopped by" },
  { from: "DEC-0059", to: "DEC-0060", says: "replaced by the lab" },
  { from: "DEC-0060", to: "DEC-0067", says: "amended by" },
  { from: "DEC-0067", to: "EXP-0052", says: "measured in" },
];

/** Family O's trial count around the arms (config/trial_registry.yaml): DEC-0040 left 21, DEC-0041 made it 35. */
export const FAMILY_O = { before: 21, after: 35, by: "DEC-0041" } as const;

export const nodeLabel = (n: LineageNode) => (n.until ? `${n.id}–${n.until.slice(4)}` : n.id);
