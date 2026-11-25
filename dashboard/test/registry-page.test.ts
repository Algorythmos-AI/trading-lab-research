import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Research records pages, server-rendered in fixture mode with each `fx` state: the index present, empty, missing
// and poisoned, and each sync state. What is not current must say so; nothing is shown from a poisoned index.

const cookie = vi.hoisted(() => ({ value: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (k: string) => (k === "fx" && cookie.value ? { value: cookie.value } : undefined) }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/research/records",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@vercel/blob", async () => (await import("./blob-sdk")).makeFakeBlobSdk());

const { default: RecordsPage } = await import("@/app/research/records/page");
const { default: RecordPage } = await import("@/app/research/records/[id]/page");
const { forgetDispatches } = await import("@/lib/registry-run");

const index = async (q: Record<string, string> = {}) => renderToString(await RecordsPage({ searchParams: Promise.resolve(q) }));
const record = async (id: string, q: Record<string, string> = {}) => renderToString(await RecordPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(q) }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

beforeEach(() => {
  cookie.value = "";
  forgetDispatches();
  vi.unstubAllEnvs();
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("DASHBOARD_FIXTURE", "1");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("the records page", () => {
  it("draws the index, synced, with every section and no banner", async () => {
    const t = text(await index());
    expect(t).toContain("GitHub sync");
    expect(t).toContain("Synced");
    expect(t).not.toContain("Not current");
    for (const s of ["Status by kind", "Timeline", "Recently changed", "Most depended on", "Records (12 of 12)", "Needs a look", "Trial families", "Deleted and renamed (2)"]) expect(t).toContain(s);
    expect(t).toContain("DEC-9001");
    expect(t).toContain("renamed to DEC-9004");
    expect(t).toContain("Changed since main");
  });

  it("filters from the address", async () => {
    const t = text(await index({ k: "exp" }));
    expect(t).toContain("Records (3 of 12)");
  });

  it("says Not current, with the index's commit, whenever it is not Synced", async () => {
    for (const [flag, label] of [["registry-stale", "Out of date"], ["registry-failed", "Sync failed"], ["registry-syncing", "Syncing"]] as const) {
      cookie.value = flag;
      const t = text(await index());
      expect(t).toContain(label);
      expect(t).toContain("Not current. These records are as of commit 38fc19f");
    }
    cookie.value = "registry-unknown";
    const t = text(await index());
    expect(t).toContain("Can't check");
    expect(t).toContain("Not confirmed current");
    expect(t).not.toMatch(/\bSynced\b/);
  });

  it("an empty index says so; a missing one invites Refresh; a poisoned one shows nothing of itself", async () => {
    cookie.value = "registry-empty";
    expect(text(await index())).toContain("This index holds no records.");
    cookie.value = "registry-off";
    const missing = text(await index());
    expect(missing).toContain("No index for integration yet");
    expect(missing).not.toContain("DEC-9001");
    cookie.value = "registry-poison";
    const poisoned = text(await index());
    expect(poisoned).toContain("could not be read or no longer matches its schema");
    expect(poisoned).not.toContain("DEC-9001");
  });

  it("says when main's index is not on file", async () => {
    cookie.value = "registry-no-main";
    const { loadRegistry, registryFlags } = await import("@/lib/registry-store");
    expect([[...(await registryFlags())], (await loadRegistry("main")).status]).toEqual([["registry-no-main"], "missing"]);
    expect(text(await index())).toContain("Main's index is not on file");
  });
});

describe("a record's page", () => {
  it("draws the map, links and history", async () => {
    const t = text(await record("DEC-9001"));
    expect(t).toContain("Dependency map");
    expect(t).toContain("Amended by");
    expect(t).toContain("First seen");
    expect(t).toContain("Changed since main");
  });

  it("a renamed record points at its new id; an unknown one says it is not in the index", async () => {
    expect(text(await record("DEC-9002"))).toContain("Renamed to DEC-9004");
    expect(text(await record("HYP-9002"))).toContain("Deleted");
    expect(text(await record("DEC-9999"))).toContain("DEC-9999 is not in the integration index");
  });

  it("refuses an address that is not a record id", async () => {
    await expect(record("../../etc")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
