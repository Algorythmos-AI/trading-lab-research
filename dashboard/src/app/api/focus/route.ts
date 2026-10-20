import { handleFocus } from "@/lib/focus-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleFocus(req);
}
