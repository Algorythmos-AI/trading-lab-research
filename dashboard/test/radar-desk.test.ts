import { beforeEach, describe, expect, it, vi } from "vitest";
import { RADAR_DESK_ACCEPTS, radarDeskHealth } from "@/lib/editions";
import { ENGINE_VERSION } from "@/lib/engine-version.gen";
import { evaluateStamped, FEEDS } from "@/lib/feed-watch";
import { sign } from "@/lib/hmac";
import { INGEST_REJECT_KINDS } from "@/lib/ingest-reject";
import { RADAR_DESK_DUE_NY, RADAR_DESK_GRACE_MIN, RADAR_DESK_NY } from "@/lib/radar-desk-slots";
import type { RadarDeskDoc } from "@/lib/radar-desk.types";
import { coverageLine, focusRows, radarDeskView } from "@/lib/radar-desk-view";
import { SIGNAL_CODE_HASH } from "@/lib/signal-version.gen";
import { isRadar, isRadarDesk, RADAR_DESK_SCHEMA, validateRadarDesk } from "@/lib/validate";
import deskJson from "./fixtures/radar-desk.v1.json";

// The Radar desk file: each morning trading-options-funnel sends, per Options desk name, the Radar's codes and levels
// beside the desk's, earnings and closed flag codes, signed with the radar's key. Display only, PRIVATE, no free text
// and no outcome. The fixture's names are real tickers; every price and date in it is synthetic.

const blob = vi.hoisted(() => {
  class PreconditionFailed extends Error {}
  const store = new Map<string, { text: string; etag: string }>();
  let seq = 0;
  return {
    store,
    PreconditionFailed,
    reset() {
      store.clear();
      seq = 0;
    },
    put(pathname: string, text: string) {
      const etag = `"e${++seq}"`;
      store.set(pathname, { text, etag });
      return etag;
    },
  };
});

vi.mock("@/lib/blob", () => ({
  LATEST_PATH: "snapshots/latest.json",
  SHADOW_LATEST_PATH: "shadow/latest.json",
  HISTORY_PREFIX: "snapshots/history/",
  ALERT_STATE_PATH: "alerts/state.json",
  PreconditionFailed: blob.PreconditionFailed,
  listPaths: vi.fn(async () => []),
  readText: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  readForUpdate: vi.fn(async (pathname: string) => blob.store.get(pathname) ?? null),
  writeText: vi.fn(async (pathname: string, body: string, opts: { ifMatch?: string | null } = {}) => {
    const cur = blob.store.get(pathname);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new blob.PreconditionFailed();
    return { etag: blob.put(pathname, body) };
  }),
}));

const { handleIngest } = await import("@/lib/ingest");

const RADAR_SECRET = "test-radar-secret";
const HOST_SECRET = "test-host-secret";
// Monday 2026-10-12, 09:00 New York (EDT): the fixture was sealed at 08:41.
const NOW = new Date("2026-10-12T13:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const doc = (mutate?: (d: RadarDeskDoc) => void): RadarDeskDoc => {
  const d = structuredClone(deskJson) as unknown as RadarDeskDoc;
  mutate?.(d);
  return d;
};
const name = (d: RadarDeskDoc, symbol: string) => d.names.find((n) => n.symbol === symbol)!;
const loose = (v: unknown) => v as Record<string, unknown>;

function post(body: unknown, keyId = "radar", secret = RADAR_SECRET): Request {
  const text = JSON.stringify(body);
  return new Request("https://lab.example/api/ingest", {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      "x-wt-timestamp": String(NOW_S),
      "x-wt-signature": sign(secret, NOW_S, Buffer.from(text, "utf8")),
      "x-wt-key-id": keyId,
    },
  });
}

beforeEach(() => {
  blob.reset();
  vi.unstubAllEnvs();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_INGEST_SECRET", HOST_SECRET);
  vi.stubEnv("RADAR_INGEST_SECRET", RADAR_SECRET);
});

