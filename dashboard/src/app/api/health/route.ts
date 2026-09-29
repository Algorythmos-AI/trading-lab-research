import { fixtureMode, loadSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await loadSnapshot();
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.BUILD_SHA ?? null;
  return Response.json(
    {
      ok: true,
      version: sha ? sha.slice(0, 12) : "dev",
      snapshot_as_of: result.status === "ok" ? (result.snapshot.as_of ?? null) : null,
      snapshot: result.status,
      ...(fixtureMode() ? { fixture: true } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
