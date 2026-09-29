import { describe, expect, it } from "vitest";
import { computeHealth } from "@/lib/health";
import { cleanSnapshot, fixture } from "./helpers";

// Inside the 2026-09-29 window (11:30Z-22:00Z) and 10 minutes after the clean snapshot.
const IN_WINDOW = new Date("2026-09-29T12:10:00Z");
const codes = (s: ReturnType<typeof computeHealth>) => s.reasons.map((r) => r.code);

describe("computeHealth", () => {
  it("is GREEN for a clean, fresh snapshot", () => {
    const h = computeHealth(cleanSnapshot(), IN_WINDOW);
    expect(h.level).toBe("green");
    expect(h.reasons).toEqual([]);
    expect(h.freshness.state).toBe("fresh");
  });

  it("is AMBER when there is no snapshot", () => {
    const h = computeHealth(null, IN_WINDOW);
    expect(h.level).toBe("amber");
    expect(codes(h)).toEqual(["no-snapshot"]);
  });

  it("reads the fixture as AMBER with every reason", () => {
    const f = fixture();
    const h = computeHealth(f, new Date("2026-09-29T21:50:00Z"));
    expect(h.level).toBe("amber");
    expect(codes(h)).toEqual(["kill", "job:routine", "swap", "preflight"]);
    expect(h.reasons.find((r) => r.code === "job:routine")?.text).toBe("Pre-market routine failed (exit 1).");
    expect(h.reasons.find((r) => r.code === "preflight")?.text).toMatch(/^5 preflight checks failing: on main, /);
  });

  describe("RED rules", () => {
    it.each(["paper-b:not-flat", "paper-b:unknown-position:QQQM", "paper-b:latched"])("alert %s", (key) => {
      const h = computeHealth(
        cleanSnapshot({ alerts: { firing: [{ key, since: null, title: "Position check" }] } }),
        IN_WINDOW,
      );
      expect(h.level).toBe("red");
      expect(codes(h)).toEqual([`alert:${key}`]);
    });

    it("ignores other alerts for RED", () => {
      const h = computeHealth(
        cleanSnapshot({ alerts: { firing: [{ key: "job:routine", since: null, title: "routine failed" }] } }),
        IN_WINDOW,
      );
      expect(h.level).toBe("green");
    });

    it("trading blocked", () => {
      const s = cleanSnapshot();
      s.ops!.account!.trading_blocked = true;
      expect(computeHealth(s, IN_WINDOW).level).toBe("red");
    });

    it("stopped while in a window", () => {
      const h = computeHealth(cleanSnapshot(), new Date("2026-09-29T13:31:00Z"));
      expect(h.level).toBe("red");
      expect(codes(h)).toEqual(["stopped"]);
    });

    it("lists RED reasons before AMBER ones", () => {
      const s = cleanSnapshot({ kill: { on: true } });
      s.ops!.account!.trading_blocked = true;
      const h = computeHealth(s, IN_WINDOW);
      expect(codes(h)).toEqual(["trading-blocked", "kill"]);
    });
  });

  describe("AMBER rules", () => {
    it("kill switch on", () => {
      expect(codes(computeHealth(cleanSnapshot({ kill: { on: true } }), IN_WINDOW))).toEqual(["kill"]);
    });

    it.each(["failed", "refused", "timeout"])("job status %s", (status) => {
      const s = cleanSnapshot({ jobs: { last: { forward: { status, exit: status === "failed" ? 2 : null } } } });
      const h = computeHealth(s, IN_WINDOW);
      expect(h.level).toBe("amber");
      expect(codes(h)).toEqual(["job:forward"]);
    });

    it("late while in a window", () => {
      const h = computeHealth(cleanSnapshot(), new Date("2026-09-29T12:40:00Z"));
      expect(h.level).toBe("amber");
      expect(codes(h)).toEqual(["late"]);
    });

    it("a stale snapshot outside every window is not a problem (Mac asleep)", () => {
      const h = computeHealth(cleanSnapshot(), new Date("2026-09-30T02:00:00Z"));
      expect(h.level).toBe("green");
      expect(h.freshness.state).toBe("asleep");
    });

    it("collector exit 1", () => {
      expect(codes(computeHealth(cleanSnapshot({ collector: { exit_code: 1 } }), IN_WINDOW))).toEqual(["collector"]);
    });

    it("disk below the floor", () => {
      const s = cleanSnapshot();
      s.ops!.host!.disk_free_gb = 2.9;
      expect(codes(computeHealth(s, IN_WINDOW))).toEqual(["disk"]);
    });

    it("swap at the warning level", () => {
      const s = cleanSnapshot();
      s.ops!.host!.swap = { used_pct: 85 };
      expect(codes(computeHealth(s, IN_WINDOW))).toEqual(["swap"]);
    });

    it("a failing preflight check", () => {
      const s = cleanSnapshot({ preflight: [{ name: "free disk", ok: false, detail: "" }, { name: "x", ok: null }] });
      const h = computeHealth(s, IN_WINDOW);
      expect(codes(h)).toEqual(["preflight"]);
      expect(h.reasons[0]!.text).toBe("1 preflight check failing: free disk.");
    });
  });

  it("never throws on a snapshot with every section missing or null", () => {
    const bare = { schema: null, schema_version: null, run_id: null, as_of: null };
    const h = computeHealth(bare, IN_WINDOW);
    expect(h.level).toBe("green");
    expect(h.freshness.state).toBe("unknown");
    const nulls = {
      ...bare,
      ops: { host: null, account: null },
      jobs: { last: null, runs: null },
      alerts: { firing: [null] },
      preflight: [null],
      expected_windows: null,
    };
    expect(() => computeHealth(nulls, IN_WINDOW)).not.toThrow();
  });
});
