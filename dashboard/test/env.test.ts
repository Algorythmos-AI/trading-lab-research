// The evidence-class primitives (lib/env.ts, components/ui/env-chip.tsx, components/ui/money.tsx): the four classes,
// their chips, the frame around a non-real region, and the money figure that always names its class.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnvChip, EnvFrame } from "@/components/ui/env-chip";
import { Money } from "@/components/ui/money";
import { ENV_META, ENVS, envMeta, isEnv, UNKNOWN_META, type Env } from "@/lib/env";
import { DASH, usd } from "@/lib/format";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const render = (el: ReactElement) => renderToStaticMarkup(el);

describe("the evidence classes", () => {
  it("are real, paper, shadow and model, with the agreed chip text", () => {
    expect(ENVS).toEqual(["real", "paper", "shadow", "model"]);
    expect(Object.fromEntries(ENVS.map((e) => [e, ENV_META[e].chip]))).toEqual({
      real: "REAL · WEBULL",
      paper: "PAPER · ALPACA",
      shadow: "SHADOW · SIM",
      model: "MODEL · BACKTEST",
    });
  });

  it("each have their own border style, so colour is never the only signal", () => {
    const borders = ENVS.map((e) => ENV_META[e].border);
    expect(new Set(borders).size).toBe(ENVS.length);
    for (const e of ENVS) {
      const m = ENV_META[e];
      expect(m.chipClass).toContain(`border-${m.border}`);
      if (e === "real") expect(m.frameClass).toBe("");
      else expect(m.frameClass).toContain(`border-${m.border}`);
    }
  });

  it("each have a name and a description", () => {
    for (const e of ENVS) {
      expect(ENV_META[e].name.length).toBeGreaterThan(0);
      expect(ENV_META[e].description).toMatch(/\.$/);
    }
    expect(ENV_META.real.description).toMatch(/real money/i);
    for (const e of ["paper", "shadow", "model"] as const) expect(ENV_META[e].description).toMatch(/not the owner's|no money/);
  });

  it("isEnv accepts the four classes only, and envMeta falls back to SOURCE UNKNOWN", () => {
    for (const e of ENVS) expect(isEnv(e)).toBe(true);
    for (const e of ENVS) expect(envMeta(e)).toBe(ENV_META[e]);
    for (const v of ["live", "REAL", "", null, undefined, 1, {}, "toString", "__proto__"]) {
      expect(isEnv(v)).toBe(false);
      expect(envMeta(v)).toBe(UNKNOWN_META);
    }
  });
});

describe("EnvChip", () => {
  it.each(ENVS)("shows the %s chip with its class, text and tooltip", (env) => {
    const html = render(createElement(EnvChip, { env }));
    expect(text(html)).toBe(ENV_META[env].chip);
    expect(html).toContain(`data-env="${env}"`);
    expect(html).toContain('data-slot="env-chip"');
    expect(html).toContain(`title="${ENV_META[env].description.replace(/'/g, "&#x27;")}"`);
    expect(html).toContain(`border-${ENV_META[env].border}`);
  });
});

describe("EnvFrame", () => {
  it.each(ENVS)("marks a %s region with data-env, a group role and the chip", (env) => {
    const html = render(createElement(EnvFrame, { env }, "inside"));
    expect(html).toMatch(new RegExp(`^<div role="group" aria-label="${ENV_META[env].name.replace(/[()]/g, "\\$&")}" data-env-frame="" data-env="${env}"`));
    expect(text(html)).toBe(`${ENV_META[env].chip} inside`);
  });

  it("frames every class but real, on the wrapper itself", () => {
    const wrapperClass = (env: Env) => /^<div[^>]* class="([^"]*)"/.exec(render(createElement(EnvFrame, { env, chip: false }, "x")))?.[1] ?? "";
    expect(wrapperClass("real")).toBe("");
    for (const env of ["paper", "shadow", "model"] as const) {
      const cls = wrapperClass(env).split(" ");
      for (const c of ENV_META[env].frameClass.split(" ")) expect(cls).toContain(c);
      expect(cls).toContain(`border-${ENV_META[env].border}`);
      expect(cls).toContain("p-2");
    }
  });

  it("leaves the chip out on request, names the region after its class, and keeps the caller's layout", () => {
    const html = render(createElement(EnvFrame, { env: "paper", chip: false, label: "Positions", className: "mt-3", id: "pp" }, "x"));
    expect(html).not.toContain("env-chip");
    expect(text(html)).toBe("x");
    expect(html).toContain('aria-label="Paper account (Alpaca): Positions"');
    expect(html).toContain('id="pp"');
    expect(html).toContain("mt-3");
  });

  it("cannot be talked out of its frame by classes", () => {
    const html = render(createElement(EnvFrame, { env: "paper", className: "border-0 border-solid p-0 rounded-none mt-3" }, "x"));
    const cls = /^<div[^>]* class="([^"]*)"/.exec(html)![1]!.split(" ");
    for (const c of [...ENV_META.paper.frameClass.split(" "), "p-2", "mt-3"]) expect(cls).toContain(c);
    for (const c of ["border-0", "border-solid", "p-0", "rounded-none"]) expect(cls).not.toContain(c);
    const chip = render(createElement(EnvChip, { env: "paper", className: "border-solid border-foreground mb-1" }));
    expect(chip).toContain("border-dashed");
    expect(chip).not.toMatch(/border-solid|border-foreground/);
    expect(chip).toContain("mb-1");
  });

  it("does not let a cast change its data-env, role, style or accessible name", () => {
    const props = {
      env: "paper",
      "data-env": "real",
      "data-env-frame": "no",
      role: "none",
      style: { border: "none" },
      "aria-label": "Real money (Webull)",
      "aria-labelledby": "elsewhere",
    } as unknown as Parameters<typeof EnvFrame>[0];
    const html = render(createElement(EnvFrame, props, "x"));
    expect(html).toContain('data-env="paper"');
    expect(html).toContain('data-env-frame=""');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Paper account (Alpaca)"');
    expect(html).not.toMatch(/style=|aria-labelledby|role="none"|Real money/);
  });

  it("fails closed on a class a cast let through: a red SOURCE UNKNOWN frame", () => {
    const html = render(createElement(EnvFrame, { env: "live" as unknown as Env }, "x"));
    expect(html).toContain('data-env="unknown"');
    expect(text(html)).toBe(`${UNKNOWN_META.chip} x`);
    expect(html).toContain("border-bad");
    expect(render(createElement(EnvChip, { env: undefined as unknown as Env }))).toContain('data-env="unknown"');
  });
});

