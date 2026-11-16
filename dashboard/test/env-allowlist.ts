// The evidence-class allowlist (lib/env.ts): every frame that is not the owner's real money, page by page. A page may
// show exactly these non-real frames, each named by its class and its label (EnvFrame's `label`), and no other: a new
// paper, shadow or model region anywhere on these pages fails test/env-pages.test.ts until it is listed here.
//
// THE OWNER APPROVES EVERY CHANGE TO THIS LIST. An automated contributor proposes a change in a pull request and says
// why; it never widens the list to make a test pass. Real (Webull) frames are the owner's own money and are not listed.
import type { Env } from "@/lib/env";

export type NonRealFrame = { env: Exclude<Env, "real">; label: string };

export const NON_REAL_FRAMES = {
  /** /options (the desk, live view): the hand-traded Alpaca paper account's positions, and the rule replay. */
  options: [
    { env: "paper", label: "Manual option positions" },
    { env: "model", label: "Rule replay" },
  ],
  /** / (the Overview): Robot B's one-line result (paper). The scan beside it is counts only, unframed. */
  overview: [{ env: "paper", label: "Robot B" }],
  /** /today: Robot B's panes (paper), its detail (paper), and the forward test (a model). The pre-market scan is unframed. */
  today: [
    { env: "paper", label: "Robot B" },
    { env: "paper", label: "Robot B, in detail" },
    { env: "model", label: "Forward test" },
  ],
  /** /trades: the options clone (paper). */
  trades: [{ env: "paper", label: "Options clone" }],
  /** /risk: Robot B's safety controls and its paper broker account (paper). */
  risk: [{ env: "paper", label: "Robot B" }],
} as const satisfies Record<string, readonly NonRealFrame[]>;

export type GuardedPage = keyof typeof NON_REAL_FRAMES;
