import { bearerMatches } from "@/lib/auth";
import { runDeskEval } from "@/lib/desk-run";
import { logEvent } from "@/lib/log";

// The server's shadow evaluation of the Options desk (DEC-0044): logs one record per settled slot, sends nothing.
// Called by Vercel Cron with the bearer CRON_SECRET, exactly like the watchdog; every check is in desk-run.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request): Promise<Response> {
  if (!bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    logEvent("desk-eval", { outcome: "unauthorized", configured: Boolean(process.env.CRON_SECRET) });
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  try {
    const r = await runDeskEval();
    // The answer names the outcome only; a dry run's record stays in the process.
    const summary = r.outcome === "dry" ? { ok: r.ok, outcome: r.outcome, slot: r.slot } : r;
    return Response.json(summary, { status: r.ok ? 200 : 500, headers: NO_STORE });
  } catch (e) {
    logEvent("desk-eval", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return Response.json({ ok: false, error: "desk eval failed" }, { status: 500, headers: NO_STORE });
  }
}
