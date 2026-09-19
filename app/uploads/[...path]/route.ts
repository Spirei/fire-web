import { getAuthUser, isAdmin } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", json: "application/json",
  html: "text/html", txt: "text/plain", woff: "font/woff", woff2: "font/woff2", pdf: "application/pdf",
  // 首页 3D 车型与隧道环境贴图（手动放进 uploads 卷，不进仓库也不进镜像）
  glb: "model/gltf-binary", gltf: "model/gltf+json", bin: "application/octet-stream",
  hdr: "image/vnd.radiance", ktx2: "image/ktx2",
  // 首页背景音乐从 uploads 卷里播（mp3 等音频素材不进公开仓库）
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", wav: "audio/wav"
};

/** 车型 / 环境贴图这类大素材：文件名带版本号即可视为不变，交给浏览器长期缓存；
 *  同时按 Range 分段返回，避免每次把上百 MB 全量读进内存再吐出去。 */
function isImmutableAsset(segments: string[]) {
  return segments[0] === "mclaren" && (segments[1] === "models" || segments[1] === "env");
}

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
    try {
      // 用户上传的素材本来就落在 ROOT（uploads 卷）里，这里只做「必须仍在 ROOT 内」的穿越防护。
      // 之前这里还要求非 reports 的路径必须位于 DEFAULT_ROOT（镜像内置素材目录）之内，
      // 等于把运行期新上传的文件（模型服务图标、头像等）全部判为非法 —— 静态命中不到时路由直接 404。
      if (!fs.realpathSync(source).startsWith(fs.realpathSync(ROOT) + path.sep)) throw new Error("Invalid path");
    } catch {
      // 回退到镜像内置素材：只有这一支才要求路径位于 DEFAULT_ROOT 内（reports 不参与回退）。
      source = defaultAbs;
      if (segs[0] === "reports" || !fs.realpathSync(source).startsWith(fs.realpathSync(DEFAULT_ROOT) + path.sep)) throw new Error("Invalid path");
    }
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error("Not a file");
    const ext = (path.extname(source) || "").slice(1).toLowerCase();
    const headers: Record<string, string> = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // 头像等上传可能同名重传，不能 immutable；浏览器每次重新校验，避免缓存旧图
      // 运行期上传的素材同样极少变化：先让浏览器复用上次成功加载的副本，再后台静默校验。
      // 车型 / 环境贴图按文件名版本化，直接 immutable，刷新不再重新校验。
      "Cache-Control":
        segs[0] === "reports"
          ? "private, no-store"
          : isImmutableAsset(segs)
            ? "public, max-age=31536000, immutable"
            : "public, max-age=3600, stale-while-revalidate=86400",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'"
    };
    // 大素材走流式 + Range：模型动辄上百 MB，整块读进内存既慢又容易把容器内存打满
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        // bytes=-500 是「最后 500 字节」（后缀区间），不能当成从 0 开始 —— 音频 / 视频播放器常用这种写法
        const suffix = !match[1] && match[2] ? Number(match[2]) : 0;
        const start = suffix > 0 ? Math.max(0, stat.size - suffix) : match[1] ? Number(match[1]) : 0;
        const end = suffix > 0 ? stat.size - 1 : match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (Number.isFinite(start) && start <= end && start < stat.size) {
          const stream = Readable.toWeb(fs.createReadStream(source, { start, end })) as ReadableStream<Uint8Array>;
          return new NextResponse(stream, {
            status: 206,
            headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": String(end - start + 1) }
          });
        }
      }
    }
    const stream = Readable.toWeb(fs.createReadStream(source)) as ReadableStream<Uint8Array>;
    return new NextResponse(stream, { headers: { ...headers, "Content-Length": String(stat.size) } });
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
}
