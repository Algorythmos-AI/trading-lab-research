import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DayBar, DrawingGuide, FocusStrip, focusOnly, RulesStrip } from "@/components/options-focus";
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

  it("spells out each side in plain words, with the codes written out, under the How fold", () => {
    const html = renderToStaticMarkup(
      createElement(FocusStrip, { e: withFocus() }),
    );
    const how = html.slice(html.indexOf("data-how"));
    expect(how).toContain("CALL if it breaks up");
    expect(how).toContain("PUT if it breaks down");
    expect(how).toContain("Limit order about");
    expect(html).toContain("last week&#x27;s low");
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

  it("lists the chart lines, folded under Draw on chart, with a big colour ball, the price, what it is and its colour and style in words", () => {
    const html = renderToStaticMarkup(
      createElement(FocusStrip, { e: focusOptions(v1) }),
    );
    expect(html.match(/data-testid="chart-lines"/g)).toHaveLength(2);
    expect(html.match(/Draw on chart<\/summary><div[^>]*><div class="grid gap-1.5" data-testid="chart-lines"/g)).toHaveLength(2);
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

  it("draws the colour code and the glossary in the drawing guide, not in the strip of cards", () => {
    expect(renderToStaticMarkup(createElement(FocusStrip, { e: focusOptions(v1) }))).not.toContain('data-testid="chart-key"');
    const html = renderToStaticMarkup(createElement(DrawingGuide));
    expect(html.match(/data-testid="chart-key"/g)).toHaveLength(1);
    expect(html).toContain("Not in today&#x27;s data");
    expect(html).toContain("turn them on as indicators");
    expect(html).toContain("PMH / PML");
    expect(html).toContain("not pre-market");
    expect(html).toContain("What do the codes mean?");
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
  it("says the no-entry times in New York, from the 09:35 first entry, as chips, and no Sydney time", () => {
    const rules = renderToStaticMarkup(createElement(RulesStrip, { session: "2026-10-19", halfDay: false }));
    const chips = [...rules.matchAll(/data-rule="(\w+)"[^>]*><span[^>]*>([^<]+)<\/span>/g)].map((m) => m[2]);
    expect(chips).toEqual(["No entries before 09:35", "No entries 11:30–13:00", "Option under $2.00", "Out after 5 min", "Max 5 a day"]);
    expect(rules).toContain('data-testid="rules-strip"');
    expect(rules).toContain("loses at most $50");
    expect(rules).toContain("New York");
    // A half day closes at 13:00: no lunch chip.
    expect(renderToStaticMarkup(createElement(RulesStrip, { session: "2026-11-27", halfDay: true }))).not.toContain("11:30");
    const html = renderToStaticMarkup(createElement(FocusStrip, { e: withFocus() }));
    expect(html).toContain("Pre-market check");
    expect(html).not.toContain("Sydney");
    expect(html).not.toContain("rules-strip");
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

describe("the focus card: strips, folds and chips", () => {
  const html = () => renderToStaticMarkup(createElement(FocusStrip, { e: withFocus() }));
  /** The QQQ card's markup (QQQ has an ATR, so every step is there). */
  const qqq = () => {
    const h = html();
    return h.slice(h.indexOf('id="focus-card-QQQ"'));
  };

  it("draws one decision strip per side, call first: the trigger with its glyph and word, then entry, stop and T1", () => {
    const h = qqq();
    const call = h.slice(h.indexOf('data-strip="call"'), h.indexOf('data-strip="put"'));
    const put = h.slice(h.indexOf('data-strip="put"'), h.indexOf("data-how"));
    expect(call).toContain("▲");
    expect(call).toContain("CALL");
    expect(call).toMatch(/data-cell="trigger">712.50</);
    expect([...call.matchAll(/data-cell="([^"]+)"/g)].map((m) => m[1])).toEqual(["trigger", "in ≈", "stop", "t1"]);
    expect(call).toContain(">711.59<");
    expect(call).toContain(">714.59<");
    expect(call).toContain("or −25%");
    expect(put).toContain("▼");
    expect(put).toMatch(/data-cell="trigger">704.10</);
    // Large prices: the size token on every price, in the mono font.
    expect(call).toMatch(/class="text-price font-mono tabular-nums text-good" data-cell="trigger"/);
    expect(put).toMatch(/class="text-price font-mono tabular-nums text-bad" data-cell="trigger"/);
    // Outside a live board, neither side is emphasised and no distance is shown, only its reserved space.
    expect(call).toContain('data-emph="none"');
    expect(call).toContain('data-live-distance="none"');
    const shown = call.replace(/<span aria-hidden="true" class="invisible[^"]*">.*?<\/span><\/span>/, "");
    expect(call).toContain("00.00 away"); // the reserved, invisible box
    expect(shown).not.toMatch(/\d away/);
  });

  it("numbers each side's steps in order under the How fold: trigger, enter, stop, targets", () => {
    const h = qqq();
    const how = h.slice(h.indexOf("data-how"));
    const call = how.slice(how.indexOf('data-how-side="call"'), how.indexOf('data-how-side="put"'));
    const order = [...call.matchAll(/data-step="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["trigger", "enter", "stop", "targets"]);
    expect(call).toContain('aria-label="Call plan, in order"');
    // the price first on each line
    expect(call).toMatch(/Trigger<\/span><span class="min-w-0"><span class="text-foreground font-mono font-semibold">712.50<\/span>/);
    expect(call).toContain("A 2-min candle closes above it, then a dip holds it");
    expect(call).toContain("Limit order about here");
    expect(call).toContain("−25% on the option");
    expect(h.slice(0, h.indexOf("data-how"))).not.toContain("Limit order about here");
  });

  it("keeps the runner plan folded, with one Testing tag, a line per side", () => {
    const h = qqq();
    const runner = h.slice(h.indexOf("data-runner"));
    expect(h).not.toMatch(/<details[^>]*open/);
    expect(runner).toContain("Runner plan");
    expect(runner.indexOf("data-testing-tag")).toBeLessThan(runner.indexOf("Sell half at 714.59"));
    expect([...runner.slice(0, runner.indexOf("</details>")).matchAll(/data-runner-side="(\w+)"/g)].map((m) => m[1])).toEqual(["call", "put"]);
  });

  it("shows the four other triggers as chips with one Testing tag, their sentences only in a fold or a title", () => {
    const h = qqq();
    const alts = h.slice(h.indexOf("data-alts"), h.indexOf("data-runner"));
    const chips = alts.slice(alts.indexOf("<ul"), alts.indexOf("</ul>"));
    expect([...chips.matchAll(/data-alt="(\w+)" data-alt-side="(\w+)"/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      "failed_break put",
      "failed_break call",
      "sweep_reclaim put",
      "sweep_reclaim call",
    ]);
    const face = chips.replace(/ title="[^"]*"/g, "");
    expect(face).toMatch(/Failed break · put<\/span><span[^>]*>712.50</);
    expect(face).toMatch(/Sweep · call<\/span><span[^>]*>704.10</);
    expect(face).not.toContain("closes above");
    expect(alts.match(/data-testing-tag/g)?.length).toBe(1);
    expect(chips).not.toContain("data-alt-live");
    const fold = alts.slice(alts.indexOf("<details"));
    expect(fold).toContain(
      "Failed break: if it closes above 712.50 and back below within 3 bars (6 min), a put under 712.50, stop above the push high",
    );
    expect(fold).toContain(
      "Sweep: if it drops at least 0.25 × the 2-min ATR under 704.10 and closes back at or above it, a call above 704.10, stop below the sweep low",
    );
  });

  it("without an ATR there is no entry, target, runner or other triggers, and the stop is said in words", () => {
    const h = html();
    const spy = h.slice(h.indexOf('id="focus-card-SPY"'), h.indexOf('id="focus-card-QQQ"'));
    const order = [...spy.matchAll(/data-step="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["trigger", "stop", "trigger", "stop"]);
    expect(spy).toContain("A 2-min close back below the level, or −25% on the option");
    expect(spy).toContain("2-min close back below 773.25, or −25%");
    expect(spy).not.toContain("data-alts");
    expect(spy).not.toContain("data-runner");
  });

  it("keeps the pre-market price and where it sits in one visible line, and folds the longer note", () => {
    const e = withFocus();
    e.focus!.premarket!.items[0]!.note = "Gapping into the zone on light volume.";
    const h = renderToStaticMarkup(createElement(FocusStrip, { e }));
    const line = h.slice(h.indexOf("data-premarket"));
    expect(line.slice(0, line.indexOf("<details"))).toMatch(/Between the levels pre-market<\/span> · <span[^>]*>765.10<\/span> \(\+0.2%\)/);
    expect(line.slice(line.indexOf("<details"))).toContain("Gapping into the zone");
  });

  it("adds no separate cautions line: the header's state chip shows the live ones", () => {
    expect(html()).not.toContain("Before you enter");
  });
});
