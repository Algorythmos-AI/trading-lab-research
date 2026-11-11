import { bearerMatches } from "@/lib/auth";
import { runFeedWatch } from "@/lib/feed-watch-run";
import { logEvent } from "@/lib/log";
import { DESK_DEPS, runDeskWatchdog, runWatchdog, type AddedDesk } from "@/lib/watchdog-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request): Promise<Response> {
  if (!bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    logEvent("watchdog", { outcome: "unauthorized", configured: Boolean(process.env.CRON_SECRET) });
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  // Every tick is separate and must never take another down with it: the stocks desk's first, then each added desk's,
  // then the feed watch (feed-watch-run.ts). A tick that throws is logged and reported, and the next one still runs.
  let stocks: Record<string, unknown> | null = null;
  try {
    stocks = await runWatchdog();
  } catch (e) {
    logEvent("watchdog", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
  }
  const desks: Record<string, Record<string, unknown>> = {};
  for (const desk of Object.keys(DESK_DEPS) as AddedDesk[]) {
    desks[desk] = await runDeskWatchdog(desk).catch((e: unknown) => {
      logEvent("watchdog", { outcome: "error", desk, error: e instanceof Error ? e.name : "unknown" });
      return { ok: false, desk };
    });
  }
  const feeds = await runFeedWatch().catch((e: unknown) => {
    logEvent("feed-watch", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return { ok: false };
  });
  if (!stocks) return Response.json({ ok: false, error: "watchdog failed", desks, feeds }, { status: 500, headers: NO_STORE });
  return Response.json({ ...stocks, desks, feeds }, { headers: NO_STORE });
}
