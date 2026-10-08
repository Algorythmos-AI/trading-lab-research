// The crypto desk's model (DEC-0016) as the pages read it, from the crypto snapshot's `learning`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Crypto } from "@/lib/crypto";
import { inputLabel, isLearningAlert, kindLabel, learning, learningAlertLabel, learningLine, lineageLabel, modelLabel, modelRoad } from "@/lib/learning";

const fixture = (): Crypto => JSON.parse(readFileSync(new URL("./fixtures/crypto.v1.json", import.meta.url), "utf8")) as Crypto;

describe("the crypto model", () => {
  it("shows the model in force, its state and the tests it has faced", () => {
    const l = learning(fixture());
    expect(l.available).toBe(true);
    expect(l.switchOn).toBe(true);
    expect(l.lineagesStarted).toBe(2);
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

  it("places the model on the road from training to acting", () => {
    const f = fixture();
    const states = (c: Crypto) => modelRoad(learning(c)).map((x) => x.state);
    expect(states(f)).toEqual(["done", "done", "current", "todo", "todo"]);
    const none = { ...f, learning: { ...f.learning, model: null, training: { ...f.learning!.training, chosen: null } } } as Crypto;
    expect(states(none)).toEqual(["done", "failed", "todo", "todo", "todo"]);
    const fresh = { ...f, learning: { switch: "on", model: null, training: null, signals: null } } as Crypto;
    expect(states(fresh)).toEqual(["current", "todo", "todo", "todo", "todo"]);
    const inState = (state: string) => ({ ...f, learning: { ...f.learning, model: { ...f.learning!.model, state } } }) as Crypto;
    expect(states(inState("acting"))).toEqual(["done", "done", "done", "done", "current"]);
    expect(modelRoad(learning(inState("demoted"))).at(-1)).toEqual({ key: "acting", label: "Demoted", state: "failed" });
    expect(modelRoad(learning(inState("suspended"))).at(-1)).toEqual({ key: "acting", label: "Suspended", state: "paused" });
  });

  it("measures each model's forecast error against the baseline, and knows the model's own alerts", () => {
    const lines = learning(fixture()).training!.lines;
    expect(lines.map((x) => (x.logLossDelta === null ? null : Number(x.logLossDelta.toFixed(4))))).toEqual([null, -0.0046, 0.0163]);
    expect(isLearningAlert("crypto:scorer-failed")).toBe(true);
    expect(isLearningAlert("crypto:model-demoted")).toBe(true);
    expect(isLearningAlert("crypto:stale-bars")).toBe(false);
    expect(learningAlertLabel("crypto:learn-train-failed")).toBe("The weekly training failed");
    expect(learningAlertLabel("crypto:model-returned")).toBe("crypto:model-returned");
  });

  it("reads the model's card, its scores and its history, and says what is only planned", () => {
    const l = learning(fixture());
    const m = l.model!;
    expect(l.detailed).toBe(true);
    expect([kindLabel(m.kind), m.inputs, m.cutoff, m.halfBelow, m.calibA, m.ageDays]).toEqual(["Logistic regression", 3, 0.31, 0.36, 0.94, 7]);
    expect(m.leansOn).toHaveLength(6);
    expect(m.bySleeve.map((x) => [x.label, x.n])).toEqual([["Breakout", 3644], ["Dip", 1127], ["Trend", 4102]]);
    expect([l.limits.driftPsi, l.limits.driftInputs, l.limits.maxAgeDays]).toEqual([0.25, 3, 14]);
    expect(l.scores!.total).toBe(6);
    expect(l.scores!.bins.map((b) => [b.kept, b.halved, b.skipped])).toEqual([[0, 0, 1], [0, 0, 1], [0, 1, 0], [1, 0, 0], [2, 0, 0]]);
    expect(l.series.map((x) => x.n)).toEqual([1, 2, 3, 4, 5]);
    expect(l.series.at(-1)).toMatchObject({ kept: 2.9, skipped: -0.4 });
    expect(l.events.map((e) => [e.event, e.label])).toEqual([
      ["checkpoint", "Tested: not passed"],
      ["lineage", "A new model entered shadow"],
    ]);
    expect(l.lineages.map((x) => [x.label, x.stateLabel, x.inForce])).toEqual([
      ["Logistic regression (C=0.1)", "In shadow", true],
      ["Gradient-boosted trees (n_estimators=100, num_leaves=4)", "In shadow", false],
    ]);
    expect(l.registry.map((x) => [x.version, x.inForce])).toEqual([["m1-20260925-fixture0", true], ["m2-20260918-fixture9", false]]);
    expect(l.planned.map((x) => x.name)).toEqual(["forecaster", "m3", "regime"]);
    expect(l.training!.lines[1]!.logLossSe).toBe(0.0225);
    expect(l.training!.dataHash).toBe("fixture0c0ffee00");
    expect(lineageLabel(null)).toBe("—");
  });

  it("still reads a host that publishes only the first version of the section", () => {
    const f = fixture();
    const { limits: _l, scores: _s, series: _r, events: _e, lineages: _n, registry: _g, planned: _p, ...old } = f.learning!;
    void [_l, _s, _r, _e, _n, _g, _p];
    const l = learning({ ...f, learning: old } as Crypto);
    expect([l.detailed, l.scores, l.series, l.events, l.lineages, l.registry, l.planned]).toEqual([false, null, [], [], [], [], []]);
    expect(l.limits.driftPsi).toBeNull();
    expect(l.model!.lineage).toBe("m1:C=0.1");
  });
});
