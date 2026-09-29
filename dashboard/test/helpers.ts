import fixtureJson from "./fixtures/snapshot.json";
import type { Snapshot } from "../src/lib/types";

/** A fresh deep copy of the anonymized fixture snapshot. */
export function fixture(): Snapshot {
  return structuredClone(fixtureJson) as unknown as Snapshot;
}

/** A minimal, fully healthy snapshot for rule tests. */
export function cleanSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schema: "trading-lab/snapshot",
    schema_version: 2,
    run_id: "run-clean",
    as_of: "2026-09-29T12:00:00+00:00",
    kill: { on: false, since: null, reason: null },
    jobs: { last: { routine: { status: "ok", exit: 0 }, "paper-b": { status: "ok", exit: 0 } }, runs: [] },
    alerts: { firing: [] },
    collector: { exit_code: 0 },
    ops: {
      host: { disk_free_gb: 10, disk_floor_gb: 3, swap_warn_pct: 85, swap: { used_pct: 20 } },
      account: { trading_blocked: false },
    },
    preflight: [{ name: "on main", ok: true, detail: "" }],
    expected_windows: [
      { session: "2026-09-29", start: "2026-09-29T11:30:00+00:00", end: "2026-09-29T22:00:00+00:00" },
    ],
    overview: { needs_you: [] },
    ...overrides,
  };
}
