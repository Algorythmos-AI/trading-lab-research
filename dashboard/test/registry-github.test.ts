import { beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_TTL_MS, REGISTRY_REPO, dispatchRegistry, forgetGithub, readGithub } from "@/lib/registry-github";

// The only code that holds the GitHub token: what it asks, what it makes of each answer, and that the token goes
// nowhere but GitHub's API.

const HEAD = "c".repeat(40);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ok = (url: string) =>
  url.includes("/branches/")
    ? json(200, { commit: { sha: HEAD, commit: { committer: { date: "2026-10-07T00:00:00Z" } } } })
    : json(200, { workflow_runs: [{ status: "in_progress", conclusion: null, head_sha: HEAD, created_at: "2026-10-07T00:01:00Z", event: "push", html_url: "x", actor: { login: "y" } }] });

beforeEach(() => {
  forgetGithub();
  vi.unstubAllEnvs();
  vi.stubEnv("GITHUB_REGISTRY_TOKEN", "tok-123");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("reading GitHub", () => {
  it("asks for the branch head and the registry job's runs, with the token, and keeps only what it needs", async () => {
    const f = vi.fn(async (...a: [string | URL | Request, RequestInit?]) => ok(String(a[0])));
    const v = await readGithub("integration", f as unknown as typeof fetch, 1_000);
    expect(v).toEqual({ ok: true, head: HEAD, headAt: "2026-10-07T00:00:00Z", runs: [{ status: "in_progress", conclusion: null, head_sha: HEAD, created_at: "2026-10-07T00:01:00Z", event: "push" }] });
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([`https://api.github.com/repos/${REGISTRY_REPO}/branches/integration`, `https://api.github.com/repos/${REGISTRY_REPO}/actions/workflows/registry.yml/runs?branch=integration&per_page=10`]);
    const init = f.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
  });

  it("shares a read for its TTL, then asks again", async () => {
    const f = vi.fn(async (...a: [string | URL | Request, RequestInit?]) => ok(String(a[0])));
    await readGithub("main", f as unknown as typeof fetch, 1_000);
    await readGithub("main", f as unknown as typeof fetch, 1_000 + GITHUB_TTL_MS - 1);
    expect(f).toHaveBeenCalledTimes(2);
    await readGithub("main", f as unknown as typeof fetch, 1_000 + GITHUB_TTL_MS);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("names each failure, and never reads as current", async () => {
    const cases: [Response, string][] = [
      [json(401, {}), "unauthorized"],
      [json(404, {}), "not-found"],
      [json(403, {}, { "x-ratelimit-remaining": "0" }), "rate-limited"],
      [json(403, {}, { "x-ratelimit-remaining": "4999" }), "forbidden"],
      [json(429, {}), "rate-limited"],
      [json(500, {}), "unreachable"],
      [json(200, { commit: { sha: "not-a-sha" } }), "unreachable"],
    ];
    for (const [res, reason] of cases) {
      forgetGithub();
      const f = vi.fn(async (u: string | URL | Request) => (String(u).includes("/branches/") ? res.clone() : ok(String(u))));
      expect(await readGithub("integration", f as unknown as typeof fetch, 1)).toEqual({ ok: false, reason });
    }
    forgetGithub();
    const boom = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await readGithub("integration", boom as unknown as typeof fetch, 1)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("asks nothing without a token", async () => {
    vi.stubEnv("GITHUB_REGISTRY_TOKEN", "");
    const f = vi.fn();
    expect(await readGithub("integration", f as unknown as typeof fetch, 1)).toEqual({ ok: false, reason: "no-token" });
    expect(await dispatchRegistry("integration", f as unknown as typeof fetch)).toEqual({ ok: false, reason: "no-token" });
    expect(f).not.toHaveBeenCalled();
  });

  it("ignores a malformed run list rather than failing", async () => {
    const f = vi.fn(async (u: string | URL | Request) => (String(u).includes("/branches/") ? ok(String(u)) : json(200, { workflow_runs: [null, { status: 3 }] })));
    const v = await readGithub("integration", f as unknown as typeof fetch, 1);
    expect(v.ok && v.runs).toEqual([]);
  });
});

describe("dispatching the job", () => {
  it("dispatches registry.yml on the branch, and forgets the kept reads", async () => {
    const f = vi.fn(async (...a: [string | URL | Request, RequestInit?]) => ok(String(a[0])));
    await readGithub("integration", f as unknown as typeof fetch, 1);
    const d = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await dispatchRegistry("integration", d as unknown as typeof fetch)).toEqual({ ok: true });
    const [url, init] = d.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/${REGISTRY_REPO}/actions/workflows/registry.yml/dispatches`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ ref: "integration" });
    await readGithub("integration", f as unknown as typeof fetch, 2);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("names a refusal", async () => {
    expect(await dispatchRegistry("main", (async () => json(403, {})) as unknown as typeof fetch)).toEqual({ ok: false, reason: "forbidden" });
    expect(await dispatchRegistry("main", (async () => json(422, {})) as unknown as typeof fetch)).toEqual({ ok: false, reason: "unreachable" });
    expect(await dispatchRegistry("main", (async () => {
      throw new Error("x");
    }) as unknown as typeof fetch)).toEqual({ ok: false, reason: "unreachable" });
  });
});
