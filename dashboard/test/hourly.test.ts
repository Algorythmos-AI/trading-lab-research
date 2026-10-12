import { describe, expect, it } from "vitest";
import { fixtureOptionsLive } from "@/lib/fixture-variants";
import { HOURLY_MIN_BARS, hourlyBySymbol, withHourly } from "@/lib/hourly";
import { mapView, type Options } from "@/lib/options";
import { POSITIONS_GONE_MIN } from "@/lib/positions";
import { validateOptionsLive } from "@/lib/validate";
import optionsJson from "./fixtures/options.v1.json";

const e = optionsJson as unknown as Options;
const NOW = new Date("2026-10-12T16:00:00Z");
const doc = (flags: string[] = []) => fixtureOptionsLive(e as never, NOW, new Set(flags) as never);
const names = e.tickers.map((t) => t.symbol);

describe("the map's hourly range", () => {
  it("is in a document the site accepts, as version 3, and absent without the block", () => {
    expect(validateOptionsLive(doc())).toMatchObject({ ok: true });
    expect(doc().schema_version).toBe(3);
    expect(doc(["hourly-off"]).hourly).toBeUndefined();
    expect(hourlyBySymbol(doc(["hourly-off"]), names, NOW.getTime())).toEqual({});
    expect(hourlyBySymbol(null, names, NOW.getTime())).toEqual({});
  });

  it("gives each carried name its bars in time order, and leaves out a name the host left out", () => {
    const got = hourlyBySymbol(doc(), names, NOW.getTime());
    expect(Object.keys(got)).toEqual(names.slice(0, -1));
    const spy = got.SPY!;
    expect(spy).toHaveLength(35);
    expect([spy[0]!.t, spy[34]!.t]).toEqual(["2026-10-05T09:30", "2026-10-09T15:00"]);
    expect(spy.every((b) => b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c))).toBe(true);
    expect(hourlyBySymbol(doc(), ["SPY"], NOW.getTime())).toHaveProperty("SPY");
    expect(Object.keys(hourlyBySymbol(doc(), ["SPY"], NOW.getTime()))).toEqual(["SPY"]);
  });

  it("passes over what is not a bar, and drops a name left with too few or a document too old", () => {
    const d = doc();
    const good = d.hourly![0]!.bars;
    d.hourly![0]!.bars = [
      ...good.slice(0, HOURLY_MIN_BARS).reverse(), // out of order: sorted
      good[0]!, // the same hour twice: read once
      { ...good[10]!, h: Number.NaN },
      { ...good[11]!, l: -1 },
      { ...good[12]!, h: 1, l: 2 },
      null as never,
      { t: 7 } as never,
    ];
    d.hourly![1]!.bars = good.slice(0, HOURLY_MIN_BARS - 1);
    d.hourly!.push({ ...d.hourly![2]! }, null as never, { symbol: "ZZZZ", bars: good });
    const got = hourlyBySymbol(d, names, NOW.getTime());
    expect(got[names[0]!]!.map((b) => b.t)).toEqual(good.slice(0, HOURLY_MIN_BARS).map((b) => b.t));
    expect(got).not.toHaveProperty(names[1]!);
    expect(got).not.toHaveProperty("ZZZZ");
    expect(hourlyBySymbol(doc(), names, NOW.getTime() + (POSITIONS_GONE_MIN + 5) * 60_000)).toEqual({});
    expect(hourlyBySymbol({ ...doc(), hourly: "x" as never }, names, NOW.getTime())).toEqual({});
  });

  it("draws the same zones against the hourly candles, in a window no wider than the daily one", () => {
    const t = e.tickers.find((x) => x.symbol === "SPY")!;
    const hourly = hourlyBySymbol(doc(), names, NOW.getTime()).SPY!;
    const h = withHourly(t, hourly);
    expect(h.zones).toBe(t.zones);
    expect(h.bars).toHaveLength(35);
    expect(h.bars![0]).toEqual({ d: "2026-10-05T09:30", o: hourly[0]!.o, h: hourly[0]!.h, l: hourly[0]!.l, c: hourly[0]!.c });
    const [day, hour] = [mapView(t)!, mapView(h)!];
    expect(hour.bars).toHaveLength(35);
    expect(hour.hi - hour.lo).toBeLessThanOrEqual(day.hi - day.lo);
    expect(t.bars).not.toBe(h.bars); // the edition's own name is not changed
  });
});
