import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DayBar, FocusStrip, focusOnly } from "@/components/options-focus";
import type { Options } from "@/lib/options";
import { focusOptions } from "@/lib/fixture-variants";
import { validateOptionsEdition } from "@/lib/validate";
import optionsJson from "./fixtures/options.v1.json";

// The focus block: a few names with one level to break and one to hold, and an optional pre-market line. It is
// optional, so an edition without it must keep validating and must draw nothing.
const v1 = optionsJson as unknown as Options;

function withFocus(): Options {
  const e = structuredClone(v1);
  e.focus = {
    picked_at: "2026-10-16T21:56:00Z",
    method: "test",
    items: [
      {
        symbol: "QQQ",
        rank: 2,
        bias: "support",
        resistance: { price: 712.5, name: "PDH" },
        support: { price: 704.1, name: "PWL" },
        close: 709.82,
        atr: 9.1,
      },
      {
        symbol: "SPY",
        rank: 1,
        bias: "breakout",
        why: "Closed just under a heavy zone.",
        breakout_above: 773.25,
        hold_above: 760.64,
      },
    ],
    premarket: {
      as_of: "2026-10-19T12:45:00Z",
      items: [{ symbol: "SPY", price: 765.1, gap_pct: 0.2, where: "between" }],
    },
  };
  return e;
}

describe("today's focus", () => {
  it("validates an edition with a focus block, and one without", () => {
    expect(validateOptionsEdition(withFocus())).toMatchObject({ ok: true });
    expect(validateOptionsEdition(v1)).toMatchObject({ ok: true });
  });

  it("refuses an unknown bias", () => {
    const e = withFocus() as unknown as {
      focus: { items: { bias: string }[] };
    };
    e.focus.items[0]!.bias = "moon";
    expect(validateOptionsEdition(e)).toMatchObject({ ok: false });
  });

  it("draws the names in rank order with their levels and the pre-market line", () => {
    const html = renderToStaticMarkup(
      createElement(FocusStrip, { e: withFocus() }),
    );
    expect(html.indexOf("SPY")).toBeLessThan(html.indexOf("QQQ"));
    expect(html).toContain("773.25");
    expect(html).toContain("704.10");
    expect(html).toContain("Between the levels pre-market");
    expect(html).toContain("Hold support");
  });

  it("spells out each side in plain words, with the codes written out and a glossary", () => {
    const html = renderToStaticMarkup(
      createElement(FocusStrip, { e: withFocus() }),
    );
    expect(html).toContain("CALL if it breaks up");
    expect(html).toContain("PUT if it breaks down");
    expect(html).toContain("last week&#x27;s low");
    expect(html).toContain("Limit order about");
    expect(html).toContain("What do the codes mean?");
    expect(html).toContain("loses at most $50");
  });

  it("warns on a name without a contract every session, and only on it", () => {
    const e = withFocus();
    e.session = "2026-10-27";
    e.focus!.items[0]!.symbol = "AVGO";
    const html = renderToStaticMarkup(createElement(FocusStrip, { e }));
    expect(html.match(/No options expire today/g)).toHaveLength(1);
    expect(
      renderToStaticMarkup(createElement(FocusStrip, { e: withFocus() })),
    ).not.toContain("expire today");
  });

  it("links to Card record beside the heading, so past cards are a click away during market hours too", () => {
    const html = renderToStaticMarkup(
      createElement(FocusStrip, { e: withFocus() }),
    );
    expect(html).toContain('href="/options/record"');
    expect(html).toContain("Card record");
  });

  it("lists the chart lines with a big colour ball, the price, what it is and its colour and style in words", () => {
    const html = renderToStaticMarkup(
      createElement(FocusStrip, { e: focusOptions(v1) }),
    );
    expect(html.match(/data-testid="chart-lines"/g)).toHaveLength(2);
    expect(html).toContain('aria-labelledby="lines-SPY"');
    expect(html).toContain("781.62");
    expect(html).toContain("one-year high");
    expect(html).toContain("Red, solid, thick");
    expect(html).toContain("Green, solid, thick");
    expect(html).toContain("Purple, dashed");
    expect(html).not.toContain("200-day average price</span>");
    // The no-trade box sits between the ceiling row and the floor row, as on the chart.
    const spy = html.slice(html.indexOf('id="lines-SPY"'));
    expect(spy.indexOf("779.40")).toBeLessThan(spy.indexOf("Grey box"));
    expect(spy.indexOf("Grey box")).toBeLessThan(spy.indexOf("775.16"));
  });

  it("says the colour code once under the cards, with pre-market lines to mark by hand and averages as indicators", () => {
    const html = renderToStaticMarkup(
      createElement(FocusStrip, { e: focusOptions(v1) }),
    );
    expect(html.match(/data-testid="chart-key"/g)).toHaveLength(1);
    expect(html).toContain("Not in today&#x27;s data");
    expect(html).toContain("turn them on as indicators");
  });

  it("draws nothing without a focus block", () => {
    expect(renderToStaticMarkup(createElement(FocusStrip, { e: v1 }))).toBe("");
  });
});

