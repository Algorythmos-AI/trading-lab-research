import { handleDeskFlags } from "@/lib/desk-flags-run";

// The owner's "done for today" flag. Every check (same origin, JSON, size, the one action) is in desk-flags-run.ts;
// the site's gate in front of it is Vercel Authentication, as for every page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = (req: Request): Promise<Response> => handleDeskFlags(req);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
// Answered here rather than by Next's defaults, so every other method is a plain 405 with no CORS headers.
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
