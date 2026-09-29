import { bearerMatches } from "@/lib/auth";
import { logEvent } from "@/lib/log";
import { runWatchdog } from "@/lib/watchdog-run";

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
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    logEvent("watchdog", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return Response.json({ ok: false, error: "watchdog failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
