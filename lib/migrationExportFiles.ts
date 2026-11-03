import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export class MigrationExportError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export const EXPORT_ROOTS = ["public", "resource-default", "data/attachments", "data/resource-library", "data/assistant-attachments"] as const;
export type OriginalFile = { path: string; bytes: string; sha256: string; stamp: string };
export type FileInventory = { roots: { path: string; present: boolean }[]; files: OriginalFile[] };
const fail = () => new MigrationExportError("original_changed", "原件缺失、发生变化或包含不受支持的链接，请核对后重新导出");

export async function hashOriginal(root: string, relative: string): Promise<OriginalFile> {
  const full = path.join(root, relative), resolved = await fs.realpath(full).catch(() => { throw fail(); });
  if (resolved !== full) throw fail(); // Never follow a symlink, including a parent directory.
  const input = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile()) throw fail();
    const hash = createHash("sha256");
    for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await input.stat({ bigint: true });
    const stamp = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(":");
    if (stamp(before) !== stamp(after) || await fs.realpath(full) !== full) throw fail();
    return { path: relative.split(path.sep).join("/"), bytes: before.size.toString(), sha256: hash.digest("hex"), stamp: stamp(after) };
  } finally { await input.close(); }
}

export async function inventoryOriginals(source: string): Promise<FileInventory> {
  const root = await fs.realpath(source), files: OriginalFile[] = [], roots: FileInventory["roots"] = [];
  const visit = async (relative: string) => {
    if (/[\x00-\x1f\x7f]/.test(relative)) throw new MigrationExportError("original_name_unsupported", "原件路径包含不受支持的控制字符");
    if ([".fire-encryption-key", "database-runtime.json", ".env", ".env.local"].includes(path.basename(relative))) throw new MigrationExportError("secret_in_originals", "原件目录中包含部署密钥或连接文件，请先隔离");
    const stat = await fs.lstat(path.join(root, relative));
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw fail();
    if (stat.isFile()) { files.push(await hashOriginal(root, relative)); return; }
    for (const name of (await fs.readdir(path.join(root, relative))).sort()) await visit(path.join(relative, name));
  };
  for (const relative of EXPORT_ROOTS) {
    const exists = await fs.lstat(path.join(root, relative)).then(() => true, error => {
      if (error.code === "ENOENT") return false; throw error;
    });
    roots.push({ path: relative, present: exists });
    if (exists) await visit(relative);
  }
  if (!roots[0].present) throw fail();
  return { roots, files };
}

export async function copyOriginals(source: string, destination: string, inventory: FileInventory) {
  for (const file of inventory.files) {
    const target = path.join(destination, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // Copy from the checked handle, never through a potentially replaced final symlink.
    const input = await fs.open(path.join(source, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const output = await fs.open(target, "wx", 0o600);
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) await output.writeFile(chunk);
      await output.sync();
    } finally { await Promise.all([input.close(), output.close()]); }
    const copied = await hashOriginal(destination, file.path);
    if (copied.sha256 !== file.sha256 || copied.bytes !== file.bytes) throw fail();
  }
  const after = await inventoryOriginals(source);
  if (JSON.stringify(after) !== JSON.stringify(inventory)) throw fail();
}

/** Only JSON string tokens are decoded. Numeric lexemes never enter JSON.parse. */
export function localReferences(rowJson: string, origin: string): string[] {
  const found = new Set<string>();
  const scan = (text: string, depth: number) => {
    for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      const value: string = JSON.parse(token[0]);
      if (depth < 2 && /^[\[{]/.test(value)) scan(value, depth + 1);
      let local = value;
      if (/^https?:\/\//i.test(local)) {
        const url = new URL(local); if (url.origin !== origin) continue; local = url.pathname;
      }
      if (!/^\/(uploads|images|fonts|icons|share|fire-assets|feature|mclaren)\//.test(local)) continue;
      try { local = decodeURIComponent(local.split(/[?#]/)[0]); } catch { throw fail(); }
      if (local.includes("\\") || local.includes("\0") || local.split("/").some(part => part === ".." || part === ".")) throw fail();
      found.add("public" + local);
    }
  };
  scan(rowJson, 0); return [...found];
}

export function assertReferences(references: Set<string>, inventory: FileInventory) {
  const names = new Set(inventory.files.map(file => file.path));
  for (const name of references) {
    if (!names.has(name) && !(name.startsWith("public/uploads/") && names.has("resource-default/" + name.slice(15)))) throw fail();
  }
}
