// The ticks of GET /api/cron/watchdog, each in its own time budget, so a tick that hangs (a store that never answers)
// can never use up the function's 60 s and starve the ticks after it: the stocks desk's, then each added desk's, then
// the feed watch's, which in a total outage is the one that says so ("Feed watch cannot read its store"). The ticks'
// own logic is untouched; a tick past its budget is reported as timed out and left to finish or fail on its own.

export type TickResult = Record<string, unknown>;

/** Milliseconds each tick may take: 12 + 8 per added desk (2) + 28 = 56, inside the route's maxDuration of 60. */
export const TICK_BUDGET_MS = { stocks: 12_000, desk: 8_000, feeds: 28_000 } as const;

class TickTimedOut extends Error {
  constructor() {
    super("tick timed out");
    this.name = "TickTimedOut";
  }
}

function budget<T>(p: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TickTimedOut()), ms);
  });
  return Promise.race([Promise.resolve().then(p), t]).finally(() => clearTimeout(timer));
}

export interface CronTicks {
  stocks: () => Promise<TickResult>;
  desks: readonly (readonly [string, () => Promise<TickResult>])[];
  feeds: () => Promise<TickResult>;
  log: (evt: string, fields: Record<string, unknown>) => void;
}

/** Every tick in turn, each isolated and in its budget. `stocks` is null when that tick threw or timed out. */
export async function runCronTicks(
  t: CronTicks,
  budgets: { stocks: number; desk: number; feeds: number } = TICK_BUDGET_MS,
): Promise<{ stocks: TickResult | null; desks: Record<string, TickResult>; feeds: TickResult }> {
  const why = (e: unknown) => (e instanceof TickTimedOut ? "timed-out" : e instanceof Error ? e.name : "unknown");
  let stocks: TickResult | null = null;
  try {
    stocks = await budget(t.stocks, budgets.stocks);
  } catch (e) {
    t.log("watchdog", { outcome: "error", error: why(e) });
  }
  const desks: Record<string, TickResult> = {};
  for (const [desk, run] of t.desks) {
    desks[desk] = await budget(run, budgets.desk).catch((e: unknown) => {
      t.log("watchdog", { outcome: "error", desk, error: why(e) });
      return { ok: false, desk, ...(e instanceof TickTimedOut ? { timed_out: true } : {}) };
    });
  }
  const feeds = await budget(t.feeds, budgets.feeds).catch((e: unknown) => {
    t.log("feed-watch", { outcome: "error", error: why(e) });
    return { ok: false, ...(e instanceof TickTimedOut ? { timed_out: true } : {}) };
  });
  return { stocks, desks, feeds };
}