describe("the Radar desk file's contract", () => {
  it("takes the fixture, and is not taken for a Radar edition", () => {
    expect(RADAR_DESK_SCHEMA).toBe("stocksdelta/radar-desk");
    expect(isRadarDesk(doc())).toBe(true);
    expect(isRadar(doc())).toBe(false);
    const r = validateRadarDesk(doc());
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("refuses an extra key at any level", () => {
    const refused = [
      doc((d) => Object.assign(d, { inputs: { wt_commit: null } })),
      doc((d) => Object.assign(d.coverage, { focus_covered: 4 })),
      doc((d) => Object.assign(d.names[0]!, { rank: 1 })),
      doc((d) => Object.assign(name(d, "AAPL").radar!, { tag: "risk" })),
      doc((d) => Object.assign(name(d, "AAPL").desk_levels!, { close: 250 })),
      doc((d) => Object.assign(name(d, "AAPL").earnings.next!, { time: "16:05" })),
      doc((d) => Object.assign(d.macro_in_hold[0]!, { label: "x" })),
    ];
    for (const d of refused) expect(validateRadarDesk(d).ok).toBe(false);
  });

  it("refuses an unknown flag, list code or earnings time", () => {
    const refused = [
      doc((d) => ((name(d, "NVDA").flags as string[]).push("PICK_ME"))),
      doc((d) => ((name(d, "AAPL").radar!.lists as string[])[0] = "top_pick")),
      doc((d) => ((name(d, "AAPL").earnings.next as { when: string }).when = "pre")),
      doc((d) => ((name(d, "NVDA").flags as string[]).push("RADAR_RISK_TAG"))),
    ];
    for (const d of refused) expect(validateRadarDesk(d).ok).toBe(false);
  });

  it("refuses free text in every string it carries", () => {
    const refused = [
      doc((d) => (d.names[0]!.symbol = "Buy AAPL calls now")),
      doc((d) => (d.names[0]!.symbol = "aapl")),
      doc((d) => ((name(d, "AAPL").radar!.lists as string[])[0] = "Daily Radar")),
      doc((d) => (d.macro_in_hold[0]!.type = "Fed chair speaks")),
      doc((d) => (d.macro_in_hold[0]!.severity = "very high!")),
      doc((d) => (d.run_id = "desk-2026-10-12-nvda")),
    ];
    for (const d of refused) expect(validateRadarDesk(d).ok).toBe(false);
  });

  it("refuses a bad date or time", () => {
    const refused = [
      doc((d) => (d.session = "2026-10-1")),
      doc((d) => (d.next_session = "2026-13-01")),
      doc((d) => (d.as_of = "2026-10-12 12:41")),
      doc((d) => (name(d, "MSFT").earnings.csv_dates = ["12/10/2026"])),
      doc((d) => (name(d, "MSFT").earnings.radar_dates = ["2026-10-32"])),
      doc((d) => (name(d, "AAPL").earnings.next!.date = "next week")),
      doc((d) => (d.macro_in_hold[0]!.time_et = "9:30")),
      doc((d) => (d.macro_in_hold[0]!.date = "2026-10-20")),
      doc((d) => (d.next_session = d.session)),
    ];
    for (const d of refused) expect(validateRadarDesk(d).ok).toBe(false);
  });

  it("holds at most 20 names", () => {
    const many = doc((d) => {
      for (let i = 0; i < 9; i++) d.names.push({ ...structuredClone(name(d, "AMZN")), symbol: `ZZ${String.fromCharCode(65 + i)}` });
      d.coverage.desk_names = d.names.length;
      d.coverage.radar_covered = d.names.filter((n) => n.radar !== null).length;
    });
    expect(many.names.length).toBe(21);
    expect(validateRadarDesk(many).ok).toBe(false);
  });

  it("refuses what the desk step could never build", () => {
    const refused = [
      doc((d) => d.names.push(structuredClone(d.names[0]!))),
      doc((d) => (d.coverage.desk_names = 11)),
      doc((d) => (d.coverage.radar_covered = 12)),
      doc((d) => (name(d, "META").flags = name(d, "META").flags.filter((f) => f !== "RADAR_NOT_COVERED"))),
      doc((d) => (name(d, "AMZN").focus = null)),
      doc((d) => (d.coverage.focus_names = null)),
    ];
    for (const d of refused) expect(validateRadarDesk(d).ok).toBe(false);
    const noFocusFile = doc((d) => {
      d.coverage.focus_names = null;
      for (const n of d.names) n.focus = null;
    });
    expect(validateRadarDesk(noFocusFile).ok).toBe(true);
  });

  it("the denylist still refuses its keys inside this document, by name", () => {
    const setup = validateRadarDesk(doc((d) => Object.assign(d.names[0]!, { setup: "a named setup" })));
    expect(setup.ok).toBe(false);
    expect(!setup.ok && setup.errors.some((e) => /setup: key is not allowed to be published/.test(e))).toBe(true);
    const headlines = validateRadarDesk(doc((d) => Object.assign(name(d, "AAPL").radar!, { headlines: ["x"] })));
    expect(!headlines.ok && headlines.errors.some((e) => /headlines: key is not allowed to be published/.test(e))).toBe(true);
  });

  it("the sealed desk.json as the desk step writes it is not this document: the sender reshapes it", () => {
    const sealed = loose(doc());
    sealed.schema = "options-funnel/radar-desk";
    delete sealed.run_id;
    delete sealed.as_of;
    sealed.inputs = { radar_folder: "2026-10-12", edition_sha256: null, focus_folder: null, focus_sha256: null, wt_commit: null };
    expect(isRadarDesk(sealed)).toBe(false);
    expect(validateRadarDesk({ ...sealed, schema: RADAR_DESK_SCHEMA }).ok).toBe(false);
  });
});

describe("POST /api/ingest with a Radar desk file", () => {
  it("the radar's key stores it at radar-desk/latest.json and one copy per session", async () => {
    const res = await handleIngest(post(doc()), NOW);
    expect(res.status).toBe(200);
    expect(blob.store.has("radar-desk/latest.json")).toBe(true);
    expect(blob.store.has("radar-desk/editions/2026-10-12.json")).toBe(true);
    expect(blob.store.has("radar/latest.json")).toBe(false);
    expect(blob.store.has("funnel/latest.json")).toBe(false);
  });

  it("the same run again is a duplicate; an invalid one is refused and only the refusal is recorded", async () => {
    await handleIngest(post(doc()), NOW);
    expect((await (await handleIngest(post(doc()), NOW)).json()).status).toBe("duplicate");
    blob.reset();
    const bad = doc((d) => ((name(d, "NVDA").flags as string[]).push("BUY")));
    expect((await handleIngest(post(bad), NOW)).status).toBe(422);
    expect([...blob.store.keys()]).toEqual(["ops/ingest-rejects/radar-desk.json"]);
  });

  it("a wrong signature stores nothing", async () => {
    const res = await handleIngest(post(doc(), "radar", "not-the-secret"), NOW);
    expect(res.status).toBe(401);
    expect(blob.store.size).toBe(0);
  });

  it("a document dated ahead of the clock is refused and recorded", async () => {
    const res = await handleIngest(post(doc((d) => (d.as_of = "2026-10-12T14:30:00Z"))), NOW);
    expect(res.status).toBe(422);
    expect(blob.store.has("radar-desk/latest.json")).toBe(false);
    expect(blob.store.has("ops/ingest-rejects/radar-desk.json")).toBe(true);
  });

  it("the trading host's key may store it too, as for the funnel; a key scoped to a desk may not", async () => {
    expect((await handleIngest(post(doc(), "default", HOST_SECRET), NOW)).status).toBe(200);
    blob.reset();
    vi.stubEnv("DASHBOARD_INGEST_KEYS", JSON.stringify({ "hft-pub": "test-hft-secret" }));
    vi.stubEnv("DASHBOARD_INGEST_SCOPES", JSON.stringify({ "hft-pub": { desks: ["hft"] } }));
    expect((await handleIngest(post(doc(), "hft-pub", "test-hft-secret"), NOW)).status).toBe(403);
    expect(blob.store.has("radar-desk/latest.json")).toBe(false);
  });
});

describe("health and the feed watch", () => {
  it("reports itself on /api/health with the run only: no names, flags or coverage", () => {
    const h = radarDeskHealth({ status: "ok", doc: doc(), source: "fixture" });
    expect(h).toEqual({ status: "ok", accepts: RADAR_DESK_ACCEPTS, session: "2026-10-12", run_id: doc().run_id, as_of: doc().as_of, schema_version: 1 });
    expect(radarDeskHealth({ status: "missing" })).toMatchObject({ status: "missing", session: null, run_id: null });
  });

  it("is watched, display only, due by 09:15 New York, and its refusals are recorded", () => {
    expect(INGEST_REJECT_KINDS).toContain("radar-desk");
    const row = FEEDS.find((f) => f.id === "radar-desk");
    expect(row).toMatchObject({ type: "doc", ingest_kind: "radar-desk", want: "this-session", severity: "display", verified: false });
    expect(row?.type === "doc" && row.schedules).toEqual([{ zone: "America/New_York", times: [RADAR_DESK_NY], grace_min: RADAR_DESK_GRACE_MIN }]);
    const [h, m] = RADAR_DESK_NY.split(":").map(Number);
    const due = h! * 60 + m! + RADAR_DESK_GRACE_MIN;
    expect(`${String(Math.floor(due / 60)).padStart(2, "0")}:${String(due % 60).padStart(2, "0")}`).toBe(RADAR_DESK_DUE_NY);
    expect(FEEDS.some((f) => f.type === "refusal" && f.kind === "radar-desk")).toBe(true);
  });

  const stamped = (stamp: { session: string; at: number } | null) => ({
    stamps: { "radar-desk": stamp ? ({ status: "ok", value: stamp } as const) : ({ status: "missing" } as const) },
    refusals: {},
    shadow: null,
  });
  const viewAt = (now: string, stamp: { session: string; at: number } | null) =>
    evaluateStamped(stamped(stamp), Date.parse(now)).find((v) => v.id === "radar-desk")!;

  it("is on time with the session's file, and late past 09:15 without it", () => {
    const fresh = { session: "2026-10-12", at: Date.parse(doc().as_of) };
    expect(viewAt("2026-10-12T13:30:00Z", fresh).state).toBe("on_time");
    const yesterday = { session: "2026-10-09", at: Date.parse("2026-10-09T12:40:00Z") };
    expect(viewAt("2026-10-12T13:30:00Z", yesterday).state).toBe("late");
    expect(viewAt("2026-10-12T13:30:00Z", null).state).not.toBe("on_time");
  });

  it("the Operations card says fresh, or nothing yet while unwatched", async () => {
    const { buildFeeds } = await import("@/components/operations/feeds-panel");
    const input = (stamp: { session: string; at: number } | null) => ({
      now: new Date("2026-10-12T13:30:00Z"),
      snapshot: { status: "missing" as const },
      journal: { status: "missing" as const },
      options: { status: "missing" as const },
      optionsLive: { status: "missing" as const },
      radar: { status: "missing" as const },
      feeds: stamped(stamp),
      optionsDates: [],
      radarDates: [],
    });
    const card = (stamp: { session: string; at: number } | null) => buildFeeds(input(stamp)).find((f) => f.key === "radar-desk");
    const fresh = card({ session: "2026-10-12", at: Date.parse(doc().as_of) });
    expect(fresh?.name).toBe("Radar desk file");
    expect(fresh?.state).toBe("ok");
    expect(fresh?.asOf).toBe(new Date(doc().as_of).toISOString());
    expect(fresh?.schedule).toContain("09:15 New York");
    expect(card(null)?.state).toBe("missing");
  });
});

describe("the Options page's Radar desk panel", () => {
  const render = async (view: ReturnType<typeof radarDeskView>) => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { RadarDeskPanel } = await import("@/components/radar-desk-panel");
    return renderToStaticMarkup(createElement(RadarDeskPanel, { view }));
  };

  it("keeps the focus names only, each with its flags and next earnings", () => {
    const rows = focusRows(doc());
    expect(rows.map((r) => r.symbol)).toEqual(["AAPL", "META", "MSFT", "NVDA"]);
    expect(rows.find((r) => r.symbol === "MSFT")).toMatchObject({ earnings: { date: "2026-10-12", when: "after the close" } });
    expect(rows.find((r) => r.symbol === "NVDA")?.flags.map((f) => f.code)).toEqual(["MACRO_HIGH_IN_HOLD", "RADAR_RISK_TAG", "LEVELS_DISAGREE"]);
    expect(coverageLine(doc())).toBe("12 of 12 built");
  });

  it("renders the focus names and never another desk name", async () => {
    const html = await render(radarDeskView(doc(), "2026-10-12"));
    for (const s of ["AAPL", "META", "MSFT", "NVDA"]) expect(html).toContain(`data-radar-desk-name="${s}"`);
    for (const s of ["AMZN", "GOOGL", "TSLA", "PLTR", "AMD", "AVGO", "NFLX", "CRM"]) expect(html).not.toContain(s);
    expect(html).toContain("Earnings in hold");
    expect(html).toContain("Not on the Radar");
    expect(html).toContain("12 of 12 built");
    // Colour first: the chips carry their tone's colour.
    expect(html).toMatch(/text-bad[^"]*"[^>]*>.*Earnings in hold/);
  });

  it("says the focus file is missing when there is none", async () => {
    const d = doc((x) => {
      x.coverage.focus_names = null;
      for (const n of x.names) n.focus = null;
    });
    const html = await render(radarDeskView(d, "2026-10-12"));
    expect(html).toContain("focus file missing");
    expect(html).not.toContain("data-radar-desk-name");
  });

  it("is a quiet line when no file exists for today's session", async () => {
    expect(radarDeskView(doc(), "2026-10-13")).toEqual({ status: "none" });
    expect(radarDeskView(null, "2026-10-12")).toEqual({ status: "none" });
    const html = await render({ status: "none" });
    expect(html).toContain("No Radar desk file for today");
  });
});

describe("the Options page's read of the file", () => {
  it("reads the session's dated copy only, checked again, and only the focus rows come back", async () => {
    const { loadRadarDeskView } = await import("@/lib/radar-desk-run");
    // VERCEL_ENV=production (beforeEach) keeps fixture mode off, so this reads the store in both test runs.
    expect((await handleIngest(post(doc()), NOW)).status).toBe(200);
    const today = await loadRadarDeskView("2026-10-12");
    expect(today.status).toBe("ok");
    expect(today.status === "ok" && today.rows.map((r) => r.symbol)).toEqual(["AAPL", "META", "MSFT", "NVDA"]);
    expect(await loadRadarDeskView("2026-10-13")).toEqual({ status: "none" });
  });
});

describe("the Radar desk code stays outside the engine and signal hashes", () => {
  it("no radar-desk file is in either import closure, and both hashes are unchanged", async () => {
    // @ts-expect-error: a plain .mjs script, no types
    const engine = (await import("../scripts/gen-engine.mjs")) as { engineFiles(): string[]; engineVersion(): string };
    // @ts-expect-error: a plain .mjs script, no types
    const signal = (await import("../scripts/gen-signal.mjs")) as { signalFiles(): string[]; signalHash(): string };
    const files = [...engine.engineFiles(), ...signal.signalFiles()].map((f) => f.replace(/\\/g, "/"));
    expect(files.filter((f) => /\/radar-desk[^/]*$/.test(f))).toEqual([]);
    expect(engine.engineVersion()).toBe(ENGINE_VERSION);
    expect(signal.signalHash()).toBe(SIGNAL_CODE_HASH);
  });
});
