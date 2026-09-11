import { NextResponse } from "next/server";
import path from "node:path";
import { getAuthUser } from "@/lib/auth";
import { recognizeCardImage } from "@/lib/cardRecognize";
import { deepseekVisionEnabled } from "@/lib/deepseekVision";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** 线上用 DeepSeek、本地用 DashScope，两者都没配就不做识别（前端静默跳过） */
function visionEnabled(): boolean {
  return deepseekVisionEnabled() || !!process.env.DASHSCOPE_API_KEY;
}
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml"
};

/**
 * POST：把刚上传的卡面交给 DeepSeek 识别，返回可填表的字段。
 * 只接受本站 /uploads 下的图片路径（防目录穿越），未配置 Key 时返回 enabled:false，前端静默跳过。
 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`card-recognize:${user.id}:${clientIp(request)}`, 30, 60 * 1000)) {
    return NextResponse.json({ error: "识别太频繁，稍后再试" }, { status: 429 });
  }
  if (!visionEnabled()) {
    return NextResponse.json({ enabled: false, card: null }, { headers: NO_STORE });
  }

  const body = await request.json().catch(() => null);
  const image = String((body as { image?: unknown } | null)?.image ?? "").trim();
  if (!image.startsWith("/uploads/") || image.includes("..")) {
    return NextResponse.json({ error: "图片地址无效" }, { status: 400 });
  }
  const ext = (image.split(".").pop() ?? "").toLowerCase();
  const mime = MIME[ext];
  if (!mime) return NextResponse.json({ error: "不支持的图片格式" }, { status: 400 });

  // 上传接口返回的地址是 URL 编码过的（中文文件名），读盘前先解码
  let relative: string;
  try {
    relative = decodeURIComponent(image).replace(/^\/+/, "");
  } catch {
    return NextResponse.json({ error: "图片地址无效" }, { status: 400 });
  }
  const filePath = path.join(process.cwd(), "public", relative);
  const card = await recognizeCardImage(filePath, mime).catch(() => null);
  return NextResponse.json({ enabled: true, card }, { headers: NO_STORE });
}
