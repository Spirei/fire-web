import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", json: "application/json",
  html: "text/html", txt: "text/plain", woff: "font/woff", woff2: "font/woff2", pdf: "application/pdf"
};

/** 动态服务上传目录 public/uploads/…：
 *  Next `next start` 只服务构建/启动时已存在的 public 文件，运行时上传的文件不会被静态服务，
 *  这里统一从磁盘读取并返回（存在静态命中→正常；不存在→该路由兜底），保证所有上传即时可访问。 */
const ROOT = path.join(process.cwd(), "public", "uploads");
// Docker 运行时 /app/public/uploads 通常由宿主机 volume 覆盖；当旧容器或
// 首次启动复制默认素材失败时，从镜像内的只读资源副本兜底，避免内置旗帜/图标 404。
const DEFAULT_ROOT = path.join(process.cwd(), "resource-default");

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path: segs } = await ctx.params;
  const rel = (segs || []).join("/");
  if (!rel || rel.includes("..") || rel.includes("\0")) {
    return new NextResponse("Bad Request", { status: 400 });
  }
  const normalized = path.normalize(rel);
  const abs = path.join(ROOT, normalized);
  const defaultAbs = path.join(DEFAULT_ROOT, normalized);
  if (!abs.startsWith(ROOT) || !defaultAbs.startsWith(DEFAULT_ROOT)) {
    return new NextResponse("Bad Request", { status: 400 });
  }
  try {
    let source = abs;
    let data: Buffer;
    try {
      data = fs.readFileSync(source);
    } catch {
      source = defaultAbs;
      data = fs.readFileSync(source);
    }
    const ext = (path.extname(source) || "").slice(1).toLowerCase();
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        // 头像等上传可能同名重传，不能 immutable；浏览器每次重新校验，避免缓存旧图
        "Cache-Control": "public, max-age=0, must-revalidate"
      }
    });
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
}
