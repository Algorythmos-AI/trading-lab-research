// The browser's side of the server's shadow check (DEC-0044, section 2), without React or the DOM: the page's
// render feeds it each second (tick), and it reads the status and sends the page's states. Everything it touches is
// passed in, so the rules below are tested on fake clocks.
//
//  * Nothing at all while the switch is off: the server render says whether it is on, and an off page never builds
//    one of these, so it makes no request about the check.
//  * The status (the switch, the server's last slot) is read when polling starts and then at most once a minute: a
//    tab coming back into view reads it only when the last read is a minute old.
//  * The page's states as of the slot: taken at its first render at or after the slot's close (end +
//    CLOSE_GRACE_MS, the instant the server evaluates), and sent once the slot settles (end + SERVER_SETTLE_MS),
//    beside its states at that later moment (`rows_at_settle`, what the owner would see as an alert arrived).
//  * A slot the page did not see whole is not comparable: hidden for any moment of it, or opened inside it (the
//    first partial slot). It is sent as hidden, never as states. A slot whose close the page did not render is not
//    sent at all.
import { BAR_MS, ENGINE_VERSION, expectedSlots, settledSlotEnd, stateRows, type StateRow } from "./desk-eval";
import { CLOSE_GRACE_MS, type NameState, SERVER_SETTLE_MS } from "./trade-state";

export const STATUS_EVERY_MS = 60_000;

export interface EvalStatus {
  eval: "off" | "log";
  /** The last slot the server logged among its latest ones (its end, ms), or null. */
  last: number | null;
  /** When it was read, on the board's (server) clock. */
  readAt: number;
}

/** The answer's check: exactly `{ eval, last_slot_end }`, or null. */
export function parseEvalStatus(v: unknown, readAt: number): EvalStatus | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.eval !== "off" && o.eval !== "log") return null;
  if (o.last_slot_end === null) return { eval: o.eval, last: null, readAt };
  if (typeof o.last_slot_end !== "string") return null;
  const t = Date.parse(o.last_slot_end);
  return Number.isFinite(t) ? { eval: o.eval, last: t, readAt } : null;
}

export interface ShadowDeps {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The browser's clock, ms. */
  browserNow(): number;
  visible(): boolean;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  /** Where the status goes for the rail. */
  publish(s: EvalStatus): void;
}

export interface Tick {
  /** The board is live and its bars have answered. */
  live: boolean;
  session: string;
  states: readonly NameState[];
  /** The board's (server) clock, and the browser's at the same render. */
  now: number | null;
  browserNow: number | null;
  /** The session bars are late or failing: the states use the page's own prices only. */
  barsDelayed: boolean;
}

interface Snap {
  rows: StateRow[];
  asOf: number;
  barsDelayed: boolean;
}

const URL_STATUS = "/api/desk/eval-status";
const URL_POST = "/api/desk/page-state";

export class DeskShadowCore {
  private status: EvalStatus | null = null;
  private lastRead = -Infinity;
  private timer: unknown = null;
  /** When this tab was last seen coming into view (browser ms): it was created visible or hidden, so its first
   * partial slot reads as not seen whole. */
  private shownAt: number;
  private lastSent: number | null = null;
  private snaps = new Map<number, Snap>();
  private offset = 0;

  /** When this page began (browser ms): a slot that ended before it is none of its business. */
  private readonly createdAt: number;

  constructor(private readonly deps: ShadowDeps) {
    this.shownAt = deps.browserNow();
    this.createdAt = this.shownAt;
  }

  /** Read the status now and then every STATUS_EVERY_MS. */
  start(): void {
    if (this.timer !== null) return;
    void this.read();
    this.timer = this.deps.setInterval(() => void this.read(), STATUS_EVERY_MS);
  }

  stop(): void {
    if (this.timer !== null) this.deps.clearInterval(this.timer);
    this.timer = null;
  }

  /** The tab's visibility changed. Coming into view: remembered, and a status read only if the last is a minute old. */
  onVisibility(): void {
    if (!this.deps.visible()) return;
    this.shownAt = this.deps.browserNow();
    if (this.timer !== null && this.deps.browserNow() - this.lastRead >= STATUS_EVERY_MS) void this.read();
  }

  private async read(): Promise<void> {
    if (!this.deps.visible()) return;
    this.lastRead = this.deps.browserNow();
    try {
      const res = await this.deps.fetch(URL_STATUS, { cache: "no-store", credentials: "same-origin" });
      const body: unknown = res.ok ? await res.json() : null;
      const parsed = parseEvalStatus(body, this.deps.browserNow() + this.offset);
      if (parsed) {
        this.status = parsed;
        this.deps.publish(parsed);
      }
    } catch {
      // kept as it was; the rail stops trusting an old read
    }
  }

  /** One render: keep the slot's states at its close, and send a settled slot once. */
  tick(t: Tick): void {
    if (t.now === null || t.browserNow === null) return;
    this.offset = t.now - t.browserNow;
    if (!t.live || this.status?.eval !== "log") return;
    const slots = expectedSlots(t.session);
    // The page's states as of the slot: its first render at or after the slot's close, before the slot settles.
    const closed = Math.floor((t.now - CLOSE_GRACE_MS) / BAR_MS) * BAR_MS;
    if (slots.includes(closed) && !this.snaps.has(closed) && t.now < closed + SERVER_SETTLE_MS)
      this.snaps.set(closed, { rows: t.states.flatMap(stateRows), asOf: t.now, barsDelayed: t.barsDelayed });
    const slot = settledSlotEnd(t.now);
    if (!slots.includes(slot) || (this.lastSent !== null && slot <= this.lastSent)) return;
    this.lastSent = slot; // before the request: at most one post per slot, even when it fails
    if (slot <= this.createdAt + this.offset) return;
    const snap = this.snaps.get(slot);
    for (const k of [...this.snaps.keys()]) if (k <= slot) this.snaps.delete(k);
    const hidden = !this.deps.visible() || this.shownAt + this.offset > slot - BAR_MS;
    // Its close was not rendered, or there were no states: nothing comparable to send.
    if (!hidden && (!snap || snap.rows.length === 0 || t.states.length === 0)) return;
    void this.deps
      .fetch(URL_POST, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json" }, body: pageBody(slot, hidden ? null : snap!, t.states) })
      .catch(() => undefined);
  }
}

/** What the page sends for a slot: its states as of the slot and at settle, or hidden. */
export function pageBody(slotEnd: number, snap: Snap | null, statesNow: readonly NameState[]): string {
  const base = { slot_end: new Date(slotEnd).toISOString(), engine: ENGINE_VERSION };
  if (!snap) return JSON.stringify({ ...base, hidden: true });
  return JSON.stringify({ ...base, as_of: new Date(snap.asOf).toISOString(), bars_delayed: snap.barsDelayed, rows: snap.rows, rows_at_settle: statesNow.flatMap(stateRows) });
}
