import { handleFeedsLive } from "@/lib/feeds-live-route";

// The Feeds page's live section: the board's own stock feed only (DEC-0050 point 5). Every check is in
// feeds-live-route.ts; Vercel Authentication is in front.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = (req: Request): Promise<Response> => handleFeedsLive(req);

export const GET = handle;
export const HEAD = handle;
// Answered here rather than by Next's defaults, so every other method is a plain 405 with no CORS headers.
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
