import { NextResponse } from "next/server";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "crypto";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { CELEBS } from "@/lib/celebs";
import { getCelebAvatars } from "@/lib/celebsData";
import { removeFileIfUnused } from "@/lib/fileCleanup";
import { validateImageContent } from "@/lib/imageSecurity";

export const dynamic = "force-dynamic";

const AVATARS_FILE = path.join(process.cwd(), "data", "celebs-avatars.json");
const DEFAULT_AVATARS_FILE = path.join(process.cwd(), "public", "uploads", "celebs", "default-avatars.json");
const EXTS = ["jpg", "jpeg", "png", "gif", "webp"];
const MAX_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "无效的上传请求" }, { status: 400 });
  const id = String(form.get("id") ?? "").trim();
  if (!CELEBS.some((c) => c.id === id)) return NextResponse.json({ error: "未知的名人" }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "请选择要上传的图片" }, { status: 400 });
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!EXTS.includes(ext)) return NextResponse.json({ error: "允许 JPG、PNG、GIF、WEBP 格式" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "图片最大 2MB" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!validateImageContent(buffer, ext)) {
    return NextResponse.json({ error: "文件内容与图片格式不匹配" }, { status: 400 });
  }
  const dir = path.join(process.cwd(), "public", "uploads", "celebs");
  mkdirSync(dir, { recursive: true });
  const filename = `${id}-custom-${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
  writeFileSync(path.join(dir, filename), buffer);
  const avatar = `/uploads/celebs/${filename}`;

  const avatars = getCelebAvatars();
  // 替换旧头像：删除上一个本地文件，保留唯一
  if (avatars[id]) removeFileIfUnused(avatars[id]);
  avatars[id] = avatar;
  mkdirSync(path.dirname(AVATARS_FILE), { recursive: true });
  writeFileSync(AVATARS_FILE, JSON.stringify(avatars, null, 2));
  // 同步一份可随源码 / Docker 镜像发布的默认映射。public/uploads/celebs
  // 在镜像中会进入 resource-default，新群晖数据盘首次启动也能找到正确头像。
  mkdirSync(path.dirname(DEFAULT_AVATARS_FILE), { recursive: true });
  writeFileSync(DEFAULT_AVATARS_FILE, JSON.stringify(avatars, null, 2));
  return NextResponse.json({ avatar });
}
