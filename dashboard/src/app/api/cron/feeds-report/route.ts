import { bearerMatches } from "@/lib/auth";
import { runFeedReport } from "@/lib/feed-compare-report";
import { logEvent } from "@/lib/log";

// The day's feed comparison report (DEC-0050 point 5): built once after the close, create-only and private, from the
// day's samples, the session's bars on iex and sip and the feed-agreement replay. Data quality only.
// Called by Vercel Cron with the bearer CRON_SECRET, exactly like /api/cron/desk; every check is in feed-compare-report.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request): Promise<Response> {
  if (!bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    logEvent("feed-compare.report", { outcome: "unauthorized", configured: Boolean(process.env.CRON_SECRET) });
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const r = await runFeedReport();
  // A build to retry answers 200: the next tick tries again; only an unexpected failure is a 500.
  return Response.json(r, { status: r.ok || r.outcome === "retry" ? 200 : 500, headers: NO_STORE });
}
