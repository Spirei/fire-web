import { getAuthUser, isAdmin } from "@/lib/auth";
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
  if (segs[0] === "reports") { const user = getAuthUser(request); if (!user || !isAdmin(user)) return new NextResponse("Forbidden", { status: 403 }); }
  const normalized = path.normalize(rel);
  const abs = path.join(ROOT, normalized);
  const defaultAbs = path.join(DEFAULT_ROOT, normalized);
  if (!abs.startsWith(ROOT + path.sep) || !defaultAbs.startsWith(DEFAULT_ROOT + path.sep)) {
    return new NextResponse("Bad Request", { status: 400 });
  }
  try {
    let source = abs;
    let data: Buffer;
    try {
      if (!fs.realpathSync(source).startsWith(fs.realpathSync(ROOT) + path.sep)) throw new Error("Invalid path");
      if (segs[0] === "reports" || !fs.realpathSync(source).startsWith(fs.realpathSync(DEFAULT_ROOT) + path.sep)) throw new Error("Invalid path");
      data = fs.readFileSync(source);
    } catch {
      source = defaultAbs;
      if (segs[0] === "reports" || !fs.realpathSync(source).startsWith(fs.realpathSync(DEFAULT_ROOT) + path.sep)) throw new Error("Invalid path");
      data = fs.readFileSync(source);
    }
    const ext = (path.extname(source) || "").slice(1).toLowerCase();
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        // 头像等上传可能同名重传，不能 immutable；浏览器每次重新校验，避免缓存旧图
        // 运行期上传的素材同样极少变化：先让浏览器复用上次成功加载的副本，再后台静默校验。
        "Cache-Control": segs[0] === "reports" ? "private, no-store" : "public, max-age=3600, stale-while-revalidate=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'"
      }
    });
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
}
