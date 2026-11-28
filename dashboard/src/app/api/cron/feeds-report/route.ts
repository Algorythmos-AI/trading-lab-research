import { bearerMatches } from "@/lib/auth";
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
  // DEC-0064 point 10: the IEX comparison is paused, not deleted. It answers "paused" and asks nothing; its cron
  // is off in vercel.json. runFeedReport (lib/feed-compare-report.ts) is kept for the way back.
  logEvent("feed-compare.report", { outcome: "paused" });
  return Response.json({ ok: true, outcome: "paused", why: "DEC-0064" }, { status: 200, headers: NO_STORE });
}
