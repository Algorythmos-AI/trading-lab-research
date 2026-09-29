/** One JSON line per event. Callers pass only secret-free fields (never bodies, headers or env values). */
export function logEvent(evt: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ evt, at: new Date().toISOString(), ...fields }));
}
