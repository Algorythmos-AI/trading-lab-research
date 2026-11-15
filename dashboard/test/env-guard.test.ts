// The evidence-class guard (test/env-guard.ts): every rendered money figure sits in an EnvFrame of its own class, and
// a page shows only the classes it allows. Page tests (B2) call assertOnlyEnvs on each page.
import { createElement as h, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnvChip, EnvFrame } from "@/components/ui/env-chip";
import { Money } from "@/components/ui/money";
import { ENVS, type Env } from "@/lib/env";
import { assertOnlyEnvs, envViolations } from "./env-guard";

const frame = (env: Env, ...children: (ReactElement | string)[]) => h(EnvFrame, { env }, ...children);
const money = (env: Env, value = 1) => h(Money, { env, value });
const kinds = (tree: Parameters<typeof envViolations>[0], allowed?: readonly Env[]) =>
  envViolations(tree, allowed).map((v) => v.kind);

describe("the evidence-class guard", () => {
  it("passes money in a frame of its own class, and returns the classes it found", () => {
    const page = h(
      "main",
      null,
      frame("real", h("p", null, "Balance ", money("real", 1200))),
      frame("paper", h("table", null, h("tbody", null, h("tr", null, h("td", null, money("paper", -3)))))),
    );
    expect(envViolations(page)).toEqual([]);
    expect(assertOnlyEnvs(page, ["real", "paper"])).toEqual(new Set(["real", "paper"]));
  });

  it("passes every class in its own frame", () => {
    const page = h("div", null, ...ENVS.map((e) => frame(e, money(e))));
    expect(assertOnlyEnvs(page, ENVS)).toEqual(new Set(ENVS));
  });

  it("catches money outside any frame", () => {
    expect(kinds(h("div", null, money("real")))).toEqual(["unframed"]);
    expect(() => assertOnlyEnvs(h("div", null, money("paper")), ["paper"])).toThrow(/unframed: money figure #1 \(paper\) is not inside an EnvFrame/);
  });

  it("catches money in a frame of another class: paper money shown as real", () => {
    expect(kinds(frame("real", money("paper")))).toEqual(["mismatch"]);
    expect(() => assertOnlyEnvs(frame("paper", money("real")), ["paper", "real"])).toThrow(/mismatch: money figure #1 \(real\) sits in a paper frame/);
  });

  it("reads the nearest frame when frames nest", () => {
    expect(kinds(frame("real", frame("paper", money("paper"))))).toEqual([]);
    expect(kinds(frame("real", frame("paper", money("real"))))).toEqual(["mismatch"]);
    // Out of the inner frame again, the outer one holds.
    expect(kinds(frame("real", frame("paper", money("paper")), money("real")))).toEqual([]);
    expect(kinds(frame("real", frame("paper", "x"), money("paper")))).toEqual(["mismatch"]);
  });

  it("catches a chip of another class inside a frame: a REAL chip beside paper money", () => {
    const page = h(EnvFrame, { env: "paper", chip: false }, h(EnvChip, { env: "real" }), money("paper"));
    expect(envViolations(page)).toEqual([{ kind: "mismatch", detail: "<span> names real inside a paper frame" }]);
    // A chip outside every frame, in a heading, is fine.
    expect(kinds(h("div", null, h("h2", null, "Positions ", h(EnvChip, { env: "paper" })), frame("paper", money("paper"))))).toEqual([]);
  });

  it("lets a frame nest only in a real frame or the page, never in another non-real one", () => {
    expect(kinds(frame("real", frame("paper", money("paper")), frame("model", money("model"))))).toEqual([]);
    expect(kinds(frame("paper", h(EnvFrame, { env: "real", chip: false }, money("real"))))).toEqual(["nested"]);
    expect(kinds(frame("paper", frame("shadow", money("shadow"))))).toEqual(["nested"]);
    expect(kinds(frame("paper", frame("paper", money("paper"))))).toEqual([]);
  });

  it("counts money after its frame has closed as unframed", () => {
    expect(kinds(h("div", null, frame("paper", money("paper")), money("paper")))).toEqual(["unframed"]);
  });

  it("is not thrown off by void and self-closing elements", () => {
    const page = frame("shadow", h("img", { alt: "", src: "x.png" }), h("br"), h("input", { readOnly: true }), h("span", null, money("shadow")));
    expect(kinds(page)).toEqual([]);
    expect(kinds(h("div", null, h("hr"), frame("model", h("br")), money("model")))).toEqual(["unframed"]);
  });

  it("reports a class the page does not allow, on a frame, a chip or a figure", () => {
    expect(kinds(frame("shadow", money("shadow")), ["paper"])).toEqual(["not-allowed", "not-allowed", "not-allowed"]);
    expect(kinds(h("div", null, h(EnvChip, { env: "model" })), ["real"])).toEqual(["not-allowed"]);
    expect(() => assertOnlyEnvs(frame("real", money("real")), [])).toThrow(/this page allows none/);
  });

  it("reports a data-env that is not a class, and money with no class", () => {
    expect(kinds('<div data-env-frame="" data-env="live"><span data-money="" data-env="live">1</span></div>')).toEqual(["unknown", "unknown"]);
    expect(kinds('<div data-env-frame="" data-env="paper"><span data-money="">1</span></div>')).toEqual(["unknown"]);
  });

  it("reads markup with React's comment markers and escaped text (renderToString)", () => {
    const page = frame("paper", h("p", null, "a > b", " ", money("paper", 2), "<c>", "</p>"), h("p", { title: 'x">y' }, money("paper", 3)));
    const html = renderToString(page);
    expect(html).toContain("<!-- -->");
    expect(envViolations(html, ["paper"])).toEqual([]);
    expect(kinds(html.replace('data-env="paper" class="tabular-nums">US$3', 'data-env="real" class="tabular-nums">US$3'), ["paper", "real"])).toEqual(["mismatch"]);
  });

  it("skips the text of <style> and <script>: a closing tag in there closes nothing", () => {
    const css = h("style", { dangerouslySetInnerHTML: { __html: ".a::after{content:'</div>'}</div>" } });
    const js = h("script", { dangerouslySetInnerHTML: { __html: "var s='</div><span data-money=\"\">';" } });
    expect(kinds(frame("paper", css, js, money("paper")))).toEqual([]);
    expect(kinds(h("div", null, h("style", { dangerouslySetInnerHTML: { __html: "x" } }), money("real")))).toEqual(["unframed"]);
  });

  it("reports injected markup that holds a frame open or hides what follows", () => {
    // An unclosed <div> inside the frame: the frame's own </div> closes it, and the paper money after reads as framed.
    const open = h("div", null, frame("paper", h("div", { dangerouslySetInnerHTML: { __html: "<div>" } })), money("paper"));
    expect(kinds(open)).toEqual(["malformed"]);
    expect(() => assertOnlyEnvs(open, ["paper"])).toThrow(/malformed: <div>.* never closes/);
    // A comment that never ends hides the unframed real money after it.
    const hidden = h("div", null, h("i", { dangerouslySetInnerHTML: { __html: "<!--" } }), money("real"));
    expect(envViolations(hidden).map((v) => v.detail)).toEqual([
      "a comment never ends: everything after it is hidden",
      "<div> never closes",
      "<i> never closes",
    ]);
    // A stray closing tag.
    expect(kinds('<div data-env-frame="" data-env="paper"><span></div></span>')).toEqual(["malformed", "malformed"]);
    expect(kinds('<div data-env-frame="" data-env="paper"><style>x')).toEqual(["malformed", "malformed"]);
  });

  it("lists every breach in one error", () => {
    const page = h("div", null, money("real"), frame("paper", money("shadow")));
    expect(() => assertOnlyEnvs(page, ["real", "paper", "shadow"])).toThrow(/2 breach\(es\)\n {2}unframed: .*\n {2}mismatch: /);
  });
});
