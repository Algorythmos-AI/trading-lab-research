import { optionsHealth, radarHealth } from "@/lib/editions";
import { fixtureMode, loadCryptoSnapshot, loadHftSnapshot, loadOptions, loadRadar, loadSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const [result, crypto, hft, options, radar] = await Promise.all([loadSnapshot(), loadCryptoSnapshot(), loadHftSnapshot(), loadOptions(), loadRadar()]);
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
      // Per-desk view (ADR 0005). The fields above stay the stocks desk's: the publisher and the deploy read them.
      desks: {
        crypto: {
          snapshot: crypto.status,
          as_of: crypto.status === "ok" ? (crypto.snapshot.as_of ?? null) : null,
          run_id: crypto.status === "ok" ? (crypto.snapshot.run_id ?? null) : null,
        },
        hft: {
          snapshot: hft.status,
          as_of: hft.status === "ok" ? (hft.snapshot.as_of ?? null) : null,
          run_id: hft.status === "ok" ? (hft.snapshot.run_id ?? null) : null,
        },
      },
      // The research editions on file, and the newest format of each this build accepts. A publisher checks
      // `accepts` before it sends and reads `run_id` back after.
      editions: { options: optionsHealth(options), radar: radarHealth(radar) },
      ...(fixtureMode() ? { fixture: true } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
