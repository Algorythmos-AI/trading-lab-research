// signal-params.ts: the signal's candidate numbers, pinned by their hash, and the same numbers as EXP-0034's
// config.yaml `parameters` when that file is on this branch.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FROZEN_PARAMS_HASH } from "@/lib/signal-freeze";
import { canonicalJson, hashedParams, paramsHash, SIGNAL_PARAMS } from "@/lib/signal-params";

const CONFIG = fileURLToPath(new URL("../../research/experiments/EXP-0034-desk-signal-gates/config.yaml", import.meta.url));

/**
 * The `parameters:` block of the config, its top-level keys only: plain numbers and strings, and a folded (`>-`)
 * string joined the way YAML folds it. Enough for this one block; not a YAML reader.
 */
function parametersBlock(text: string): Record<string, string | number> {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^parameters:/.test(l));
  if (start < 0) throw new Error("no parameters block");
  const out: Record<string, string | number> = {};
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]!); i++) {
    const m = /^ {2}([a-z_]+):\s*(.*?)\s*(?:#.*)?$/.exec(lines[i]!);
    if (!m) continue;
    const [, key, raw] = m;
    if (raw === ">-") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^ {4}\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      out[key!] = parts.join(" ");
    } else if (raw !== "") out[key!] = /^-?\d+(\.\d+)?$/.test(raw!) ? Number(raw) : raw!;
  }
  return out;
}

describe("the signal's numbers", () => {
  it("are the candidates, not frozen: status candidate, and no frozen hash until Amendment 1", () => {
    expect(SIGNAL_PARAMS.status).toBe("candidate");
    expect(FROZEN_PARAMS_HASH).toBeNull();
  });

  it("hash to a pinned value: any change to a number is a visible diff here", () => {
    expect(canonicalJson(hashedParams())).toBe(
      '{"contract_min_volume":100,"contract_quote_max_age_s":10,"contract_quote_stamp_max_age_s":60,"contract_spread_share_of_stop":0.2,"event_window_after_min":30,"event_window_before_min":30,"expiry_rule":{"max_sessions":5,"min_sessions":1},"shock_range_multiple":3,"stock_spread_max_bps":5,"volume_min_ratio":1.5}',
    );
    expect(paramsHash()).toBe("f0f2b40663aeead4fced5e2ac84a4564f3571d2b620497b2a67ff6da1323dc59");
  });

  it("the hash leaves out the status, and moves with any number or key order-free", () => {
    expect(paramsHash({ ...SIGNAL_PARAMS, status: "frozen" })).toBe(paramsHash());
    expect(paramsHash({ ...SIGNAL_PARAMS, volume_min_ratio: 1.6 })).not.toBe(paramsHash());
    const reordered = Object.fromEntries(Object.entries(SIGNAL_PARAMS).reverse()) as unknown as typeof SIGNAL_PARAMS;
    expect(paramsHash(reordered)).toBe(paramsHash());
  });

  it("covers numbers and rule identifiers only: a wording edit keeps the hash, a number edit changes it", () => {
    const reworded = { ...SIGNAL_PARAMS, expiry_rule: { ...SIGNAL_PARAMS.expiry_rule, words: "other words" } };
    expect(paramsHash(reworded)).toBe(paramsHash());
    expect(paramsHash({ ...SIGNAL_PARAMS, expiry_rule: { ...SIGNAL_PARAMS.expiry_rule, max_sessions: 4 } })).not.toBe(paramsHash());
    expect(paramsHash({ ...SIGNAL_PARAMS, contract_quote_stamp_max_age_s: 61 })).not.toBe(paramsHash());
  });

  it("the quote-stamp limit is a candidate the record does not hold yet: 60 s", () => {
    expect(SIGNAL_PARAMS.contract_quote_stamp_max_age_s).toBe(60);
  });

  it("the bid–ask share is whole hundredths, so the contract check's edge is exact", () => {
    expect(Number.isInteger(Math.round(SIGNAL_PARAMS.contract_spread_share_of_stop * 100))).toBe(true);
    expect(Math.abs(SIGNAL_PARAMS.contract_spread_share_of_stop * 100 - Math.round(SIGNAL_PARAMS.contract_spread_share_of_stop * 100))).toBeLessThan(1e-9);
  });

  it.skipIf(!existsSync(CONFIG))(
    "agree with EXP-0034's config.yaml parameters (skipped while the record's pull request is not merged into this branch; enforced once it is)",
    () => {
      const p = parametersBlock(readFileSync(CONFIG, "utf8"));
      expect(p.status).toBe(SIGNAL_PARAMS.status);
      for (const k of [
        "volume_min_ratio",
        "stock_spread_max_bps",
        "shock_range_multiple",
        "event_window_before_min",
        "event_window_after_min",
        "contract_spread_share_of_stop",
        "contract_quote_max_age_s",
        "contract_min_volume",
      ] as const)
        expect([k, p[k]]).toEqual([k, SIGNAL_PARAMS[k]]);
      expect(String(p.expiry_rule).endsWith(SIGNAL_PARAMS.expiry_rule.words)).toBe(true);
    },
  );

  it("the config reader folds a `>-` string and stops at the next top-level key", () => {
    const text = ["x: 1", "parameters:", "  status: candidate", "  a: 1.5   # note", "  rule: >-", "    one two", "    three", "  grid:", "    a: [1, 2, 0.1]", "log:", "  b: 2"].join("\n");
    expect(parametersBlock(text)).toEqual({ status: "candidate", a: 1.5, rule: "one two three" });
  });
});
