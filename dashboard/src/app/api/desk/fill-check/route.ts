import { handleFillCheck } from "@/lib/fill-check-run";

// The fill-time check of DEC-0049 point 4, for the owner only: GET answers the stored result (or "not_run"), POST
// with {"confirm":"run-once"} runs it once. Every check is in fill-check-run.ts; Vercel Authentication is in front.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const handle = (req: Request): Promise<Response> => handleFillCheck(req);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
// Answered here rather than by Next's defaults, so every other method is a plain 405 with no CORS headers.
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
