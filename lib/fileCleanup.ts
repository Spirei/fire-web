import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const CELEB_AVATARS_FILE = path.join(process.cwd(), "data", "celebs-avatars.json");

export function isLocalUrl(url: string | undefined | null): url is string {
  return !!url && /^\/uploads\//.test(url);
}

function safeDecode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

export function localPathOf(url: string): string {
  const decoded = safeDecode(url);
  if (!isLocalUrl(decoded) || decoded.includes("\0")) throw new Error("无效的本地素材路径");
  const target = path.resolve(PUBLIC_DIR, decoded.replace(/^\/+/, ""));
  if (!target.startsWith(PUBLIC_DIR + path.sep)) throw new Error("本地素材路径越界");
  return target;
}

/* 图片是否仍被引用（assets / 网站设置 / 用户头像 / 名人头像） */
export function urlReferenced(url: string): boolean {
  if (!isLocalUrl(url)) return false;
  const db = getDb();
  const a = (db.prepare("SELECT COUNT(*) AS c FROM assets WHERE url = ?").get(url) as { c: number }).c;
  const s = (db.prepare("SELECT COUNT(*) AS c FROM site_settings WHERE value = ?").get(url) as { c: number }).c;
  const u = (db.prepare("SELECT COUNT(*) AS c FROM users WHERE avatar = ?").get(url) as { c: number }).c;
  const c = (db.prepare("SELECT COUNT(*) AS c FROM celebs WHERE avatar = ?").get(url) as { c: number }).c;
  let celebJson = 0;
  try {
    const avatars = JSON.parse(fs.readFileSync(CELEB_AVATARS_FILE, "utf8")) as Record<string, string>;
    if (Object.values(avatars).includes(url)) celebJson = 1;
  } catch {
    /* 无文件忽略 */
  }
  return a + s + u + c + celebJson > 0;
}

/* 删除本地文件（仅当没有其他引用，避免误删共享图片） */
export function removeFileIfUnused(url: string | undefined | null): boolean {
  if (!isLocalUrl(url)) return false;
  if (urlReferenced(url)) return false;
  try {
    const file = localPathOf(url);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
  } catch {
    /* 忽略删除失败 */
  }
  return false;
}

/* 素材库文件归类：把根目录历史图标移到对应子文件夹（market / crypto / metal / stock/{市场}），并更新引用 */
export function organizeAssetFiles(): number {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, type, market, url FROM assets WHERE url LIKE '/uploads/asset/%' AND url NOT LIKE '/uploads/asset/stock/%'"
    )
    .all() as { id: string; type: string; market: string; url: string }[];
  let moved = 0;
  for (const r of rows) {
    if (!isLocalUrl(r.url)) continue;
    let file: string;
    try {
      file = localPathOf(r.url);
    } catch {
      continue;
    }
    if (!fs.existsSync(file)) continue;
    let folder: string;
    if (r.type === "market") folder = "market";
    else if (r.type === "crypto") folder = "crypto";
    else if (r.type === "metal") folder = "metal";
    else if (r.type === "icon") folder = "icon";
    else folder = `stock/${(r.market || "OTHER").toUpperCase()}`;
    const filename = path.basename(safeDecode(r.url));
    const dir = path.join(PUBLIC_DIR, "uploads", "asset", folder);
    const target = path.join(dir, filename);
    if (target === file) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(file, target);
      db.prepare("UPDATE assets SET url = ? WHERE id = ?").run(
        `/uploads/asset/${folder}/${encodeURIComponent(filename)}`,
        r.id
      );
      moved += 1;
    } catch {
      /* 单个失败跳过 */
    }
  }
  return moved;
}

/* 清理孤立文件：扫描 public/uploads 下未被任何记录引用的文件（历史遗留 / 替换后残留） */
export function cleanupOrphanFiles(): { removed: number; failed: number } {
  const db = getDb();
  const refs = new Set<string>();
  const addRef = (url: string | null | undefined) => {
    if (isLocalUrl(url)) refs.add(safeDecode(url));
  };
  (db.prepare("SELECT url FROM assets").all() as { url: string }[]).forEach((r) => addRef(r.url));
  (db.prepare("SELECT avatar FROM users WHERE avatar <> ''").all() as { avatar: string }[]).forEach((r) => addRef(r.avatar));
  (db.prepare("SELECT avatar FROM celebs WHERE avatar <> ''").all() as { avatar: string }[]).forEach((r) => addRef(r.avatar));
  (
    db.prepare("SELECT value FROM site_settings WHERE key IN ('ico','homepageBg','siteLogo')").all() as { value: string }[]
  ).forEach((r) => addRef(r.value));
  try {
    const avatars = JSON.parse(fs.readFileSync(CELEB_AVATARS_FILE, "utf8")) as Record<string, string>;
    Object.values(avatars).forEach((u) => addRef(u));
  } catch {
    /* 忽略 */
  }

  let removed = 0;
  let failed = 0;
  const now = Date.now();
  const SAFE_MS = 24 * 60 * 60 * 1000; // 安全期：最近 24h 内的未引用文件不清理（防误删刚上传未保存的资源）
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "trading-square" && path.basename(dir) === "uploads") continue;
        walk(full);
        continue;
      }
      const rel = "/" + path.relative(PUBLIC_DIR, full);
      let fresh = false;
      try {
        fresh = now - fs.statSync(full).mtimeMs < SAFE_MS;
      } catch {
        /* 无法 stat 按旧文件处理 */
      }
      if (!refs.has(rel) && !fresh) {
        try {
          fs.unlinkSync(full);
          removed += 1;
        } catch {
          failed += 1;
        }
      }
    }
  };
  walk(path.join(PUBLIC_DIR, "uploads"));
  return { removed, failed };
}
