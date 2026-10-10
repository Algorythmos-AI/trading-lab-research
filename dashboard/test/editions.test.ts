import { describe, expect, it } from "vitest";
import { OPTIONS_ACCEPTS, RADAR_ACCEPTS, optionsHealth, radarHealth } from "@/lib/editions";
import type { OptionsEdition } from "@/lib/options.types";
import type { RadarEdition } from "@/lib/radar.types";
import optionsJson from "./fixtures/options.v1.json";
import radarJson from "./fixtures/radar.v1.json";

const options = optionsJson as unknown as OptionsEdition;
const radar = radarJson as unknown as RadarEdition;

describe("edition health", () => {
  it("reports the stored options edition and the format this build accepts", () => {
    expect(optionsHealth({ status: "ok", edition: options, source: "blob" })).toEqual({
      status: "ok",
      accepts: OPTIONS_ACCEPTS,
      session: options.session,
      run_id: options.run_id,
      as_of: options.as_of,
      schema_version: options.schema_version,
    });
  });

  it("reports the stored radar edition", () => {
    expect(radarHealth({ status: "ok", edition: radar, source: "blob" })).toMatchObject({
      status: "ok",
      accepts: RADAR_ACCEPTS,
      edition_date: radar.edition_date,
      run_id: radar.run_id,
    });
  });

  it("still says what it accepts when nothing is stored or storage failed", () => {
    for (const status of ["missing", "error"] as const) {
      expect(optionsHealth({ status })).toEqual({ status, accepts: OPTIONS_ACCEPTS, session: null, run_id: null, as_of: null, schema_version: null });
      expect(radarHealth({ status })).toEqual({ status, accepts: RADAR_ACCEPTS, edition_date: null, run_id: null, as_of: null, schema_version: null });
    }
  });

  it("an edition without the optional fields reads as nulls, never undefined", () => {
    const bare = { schema: "stocksdelta/options", session: "2026-10-12", tickers: [] } as unknown as OptionsEdition;
    const h = optionsHealth({ status: "ok", edition: bare, source: "blob" });
    expect(h).toEqual({ status: "ok", accepts: OPTIONS_ACCEPTS, session: "2026-10-12", run_id: null, as_of: null, schema_version: null });
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
  });

  it("accepts the format of the fixtures the pages are tested with", () => {
    expect(options.schema_version ?? 1).toBeLessThanOrEqual(OPTIONS_ACCEPTS);
    expect(radar.schema_version ?? 1).toBeLessThanOrEqual(RADAR_ACCEPTS);
  });
});