describe("Money", () => {
  const shown = (value: number | null | undefined, signed = false, env: Env = "paper") =>
    text(render(createElement(Money, { env, value, signed })));

  it("formats through lib/format.ts's usd", () => {
    for (const v of [0, 1, 1234.5, -12, 1_000_000.004]) expect(shown(v)).toBe(usd(v));
    expect(shown(1234.5)).toBe("US$1,234.50");
    expect(shown(-12)).toBe("−US$12.00");
  });

  it("shows a dash for a missing figure", () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(shown(v)).toBe(DASH);
      expect(shown(v, true)).toBe(DASH);
    }
  });

  it("adds a plus to a gain when signed, and never signs a figure that rounds to zero", () => {
    expect(shown(42.1, true)).toBe("+US$42.10");
    expect(shown(-42.1, true)).toBe("−US$42.10");
    expect(shown(0, true)).toBe("US$0.00");
    expect(shown(0.001, true)).toBe("US$0.00");
    expect(shown(-0.001)).toBe("US$0.00");
    expect(shown(-0.001, true)).toBe("US$0.00");
  });

  it.each(ENVS)("renders data-money and data-env=%s", (env) => {
    const html = render(createElement(Money, { env, value: 5 }));
    expect(html).toBe(`<span data-money="" data-env="${env}" class="tabular-nums">US$5.00</span>`);
  });

  it("fails closed on a class a cast let through: a dash, marked unknown", () => {
    for (const env of ["live", undefined, "REAL"]) {
      const html = render(createElement(Money, { env: env as unknown as Env, value: 1200 }));
      expect(html).toBe(`<span data-money="" data-env="unknown" class="tabular-nums">${DASH}</span>`);
    }
  });

  it("will not type-check without an env", () => {
    // @ts-expect-error: env is required, so a money figure always names its class.
    const el = createElement(Money, { value: 1 });
    expect(el).toBeTruthy();
    // @ts-expect-error: and it must be one of the four classes.
    expect(createElement(Money, { env: "live", value: 1 })).toBeTruthy();
  });
});
