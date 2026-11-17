import "server-only";
import { loadRadarDesk } from "./snapshot";
import { validateRadarDesk } from "./validate";
import { radarDeskView, type RadarDeskView } from "./radar-desk-view";

// The Options page's read of the Radar desk file: the dated copy for the session on the board, never the latest, and
// checked again against its schema before anything is drawn. Only the focus rows leave this function.

/** The panel's view for `session` (YYYY-MM-DD): none when no file was sent for it, unreadable when the store failed. */
export async function loadRadarDeskView(session: string): Promise<RadarDeskView> {
  const r = await loadRadarDesk(session);
  if (r.status === "missing") return { status: "none" };
  if (r.status !== "ok") return { status: "unreadable" };
  const v = validateRadarDesk(r.doc);
  return v.ok ? radarDeskView(v.doc, session) : { status: "unreadable" };
}
