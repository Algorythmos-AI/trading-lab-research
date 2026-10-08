// The performance panels render from a snapshot without a browser: what a reader would see, as text.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DrawdownPanel, MonthlyReturnsPanel, SignalFunnelPanel } from "@/components/crypto/performance";
import type { Crypto } from "@/lib/crypto";

const fixture = (): Crypto => JSON.parse(readFileSync(new URL("./fixtures/crypto.v1.json", import.meta.url), "utf8")) as Crypto;
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const withMarks = (): Crypto => {
  const s = fixture();
  for (const x of s.sleeves ?? []) {
    if (x) x.equity_curve = [{ t: "2026-09-28T00:00:00+00:00", equity: 10100 }, { t: "2026-09-30T00:00:00+00:00", equity: 9900 }, { t: "2026-10-04T00:00:00+00:00", equity: 10050 }];
  }
  return s;
};

describe("the performance panels", () => {
  it("show each book's deepest fall and where it stands now", () => {
    const out = text(renderToString(createElement(DrawdownPanel, { s: withMarks() })));
    expect(out).toContain("Fall from the high");
    expect(out).toContain("Trend deepest −1.98% now −0.50%"); // 9,900 against the high of 10,100; then 10,050
    expect(out).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("show each book's return month by month", () => {
    const out = text(renderToString(createElement(MonthlyReturnsPanel, { s: withMarks() })));
    expect(out).toContain("Sept 2026 Oct 2026");
    expect(out).toContain("Trend −1.00% +1.52%"); // 9,900 from a start of 10,000; then 10,050 from 9,900
    expect(out).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("show what became of the signals, with reasons in plain words and never a raw code", () => {
    const out = text(renderToString(createElement(SignalFunnelPanel, { s: fixture() })));
    expect(out).toContain("All sleeves · 6 of 10 bought");
    expect(out).toContain("another book of the tournament already holds this coin 1");
    expect(out).not.toMatch(/desk_coin|stop_too_tight|NaN|undefined/);
  });

  it("say so plainly when there is nothing to show yet", () => {
    const empty = fixture();
    for (const x of empty.sleeves ?? []) {
      if (x) {
        x.equity_curve = [];
        delete (x as { funnel?: unknown }).funnel;
      }
    }
    if (empty.perf) empty.perf.equity_curve = [];
    expect(text(renderToString(createElement(DrawdownPanel, { s: empty })))).toContain("Not enough history yet");
    expect(text(renderToString(createElement(MonthlyReturnsPanel, { s: empty })))).toContain("No book has published a mark yet");
    expect(text(renderToString(createElement(SignalFunnelPanel, { s: empty })))).toContain("No signal recorded yet");
  });
});
