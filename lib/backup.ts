/* ---------- SQLite 定时备份 ----------
 *
 * - 使用 better-sqlite3 的在线备份 API（db.backup）生成一致快照，WAL 模式下也安全；
 * - 每次备份生成一个时间戳文件夹：fire.db + public/uploads 素材；
 * - 配置（开关 / 间隔 / 保留份数）保存在 data/backup-config.json，独立于数据库；
 * - maybeRunBackup() 有 60 秒节流，由 getDb() 每次访问时惰性触发，
 *   服务器只要在运行且有人访问，就会按计划自动备份。
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DATA_DIR = path.join(process.cwd(), "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const UPLOADS_DIR = path.join(process.cwd(), "public", "uploads");
const CONFIG_FILE = path.join(DATA_DIR, "backup-config.json");

export interface BackupConfig {
  enabled: boolean;
  /** 备份间隔（小时）：1 每小时 / 24 每天 / 168 每周 / 720 每月 */
  intervalHours: number;
  /** 保留份数 */
  keep: number;
  /** 上次备份时间戳 */
  lastAt: number;
  lastFile: string;
  lastSize: number;
}

const DEFAULT_CONFIG: BackupConfig = {
  enabled: true,
  intervalHours: 24,
  keep: 7,
  lastAt: 0,
  lastFile: "",
  lastSize: 0
};

let lastCheckAt = 0;

export function getBackupConfig(): BackupConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Partial<BackupConfig>;
      return {
        ...DEFAULT_CONFIG,
        ...(typeof parsed.enabled === "boolean" ? { enabled: parsed.enabled } : {}),
        ...(typeof parsed.intervalHours === "number" && parsed.intervalHours > 0 ? { intervalHours: parsed.intervalHours } : {}),
        ...(typeof parsed.keep === "number" && parsed.keep > 0 ? { keep: parsed.keep } : {}),
        ...(typeof parsed.lastAt === "number" ? { lastAt: parsed.lastAt } : {}),
        ...(typeof parsed.lastFile === "string" ? { lastFile: parsed.lastFile } : {}),
        ...(typeof parsed.lastSize === "number" ? { lastSize: parsed.lastSize } : {})
      };
    }
  } catch {
    /* 配置损坏时用默认值 */
  }
  return { ...DEFAULT_CONFIG };
}

export function saveBackupConfig(cfg: BackupConfig): BackupConfig {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* 不支持 POSIX 权限的平台忽略 */ }
  return cfg;
}

function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function copyDir(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function pruneBackups(keep: number) {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const dirs = fs
    .readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(BACKUP_DIR, e.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  dirs.slice(keep).forEach((dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

export function listBackups(): { name: string; size: number; mtime: number }[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const p = path.join(BACKUP_DIR, e.name);
      const st = fs.statSync(p);
      let size = 0;
      const walk = (dir: string) => {
        for (const en of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, en.name);
          if (en.isDirectory()) walk(fp);
          else size += fs.statSync(fp).size;
        }
      };
      walk(p);
      return { name: e.name, size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** 立即执行一次备份，返回备份目录名 */
export async function runBackup(): Promise<{ name: string; size: number }> {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  try { fs.chmodSync(BACKUP_DIR, 0o700); } catch { /* 不支持 POSIX 权限的平台忽略 */ }
  const name = `fire-${fmtStamp(new Date())}`;
  const dir = path.join(BACKUP_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* 不支持 POSIX 权限的平台忽略 */ }

  const dbFile = path.join(process.cwd(), "data", "fire.db");
  const src = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    // 在线备份：生成一致快照（WAL 安全，better-sqlite3 的 backup 为异步）
    await src.backup(path.join(dir, "fire.db"));
    try { fs.chmodSync(path.join(dir, "fire.db"), 0o600); } catch { /* 不支持 POSIX 权限的平台忽略 */ }
  } finally {
    src.close();
  }
  copyDir(UPLOADS_DIR, path.join(dir, "uploads"));

  let size = 0;
  const walk = (p: string) => {
    for (const en of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, en.name);
      if (en.isDirectory()) walk(fp);
      else size += fs.statSync(fp).size;
    }
  };
  walk(dir);

  const cfg = { ...getBackupConfig(), lastAt: Date.now(), lastFile: name, lastSize: size };
  saveBackupConfig(cfg);
  pruneBackups(cfg.keep);
  return { name, size };
}

/** 按计划惰性备份（60 秒节流），由 getDb() 每次访问时触发 */
export function maybeRunBackup(): void {
  const now = Date.now();
  if (now - lastCheckAt < 60_000) return;
  lastCheckAt = now;
  const cfg = getBackupConfig();
  if (!cfg.enabled) return;
  if (cfg.lastAt && now - cfg.lastAt < cfg.intervalHours * 3_600_000) return;
  runBackup().catch(() => {
    /* 备份失败静默，下个周期重试 */
  });
}
