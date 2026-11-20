// The evidence-class allowlist (lib/env.ts): every frame that is not the owner's real money, page by page. A page may
// show exactly these non-real frames, each named by its class and its label (EnvFrame's `label`), and no other: a new
// paper, shadow or model region anywhere on these pages fails test/env-pages.test.ts until it is listed here.
//
// THE OWNER APPROVES EVERY CHANGE TO THIS LIST. An automated contributor proposes a change in a pull request and says
// why; it never widens the list to make a test pass. Real (Webull) frames are the owner's own money and are not listed.
import type { Env } from "@/lib/env";

export type NonRealFrame = { env: Exclude<Env, "real">; label: string };

export const NON_REAL_FRAMES = {
  /** /options (the desk, live view): the rule replay. The hand-traded paper account's positions pane is gone (2026-11-20). */
  options: [{ env: "model", label: "Rule replay" }],
  /** / (the Overview): the three robots in a state word each and the scan in counts. No money, so no frame. */
  overview: [],
  /** /today: the forward test (a model). The three robots (states only) and the pre-market scan (counts) are unframed. */
  today: [{ env: "model", label: "Forward test" }],
  /** /trades: the options clone (paper). */
  trades: [{ env: "paper", label: "Options clone" }],
  /**
   * /paper (DEC-0057): two books, each with a card at the top and a section below, and no real money anywhere.
   * The options clone (paper): its glance card, today's session (the same panel as on /trades) and its history. The
   * research arms' simulated trades (shadow): their glance card and their section. The hand-placed paper account's
   * two frames went with that account (2026-11-20).
   */
  paper: [
    { env: "paper", label: "Options clone at a glance" },
    { env: "paper", label: "Options clone" },
    { env: "paper", label: "Options clone history" },
    { env: "shadow", label: "Research arms at a glance" },
    { env: "shadow", label: "Research arms" },
  ],
  /** /risk: the owner's own account, then the robots' alerts and the kill switch. No paper money, so no frame. */
  risk: [],
  /** /gap-hunter: the stock robot's own page, all of it its paper desk. The frame Robot B's page had, under the robot's new name. */
  "gap-hunter": [{ env: "paper", label: "Gap Hunter" }],
} as const satisfies Record<string, readonly NonRealFrame[]>;

export type GuardedPage = keyof typeof NON_REAL_FRAMES;
