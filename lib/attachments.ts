/* ---------- 附件管理（13F 原始文件 / 解析结果 / 未来扩展文件） ----------
 *
 * 存储根目录：data/attachments（服务端私有目录，仅通过接口下载，不对外静态暴露）
 * 目录结构建议：人名（如 沃伦巴菲特）/ 年份（2026）/ 季度（Q1）
 * 13F 为季度申报（每季度末后 45 天内披露），按季度归档可对照披露节奏。
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { getDb } from "./db";

const ROOT = path.join(process.cwd(), "data", "attachments");

export interface LibraryAssetEntry {
  id: string;
  type: string;
  market: string;
  code: string;
  name: string;
  url: string;
  board: string;
  marketCap: number;
}

export interface LibraryAssetPage {
  items: LibraryAssetEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalAll: number;
  counts: Record<string, number>;
  markets: string[];
}

export function queryLibraryAssets(input: {
  type?: string;
  market?: string;
  q?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}): LibraryAssetPage {
  const db = getDb();
  const allowedTypes = new Set(["stock", "crypto", "metal", "market"]);
  const type = allowedTypes.has(input.type ?? "") ? String(input.type) : "stock";
  const market = type === "stock" && input.market && input.market !== "ALL" ? input.market : "";
  const q = String(input.q ?? "").trim().slice(0, 80);
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(input.pageSize) || 10)));
  const page = Math.max(1, Math.floor(Number(input.page) || 1));
  const where = ["type = ?"];
  const params: Array<string | number> = [type];
  if (market) {
    where.push("market = ?");
    params.push(market);
  }
  if (q) {
    where.push("(name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(like, like);
  }
  const usdMarketCapSql = `(market_cap / CASE market
    WHEN 'HK' THEN 7.85 WHEN 'CN' THEN 7.2 WHEN 'JP' THEN 155
    WHEN 'KR' THEN 1350 WHEN 'SG' THEN 1.35 ELSE 1 END)`;
  const sortSql =
    input.sort === "cap_asc"
      ? `${usdMarketCapSql} ASC, code ASC`
      : input.sort === "code"
        ? "code COLLATE NOCASE ASC"
        : `${usdMarketCapSql} DESC, code COLLATE NOCASE ASC`;
  const whereSql = where.join(" AND ");
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS count FROM assets WHERE ${whereSql}`).get(...params) as { count: number }).count
  );
  const totalAll = Number(
    (db
      .prepare("SELECT COUNT(*) AS count FROM assets WHERE type IN ('stock','crypto','metal','market')")
      .get() as { count: number }).count
  );
  const rawRows = db
    .prepare(
      `SELECT id, type, market, code, name, url, board, market_cap
       FROM assets WHERE ${whereSql}
       ORDER BY ${sortSql} LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Array<{
    id: string;
    type: string;
    market: string;
    code: string;
    name: string;
    url: string;
    board: string;
    market_cap: number;
  }>;
  const countRows = db
    .prepare(
      "SELECT type, COUNT(*) AS count FROM assets WHERE type IN ('stock','crypto','metal','market') GROUP BY type"
    )
    .all() as Array<{ type: string; count: number }>;
  const marketRows = db
    .prepare("SELECT DISTINCT market FROM assets WHERE type = 'stock' AND market <> '' ORDER BY market")
    .all() as Array<{ market: string }>;
  return {
    items: rawRows.map((r) => ({
      id: r.id,
      type: r.type,
      market: r.market,
      code: r.code,
      name: r.name,
      url: r.url,
      board: r.board,
      marketCap: Number(r.market_cap) || 0
    })),
    page,
    pageSize,
    total,
    totalAll,
    counts: Object.fromEntries(countRows.map((r) => [r.type, Number(r.count)])),
    markets: marketRows.map((r) => r.market)
  };
}

/* 素材库分类树：实时读 assets 表（本地发生变化后附件管理自动同步），按 股票(市场) / 加密货币 / 贵金属 / 市场 分组 */
export function listLibraryAssets(): {
  stock: Record<string, LibraryAssetEntry[]>;
  crypto: LibraryAssetEntry[];
  metal: LibraryAssetEntry[];
  market: LibraryAssetEntry[];
} {
  const rows = getDb()
    .prepare(
      "SELECT id, type, market, code, name, url, board, market_cap FROM assets WHERE type IN ('stock','crypto','metal','market') ORDER BY type, market, code"
    )
    .all() as {
    id: string;
    type: string;
    market: string;
    code: string;
    name: string;
    url: string;
    board: string;
    market_cap: number;
  }[];
  const stock: Record<string, LibraryAssetEntry[]> = {};
  const crypto: LibraryAssetEntry[] = [];
  const metal: LibraryAssetEntry[] = [];
  const market: LibraryAssetEntry[] = [];
  rows.forEach((r) => {
    const e: LibraryAssetEntry = {
      id: r.id,
      type: r.type,
      market: r.market,
      code: r.code,
      name: r.name,
      url: r.url,
      board: r.board,
      marketCap: r.market_cap
    };
    if (r.type === "stock") {
      (stock[r.market] ??= []).push(e);
    } else if (r.type === "crypto") crypto.push(e);
    else if (r.type === "metal") metal.push(e);
    else market.push(e);
  });
  return { stock, crypto, metal, market };
}

function ensureRoot() {
  mkdirSync(ROOT, { recursive: true });
}

/** 规范化相对路径并阻止路径穿越（.. / 绝对路径 / 空） */
export function safeRel(raw: string): string {
  const cleaned = String(raw ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!cleaned || cleaned.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error("无效的路径");
  }
  return cleaned;
}

function abs(rel: string): string {
  const target = path.join(ROOT, rel);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) throw new Error("路径越界");
  return target;
}

