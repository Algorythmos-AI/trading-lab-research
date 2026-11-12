import { handleContract } from "@/lib/contract-quote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleContract(req);
}