describe("the trading screen", () => {
  it("narrows the desk to the focus names in rank order, and keeps the whole board without a focus block", () => {
    expect(focusOnly(withFocus()).tickers.map((t) => t.symbol)).toEqual([
      "SPY",
      "QQQ",
    ]);
    expect(focusOnly(v1).tickers).toHaveLength(v1.tickers.length);
  });

  it("puts the day's limits in one line, and with no journal says the trades were not read, never a fresh day", () => {
    const html = renderToStaticMarkup(
      createElement(DayBar, {
        doc: null,
        now: new Date("2026-10-19T14:00:00Z"),
        session: "2026-10-19",
      }),
    );
    expect(html).toContain("Journal not current");
    expect(html).toContain("have not been read");
    expect(html).not.toContain("New day");
    expect(html).toContain("0 of 5");
    expect(html).toContain("$0 of $100");
  });
});

describe("New York times and the open-position caution", () => {
  it("says the no-entry times in New York, from the 09:35 first entry, and no Sydney time", () => {
    const html = renderToStaticMarkup(createElement(FocusStrip, { e: withFocus() }));
    expect(html).toContain("take no entries before 09:35 or between 11:30 and 13:00 New York");
    expect(html).toContain("Pre-market check");
    expect(html).not.toContain("Sydney");
  });

  it("says an open position's loss is counted by rule 7, as a caution beside the day line, without changing the count", () => {
    const now = new Date("2026-10-16T15:00:00Z");
    const lot = { symbol: "SPY", kind: "call", strike: 760, expiry: "2026-10-16", side: "long", qty: 1, entry: 1.2, opened_at: "2026-10-16T14:45:00Z" };
    const doc = { as_of: now.toISOString(), trades: [], open: [lot] } as unknown as Parameters<typeof DayBar>[0]["doc"];
    const html = renderToStaticMarkup(createElement(DayBar, { doc, now, session: "2026-10-16" }));
    const open = html.slice(html.indexOf("data-day-open"));
    expect(open).toMatch(/^data-day-open="true" class="text-warn[^"]*">1 position open: its open loss isn&#x27;t priced here, and rule 7 counts it; check Webull\.</);
    expect(html.split("1 position open").length).toBe(2); // said once, not also in the grey line
    expect(html).toContain("1 of 5");
  });
});

describe("the focus card as steps", () => {
  const html = () => renderToStaticMarkup(createElement(FocusStrip, { e: withFocus() }));
  /** The QQQ card's markup (QQQ has an ATR, so every step is there). */
  const qqq = () => {
    const h = html();
    return h.slice(h.indexOf('id="focus-card-QQQ"'));
  };

  it("numbers each side's steps in order: trigger, enter, stop, targets, runner", () => {
    const h = qqq();
    const call = h.slice(h.indexOf('data-side="call"'), h.indexOf('data-side="put"'));
    const order = [...call.matchAll(/data-step="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["trigger", "enter", "stop", "targets", "runner"]);
    expect(call).toContain('aria-label="Call plan, in order"');
    // the price first on each line
    expect(call).toMatch(/Trigger<\/span><span class="min-w-0"><span class="text-foreground font-mono font-semibold">712.50<\/span>/);
    expect(call).toContain("A 2-min candle closes above it, then a dip holds it");
    expect(call).toContain("Limit order about here");
    expect(call).toContain("711.59");
    expect(call).toContain("−25% on the option");
    expect(call).toContain("714.59");
  });

  it("keeps the runner plan folded, with its Testing tag", () => {
    const h = qqq();
    const runner = h.slice(h.indexOf('data-step="runner"'));
    expect(runner.startsWith('data-step="runner" class')).toBe(true);
    expect(h).not.toMatch(/<details[^>]*open/);
    expect(runner).toContain("Runner plan");
    expect(runner.indexOf("data-testing-tag")).toBeLessThan(runner.indexOf("Sell half at 714.59"));
  });

  it("lists the four other triggers under Also watch, one line each, tagged as testing", () => {
    const h = qqq();
    const also = h.slice(h.indexOf("data-also-watch"));
    expect(also).toContain("Also watch");
    expect(also).toContain(
      "Failed break: if it closes above 712.50 and back below within 3 bars (6 min), a put under 712.50, stop above the push high",
    );
    expect(also).toContain("Failed break: if it closes below 704.10 and back above within 3 bars (6 min), a call above 704.10, stop below the push low");
    expect(also).toContain(
      "Sweep: if it rises at least 0.25 × the 2-min ATR over 712.50 and closes back at or below it, a put under 712.50, stop above the sweep high",
    );
    expect(also).toContain(
      "Sweep: if it drops at least 0.25 × the 2-min ATR under 704.10 and closes back at or above it, a call above 704.10, stop below the sweep low",
    );
    const list = also.slice(0, also.indexOf("</ul>"));
    expect(list.match(/<li/g)?.length).toBe(4);
    expect(list.match(/data-testing-tag/g)?.length).toBe(4);
  });

  it("without an ATR there is no entry, runner or also-watch, and the stop is said in words", () => {
    const h = html();
    const spy = h.slice(h.indexOf('id="focus-card-SPY"'), h.indexOf('id="focus-card-QQQ"'));
    const order = [...spy.matchAll(/data-step="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["trigger", "stop", "trigger", "stop"]);
    expect(spy).toContain("A 2-min close back below the level, or −25% on the option");
    expect(spy).not.toContain("data-also-watch");
  });

  it("adds no separate cautions line: the board shows the live ones", () => {
    expect(html()).not.toContain("Before you enter");
  });
});
