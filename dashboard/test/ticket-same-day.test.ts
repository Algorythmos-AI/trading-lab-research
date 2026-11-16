// The ticket's same-day line: "Expires today", and which stop fires first, from the typed price only. Synthetic
// numbers on a synthetic date.
import { describe, expect, it } from "vitest";
import { price } from "@/lib/bs";
import { minutesLeft, sizeTicket, ticketEstimates, usd } from "@/lib/ticket";
import { sameDay } from "@/lib/ticket-same-day";

const DAY = "2026-12-09"; // a Wednesday, a full session
const NEXT_WEEK = "2026-12-16";
const NOW = Date.parse("2026-12-09T19:00:00Z"); // 14:00 in New York: two hours to the bell
const SPOT = 500;
const STRIKE = 500;

/** A same-day at-the-money put priced at 25% a year, sized by the owner's rules, and its estimates. */
function setup(expiry: string, chartStop: number) {
  const minutes = minutesLeft(expiry, NOW, DAY);
  const paidCents = Math.round(price(SPOT, STRIKE, minutes ?? 0, 0.25, "put") * 100);
  const size = sizeTicket(paidCents);
  const est = ticketEstimates({
    kind: "put",
    paidCents,
    spot: SPOT,
    strike: STRIKE,
    minutes,
    contracts: size.contracts,
    levels: [{ key: "stop", label: "At the chart stop", price: chartStop }],
  });
  return { size, est, stop: est?.rows.find((r) => r.key === "stop") };
}

describe("a contract that expires today", () => {
  it("says it expires today and that the premium stop fires before a far chart stop, with each loss after fees", () => {
    const { size, est, stop } = setup(DAY, 502);
    expect(est).not.toBeNull();
    expect(size.contracts).toBeGreaterThan(0);
    // Two dollars against an at-the-money put with two hours left takes it well under 75% of the price.
    expect(stop!.valueCents).toBeLessThan(size.stopCents);
    const d = sameDay(DAY, NOW, size, stop);
    expect(d?.line).toBe("Expires today");
    expect(d?.compare?.first).toBe("premium");
    // The premium stop's loss is the sized risk: price less stop, a hundred shares, plus $0.55 + $0.56 a contract.
    expect(d?.compare?.premiumLossCents).toBe(-size.contracts * ((size.priceCents - size.stopCents) * 100 + 111));
    // The chart stop's loss is the estimate's, fees in, and bigger than the premium stop's.
    expect(d?.compare?.chartLossCents).toBe(stop!.pnlCents);
    expect(d!.compare!.chartLossCents).toBeLessThan(d!.compare!.premiumLossCents);
    expect(d?.compare?.text).toBe(
      `The −25% premium stop fires first, before the stock reaches the chart stop: −${usd(size.riskCents)} at the −25% premium stop ${usd(size.stopCents)}; ≈ ${usd(stop!.pnlCents)} at the chart stop 502.00. Fees in. Time decay brings the premium stop closer as the day goes on.`,
    );
    // One minus sign on each loss, never "−−" or "-".
    expect(d?.compare?.text).not.toMatch(/−−|-\$/);
    expect(d?.compare?.text).toMatch(/: −\$[\d,]+\.\d\d at the −25% premium stop \$\d+\.\d\d; ≈ −\$[\d,]+\.\d\d at the chart stop/);
  });

  it("says the chart stop comes first when it is near", () => {
    const { size, stop } = setup(DAY, 500.1);
    const d = sameDay(DAY, NOW, size, stop);
    expect(d?.compare?.first).toBe("chart");
    expect(d?.compare?.text).toMatch(/^If the stock got there now, the chart stop comes first/);
  });

  it("says the two land together when the estimate at the chart stop is the premium stop's price", () => {
    const { size } = setup(DAY, 502);
    const d = sameDay(DAY, NOW, size, { stockPrice: 502, valueCents: size.stopCents, pnlCents: -size.riskCents });
    expect(d?.compare?.first).toBe("together");
    expect(d?.compare?.text).toMatch(/^If the stock got there now, the −25% premium stop and the chart stop land together/);
  });

  it("states no order when the chart stop is on the winning side of the stock (worth more than was paid there)", () => {
    // A put whose chart stop is under the stock: getting there is a gain, not a stop the stock reaches against it.
    const { size, stop } = setup(DAY, 498);
    expect(stop!.valueCents).toBeGreaterThan(size.priceCents);
    expect(sameDay(DAY, NOW, size, stop)).toEqual({ line: "Expires today", compare: null });
  });

  it("says nothing once today's bell has gone, whatever session the page is on", () => {
    const { size, stop } = setup(DAY, 502);
    expect(sameDay(DAY, Date.parse("2026-12-09T20:59:00Z"), size, stop)?.line).toBe("Expires today"); // 15:59
    expect(sameDay(DAY, Date.parse("2026-12-09T21:00:00Z"), size, stop)).toBeNull(); // 16:00
    expect(sameDay(DAY, Date.parse("2026-12-09T22:00:00Z"), size, stop)).toBeNull();
    // A half day closes at 13:00 New York (the day after Thanksgiving).
    expect(sameDay("2026-11-27", Date.parse("2026-11-27T17:30:00Z"), size, stop)?.line).toBe("Expires today");
    expect(sameDay("2026-11-27", Date.parse("2026-11-27T18:30:00Z"), size, stop)).toBeNull();
  });

  it("says nothing for a contract that expires next week", () => {
    const { size, stop } = setup(NEXT_WEEK, 502);
    expect(stop).toBeDefined();
    expect(sameDay(NEXT_WEEK, NOW, size, stop)).toBeNull();
  });

  it("shows the line but no comparison without an estimate at the chart stop, never a guess", () => {
    const { size } = setup(DAY, 502);
    const d = sameDay(DAY, NOW, size, undefined);
    expect(d).toEqual({ line: "Expires today", compare: null });
    expect(sameDay(DAY, NOW, size, null)?.compare).toBeNull();
  });

  it("says nothing when the clock or the date cannot be read", () => {
    const { size, stop } = setup(DAY, 502);
    expect(sameDay(DAY, null, size, stop)).toBeNull();
    expect(sameDay("", NOW, size, stop)).toBeNull();
  });

  it("ticket-same-day.ts is outside the signal's and the engine's hashed import closures", async () => {
    // @ts-expect-error: a plain .mjs script, no types
    const sig = (await import("../scripts/gen-signal.mjs")) as { signalFiles(): string[] };
    // @ts-expect-error: a plain .mjs script, no types
    const eng = (await import("../scripts/gen-engine.mjs")) as { engineFiles(): string[] };
    const files = [...sig.signalFiles(), ...eng.engineFiles()].map((f) => f.split("/src/lib/")[1]);
    expect(files).not.toContain("ticket-same-day.ts");
  });
});
