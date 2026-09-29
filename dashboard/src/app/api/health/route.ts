import { fixtureMode, loadSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await loadSnapshot();
  // BUILD_SHA is inlined at build time (next.config.ts) by CI and `make dashboard-deploy`. `||`, not `??`:
  // VERCEL_GIT_COMMIT_SHA is an empty string on CLI deploys, which `??` would keep.
  const sha = process.env.BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null;
  return Response.json(
    {
      ok: true,
      version: sha ? sha.slice(0, 12) : "dev",
      snapshot_as_of: result.status === "ok" ? (result.snapshot.as_of ?? null) : null,
      snapshot_run_id: result.status === "ok" ? (result.snapshot.run_id ?? null) : null,
      snapshot: result.status,
      ...(fixtureMode() ? { fixture: true } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
