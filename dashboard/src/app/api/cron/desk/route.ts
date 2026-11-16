import { after } from "next/server";
import { bearerMatches } from "@/lib/auth";
import { stampBoardFeed } from "@/lib/board-feed-stamp";
import { type DeskRunResult, type LoggedSlot, runDeskEval } from "@/lib/desk-run";
import { logEvent } from "@/lib/log";
import { runSignalStep } from "@/lib/signal-run";

// The server's shadow evaluation of the Options desk (DEC-0044): logs one record per settled slot, sends nothing.
// Called by Vercel Cron with the bearer CRON_SECRET, exactly like the watchdog; every check is in desk-run.ts.
// Before it, the board-feed stamp (EXP-0033, board-feed-stamp.ts): which stock feed the board reads this minute. It
// runs in its own try, so it never changes the run's answer or status. In the session it takes at most about 5.5 s (the
// SPY read, then 3 s of store work); its seal, up to 20 s, runs only outside the session, where the run is idle and
// answers at once, so both stay inside maxDuration.
// After it, the signal step (DEC-0051, signal-run.ts), under its own switch desk/signal.json: it starts only once the
// DEC-0044 record's write has settled, runs after the answer is sent, has its own 5 s budget (up to about 5.5 s with
// the read-back of a late write) and catches its own errors. In the session the three together stay under about
// 21 s (the stamp's 5.5 + the evaluator's 9.9, read-back included, + the signal step's 5.5), inside maxDuration.
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
    await stampBoardFeed();
  } catch {
    // stampBoardFeed logs its own failures and never throws; this only keeps the run's answer its own.
  }
  let r: DeskRunResult;
  let logged = null as LoggedSlot | null;
  try {
    r = await runDeskEval(undefined, (x) => {
      logged = x;
    });
  } catch (e) {
    logEvent("desk-eval", { outcome: "error", error: e instanceof Error ? e.name : "unknown" });
    return Response.json({ ok: false, error: "desk eval failed" }, { status: 500, headers: NO_STORE });
  }
  // After the answer is sent (next/server after()), so the evaluator's answer is never delayed by it. Outside a request
  // scope (a direct call, a test) after() throws and the step is started without being awaited.
  const step = () => runSignalStep(logged).catch(() => undefined);
  try {
    after(step);
  } catch {
    void step();
  }
  // The answer names the outcome only; a dry run's record stays in the process.
  const summary = r.outcome === "dry" ? { ok: r.ok, outcome: r.outcome, slot: r.slot } : r;
  return Response.json(summary, { status: r.ok ? 200 : 500, headers: NO_STORE });
}
