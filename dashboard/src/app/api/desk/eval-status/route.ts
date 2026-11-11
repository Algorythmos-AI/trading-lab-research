import { handleEvalStatus } from "@/lib/desk-page-run";

// The server check's switch and the last slot it logged, for the Options page's status line (DEC-0044). Every check
// is in desk-page-run.ts; Vercel Authentication is in front.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = (req: Request): Promise<Response> => handleEvalStatus(req);

export const GET = handle;
export const HEAD = handle;
// Answered here rather than by Next's defaults, so every other method is a plain 405 with no CORS headers.
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
