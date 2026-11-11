import { handlePageState } from "@/lib/desk-page-run";

// The open Options page's own states for a settled slot, beside the server's shadow log (DEC-0044). Every check
// (same origin, JSON, size, the strict schema, the switch) is in desk-page-run.ts; Vercel Authentication is in front.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = (req: Request): Promise<Response> => handlePageState(req);

export const POST = handle;
// Answered here rather than by Next's defaults, so every other method is a plain 405 with no CORS headers.
export const GET = handle;
export const HEAD = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
