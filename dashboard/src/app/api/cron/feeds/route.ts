import { bearerMatches } from "@/lib/auth";
import { runFeedSample } from "@/lib/feed-compare-sample";
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
  const r = await runFeedSample();
  return Response.json(r, { status: r.ok ? 200 : 500, headers: NO_STORE });
}
