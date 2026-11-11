import { bearerMatches } from "@/lib/auth";
import { runCronTicks } from "@/lib/cron-watchdog";
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
  // Every tick is separate and in its own time budget (cron-watchdog.ts): the stocks desk's first, then each added
  // desk's, then the feed watch (feed-watch-run.ts). A tick that throws or hangs is logged and reported, and the next
  // one still runs.
  const { stocks, desks, feeds } = await runCronTicks({
    stocks: () => runWatchdog(),
    desks: (Object.keys(DESK_DEPS) as AddedDesk[]).map((desk) => [desk, () => runDeskWatchdog(desk)] as const),
    feeds: () => runFeedWatch(),
    log: logEvent,
  });
  if (!stocks) return Response.json({ ok: false, error: "watchdog failed", desks, feeds }, { status: 500, headers: NO_STORE });
  return Response.json({ ...stocks, desks, feeds }, { headers: NO_STORE });
}
