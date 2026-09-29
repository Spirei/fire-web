import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getDb } from "./db";

type ImageRef = { key: string; asset_id: string; variant: string; url: string; digest: string; bytes: number; stamp: string };
const roots = () => [path.join(process.cwd(), "public/uploads"), path.join(process.cwd(), "resource-default")];
const initialized = new WeakSet<object>();
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const eligible = (url: string) => /^\/uploads\/(asset|cards)\/.+\.(svg|png|jpe?g|webp|gif|ico|avif)$/i.test(url);
function database() {
  const db = getDb();
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS asset_image_refs (
      key TEXT PRIMARY KEY, asset_id TEXT NOT NULL, variant TEXT NOT NULL,
      url TEXT NOT NULL, digest TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0, stamp TEXT NOT NULL DEFAULT ''
    ); CREATE TABLE IF NOT EXISTS asset_image_aliases (url TEXT PRIMARY KEY, image_key TEXT NOT NULL);`);
    initialized.add(db);
  }
  return db;
}

/** Only public managed images can be served; symlinks cannot escape either root. */
export function managedImageFile(url: string): string | null {
  if (!eligible(url)) return null;
  let rel: string;
  try { rel = decodeURIComponent(url.slice(9)); } catch { return null; }
  if (rel.split(/[\\/]/).some(segment => segment === ".." || segment.startsWith(".")) || rel.includes("\0")) return null;
  for (const root of roots()) {
    try {
      const file = fs.realpathSync(path.join(root, rel));
      if (file.startsWith(fs.realpathSync(root) + path.sep) && fs.statSync(file).isFile()) return file;
    } catch { /* Try the bundled defaults. */ }
  }
  return null;
}

function aliases(url: string): string[] {
  try { const raw = decodeURIComponent(url); return [...new Set([url, raw, raw.split('/').map(encodeURIComponent).join('/')])]; }
  catch { return [url]; }
}

/** The ID is immutable; the file path and fingerprint are implementation details. */
export function managedImageUrl(assetId: string, url: string, variant = "light"): string {
  if (!assetId || !eligible(url)) return url;
  const db = database(), key = hash(`${assetId}\0${variant}`).slice(0, 24);
  const previous = db.prepare("SELECT * FROM asset_image_refs WHERE key=?").get(key) as ImageRef | undefined;
  const file = managedImageFile(url);
  if (!file && previous) return `/api/asset-image/${key}?v=${previous.digest.slice(0, 12)}`;
  if (!file) return url;
  const stat = fs.statSync(file), stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  const digest = previous?.url === url && previous.stamp === stamp ? previous.digest : hash(fs.readFileSync(file));
  if (!previous || previous.url !== url || previous.stamp !== stamp) {
    db.transaction(() => {
      db.prepare("INSERT INTO asset_image_refs (key,asset_id,variant,url,digest,bytes,stamp) VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET url=excluded.url,digest=excluded.digest,bytes=excluded.bytes,stamp=excluded.stamp")
        .run(key, assetId, variant, url, digest, stat.size, stamp);
      const insert = db.prepare("INSERT OR IGNORE INTO asset_image_aliases VALUES (?,?)");
      for (const old of [previous?.url, url]) if (old) for (const alias of aliases(old)) insert.run(alias, key);
    })();
  }
  return `/api/asset-image/${key}?v=${digest.slice(0, 12)}`;
}

const retryAfter = new Map<string, number>();
function findRenamed(ref: ImageRef): string | null {
  if (!ref.digest || (retryAfter.get(ref.key) || 0) > Date.now()) return null;
  retryAfter.set(ref.key, Date.now() + 5000);
  const root = roots()[0];
  const search = (dir: string): string | null => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = search(file); if (found) return found; }
      else if (/\.(svg|png|jpe?g|webp|gif|ico|avif)$/i.test(entry.name)) {
        try { if (fs.statSync(file).size === ref.bytes && hash(fs.readFileSync(file)) === ref.digest) return file; } catch { /* File changed during scan. */ }
      }
    }
    return null;
  };
  const file = search(path.join(root, 'asset')) || search(path.join(root, 'cards'));
  return file ? '/uploads/' + path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/') : null;
}

export function resolveManagedImage(key: string): { url: string; etag: string } | null {
  if (!/^[a-f0-9]{24}$/.test(key)) return null;
  const db = database();
  const ref = db.prepare("SELECT * FROM asset_image_refs WHERE key=?").get(key) as ImageRef | undefined;
  if (!ref) return null;
  const column = ref.variant === 'dark' ? 'url_dark' : 'url';
  const asset = db.prepare(`SELECT ${column} AS url FROM assets WHERE id=?`).get(ref.asset_id) as { url?: string } | undefined;
  if (!asset?.url || !eligible(asset.url)) return null;
  let url = asset.url;
  if (!managedImageFile(url)) {
    // A rename is recoverable only when the recorded bytes still match; no filename guessing.
    if (url !== ref.url) return null;
    const recovered = findRenamed(ref);
    if (!recovered) return null;
    const updated = db.prepare(`UPDATE assets SET ${column}=? WHERE id=? AND ${column}=?`).run(recovered, ref.asset_id, url);
    if (!updated.changes) return null;
    url = recovered;
  }
  const stable = managedImageUrl(ref.asset_id, url, ref.variant);
  return { url, etag: '"' + stable.split('?v=')[1] + '"' };
}

export function resolveManagedAlias(url: string): { url: string; etag: string } | null {
  if (!eligible(url)) return null;
  const db = database();
  const row = db.prepare("SELECT image_key FROM asset_image_aliases WHERE url=?").get(url) as { image_key: string } | undefined;
  return row ? resolveManagedImage(row.image_key) : null;
}
