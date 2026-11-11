// The ticks of GET /api/cron/watchdog. No started tick is ever abandoned: a tick that commits an alert level and
// then fails to page must be able to write its rollback, so every tick is awaited before the route replies.
//
// What the budgets do. The feed watch's tick starts at once, beside the desks' (it reads and writes only its own
// state), so a hanging store in a desk's tick can never starve it. The desks' ticks run one after another as before;
// a desk's budget only decides when the NEXT desk's tick may start. Before replying the route waits for every started
// tick (Promise.allSettled), up to CRON_CAP_MS from the start of the request; anything still running then is handed
// to Next's `after()` (on Vercel, the platform's waitUntil), which keeps the function alive for it up to its
// maxDuration. Each desk's budget (14 s) exceeds ntfy's send timeout (10 s, ntfy.ts) plus two state writes.
//
// Time: desks start by 0 + 14 (stocks) + 14 (each of 2 added desks) = at most 28 s after the request (the third
// would start at 42 s; there are two, and a closed one returns at once); the feed tick runs from 0 within its own 25 s
// budget (feed-watch-run.ts) plus its reads' limits; the cap is 55 s, inside the route's maxDuration of 60 s. The
// residual: a tick still unfinished at 60 s is cut off by the platform, as any function would be.

export type TickResult = Record<string, unknown>;

export const TICK_BUDGET_MS = { stocks: 14_000, desk: 14_000 } as const;
/** How long the route waits for every started tick before replying (and handing the rest to `after`). */
export const CRON_CAP_MS = 55_000;

export interface CronTicks {
  stocks: () => Promise<TickResult>;
  desks: readonly (readonly [string, () => Promise<TickResult>])[];
  feeds: () => Promise<TickResult>;
  log: (evt: string, fields: Record<string, unknown>) => void;
  /** Keeps work alive after the reply (Next's `after`); in tests, a recorder. */
  defer: (work: () => Promise<unknown>) => void;
}

const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");
/** `p` raced against a timer that is always cleared: "late" when the timer won. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => {
    timer = setTimeout(() => r("late"), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every tick, none abandoned. `stocks` is null when that tick threw or had not finished by the cap. */
export async function runCronTicks(
  t: CronTicks,
  budgets: { stocks: number; desk: number } = TICK_BUDGET_MS,
  capMs: number = CRON_CAP_MS,
): Promise<{ stocks: TickResult | null; desks: Record<string, TickResult>; feeds: TickResult }> {
  const started = Date.now();
  const desksNamed = new Set(t.desks.map(([d]) => d));
  const settle = (name: string, p: Promise<TickResult>) =>
    p.catch((e: unknown): TickResult => {
      const desk = desksNamed.has(name) ? { desk: name } : {};
      t.log(name === "feeds" ? "feed-watch" : "watchdog", { outcome: "error", ...desk, error: errName(e) });
      return { ok: false, ...desk, ...(name === "stocks" ? { error: "tick failed" } : {}) };
    });
  const running: Promise<TickResult>[] = [];
  const results: Record<string, TickResult | undefined> = {};
  const start = (name: string, fn: () => Promise<TickResult>) => {
    const p = settle(name, Promise.resolve().then(fn)).then((r) => (results[name] = r));
    running.push(p);
    return p;
  };

  start("feeds", t.feeds);
  // The desks one after another: the next starts when the last one finished or its budget ran out.
  await within(start("stocks", t.stocks), budgets.stocks);
  for (const [desk, run] of t.desks) await within(start(desk, run), budgets.desk);

  const left = Math.max(0, capMs - (Date.now() - started));
  const all = Promise.allSettled(running);
  if ((await within(all, left)) === "late") {
    t.log("watchdog", { outcome: "deferred", unfinished: running.length - Object.keys(results).length });
    t.defer(() => all);
  }
  const unfinished = (name: string): TickResult => results[name] ?? { ok: false, still_running: true };
  const desks: Record<string, TickResult> = {};
  for (const [desk] of t.desks) desks[desk] = unfinished(desk);
  return { stocks: results.stocks?.error === "tick failed" ? null : (results.stocks ?? null), desks, feeds: unfinished("feeds") };
}
