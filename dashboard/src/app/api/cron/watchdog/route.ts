import { bearerMatches } from "@/lib/auth";
import { logEvent } from "@/lib/log";
import { runCryptoWatchdog, runWatchdog } from "@/lib/watchdog-run";

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
    // The crypto desk's tick is separate and must never take the stocks desk's down with it.
    const crypto = await runCryptoWatchdog().catch((e: unknown) => {
      logEvent("watchdog", { outcome: "error", desk: "crypto", error: e instanceof Error ? e.name : "unknown" });
      return { ok: false, desk: "crypto" };
    });
    return Response.json({ ...result, desks: { crypto } }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    logEvent("watchdog", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return Response.json({ ok: false, error: "watchdog failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
