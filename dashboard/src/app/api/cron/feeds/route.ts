import { bearerMatches } from "@/lib/auth";
import { logEvent } from "@/lib/log";

// The paired feed sampler (DEC-0050 point 5): once a minute in the session, one snapshots request on iex and one on
// sip, stored side by side, create-only and private. Data quality only; it sends nothing and places nothing.
// Called by Vercel Cron with the bearer CRON_SECRET, exactly like /api/cron/desk; every check is in feed-compare-sample.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request): Promise<Response> {
  if (!bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    logEvent("feed-compare.sample", { outcome: "unauthorized", configured: Boolean(process.env.CRON_SECRET) });
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  // DEC-0064 point 10: the IEX comparison is paused, not deleted. It answers "paused" and asks nothing; its cron
  // is off in vercel.json. runFeedSample (lib/feed-compare-sample.ts) is kept for the way back.
  logEvent("feed-compare.sample", { outcome: "paused" });
  return Response.json({ ok: true, outcome: "paused", why: "DEC-0064" }, { status: 200, headers: NO_STORE });
}
