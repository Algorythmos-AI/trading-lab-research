import { describe, expect, it } from "vitest";
import { BOARD_LOG_MAX, type BoardLogEntry, byHour, logKey, logNames, mergeLogs, parseBoardLog, parseSeen, SAME_CHANGE_MS, sameLog, staleLogKeys, unreadCount, withSeen } from "@/lib/board-log";

const line = (at: number, symbol = "QQQ", word = "ENTER ZONE", over: Partial<BoardLogEntry> = {}): BoardLogEntry => ({
  at,
  symbol,
  word,
  side: "call",
  tone: "good",
  kind: "board",
  ...over,
});

describe("the Today log keeps a whole session", () => {
  it("F7: keeps BOARD_LOG_MAX lines (no longer 30), the newest first", () => {
    expect(BOARD_LOG_MAX).toBe(200);
    // 250 changes, the word alternating as a busy name's does
    const many = Array.from({ length: 250 }, (_, i) => line(i, "QQQ", i % 2 ? "GET READY" : "ENTER ZONE"));
    const kept = mergeLogs(many);
    expect(kept).toHaveLength(200);
    expect(kept[0]!.at).toBe(249);
    expect(kept.at(-1)!.at).toBe(50);
    // the 31st change of a session is still there
    expect(mergeLogs(Array.from({ length: 31 }, (_, i) => line(i, "QQQ", i % 2 ? "GET READY" : "ENTER ZONE")))).toHaveLength(31);
  });
});

describe("mergeLogs", () => {
  it("keeps the same line once, however often it is added (a render run twice, two tabs)", () => {
    const a = line(1);
    expect(mergeLogs([a], [a], [{ ...a }])).toEqual([a]);
  });
  it("keeps a board line and a manage line at the same moment apart", () => {
    const a = line(1);
    const m = line(1, "QQQ", "EXIT", { kind: "manage", side: null, tone: "bad" });
    expect(mergeLogs([a], [m])).toHaveLength(2);
  });
  it("two tabs merging the same lines write the same text, in either order", () => {
    const x = [line(5, "QQQ"), line(5, "SPY"), line(3, "AAPL")];
    const y = [line(5, "SPY"), line(4, "TSLA")];
    expect(JSON.stringify(mergeLogs(x, y))).toBe(JSON.stringify(mergeLogs(y, x)));
    expect(sameLog(mergeLogs(x, y), mergeLogs(y, x))).toBe(true);
  });
});

describe("parseBoardLog", () => {
  it("reads a log saved before lines had a kind as board lines", () => {
    const old = { at: 1, symbol: "QQQ", word: "ENTER ZONE", side: "call", tone: "good" };
    expect(parseBoardLog(JSON.stringify([old]))).toEqual([{ ...old, kind: "board" }]);
  });
  it("drops a line with an unknown kind, and anything that is not a log", () => {
    expect(parseBoardLog(JSON.stringify([{ ...line(1), kind: "other" }]))).toEqual([]);
    expect(parseBoardLog("nope")).toEqual([]);
    expect(parseBoardLog(JSON.stringify({}))).toEqual([]);
  });
});

describe("unread", () => {
  it("counts the lines not yet seen in the open log, by the line itself, not by its time", () => {
    const a = line(10), b = line(20, "SPY"), c = line(30, "AAPL");
    const log = mergeLogs([a, b, c]);
    expect(unreadCount(log, new Set())).toBe(3);
    const seen = new Set(withSeen(new Set(), [c, b], log));
    expect(unreadCount(log, seen)).toBe(1);
    // a line that arrives later with an OLDER time (another tab's clock behind) still counts as new
    const late = line(5, "TSLA");
    expect(unreadCount(mergeLogs(log, [late]), seen)).toBe(2);
  });
  it("reads the stored keys, or none, and keeps only keys still in the log", () => {
    expect(parseSeen(JSON.stringify(["k1", 3, "k2"]))).toEqual(new Set(["k1", "k2"]));
    expect(parseSeen("")).toEqual(new Set());
    expect(parseSeen(null)).toEqual(new Set());
    expect(parseSeen("soon")).toEqual(new Set());
    const log = mergeLogs([line(1)]);
    expect(withSeen(new Set(["gone"]), log, log)).toEqual([logKey(log[0]!)]);
  });
});

describe("one change seen by two tabs", () => {
  it("is logged once: the same word for the same name within a minute is the same change", () => {
    const tabA = [line(100_000), line(160_000, "QQQ", "GET READY", { tone: "info" })];
    const tabB = [line(103_000)]; // tab B polled 3 s later
    const merged = mergeLogs(tabA, tabB);
    expect(merged.map((e) => [e.at, e.word])).toEqual([
      [160_000, "GET READY"],
      [100_000, "ENTER ZONE"],
    ]);
    // either order of merging gives the same log
    expect(sameLog(mergeLogs(tabB, tabA), merged)).toBe(true);
  });
  it("keeps a real second entry: a different word came between, or more than a minute passed", () => {
    const back = [line(0), line(20_000, "QQQ", "GET READY", { tone: "info" }), line(40_000)];
    expect(mergeLogs(back)).toHaveLength(3);
    expect(mergeLogs([line(0), line(SAME_CHANGE_MS + 1)])).toHaveLength(2);
  });
  it("keeps two trades on one name apart, and a board line apart from a manage line", () => {
    const exitA = line(1, "QQQ", "EXIT", { kind: "manage", ref: "t1", side: "call", tone: "bad" });
    const exitB = line(1, "QQQ", "EXIT", { kind: "manage", ref: "t2", side: "put", tone: "bad" });
    expect(mergeLogs([exitA, exitB, line(1)])).toHaveLength(3);
  });
});

describe("old sessions' logs", () => {
  it("are listed for removal; today's and other stores are kept", () => {
    const keys = ["trade-now-log:2026-11-17", "trade-now-log-seen:2026-11-17", "trade-now-log:2026-11-18", "trade-now-log-seen:2026-11-18", "trade-now-alerts", "options-cockpit"];
    expect(staleLogKeys(keys, "2026-11-18")).toEqual(["trade-now-log:2026-11-17", "trade-now-log-seen:2026-11-17"]);
  });
});

describe("byHour and logNames", () => {
  it("groups the newest first by hour, and lists the names as they first appear", () => {
    const hour = (at: number) => `${Math.floor(at / 60)}:00`;
    const log = mergeLogs([line(125, "QQQ"), line(130, "SPY"), line(61, "QQQ", "GET READY"), line(10, "AAPL")]);
    expect(byHour(log, hour).map((g) => [g.hour, g.lines.length])).toEqual([
      ["2:00", 2],
      ["1:00", 1],
      ["0:00", 1],
    ]);
    expect(logNames(log)).toEqual(["SPY", "QQQ", "AAPL"]);
  });
});
