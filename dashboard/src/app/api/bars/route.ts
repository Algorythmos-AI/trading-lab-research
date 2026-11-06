import { handleBars } from "@/lib/bars-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleBars(req);
}
