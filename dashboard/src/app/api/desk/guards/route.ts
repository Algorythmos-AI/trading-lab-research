import { handleGuards } from "@/lib/desk-guards-run";

// The bad-data guards' switches (desk/guards.json), for the Options page to read again while its live board is on.
// Every check is in desk-guards-run.ts; Vercel Authentication is in front.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = (req: Request): Promise<Response> => handleGuards(req);

export const GET = handle;
export const HEAD = handle;
// Answered here rather than by Next's defaults, so every other method is a plain 405 with no CORS headers.
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
