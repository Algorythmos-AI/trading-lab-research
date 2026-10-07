// The crypto desk's model (DEC-0016) as the pages read it, from the crypto snapshot's `learning`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Crypto } from "@/lib/crypto";
import { inputLabel, learning, learningLine, modelLabel } from "@/lib/learning";

const fixture = (): Crypto => JSON.parse(readFileSync(new URL("./fixtures/crypto.v1.json", import.meta.url), "utf8")) as Crypto;

describe("the crypto model", () => {
  it("shows the model in force, its state and the tests it has faced", () => {
    const l = learning(fixture());
    expect(l.available).toBe(true);
    expect(l.switchOn).toBe(true);
    const m = l.model!;
    expect([m.lineage, m.state, m.stateLabel, m.tone]).toEqual(["m1:C=0.1", "shadow", "In shadow", "info"]);
    expect([m.finished, m.nextCheckpoint, m.checkpoints, m.maxCheckpoints]).toEqual([74, 120, 1, 6]);
    expect(m.looks).toHaveLength(1);
    expect([m.looks[0]!.passed, m.looks[0]!.signals, m.looks[0]!.lower]).toEqual([false, 60, -0.318]);
    expect(m.drifted).toBe(false);
    expect(learningLine(l)).toBe("Logistic regression is in shadow. Next test in 46 finished signals.");
  });

  it("compares every model with taking every signal and marks the one chosen", () => {
    const t = learning(fixture()).training!;
    expect(t.lines.map((x) => [x.name, x.label, x.chosen, x.beatsBaseline])).toEqual([
      ["m0", "Take every signal", false, false],
      ["m1", "Logistic regression", true, true],
      ["m2", "Gradient-boosted trees", false, false],
    ]);
    expect([t.examples, t.pairs, t.attempt]).toEqual([8873, 30, 3]);
    expect(t.leansOn[0]).toEqual({ input: "btc_above_sma50", label: "Bitcoin above its 50-day average", weight: 0.31 });
    expect(inputLabel("something_new")).toBe("something_new");
    expect(modelLabel("m9")).toBe("m9");
  });

  it("counts the desk's own signals and how the model's picks have done", () => {
    const g = learning(fixture()).signals;
    expect([g.recorded, g.finished, g.open, g.scored, g.kept, g.skipped]).toEqual([6, 5, 1, 5, 3, 2]);
    expect(g.keptMeanR).toBeGreaterThan(g.skippedMeanR!);
  });

  it("says plainly when no model is in force, when learning is off, and before the host publishes", () => {
    const f = fixture();
    const none = learning({ ...f, learning: { ...f.learning, model: null, training: { ...f.learning!.training, chosen: null } } } as Crypto);
    expect(none.model).toBeNull();
    expect(none.training!.lines.every((x) => !x.chosen)).toBe(true);
    expect(learningLine(none)).toBe("No model is in force: at the last training none beat taking every signal.");
    const fresh = learning({ ...f, learning: { switch: "on", model: null, training: null, signals: null } } as Crypto);
    expect(learningLine(fresh)).toBe("No model has been trained on this host yet.");
    expect(fresh.signals.recorded).toBe(0);
    const off = learning({ ...f, learning: { ...f.learning, switch: "off" } } as Crypto);
    expect(learningLine(off)).toBe("Learning is switched off: no model scores or acts.");
    const spent = learning({ ...f, learning: { ...f.learning, model: { ...f.learning!.model, checkpoints: 6 } } } as Crypto);
    expect(learningLine(spent)).toBe("Logistic regression is in shadow. It has used all its checkpoints.");
    const older = learning({ ...f, learning: undefined } as Crypto);
    expect([older.available, older.model, older.training]).toEqual([false, null, null]);
    expect(learningLine(older)).toBe("The model has not published yet.");
  });
});
