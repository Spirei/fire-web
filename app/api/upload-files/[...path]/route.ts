import { GET as serveUpload } from "@/app/uploads/[...path]/route";
import { NextRequest } from "next/server";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return serveUpload(request, ctx);
}
