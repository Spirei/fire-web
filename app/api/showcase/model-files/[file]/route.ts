import { NextRequest, NextResponse } from "next/server";
import { GET as serveUpload } from "@/app/uploads/[...path]/route";
import { validModelFile } from "@/lib/showcaseModels";

/** 绕开 public 对隐藏草稿的拦截；沿用 uploads 的路径防护、流式读取和 Range。 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ file: string }> }
) {
  const { file } = await ctx.params;
  if (!validModelFile(file)) return new NextResponse("Bad Request", { status: 400 });
  return serveUpload(request, { params: Promise.resolve({ path: ["mclaren", "models", file] }) });
}
