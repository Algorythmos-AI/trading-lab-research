import { deskNote } from "@/lib/desk-state";
import { after } from "next/server";
import { entitlementForHealth } from "@/lib/entitlement";
import { calendarHealth, funnelHealth, journalHealth, ledgerHealth, optionsCloneHealth, optionsHealth, optionsLiveHealth, paperOptionsHealth, radarDeskHealth, radarHealth } from "@/lib/editions";
import { fixtureMode, loadCalendar, loadCryptoSnapshot, loadFunnel, loadHftSnapshot, loadJournal, loadLedger, loadOptions, loadOptionsClone, loadOptionsLive, loadPaperOptions, loadRadar, loadRadarDesk, loadSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const [result, crypto, hft, options, radar, optionsLive, journal, optionsClone, ledger, calendar, funnel, radarDesk, paperOptions, plan] = await Promise.all([
    loadSnapshot(),
    loadCryptoSnapshot(),
    loadHftSnapshot(),
    loadOptions(),
    loadRadar(),
    loadOptionsLive(),
    loadJournal(),
    loadOptionsClone(),
    loadLedger(),
    loadCalendar(),
    loadFunnel(),
    loadRadarDesk(),
    loadPaperOptions(),
    // Never waits on Alpaca: the instance's last answer, or a first probe raced against 300 ms (entitlement.ts).
    entitlementForHealth().catch(() => ({ value: null, pending: null })),
  ]);
  // A probe still running is kept alive past the answer, so the next reader finds it done.
  if (plan.pending) {
    try {
      after(plan.pending);
    } catch {
      // Outside a request (a unit test): the promise runs on and never rejects.
    }
  }
  // BUILD_SHA is inlined at build time (next.config.ts) by CI and `make dashboard-deploy`. `||`, not `??`:
  // VERCEL_GIT_COMMIT_SHA is an empty string on CLI deploys, which `??` would keep.
  const sha = process.env.BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null;
  return Response.json(
    {
      ok: true,
      version: sha ? sha.slice(0, 12) : "dev",
      snapshot_as_of: result.status === "ok" ? (result.snapshot.as_of ?? null) : null,
      snapshot_run_id: result.status === "ok" ? (result.snapshot.run_id ?? null) : null,
      snapshot: result.status,
      // Per-desk view (ADR 0005). The fields above stay the stocks desk's: the publisher and the deploy read them.
      desks: {
        crypto: {
          snapshot: crypto.status,
          as_of: crypto.status === "ok" ? (crypto.snapshot.as_of ?? null) : null,
          run_id: crypto.status === "ok" ? (crypto.snapshot.run_id ?? null) : null,
          // The lab's word on the desk (src/lib/desks.json): running, parked or closed. A parked desk publishes
          // nothing, and "missing" alone would read as a fault.
          state: deskNote("crypto").state,
        },
        hft: {
          snapshot: hft.status,
          as_of: hft.status === "ok" ? (hft.snapshot.as_of ?? null) : null,
          run_id: hft.status === "ok" ? (hft.snapshot.run_id ?? null) : null,
          state: deskNote("hft").state,
        },
      },
      // The research editions on file, and the newest format of each this build accepts. A publisher checks
      // `accepts` before it sends and reads `run_id` back after.
      editions: {
        options: optionsHealth(options),
        radar: radarHealth(radar),
        options_live: optionsLiveHealth(optionsLive),
        options_clone: optionsCloneHealth(optionsClone),
        journal: journalHealth(journal),
        ledger: ledgerHealth(ledger),
        calendar: calendarHealth(calendar),
        funnel: funnelHealth(funnel),
        radar_desk: radarDeskHealth(radarDesk),
        paper_options: paperOptionsHealth(paperOptions),
      },
      // What the site's keys are entitled to, asked of Alpaca: added after every older field, and left out without
      // keys, so nothing a reader of the fields above relies on moves.
      ...(plan.value ? { entitlement: plan.value } : {}),
      ...(fixtureMode() ? { fixture: true } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
