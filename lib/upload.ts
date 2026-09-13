/* ---------- 文件上传核心（Web 旧接口与 v1 移动端接口共用） ---------- */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { getAuthUser, isAdmin, updateUserAvatar } from "@/lib/auth";
import { removeFileIfUnused } from "@/lib/fileCleanup";
import { normalizeSvgAttribution, sanitizeSvg, validateImageContent } from "@/lib/imageSecurity";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export type UploadKind = "avatar" | "ico" | "background" | "logo" | "login" | "asset";

const KIND_CONFIG: Record<UploadKind, { exts: string[]; maxBytes: number; hint: string }> = {
  avatar: {
    exts: ["jpg", "jpeg", "png", "gif", "webp"],
    maxBytes: 5 * 1024 * 1024,
    hint: "允许 JPG、PNG、GIF、WEBP 格式，最大尺寸 5MB"
  },
  ico: {
    exts: ["jpg", "jpeg", "png", "gif", "webp", "ico", "svg"],
    maxBytes: 1024 * 1024,
    hint: "允许 JPG、PNG、GIF、WEBP、ICO、SVG 格式，最大尺寸 1024KB"
  },
  background: {
    exts: ["jpg", "jpeg", "png", "gif", "webp"],
    maxBytes: 10 * 1024 * 1024,
    hint: "允许 JPG、PNG、GIF、WEBP 格式，最大尺寸 10MB"
  },
  logo: {
    exts: ["jpg", "jpeg", "png", "gif", "webp", "svg"],
    maxBytes: 2 * 1024 * 1024,
    hint: "允许 JPG、PNG、GIF、WEBP、SVG 格式，最大尺寸 2MB"
  },
  login: {
    exts: ["jpg", "jpeg", "png", "gif", "webp"],
    maxBytes: 10 * 1024 * 1024,
    hint: "允许 JPG、PNG、GIF、WEBP 格式，最大尺寸 10MB"
  },
  asset: {
    exts: ["jpg", "jpeg", "png", "gif", "webp", "svg"],
    maxBytes: 2 * 1024 * 1024,
    hint: "允许 JPG、PNG、GIF、WEBP、SVG 格式，最大尺寸 2MB"
  }
};

export class UploadError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/* 素材文件规范命名：中文名 + 英文简称/代码
 *  - 市场图标：中文名+市场码（如 美股US.svg / 新加坡SG.svg）
 *  - 加密货币/贵金属：中文名+代码（如 比特币BTC.svg / 黄金GOLD.png）
 *  - 股票图标：中文名+股票代码（如 苹果AAPL.png，与素材库同步一致）
 *  - 自定义卡面：银行名+卡名+地区码（如 中国银行长城借记卡CN.png；同一地区的卡名不会重复）
 */
