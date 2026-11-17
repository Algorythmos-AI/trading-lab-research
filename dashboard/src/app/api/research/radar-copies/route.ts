import { handleRadarCopies } from "@/lib/radar-copies-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleRadarCopies(req);
}
