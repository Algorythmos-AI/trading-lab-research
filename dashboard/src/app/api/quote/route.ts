import { handleQuote } from "@/lib/quote-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleQuote(req);
}
