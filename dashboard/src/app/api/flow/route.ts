import { handleFlow } from "@/lib/flow-route";

// The flow data for the allowed names (EXP-0032's blind), on SIP only. Every check is in flow-route.ts; Vercel
// Authentication is in front.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = (req: Request): Promise<Response> => handleFlow(req);

export const GET = handle;
export const HEAD = handle;
// Answered here rather than by Next's defaults, so every other method is a plain 405 with no CORS headers.
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
