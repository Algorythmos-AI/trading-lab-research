import { bearerMatches } from "@/lib/auth";
import { logEvent } from "@/lib/log";
import { runDrill } from "@/lib/watchdog-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/cron/watchdog-drill (bearer CRON_SECRET): sends two real DRILL pages through the watchdog's own
 * code path on in-memory state, so the dead-man's switch can be proven end to end without touching its state.
 * Called by `make watchdog-drill`. Not a cron: vercel.json never schedules it, and GET is not allowed.
 */
export async function POST(req: Request): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (!bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    logEvent("watchdog.drill", { outcome: "unauthorized", configured: Boolean(process.env.CRON_SECRET) });
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  }
  try {
    return Response.json(await runDrill(), { headers });
  } catch (e) {
    logEvent("watchdog.drill", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return Response.json({ ok: false, error: "drill failed" }, { status: 500, headers });
  }
}
