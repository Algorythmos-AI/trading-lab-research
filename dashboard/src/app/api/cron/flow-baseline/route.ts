import { bearerMatches } from "@/lib/auth";
import { runFlowBaseline } from "@/lib/flow-baseline-run";
import { logEvent } from "@/lib/log";

// The day's volume baseline for /api/flow: built once before the open, create-only and private, from the previous 20
// full sessions' 2-minute SIP bars. Called by Vercel Cron with the bearer CRON_SECRET, exactly like /api/cron/desk;
// every check is in flow-baseline-run.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request): Promise<Response> {
  if (!bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    logEvent("flow.baseline", { outcome: "unauthorized", configured: Boolean(process.env.CRON_SECRET) });
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const r = await runFlowBaseline();
  // A build to retry answers 200: the next tick tries again; only an unexpected failure is a 500.
  return Response.json(r, { status: r.ok ? 200 : 500, headers: NO_STORE });
}
