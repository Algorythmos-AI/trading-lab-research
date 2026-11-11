"use client";

// The price typed in an open trade ticket, held in this tab's memory only (never stored, never sent), so the "I'm in"
// form on the same name and side can start from it. Gone when the ticket closes, unmounts or the tab reloads.
const typed = new Map<string, string>();
const key = (symbol: string, side: "call" | "put") => `${symbol}|${side}`;

/** The ticket for this name and side is open with this price typed; an empty price or a closed ticket forgets it. */
export function rememberTicketPrice(symbol: string, side: "call" | "put", price: string | null) {
  if (price && price.trim()) typed.set(key(symbol, side), price);
  else typed.delete(key(symbol, side));
}

/** The price typed in this tab's open ticket for the name and side, or null. */
export function ticketPrice(symbol: string, side: "call" | "put"): string | null {
  return typed.get(key(symbol, side)) ?? null;
}
