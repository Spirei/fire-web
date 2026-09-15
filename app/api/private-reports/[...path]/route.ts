import { GET as serveUpload } from "@/app/uploads/[...path]/route";
import { NextRequest } from "next/server";
export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) { const params = await ctx.params; return serveUpload(request, { params: Promise.resolve({ path: ["reports", ...params.path] }) }); }
