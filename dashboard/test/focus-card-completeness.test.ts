// The focus card's completeness rule: every number a decision needs is on the card's face, never only in a fold, a
// tooltip or a screen-reader line. Both triggers, and each side's entry, stop and first target, appear to 2 decimals
// in visible text; the no-trade box and the live note sit on the ladder, outside any fold; the expiry caution is on
// the face. Only explanations fold. (A .ts file: vitest reads test/**/*.test.ts only.)
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FocusStrip } from "@/components/options-focus";
import { focusOptions } from "@/lib/fixture-variants";
import { focusPlan } from "@/lib/focus-plan";
import type { Options } from "@/lib/options";
import optionsJson from "./fixtures/options.v1.json";

const v1 = optionsJson as unknown as Options;

/** The fixture's focus plus a name without an ATR (no entry, stop or target: only its triggers) and a MWF-only name. */
function mixed(): Options {
  const e = focusOptions(v1);
  e.session = "2026-10-27"; // a Tuesday: no AVGO expiry today
  const t = e.tickers.find((x) => !e.focus!.items.some((i) => i.symbol === x.symbol) && x.last?.close)!;
  const c = t.last!.close!;
  e.focus!.items.push({ symbol: t.symbol, rank: 9, bias: "range", breakout_above: Math.round(c * 1.01 * 100) / 100, hold_above: Math.round(c * 0.99 * 100) / 100 });
  e.focus!.items.push({ symbol: "AVGO", rank: 10, bias: "breakout", resistance: { price: 401.25, name: "PDH" }, support: { price: 392.4, name: "PDL" }, atr: 6.2 });
  return e;
}

const EDITIONS: [string, Options][] = [
  ["the fixture's focus", focusOptions(v1)],
  ["the scripted morning's focus", focusOptions(v1, true)],
  ["a focus with a name without an ATR and a MWF-only name", mixed()],
];

/** The end of the element whose open tag starts at `start`: its matching close tag, counting nested same-name tags. */
function elementEnd(html: string, start: number): number {
  const tag = /^<([a-zA-Z][\w-]*)/.exec(html.slice(start))![1]!;
  const re = new RegExp(`<${tag}(?=[\\s>/])|</${tag}>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return html.length;
}

/** The markup without every element whose open tag matches `open` (a regex for the open tag), nested ones included. */
function without(html: string, open: RegExp): string {
  let out = html;
  for (let m = open.exec(out); m; m = open.exec(out)) out = out.slice(0, m.index) + out.slice(elementEnd(out, m.index));
  return out;
}

/**
 * What a sighted reader sees without opening anything: no folds (details), no screen-reader-only or invisible
 * elements, no SVG titles, and no attributes (title, aria-label). Then the text alone.
 */
function face(html: string): string {
  let h = without(html, /<details[\s>]/);
  h = without(h, /<[a-z]+ [^>]*class="[^"]*\b(?:sr-only|invisible)\b[^"]*"[^>]*>/);
  h = without(h, /<title>/);
  return h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** One card's markup: from its own id to the next card's. */
function cards(html: string): Map<string, string> {
  const at = [...html.matchAll(/<li id="focus-card-([A-Z.]+)"/g)];
  return new Map(at.map((m, k) => [m[1]!, html.slice(m.index, k + 1 < at.length ? at[k + 1]!.index : html.length)]));
}

const p2 = (v: number) => v.toFixed(2);

for (const [name, e] of EDITIONS)
  describe(`focus card completeness: ${name}`, () => {
    const html = renderToStaticMarkup(createElement(FocusStrip, { e }));
    const byCard = cards(html);
    const items = e.focus!.items;

    it("draws a card for every focus name", () => {
      expect([...byCard.keys()].sort()).toEqual(items.map((i) => i.symbol).sort());
    });

    for (const item of items) {
      const plan = focusPlan(item);
      const card = () => byCard.get(item.symbol)!;

      it(`${item.symbol}: both triggers, and each side's entry, stop and T1, are on the card's face`, () => {
        const text = face(card());
        const prices = [plan.call, plan.put].flatMap((s) => (s ? [s.level, s.entry, s.stop, s.target1] : [])).filter((v): v is number => v != null);
        expect(prices.length).toBeGreaterThan(0);
        for (const v of prices) expect(text, `${item.symbol} ${p2(v)}`).toContain(p2(v));
      });

      it(`${item.symbol}: each side's numbers sit in its own strip, outside any fold`, () => {
        for (const s of [plan.call, plan.put]) {
          if (!s) continue;
          const at = card().indexOf(`data-strip="${s.side}"`);
          expect(at).toBeGreaterThan(-1);
          const open = card().lastIndexOf("<section", at);
          const strip = card().slice(open, elementEnd(card(), open));
          expect(strip).not.toContain("<details");
          const text = face(strip);
          expect(text).toContain(p2(s.level));
          for (const v of [s.entry, s.stop, s.target1]) if (v != null) expect(text).toContain(p2(v));
          // The side is said in a word and a glyph, not by colour alone.
          expect(text).toContain(s.side === "call" ? "▲ CALL" : "▼ PUT");
        }
      });

      it(`${item.symbol}: the ladder with its no-trade box and its live note is outside any fold`, () => {
        const shown = without(card(), /<details[\s>]/);
        expect(shown).toContain(`data-testid="ladder-${item.symbol}"`);
        if (plan.call && plan.put) expect(shown).toContain('data-testid="ladder-box"');
        if (e.tickers.some((t) => t.symbol === item.symbol)) expect(shown).toContain('data-testid="ladder-note"');
      });
    }

    it("keeps a caution on the face when it applies (the expiry note)", () => {
      if (!items.some((i) => i.symbol === "AVGO")) return;
      expect(face(byCard.get("AVGO")!)).toContain("No options expire today");
    });
  });

describe("the face reader", () => {
  it("drops folds, nested ones too, screen-reader text, titles and attributes", () => {
    const html =
      '<div title="9.99"><p>1.11</p><details><summary>x</summary><details>2.22</details>3.33</details><span class="sr-only">4.44</span><span aria-label="5.55">6.66</span><svg><title>7.77</title></svg></div>';
    const t = face(html);
    expect(t).toContain("1.11");
    expect(t).toContain("6.66");
    for (const v of ["9.99", "2.22", "3.33", "4.44", "5.55", "7.77"]) expect(t).not.toContain(v);
  });
});
