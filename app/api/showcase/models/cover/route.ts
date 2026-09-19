import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getAuthUser, isTrustedMutationRequest } from "@/lib/auth";
import { COVERS_DIR, setModelCover, validModelId } from "@/lib/showcaseModels";
import { validateImageContent } from "@/lib/imageSecurity";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const MAX_BYTES = 6 * 1024 * 1024;
const EXTS = ["png", "jpg", "jpeg", "webp"];

/** 上传某辆车的自定义封面（卡片与将来其他入口都用它） */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  if (!rateLimit(`showcase-cover:${clientIp(request)}`, 40, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "上传过于频繁，请稍后再试" }, { status: 429 });
  }
  const url = new URL(request.url);
  const id = String(url.searchParams.get("id") ?? "").trim().toLowerCase();
  const rawName = String(url.searchParams.get("name") ?? "cover.jpg").trim();
  const ext = (rawName.split(".").pop() ?? "").toLowerCase();
  if (!validModelId(id)) return NextResponse.json({ error: "车型不存在" }, { status: 404 });
  if (!EXTS.includes(ext)) return NextResponse.json({ error: "封面只支持 PNG / JPG / WEBP" }, { status: 400 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared && declared > MAX_BYTES) return NextResponse.json({ error: "封面请控制在 6MB 以内" }, { status: 413 });
  const buffer = Buffer.from(await request.arrayBuffer());
  if (!buffer.length) return NextResponse.json({ error: "没有收到图片内容" }, { status: 400 });
  if (buffer.length > MAX_BYTES) return NextResponse.json({ error: "封面请控制在 6MB 以内" }, { status: 413 });
  const validated = validateImageContent(buffer, ext);
  if (!validated) return NextResponse.json({ error: "图片内容与格式不匹配" }, { status: 400 });
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  const filename = `${id}-${Date.now()}.${validated}`;
  try {
    fs.writeFileSync(path.join(COVERS_DIR, filename), buffer);
    const entry = setModelCover(id, `/uploads/mclaren/covers/${filename}`);
    return NextResponse.json({ cover: entry.cover });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "封面保存失败" }, { status: 400 });
  }
}

/** 移除自定义封面（回到用车型代号占位） */
export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  const id = String(new URL(request.url).searchParams.get("id") ?? "").trim().toLowerCase();
  if (!validModelId(id)) return NextResponse.json({ error: "车型不存在" }, { status: 404 });
  try {
    setModelCover(id, "");
    return NextResponse.json({ cover: "" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "移除失败" }, { status: 400 });
  }
}
