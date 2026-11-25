import { handleRegistryStatus } from "@/lib/registry-run";

// The Reference Registry's sync status for one branch (?b=integration|main). Every check is in registry-run.ts; the
// site's gate in front of it is Vercel Authentication, as for every page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = (req: Request): Promise<Response> => handleRegistryStatus(req);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
