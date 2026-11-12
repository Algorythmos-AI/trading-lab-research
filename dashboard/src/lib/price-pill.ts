import type { DataFeed } from "./feed-provenance";
import { nyNow, sessionOf } from "./market-calendar";
import { nyInstant } from "./options";
import { FEED_STALE_MS } from "./trade-state";

// The header pill on the Options page: how fresh the page's live prices are, in place of the lab's status snapshot
// (which the board does not read). It says what the page's own 2-second poll last did, never more: "live" means the
// last answer arrived within the board's own limit (FEED_STALE_MS), and the age shown is the time since that answer,
// so a poll that has stopped reads "paused" within seconds. Outside the regular session it says the market is closed
// rather than call pre-market or overnight prices live. Display only: no state, level or guard reads it.

/** What the Options page's live layer tells the header about its price poll; null when no page is polling. */
export interface PriceStatus {
  status: "loading" | "ok" | "error" | "off";
  /** The feed the last answer named, when it named one. */
  source: DataFeed | null;
  /** The browser clock when the last good answer arrived; null before the first. */
  receivedAt: number | null;
  /** The poll is waiting to try again after a failure. */
  retrying: boolean;
}

export type PricePillState = "live" | "paused" | "connecting" | "off" | "closed";

export interface PricePill {
  state: PricePillState;
  /** The words on a wide screen. */
  full: string;
  /** The words on a phone. */
  short: string;
  /** The longer explanation behind the pill. */
  title: string;
}

const FEED_NAME: Record<DataFeed, string> = { sip: "SIP", iex: "IEX" };

/** True from the regular session's open to its close on a session day (holidays and half days from the calendar). */
export function regularSessionOpen(nowMs: number): boolean {
  const now = new Date(nowMs);
  const { day } = nyNow(now);
  const s = sessionOf(day);
  if (s.open === null || s.close === null) return false;
  const open = nyInstant(day, s.open);
  const close = nyInstant(day, s.close);
  return open !== null && close !== null && nowMs >= open && nowMs < close;
}

const POLLED = "polled every 2 s, not streaming";

/** The pill for a price poll at `nowMs` (the browser clock, the same clock `receivedAt` was read on). */
export function pricePill(p: PriceStatus, nowMs: number): PricePill {
  if (p.status === "off") return { state: "off", full: "Live prices off", short: "Prices off", title: "This page is not reading live prices." };
  if (!regularSessionOpen(nowMs)) {
    return { state: "closed", full: "Market closed", short: "Closed", title: "Outside the regular session: prices on this page are not live." };
  }
  const ageS = p.receivedAt === null ? null : Math.max(0, Math.floor((nowMs - p.receivedAt) / 1000));
  if (p.status === "ok" && ageS !== null && !p.retrying && ageS * 1000 <= FEED_STALE_MS) {
    const feed = p.source ? ` · ${FEED_NAME[p.source]}` : "";
    return { state: "live", full: `Prices live${feed} · ${ageS} s`, short: `Live ${ageS}s`, title: `Last price check ${ageS} s ago; ${POLLED}.` };
  }
  if (p.status === "loading" && ageS === null) return { state: "connecting", full: "Prices connecting", short: "Connecting", title: `Waiting for the first price answer; ${POLLED}.` };
  const age = ageS === null ? "" : ` · ${ageS} s`;
  return {
    state: "paused",
    full: `Prices paused${age}`,
    short: ageS === null ? "Paused" : `Paused ${ageS}s`,
    title: ageS === null ? "No price answer yet: check your platform." : `No price answer for ${ageS} s: check your platform.`,
  };
}
