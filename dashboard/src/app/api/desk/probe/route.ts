import { handleProbeSummary } from "@/lib/quote-probe-run";

// The snapshot probe's counts for one New York day, for the owner only (temporary evidence for the board's bad-data
// guards). Every check is in quote-probe-run.ts; Vercel Authentication is in front.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const handle = (req: Request): Promise<Response> => handleProbeSummary(req);

export const GET = handle;
export const HEAD = handle;
// Answered here rather than by Next's defaults, so every other method is a plain 405 with no CORS headers.
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
