import { bearerMatches } from "@/lib/auth";
import { logEvent } from "@/lib/log";
import { DESK_DEPS, runDeskWatchdog, runWatchdog, type AddedDesk } from "@/lib/watchdog-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    logEvent("watchdog", { outcome: "unauthorized", configured: Boolean(process.env.CRON_SECRET) });
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  try {
    const result = await runWatchdog();
    // Every added desk's tick is separate, runs after the stocks desk's, and must never take another desk's down
    // with it: a tick that throws is logged and reported, and the next desk's tick still runs.
    const desks: Record<string, Record<string, unknown>> = {};
    for (const desk of Object.keys(DESK_DEPS) as AddedDesk[]) {
      desks[desk] = await runDeskWatchdog(desk).catch((e: unknown) => {
        logEvent("watchdog", { outcome: "error", desk, error: e instanceof Error ? e.name : "unknown" });
        return { ok: false, desk };
      });
    }
    return Response.json({ ...result, desks }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    logEvent("watchdog", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return Response.json({ ok: false, error: "watchdog failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
