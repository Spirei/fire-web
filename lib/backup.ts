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
import { randomBytes } from "node:crypto";

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
let runningBackup: Promise<{ name: string; size: number }> | null = null;
let activeBackupName: string | null = null;
const deletingBackupNames = new Set<string>();
const SIZE_META_FILE = ".backup-meta.json";

function positiveInteger(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(max, Math.round(value))) : fallback;
}

function normalizedConfig(cfg: Partial<BackupConfig>): BackupConfig {
  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULT_CONFIG.enabled,
    intervalHours: positiveInteger(cfg.intervalHours, DEFAULT_CONFIG.intervalHours, 24 * 365),
    keep: positiveInteger(cfg.keep, DEFAULT_CONFIG.keep, 90),
    lastAt: typeof cfg.lastAt === "number" && Number.isFinite(cfg.lastAt) ? Math.max(0, cfg.lastAt) : 0,
    lastFile: typeof cfg.lastFile === "string" ? cfg.lastFile : "",
    lastSize: typeof cfg.lastSize === "number" && Number.isFinite(cfg.lastSize) ? Math.max(0, cfg.lastSize) : 0
  };
}

export function getBackupConfig(): BackupConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Partial<BackupConfig>;
      return normalizedConfig(parsed);
    }
  } catch {
    /* 配置损坏时用默认值 */
  }
  return { ...DEFAULT_CONFIG };
}

export function saveBackupConfig(cfg: BackupConfig): BackupConfig {
  const normalized = normalizedConfig(cfg);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2), "utf8");
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* 不支持 POSIX 权限的平台忽略 */ }
  return normalized;
}

function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function copyDir(src: string, dest: string): Promise<number> {
  if (!fs.existsSync(src)) return 0;
  const files: { src: string; dest: string }[] = [];
  const collect = async (from: string, to: string) => {
    await fs.promises.mkdir(to, { recursive: true });
    for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name), d = path.join(to, entry.name);
      if (entry.isDirectory()) await collect(s, d);
      else if (entry.isFile()) files.push({ src: s, dest: d });
    }
  };
  await collect(src, dest);
  let next = 0, size = 0, failed = false;
  let failure: unknown;
  // Drain every in-flight copy before removing a failed snapshot.
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (!failed && next < files.length) {
      const file = files[next++];
      try {
        await fs.promises.copyFile(file.src, file.dest);
        size += (await fs.promises.stat(file.dest)).size;
      } catch (error) { if (!failed) failure = error; failed = true; }
    }
  }));
  if (failed) throw failure;
  return size;
}

async function pruneBackups(keep: number): Promise<void> {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const entries = await fs.promises.readdir(BACKUP_DIR, { withFileTypes: true });
  const dirs = await Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => {
    const dir = path.join(BACKUP_DIR, e.name);
    return { dir, mtime: (await fs.promises.stat(dir)).mtimeMs };
  }));
  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const { dir } of dirs.slice(keep)) {
    const name = path.basename(dir);
    deletingBackupNames.add(name);
    try { await fs.promises.rm(dir, { recursive: true, force: true }); }
    finally { deletingBackupNames.delete(name); }
  }
}

function indexedSize(dir: string, name: string): number | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(dir, SIZE_META_FILE), "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 1024) return null;
    const buffer = Buffer.alloc(1025);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 1024 || length !== st.size) return null;
    const meta = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (meta.version !== 1 || meta.name !== name || !Number.isSafeInteger(meta.payloadSize) || meta.payloadSize < 0) return null;
    const total = meta.payloadSize + length;
    return Number.isSafeInteger(total) ? total : null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function listBackups(): { name: string; size: number; mtime: number }[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== activeBackupName && !deletingBackupNames.has(e.name))
    .map((e) => {
      try {
        const p = path.join(BACKUP_DIR, e.name);
        const st = fs.statSync(p);
        const indexed = indexedSize(p, e.name);
        let size = indexed ?? 0;
        const walk = (dir: string) => {
          for (const en of fs.readdirSync(dir, { withFileTypes: true })) {
            const fp = path.join(dir, en.name);
            if (en.isDirectory()) walk(fp);
            else size += fs.statSync(fp).size;
          }
        };
        if (indexed === null) walk(p);
        return { name: e.name, size, mtime: st.mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    })
    .filter((backup): backup is { name: string; size: number; mtime: number } => backup !== null)
    .sort((a, b) => b.mtime - a.mtime);
}

/** 立即执行一次备份，返回备份目录名 */
async function performBackup(): Promise<{ name: string; size: number }> {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  try { fs.chmodSync(BACKUP_DIR, 0o700); } catch { /* 不支持 POSIX 权限的平台忽略 */ }
  const stamp = `fire-${fmtStamp(new Date())}`;
  let name = stamp, dir = path.join(BACKUP_DIR, name);
  // A completed backup in the same second must never be reused or overwritten.
  for (;;) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      name = `${stamp}-${randomBytes(6).toString("hex")}`; dir = path.join(BACKUP_DIR, name);
    }
  }
  try { fs.chmodSync(dir, 0o700); } catch { /* 不支持 POSIX 权限的平台忽略 */ }
  activeBackupName = name;

  let complete = false;
  try {
    const dbFile = path.join(process.cwd(), "data", "fire.db");
    const src = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      // 在线备份：生成一致快照（WAL 安全，better-sqlite3 的 backup 为异步）
      await src.backup(path.join(dir, "fire.db"));
      try { fs.chmodSync(path.join(dir, "fire.db"), 0o600); } catch { /* 不支持 POSIX 权限的平台忽略 */ }
    } finally {
      src.close();
    }
    let size = await copyDir(UPLOADS_DIR, path.join(dir, "uploads"));
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isFile()) size += (await fs.promises.stat(path.join(dir, entry.name))).size;
    }
    complete = true;
    const meta = JSON.stringify({ version: 1, name, payloadSize: size });
    await fs.promises.writeFile(path.join(dir, SIZE_META_FILE), meta, { flag: "wx", mode: 0o600 });
    size += Buffer.byteLength(meta);
    activeBackupName = null;

    const cfg = { ...getBackupConfig(), lastAt: Date.now(), lastFile: name, lastSize: size };
    saveBackupConfig(cfg);
    await pruneBackups(cfg.keep);
    return { name, size };
  } catch (error) {
    if (!complete) await fs.promises.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Concurrent manual/import/scheduled requests share one consistent snapshot. */
export function runBackup(): Promise<{ name: string; size: number }> {
  if (!runningBackup) {
    runningBackup = performBackup();
    const release = () => { runningBackup = null; activeBackupName = null; };
    runningBackup.then(release, release);
  }
  return runningBackup;
}

/** 按计划惰性备份（60 秒节流），由 getDb() 每次访问时触发 */
export function maybeRunBackup(): void {
  const now = Date.now();
  if (now - lastCheckAt < 60_000) return;
  lastCheckAt = now;
  const cfg = getBackupConfig();
  if (!cfg.enabled) return;
  if (cfg.lastAt && now - cfg.lastAt < cfg.intervalHours * 3_600_000) return;
  // 备份会复制整个 uploads，避开首屏磁盘争用
  setTimeout(() => {
    const current = getBackupConfig();
    if (!current.enabled || (current.lastAt && Date.now() - current.lastAt < current.intervalHours * 3_600_000)) return;
    runBackup().catch(() => {
      /* 备份失败静默，下个周期重试 */
    });
  }, 30_000);
}
