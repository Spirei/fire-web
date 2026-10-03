import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { getDb } from "./db";
import { hmacWithDataKey } from "./secretStorage";
import { RESOURCE_CATEGORIES, RESOURCE_KINDS, RESOURCE_EXTENSIONS, RESOURCE_UPLOAD_LIMIT, RESOURCE_QUOTA, type ResourceCategory, type ResourceKind } from "./resourceLibraryConfig";

export class ResourceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type FolderRow = { id: string; user_id: string; category: ResourceCategory; parent_id: string; name: string; revision: number; created_at: string };
type FileRow = { id: string; user_id: string; category: ResourceCategory; folder_id: string; name: string; kind: ResourceKind; mime: string; size_bytes: number; sha256: string; revision: number; created_at: string; state: "uploading" | "ready" | "deleting" | "deleted" };
type OperationRow = { user_id: string; request_id: string; type: "upload" | "delete"; file_id: string; state: "pending" | "completed" | "failed"; result: string | null; created_at: string };
const initialized = new WeakSet<object>();
function database() {
  const db = getDb();
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS resource_folders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, category TEXT NOT NULL,
      parent_id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id,category,parent_id,name));
      CREATE INDEX IF NOT EXISTS resource_folders_owner ON resource_folders(user_id,category,parent_id,created_at,id);
      CREATE TABLE IF NOT EXISTS resource_files (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, category TEXT NOT NULL,
        folder_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS resource_files_owner ON resource_files(user_id,category,kind,state,created_at,id);
      CREATE TABLE IF NOT EXISTS resource_operations (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id TEXT NOT NULL, type TEXT NOT NULL,
        file_id TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(user_id,request_id));`);
    initialized.add(db);
  }
  return db;
}
export function resourceCategory(value: unknown): ResourceCategory {
  if (typeof value !== "string" || !RESOURCE_CATEGORIES.includes(value as ResourceCategory)) throw new ResourceError("分类无效");
  return value as ResourceCategory;
}
function displayName(value: unknown, normalize = true) {
  if (typeof value !== "string" || value !== value.trim() || !value || [...value].length > 120 || Buffer.byteLength(value) > 240 || /[\/\\\x00-\x1f\x7f]/.test(value) || [".", ".."].includes(value)) throw new ResourceError("名称无效");
  return normalize ? value.normalize("NFC") : value;
}
export function resourceRequestId(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new ResourceError("requestId 必须为小写 UUID");
  return value;
}
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ResourceError("版本无效");
  return Number(value);
}
function shape(body: unknown, keys: string[]): asserts body is Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k))) throw new ResourceError("请求字段无效");
}
function folder(user: string, id: string) {
  if (!/^rld_[a-f0-9]{32}$/.test(id)) throw new ResourceError("目录不存在", 404);
  const item = database().prepare("SELECT * FROM resource_folders WHERE id=? AND user_id=?").get(id, user) as FolderRow | undefined;
  if (!item) throw new ResourceError("目录不存在", 404);
  return item;
}
function file(user: string, id: string, includeDeleted = false) {
  if (!/^rlf_[a-f0-9]{32}$/.test(id)) throw new ResourceError("文件不存在", 404);
  const item = database().prepare("SELECT * FROM resource_files WHERE id=? AND user_id=?").get(id, user) as FileRow | undefined;
  if (!item || (!includeDeleted && ["deleted", "uploading"].includes(item.state))) throw new ResourceError("文件不存在", 404);
  return item;
}
function folderValue(row: FolderRow) { return { id: row.id, category: row.category, parentId: row.parent_id || null, name: row.name, revision: row.revision, createdAt: row.created_at }; }
function fileValue(row: FileRow, version: 1 | 2) {
  return { id: row.id, category: row.category, folderId: row.folder_id || null, name: row.name, kind: row.kind, mime: row.mime, sizeBytes: row.size_bytes, sha256: row.sha256, revision: row.revision, createdAt: row.created_at, state: row.state, downloadPath: `/api/v${version}/resource-library/files/${row.id}/content` };
}
export function resourceUsage(user: string) {
  const row = database().prepare("SELECT COALESCE(SUM(size_bytes),0) AS usedBytes,COUNT(*) AS fileCount FROM resource_files WHERE user_id=? AND state<>'deleted'").get(user) as { usedBytes: number; fileCount: number };
  return { ...row, quotaBytes: RESOURCE_QUOTA };
}
function page(q: URLSearchParams, binding: string) {
  const raw = q.get("limit"), limit = raw === null ? 30 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ResourceError("每页条数为 1–100");
  let after: { time: string; id: string } | null = null;
  const cursor = q.get("cursor");
  if (cursor !== null) {
    try {
      if (cursor.length > 1024) throw Error();
      const [payload, signature, extra] = cursor.split(".");
      const expected = Buffer.from(hmacWithDataKey("resource-cursor:" + payload), "hex"), received = Buffer.from(signature || "", "hex");
      if (extra || received.length !== expected.length || !timingSafeEqual(expected, received)) throw Error();
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (data.binding !== binding || typeof data.time !== "string" || !/^rl[fd]_[a-f0-9]{32}$/.test(data.id)) throw Error();
      after = { time: data.time, id: data.id };
    } catch { throw new ResourceError("分页游标无效"); }
  }
  return { limit, after, cursor: (time: string, id: string) => {
    const payload = Buffer.from(JSON.stringify({ binding, time, id })).toString("base64url");
    return payload + "." + hmacWithDataKey("resource-cursor:" + payload);
  } };
}
function assertQuery(q: URLSearchParams, keys: string[]) {
  if ([...q.keys()].some(k => !keys.includes(k) || q.getAll(k).length !== 1)) throw new ResourceError("查询字段无效");
}
export function resourceFolders(user: string, q: URLSearchParams) {
  assertQuery(q, ["category", "parentId", "limit", "cursor"]);
  const category = resourceCategory(q.get("category")), parentId = q.get("parentId") || "";
  if (parentId && folder(user, parentId).category !== category) throw new ResourceError("目录不存在", 404);
  const p = page(q, JSON.stringify([user, "folders", category, parentId]));
  const rows = database().prepare(`SELECT * FROM resource_folders WHERE user_id=? AND category=? AND parent_id=? ${p.after ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`).all(user, category, parentId, ...(p.after ? [p.after.time, p.after.time, p.after.id] : []), p.limit + 1) as FolderRow[];
  const items = rows.slice(0, p.limit), last = items.at(-1);
  return { items: items.map(folderValue), nextCursor: rows.length > p.limit && last ? p.cursor(last.created_at, last.id) : null };
}
export function createResourceFolder(user: string, body: unknown) {
  shape(body, ["category", "parentId", "name"]);
  const category = resourceCategory(body.category), name = displayName(body.name);
  if (body.parentId !== undefined && typeof body.parentId !== "string") throw new ResourceError("目录无效");
  const parentId = String(body.parentId || ""), db = database();
  return db.transaction(() => {
    let next = parentId, depth = 1;
    while (next) {
      const item = folder(user, next);
      if (item.category !== category) throw new ResourceError("目录不存在", 404);
      next = item.parent_id;
      if (++depth > 8) throw new ResourceError("最多 8 层目录");
    }
    if ((db.prepare("SELECT COUNT(*) AS n FROM resource_folders WHERE user_id=?").get(user) as { n: number }).n >= 128) throw new ResourceError("目录数量已达上限", 409);
    if (db.prepare("SELECT 1 FROM resource_folders WHERE user_id=? AND category=? AND parent_id=? AND name=?").get(user, category, parentId, name)) throw new ResourceError("目录名称已存在", 409);
    const row: FolderRow = { id: "rld_" + randomBytes(16).toString("hex"), user_id: user, category, parent_id: parentId, name, revision: 1, created_at: new Date().toISOString() };
    db.prepare("INSERT INTO resource_folders VALUES(?,?,?,?,?,?,?)").run(row.id, user, category, parentId, name, 1, row.created_at);
    return folderValue(row);
  }).immediate();
}
export function deleteResourceFolder(user: string, id: string, body: unknown) {
  shape(body, ["revision"]);
  const expected = revision(body.revision), db = database();
  return db.transaction(() => {
    const row = folder(user, id);
    if (row.revision !== expected) throw new ResourceError("目录版本已变化", 409);
    if (db.prepare("SELECT 1 FROM resource_folders WHERE user_id=? AND parent_id=?").get(user, id) || db.prepare("SELECT 1 FROM resource_files WHERE user_id=? AND folder_id=? AND state<>'deleted'").get(user, id)) throw new ResourceError("目录不为空", 409);
    db.prepare("DELETE FROM resource_folders WHERE id=? AND user_id=?").run(id, user);
    return { deletedId: id };
  }).immediate();
}
export function resourceFiles(user: string, q: URLSearchParams, version: 1 | 2) {
  assertQuery(q, ["category", "kind", "folderId", "limit", "cursor", "sort", "direction"]);
  const category = q.has("category") ? resourceCategory(q.get("category")) : null, kind = q.get("kind"), folderId = q.get("folderId");
  const sortInput = q.get("sort") ?? "createdAt", direction = q.get("direction") ?? "desc";
  if (!["name", "createdAt"].includes(sortInput) || !["asc", "desc"].includes(direction)) throw new ResourceError("排序无效");
  const sort = sortInput === "name" ? "name" : "created_at", compare = direction === "asc" ? ">" : "<";
  if (kind !== null && !RESOURCE_KINDS.includes(kind as ResourceKind)) throw new ResourceError("文件类型无效");
  if (folderId !== null && folderId !== "root") {
    const f = folder(user, folderId);
    if (category && f.category !== category) throw new ResourceError("目录不存在", 404);
  }
  const p = page(q, JSON.stringify([user, "files", category, kind, folderId, sortInput, direction])), conditions = ["user_id=?", "state IN ('ready','deleting')"], values: (string | number)[] = [user];
  if (category) { conditions.push("category=?"); values.push(category); }
  if (kind) { conditions.push("kind=?"); values.push(kind); }
  if (folderId !== null) { conditions.push("folder_id=?"); values.push(folderId === "root" ? "" : folderId); }
  if (p.after) { conditions.push(`(${sort}${compare}? OR (${sort}=? AND id${compare}?))`); values.push(p.after.time, p.after.time, p.after.id); }
  const rows = database().prepare(`SELECT * FROM resource_files WHERE ${conditions.join(" AND ")} ORDER BY ${sort} ${direction},id ${direction} LIMIT ?`).all(...values, p.limit + 1) as FileRow[];
  const items = rows.slice(0, p.limit), last = items.at(-1);
  return { items: items.map(r => fileValue(r, version)), nextCursor: rows.length > p.limit && last ? p.cursor(last[sort], last.id) : null, usage: resourceUsage(user) };
}
export function resourceFile(user: string, id: string, version: 1 | 2) { return fileValue(file(user, id), version); }

// Only server-generated names enter private storage. Reject links in every directory and file.
function userDirectory(user: string) {
  let current = fs.realpathSync(process.cwd());
  for (const segment of ["data", "resource-library", createHash("sha256").update(user).digest("hex")]) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ResourceError("资源存储不可用", 500);
  }
  return current;
}
function privatePath(user: string, id: string) {
  if (!/^rlf_[a-f0-9]{32}$/.test(id)) throw new ResourceError("文件不存在", 404);
  return path.join(userDirectory(user), id);
}
function syncDirectory(directory: string) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function openPrivate(target: string) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new ResourceError("资源文件不可用", 500);
    return { fd, stat };
  } catch (e) { fs.closeSync(fd); throw e; }
}
function classify(name: string, bytes: Buffer): { kind: ResourceKind; mime: string } {
  const ext = path.extname(name).slice(1).toLowerCase();
  const kind = Object.entries(RESOURCE_EXTENSIONS).find(([, extensions]) => (extensions as readonly string[]).includes(ext))?.[0] as ResourceKind | undefined;
  if (!kind) return { kind: "other", mime: "application/octet-stream" };
  const starts = (hex: string) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  const text = (offset: number, length: number) => bytes.subarray(offset, offset + length).toString("ascii");
  const ftyp = text(4, 4) === "ftyp", zip = starts("504b0304") || starts("504b0506") || starts("504b0708");
  const spec: Record<string, [boolean, string]> = {
    jpg: [starts("ffd8ff"), "image/jpeg"], jpeg: [starts("ffd8ff"), "image/jpeg"], png: [starts("89504e470d0a1a0a"), "image/png"],
    gif: [text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a", "image/gif"], webp: [text(0, 4) === "RIFF" && text(8, 4) === "WEBP", "image/webp"],
    heic: [ftyp && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(text(8, 4)), "image/heic"], heif: [ftyp && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(text(8, 4)), "image/heif"],
    mp4: [ftyp, "video/mp4"], mov: [ftyp, "video/quicktime"], webm: [starts("1a45dfa3"), "video/webm"],
    mp3: [text(0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 224) === 224), "audio/mpeg"],
    m4a: [ftyp, "audio/mp4"], aac: [bytes[0] === 255 && (bytes[1] & 246) === 240, "audio/aac"],
    wav: [text(0, 4) === "RIFF" && text(8, 4) === "WAVE", "audio/wav"], ogg: [text(0, 4) === "OggS", "audio/ogg"], flac: [text(0, 4) === "fLaC", "audio/flac"],
    pdf: [text(0, 5) === "%PDF-", "application/pdf"], zip: [zip, "application/zip"], gz: [starts("1f8b"), "application/gzip"],
    "7z": [starts("377abcaf271c"), "application/x-7z-compressed"], rar: [starts("526172211a07"), "application/vnd.rar"],
    docx: [zip, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    xlsx: [zip, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], pptx: [zip, "application/vnd.openxmlformats-officedocument.presentationml.presentation"]
  };
  if (["txt", "md", "csv", "json"].includes(ext)) {
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (value.includes("\0")) throw Error();
      if (ext === "json") JSON.parse(value);
    } catch { throw new ResourceError("文档格式无效", 415); }
    return { kind, mime: ext === "json" ? "application/json" : ext === "csv" ? "text/csv" : ext === "md" ? "text/markdown" : "text/plain" };
  }
  if (!spec[ext]?.[0]) throw new ResourceError("文件格式与后缀不一致", 415);
  return { kind, mime: spec[ext][1] };
}
function operation(user: string, requestId: string) {
  return database().prepare("SELECT * FROM resource_operations WHERE user_id=? AND request_id=?").get(user, requestId) as OperationRow | undefined;
}
function completeUpload(row: FileRow, requestId: string) {
  const db = database();
  db.transaction(() => {
    db.prepare("UPDATE resource_files SET state='ready' WHERE id=? AND user_id=? AND state='uploading'").run(row.id, row.user_id);
    db.prepare("UPDATE resource_operations SET state='completed',result=? WHERE user_id=? AND request_id=?").run(JSON.stringify(fileValue({ ...row, state: "ready" }, 1)), row.user_id, requestId);
  }).immediate();
}
export function uploadResource(user: string, bytes: Buffer, input: { category: unknown; folderId?: unknown; name: string; requestId: unknown }, version: 1 | 2) {
  const category = resourceCategory(input.category), name = displayName(input.name, false), requestId = resourceRequestId(input.requestId);
  if (!bytes.length || bytes.length > RESOURCE_UPLOAD_LIMIT) throw new ResourceError("文件须为 1 字节至 50 MiB", 413);
  if (input.folderId !== undefined && typeof input.folderId !== "string") throw new ResourceError("目录无效");
  const folderId = String(input.folderId || ""), format = classify(name, bytes), db = database();
  if (category === "media" && !["image", "video", "audio"].includes(format.kind)) throw new ResourceError("影音内容只接受图片、视频和音频", 415);
  const row: FileRow = { id: "rlf_" + randomBytes(16).toString("hex"), user_id: user, category, folder_id: folderId, name, ...format, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), revision: 1, created_at: new Date().toISOString(), state: "uploading" };
  const target = privatePath(user, row.id), staging = target + ".part";
  db.transaction(() => {
    if (operation(user, requestId)) throw new ResourceError("此操作已登记，请查询结果", 409);
    if (folderId && folder(user, folderId).category !== category) throw new ResourceError("目录不存在", 404);
    const usage = resourceUsage(user);
    if (usage.usedBytes + bytes.length > RESOURCE_QUOTA || usage.fileCount >= 5000) throw new ResourceError("个人资源库容量或文件数已达上限", 409);
    db.prepare("INSERT INTO resource_files VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(row.id, user, category, folderId, name, row.kind, row.mime, bytes.length, row.sha256, 1, row.created_at, row.state);
    db.prepare("INSERT INTO resource_operations VALUES(?,?,?,?,?,?,?)").run(user, requestId, "upload", row.id, "pending", null, row.created_at);
  }).immediate();
  try {
    const fd = fs.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(staging, target);
    syncDirectory(path.dirname(target));
    completeUpload(row, requestId);
    return fileValue({ ...row, state: "ready" }, version);
  } catch (error) {
    // A committed original with an uncertain DB acknowledgement stays reserved for read-only reconciliation.
    if (!fs.existsSync(target)) {
      try {
        fs.rmSync(staging, { force: true });
        db.transaction(() => {
          db.prepare("DELETE FROM resource_files WHERE id=? AND user_id=?").run(row.id, user);
          db.prepare("UPDATE resource_operations SET state='failed' WHERE user_id=? AND request_id=?").run(user, requestId);
        }).immediate();
      } catch { /* Keep pending and its quota reservation until storage is available. */ }
    }
    throw error instanceof ResourceError ? error : new ResourceError("上传结果未确认，请查询操作状态", 500);
  }
}
function completeDeletion(user: string, row: FileRow, requestId: string) {
  const db = database();
  return db.transaction(() => {
    const existing = operation(user, requestId);
    if (existing?.state === "completed") return JSON.parse(existing.result!);
    db.prepare("UPDATE resource_files SET state='deleted' WHERE user_id=? AND id=?").run(user, row.id);
    const result = { deletedId: row.id, fileDeleted: true, removedBytes: row.size_bytes, usedBytes: resourceUsage(user).usedBytes, deletedAt: new Date().toISOString() };
    db.prepare("UPDATE resource_operations SET state='completed',result=? WHERE user_id=? AND request_id=?").run(JSON.stringify(result), user, requestId);
    // Any previous uncertain deletion of the same immutable file receives the same confirmed receipt.
    db.prepare("UPDATE resource_operations SET state='completed',result=? WHERE user_id=? AND file_id=? AND type='delete' AND state='pending'").run(JSON.stringify(result), user, row.id);
    return result;
  }).immediate();
}
function missing(target: string) {
  try { fs.lstatSync(target); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; throw e; }
}
export function deleteResource(user: string, id: string, body: unknown) {
  shape(body, ["revision", "requestId"]);
  const expected = revision(body.revision), requestId = resourceRequestId(body.requestId), db = database();
  const row = db.transaction(() => {
    if (operation(user, requestId)) throw new ResourceError("此操作已登记，请查询结果", 409);
    const item = file(user, id);
    if (item.revision !== expected) throw new ResourceError("文件版本已变化", 409);
    // Missing storage before the first deletion is corruption, not evidence this request removed it.
    if (item.state === "ready") {
      const opened = openPrivate(privatePath(user, id));
      try { if (opened.stat.size !== item.size_bytes) throw new ResourceError("资源文件大小异常", 500); } finally { fs.closeSync(opened.fd); }
    }
    db.prepare("INSERT INTO resource_operations VALUES(?,?,?,?,?,?,?)").run(user, requestId, "delete", id, "pending", null, new Date().toISOString());
    db.prepare("UPDATE resource_files SET state='deleting' WHERE id=? AND user_id=?").run(id, user);
    return item;
  }).immediate();
  try {
    const target = privatePath(user, id);
    if (!missing(target)) {
      const opened = openPrivate(target);
      try { if (opened.stat.size !== row.size_bytes) throw new ResourceError("资源文件大小异常", 500); } finally { fs.closeSync(opened.fd); }
      fs.unlinkSync(target);
    }
    if (!missing(target)) throw new ResourceError("原文件尚未移除", 500);
    syncDirectory(path.dirname(target));
    return completeDeletion(user, row, requestId);
  } catch (e) { throw e instanceof ResourceError ? e : new ResourceError("删除结果未确认，请查询操作状态", 500); }
}
export function resourceOperation(user: string, requestId: string, type: "upload" | "delete", version: 1 | 2) {
  resourceRequestId(requestId);
  let op = operation(user, requestId);
  if (!op || op.type !== type) throw new ResourceError("操作不存在", 404);
  if (op.state === "pending") {
    const row = file(user, op.file_id, true), target = privatePath(user, row.id);
    if (type === "delete" && missing(target)) { syncDirectory(path.dirname(target)); completeDeletion(user, row, requestId); }
    if (type === "upload" && !missing(target)) {
      const opened = openPrivate(target);
      try {
        if (opened.stat.size !== row.size_bytes || createHash("sha256").update(fs.readFileSync(opened.fd)).digest("hex") !== row.sha256) throw new ResourceError("原文件校验失败", 500);
      } finally { fs.closeSync(opened.fd); }
      syncDirectory(path.dirname(target));
      completeUpload(row, requestId);
    } else if (type === "upload" && Date.now() - Date.parse(op.created_at) > 60_000) {
      // Expired staging belongs to this registered operation; no original is re-uploaded.
      fs.rmSync(target + ".part", { force: true });
      database().transaction(() => {
        database().prepare("DELETE FROM resource_files WHERE id=? AND user_id=? AND state='uploading'").run(row.id, user);
        database().prepare("UPDATE resource_operations SET state='failed' WHERE user_id=? AND request_id=?").run(user, requestId);
      }).immediate();
    }
    op = operation(user, requestId)!;
  }
  const result = op.state !== "completed" ? null : type === "delete" ? JSON.parse(op.result!) : { ...JSON.parse(op.result!), downloadPath: `/api/v${version}/resource-library/files/${op.file_id}/content` };
  return { requestId, state: op.state, fileId: op.file_id, result };
}
export function downloadResource(user: string, id: string, range: string | null) {
  const row = file(user, id);
  if (row.state !== "ready") throw new ResourceError("文件正在删除", 409);
  const opened = openPrivate(privatePath(user, id));
  try {
    if (opened.stat.size !== row.size_bytes) throw new ResourceError("资源文件大小异常", 500);
    let start = 0, end = row.size_bytes - 1;
    if (range !== null) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) throw new ResourceError("下载范围无效", 416);
      if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) throw new ResourceError("下载范围无效", 416); start = Math.max(0, row.size_bytes - suffix); }
      else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= row.size_bytes) throw new ResourceError("下载范围无效", 416);
    }
    const headers: Record<string, string> = { "Content-Type": row.mime, "Content-Length": String(end - start + 1), "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16))}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" };
    if (range !== null) headers["Content-Range"] = `bytes ${start}-${end}/${row.size_bytes}`;
    const stream = fs.createReadStream("", { fd: opened.fd, autoClose: true, start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range !== null ? 206 : 200, headers });
  } catch (e) {
    fs.closeSync(opened.fd);
    if (e instanceof ResourceError && e.status === 416) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${row.size_bytes}`, "Cache-Control": "private, no-store" } });
    throw e;
  }
}

/** Existing administrator account deletion must not strand personal originals on disk. */
export function purgeResourceUser(user: string) {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_files'").get()) return;
  const rows = db.prepare("SELECT * FROM resource_files WHERE user_id=? AND state<>'deleted'").all(user) as FileRow[];
  for (const row of rows) {
    const target = privatePath(user, row.id);
    for (const candidate of [target, target + ".part"]) {
      if (!missing(candidate)) { const opened = openPrivate(candidate); fs.closeSync(opened.fd); fs.unlinkSync(candidate); }
    }
    syncDirectory(path.dirname(target));
    db.prepare("UPDATE resource_files SET state='deleted' WHERE id=? AND user_id=?").run(row.id, user);
  }
  db.transaction(() => {
    db.prepare("DELETE FROM resource_operations WHERE user_id=?").run(user);
    db.prepare("DELETE FROM resource_files WHERE user_id=?").run(user);
    db.prepare("DELETE FROM resource_folders WHERE user_id=?").run(user);
  }).immediate();
}