export interface AttachmentEntry {
  name: string;
  rel: string; // 相对 data/attachments 的路径
  isDir: boolean;
  size: number;
  mtime: string;
  ext: string;
}

export function listAttachments(rel = ""): { path: string; dirs: AttachmentEntry[]; files: AttachmentEntry[] } {
  ensureRoot();
  const relPath = rel ? safeRel(rel) : "";
  const dir = abs(relPath);
  if (!existsSync(dir)) return { path: relPath, dirs: [], files: [] };
  const entries = readdirSync(dir, { withFileTypes: true }).map((e) => {
    const p = path.join(dir, e.name);
    const st = statSync(p);
    const relChild = relPath ? `${relPath}/${e.name}` : e.name;
    return {
      name: e.name,
      rel: relChild,
      isDir: e.isDirectory(),
      size: e.isDirectory() ? 0 : st.size,
      mtime: st.mtime.toISOString(),
      ext: e.isDirectory() ? "" : path.extname(e.name).replace(".", "").toLowerCase()
    };
  });
  const dirs = entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const files = entries
    .filter((e) => !e.isDir)
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { path: relPath, dirs, files };
}

export function createAttachmentDir(rel: string): void {
  ensureRoot();
  mkdirSync(abs(safeRel(rel)), { recursive: true });
}

export type AttachmentConflictMode = "error" | "replace" | "keep-both";

export class AttachmentConflictError extends Error {
  code = "ATTACHMENT_EXISTS";
  constructor(public rel: string) {
    super("同名文件或目录已存在");
  }
}

export function attachmentExists(rel: string): boolean {
  return existsSync(abs(safeRel(rel)));
}

function availableRel(rel: string): string {
  const clean = safeRel(rel);
  if (!existsSync(abs(clean))) return clean;
  const parsed = path.posix.parse(clean);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = path.posix.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!existsSync(abs(candidate))) return candidate;
  }
  throw new Error("无法生成可用的文件名");
}

function resolveTargetRel(rel: string, conflict: AttachmentConflictMode): string {
  const clean = safeRel(rel);
  if (!existsSync(abs(clean))) return clean;
  if (conflict === "replace") return clean;
  if (conflict === "keep-both") return availableRel(clean);
  throw new AttachmentConflictError(clean);
}

export function writeAttachment(
  rel: string,
  buffer: Buffer,
  conflict: AttachmentConflictMode = "error"
): string {
  ensureRoot();
  const actualRel = resolveTargetRel(rel, conflict);
  const target = abs(actualRel);
  if (conflict === "replace" && existsSync(target) && statSync(target).isDirectory()) {
    throw new Error("同名目录已存在，不能用文件替换");
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, buffer);
  return actualRel;
}

export function readAttachment(rel: string): { buffer: Buffer; name: string } {
  const target = abs(safeRel(rel));
  if (!existsSync(target)) throw new Error("文件不存在");
  const st = statSync(target);
  if (st.isDirectory()) throw new Error("目标是目录");
  return { buffer: readFileSync(target), name: path.basename(target) };
}

export function deleteAttachment(rel: string, recursive = false): void {
  const target = abs(safeRel(rel));
  if (!existsSync(target)) throw new Error("目标不存在");
  if (!recursive && statSync(target).isDirectory()) {
    const children = readdirSync(target);
    if (children.length > 0) throw new Error("目录非空，无法删除（请先清空目录内容）");
  }
  rmSync(target, { recursive });
}

export function listAttachmentDirectories(): string[] {
  ensureRoot();
  const result = [""];
  const walk = (relative: string) => {
    const current = abs(relative);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      result.push(child);
      walk(child);
    }
  };
  walk("");
  return result.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function assertNotInside(sourceRel: string, targetRel: string) {
  if (targetRel === sourceRel || targetRel.startsWith(`${sourceRel}/`)) {
    throw new Error("不能把目录移动或复制到自身内部");
  }
}

export function moveAttachment(
  source: string,
  targetDir: string,
  newName?: string,
  conflict: AttachmentConflictMode = "error"
): string {
  const sourceRel = safeRel(source);
  const sourcePath = abs(sourceRel);
  if (!existsSync(sourcePath)) throw new Error("源文件不存在");
  const dir = targetDir ? safeRel(targetDir) : "";
  const destination = dir ? `${dir}/${newName || path.posix.basename(sourceRel)}` : newName || path.posix.basename(sourceRel);
  const destinationRel = resolveTargetRel(destination, conflict);
  assertNotInside(sourceRel, destinationRel);
  const destinationPath = abs(destinationRel);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (conflict === "replace" && existsSync(destinationPath)) rmSync(destinationPath, { recursive: true });
  renameSync(sourcePath, destinationPath);
  return destinationRel;
}

export function copyAttachment(
  source: string,
  targetDir: string,
  conflict: AttachmentConflictMode = "error"
): string {
  const sourceRel = safeRel(source);
  const sourcePath = abs(sourceRel);
  if (!existsSync(sourcePath)) throw new Error("源文件不存在");
  const dir = targetDir ? safeRel(targetDir) : "";
  const destination = dir ? `${dir}/${path.posix.basename(sourceRel)}` : path.posix.basename(sourceRel);
  const destinationRel = resolveTargetRel(destination, conflict);
  assertNotInside(sourceRel, destinationRel);
  const destinationPath = abs(destinationRel);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (conflict === "replace" && existsSync(destinationPath)) rmSync(destinationPath, { recursive: true });
  if (statSync(sourcePath).isDirectory()) cpSync(sourcePath, destinationPath, { recursive: true });
  else copyFileSync(sourcePath, destinationPath);
  return destinationRel;
}
