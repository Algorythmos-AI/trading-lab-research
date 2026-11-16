import type { HeldLot } from "./option-value";
import type { ManualNote } from "./trade-manage";

// The contract an "I'm in" note names: its strike and expiry, so the card can quote the option and watch the −25%
// premium stop from the first second, not only once the journal (read every 15 minutes) shows the trade. Owner
// decision, 2026-11-17. Kept beside the notes in this browser, apart from ManualNote, whose type is in the signal's
// hashed code: no hashed file imports this module (test/held-marks.test.ts checks).

export const CONTRACT_PREFIX = "trade-now-contract:";
export const contractKey = (day: string) => `${CONTRACT_PREFIX}${day}`;

export interface NoteContract {
  strike: number;
  /** YYYY-MM-DD. */
  expiry: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STRIKE = 100_000;

/** A stored contract, or null for anything that is not one. */
export function parseContract(v: unknown): NoteContract | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 2) return null;
  if (typeof o.strike !== "number" || !Number.isFinite(o.strike) || o.strike <= 0 || o.strike > MAX_STRIKE) return null;
  if (typeof o.expiry !== "string" || !DAY_RE.test(o.expiry) || !Number.isFinite(Date.parse(`${o.expiry}T00:00:00Z`))) return null;
  return { strike: o.strike, expiry: o.expiry };
}

/** A day's stored contracts by note id; anything unreadable is left out. */
export function parseContracts(raw: string | null | undefined): Record<string, NoteContract> {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, NoteContract> = {};
  for (const [id, c] of Object.entries(v as Record<string, unknown>)) {
    const p = parseContract(c);
    if (p) out[id] = p;
  }
  return out;
}

export type StrikeCheck = { ok: true; contract: NoteContract | null } | { ok: false; error: string };

/**
 * The form's two boxes: an empty strike is no contract (the note is saved without one); a strike must be a price
 * above zero in dollars and cents or halves; the expiry must be a date, today's by default.
 */
export function checkContract(strikeRaw: string, expiryRaw: string, session: string): StrikeCheck {
  const s = strikeRaw.trim();
  if (s === "") return { ok: true, contract: null };
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return { ok: false, error: "Type the strike as a price, like 102.5." };
  const strike = Number(s);
  if (!(strike > 0) || strike > MAX_STRIKE) return { ok: false, error: "Type the strike as a price, like 102.5." };
  const e = expiryRaw.trim() || session;
  if (!DAY_RE.test(e) || !Number.isFinite(Date.parse(`${e}T00:00:00Z`))) return { ok: false, error: `Type the expiry as a date, like ${session}.` };
  if (e < session) return { ok: false, error: "That expiry has passed: type today's date or a later one." };
  return { ok: true, contract: { strike, expiry: e } };
}

/**
 * The one lot a note names, for the card's live option value (option-value.ts lotsContract): its contract, its
 * contracts and the price a share it typed. None without both a contract and a typed option fill.
 */
export function noteHeldLots(note: Pick<ManualNote, "symbol" | "side" | "fill">, contract: NoteContract | null | undefined): HeldLot[] {
  if (!contract || !note.fill) return [];
  return [{ symbol: note.symbol, kind: note.side, side: "long", strike: contract.strike, expiry: contract.expiry, qty: note.fill.contracts, entry: note.fill.priceCents / 100 }];
}
