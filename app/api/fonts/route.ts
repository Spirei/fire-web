import { NextResponse } from "next/server";
import { getAuthUser, isTrustedMutationRequest } from "@/lib/auth";
import { readFormBody, RequestBodyTooLargeError } from "@/lib/requestBody";
import { FONT_MAX_BYTES, listCustomFonts, saveCustomFont } from "@/lib/customFonts";
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({ fonts: listCustomFonts(Number(user.uid)) }, { headers: { "Cache-Control": "private, no-store" } });
}
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  try {
    const form = await readFormBody(request, FONT_MAX_BYTES + 64 * 1024);
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "请选择字体文件" }, { status: 400 });
    const font = saveCustomFont(Number(user.uid), file.name, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ font });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "字体不能超过 10 MB" }, { status: 413 });
    return NextResponse.json({ error: error instanceof Error && !('code' in error) ? error.message : "上传失败，请重试" }, { status: 400 });
  }
}