function assetFilename(
  form: FormData,
  folder: string,
  ext: string
): string {
  const name = String(form.get("name") ?? "").trim();
  const code = String(form.get("code") ?? "").trim().toUpperCase();
  const market = String(form.get("market") ?? "").trim().toUpperCase();
  const base =
    name
      .replace(/[\\/:*?"<>|\s()（）[\]{}]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") ||
    code ||
    "asset";
  if (folder === "market" && market) return `${base}${market}${ext}`;
  if (code) return `${base}${code}${ext}`;
  return `${base}${ext}`;
}

/** 校验并保存上传文件，返回可访问 URL（失败抛 UploadError） */
export async function saveUpload(request: Request): Promise<{ url: string; kind: UploadKind }> {
  const user = getAuthUser(request);
  if (!user) throw new UploadError("未登录", 401);
  if (!rateLimit(`upload:${clientIp(request)}:${user.id}`, 60, 60 * 60 * 1000) || !rateLimitGlobal("upload", 600, 60 * 60 * 1000)) {
    throw new UploadError("上传过于频繁，请稍后再试", 429);
  }
  const form = await request.formData().catch(() => null);
  if (!form) throw new UploadError("无效的上传请求", 400);
  const kind = String(form.get("kind") ?? "avatar") as UploadKind;
  const config = KIND_CONFIG[kind];
  if (!config) throw new UploadError("不支持的上传类型", 400);
  const folder = String(form.get("folder") ?? "").trim();
  if (kind === "asset" && folder && !["market", "flag", "crypto", "metal", "stock", "broker", "group", "icon", "card"].includes(folder)) {
    throw new UploadError("无效的素材文件夹", 400);
  }
  // 卡面（folder=card）单独放宽：手机拍的卡片原图动辄十几 MB，其它素材仍按类别限制
  const maxBytes = folder === "card" ? 20 * 1024 * 1024 : config.maxBytes;
  const sizeHint = folder === "card" ? `${config.hint.split("，最大")[0]}，最大尺寸 20MB` : config.hint;
  if (kind !== "avatar" && !isAdmin(user)) {
    throw new UploadError("需要管理员权限", 403);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new UploadError("请选择要上传的文件", 400);
  }
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!config.exts.includes(ext)) throw new UploadError(sizeHint, 400);
  if (file.size > maxBytes) throw new UploadError(`文件过大，${sizeHint}`, 400);
  const buffer = Buffer.from(await file.arrayBuffer());
  const validatedExt = validateImageContent(buffer, ext);
  if (!validatedExt) {
    throw new UploadError("文件内容与图片格式不匹配或包含不安全内容", 400);
  }
  const outputBuffer = validatedExt === "svg" ? sanitizeSvg(normalizeSvgAttribution(buffer)) : buffer;
  let dir = path.join(process.cwd(), "public", "uploads", kind);
  let urlPrefix = `/uploads/${kind}`;
  if (kind === "asset" && folder) {
    const market = String(form.get("market") ?? "").trim().toUpperCase();
    if (folder === "stock" && market && ["US", "HK", "CN", "JP", "KR"].includes(market)) {
      dir = path.join(dir, "stock", market);
      urlPrefix = `/uploads/asset/stock/${market}`;
    } else {
      dir = path.join(dir, folder);
      urlPrefix = `/uploads/asset/${folder}`;
    }
  }
  // 命名规范：素材按「中文名+代码」；头像按「登录名(UID编号)」（如 admin(UID1)，无冒号分隔）；其他类型保持时间戳随机名
  let filename: string;
  if (kind === "asset") {
    filename = assetFilename(form, folder, `.${ext}`);
  } else if (kind === "avatar") {
    const username = (user as { username?: string }).username ?? "user";
    const uid = (user as { uid?: string }).uid ?? "";
    const stem = `${username}(UID${uid})`.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "avatar";
    filename = `${stem}.${ext}`;
  } else {
    filename = `${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), outputBuffer);
  } catch {
    throw new UploadError("文件保存失败，请检查磁盘空间或上传目录权限", 500);
  }
  const url = `${urlPrefix}/${encodeURIComponent(filename)}`;
  if (kind === "avatar") {
    const old = (user as { avatar?: string }).avatar;
    updateUserAvatar(user.id, url);
    if (old && old !== url) removeFileIfUnused(old);
  }
  logSecurityEvent(request, user.id, "file_upload", `${kind}:${file.size}:${validatedExt}`);
  return { url, kind };
}

/** User-owned group icons have a separate write path; shared assets remain admin-only. */
export async function saveWatchGroupIcon(request: Request, groupId: string) {
  const user = getAuthUser(request);
  if (!user) throw new UploadError("未登录", 401);
  if (!/^[a-zA-Z0-9_-]+$/.test(groupId) || !/^[a-zA-Z0-9_-]+$/.test(user.id)) throw new UploadError("分组不存在", 404);
  const { getOwnedWatchGroup, updateWatchGroup } = await import("./watchGroupsStore");
  const group = getOwnedWatchGroup(user.id, groupId);
  if (!group) throw new UploadError("分组不存在", 404);
  if (group.kind !== "custom") throw new UploadError("市场分组不支持自定义图标", 400);
  if (!rateLimit(`group-icon:${user.id}`, 30, 60 * 60 * 1000) || !rateLimitGlobal("group-icon", 300, 60 * 60 * 1000)) throw new UploadError("上传过于频繁", 429);
  const config = KIND_CONFIG.asset;
  if (Number(request.headers.get("content-length")) > config.maxBytes + 65536) throw new UploadError("文件过大，最大 2MB", 413);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || !file.size) throw new UploadError("请选择要上传的文件");
  if (file.size > config.maxBytes) throw new UploadError("文件过大，最大 2MB", 413);
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!config.exts.includes(ext)) throw new UploadError(config.hint);
  const bytes = Buffer.from(await file.arrayBuffer());
  const valid = validateImageContent(bytes, ext);
  if (!valid) throw new UploadError("文件内容与图片格式不匹配或包含不安全内容");
  const output = valid === "svg" ? sanitizeSvg(normalizeSvgAttribution(bytes)) : bytes;
  const nameForm = new FormData(); nameForm.set("name", group.name);
  const filename = assetFilename(nameForm, "group", `.${valid}`);
  const dir = path.join(process.cwd(), "public", "uploads", "asset", "group", user.id, groupId);
  const url = `/uploads/asset/group/${user.id}/${groupId}/${encodeURIComponent(filename)}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), output);
  const updated = updateWatchGroup(user.id, groupId, { icon: url });
  if (group.icon && group.icon !== url) removeFileIfUnused(group.icon);
  logSecurityEvent(request, user.id, "group_icon_upload", groupId);
  return updated;
}
