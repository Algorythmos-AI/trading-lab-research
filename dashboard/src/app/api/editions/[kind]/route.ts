import { handleEdition } from "@/lib/edition-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }): Promise<Response> {
  const { kind } = await ctx.params;
  return handleEdition(req, kind);
}
