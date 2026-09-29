#!/usr/bin/env node
/** Copy-first migration; old URLs remain compatible. Default dry-run, --apply writes.
 * Run on the DB host: never open a live SQLite database over SMB.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import naming from '../lib/assetNaming.cjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
const urlOf = rel => '/uploads/' + rel.split('/').map(encodeURIComponent).join('/');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const image = /\.(svg|png|jpe?g|webp|gif|ico|avif|woff2?|ttf|otf)$/i;
function filesIn(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) return [];
    const next = path.posix.join(rel, entry.name);
    return entry.isDirectory() ? filesIn(root, next) : [next];
  });
}
export function planAssets(db, uploads) {
  const files = filesIn(uploads).filter(file => image.test(file));
  const available = new Set(files), desired = new Map(), missing = [], caseAliases = new Map();
  const rows = db.prepare('SELECT type, market, code, name, url, url_dark FROM assets').all();
  for (const row of rows) for (const field of ['url', 'url_dark']) {
    if (!row[field]?.startsWith('/uploads/')) continue;
    let rel = decode(row[field].slice(9));
    if (!available.has(rel) && fs.existsSync(path.join(uploads, rel))) {
      const actual = files.find(file => file.toLowerCase() === rel.toLowerCase());
      if (actual) { caseAliases.set(rel, actual); rel = actual; }
    }
    if (!available.has(rel)) { missing.push(row[field]); continue; }
    if (!rel.startsWith(`asset/${row.type}/`)) continue;
    // Card keys are wallet identities; only their image URLs move. CN/HK names are allowed.
    if (row.type === 'card' || /^asset\/stock\/(CN|HK)\//.test(rel)) continue;
    const ext = path.extname(rel);
    const filename = naming.assetFilename(row, ext);
    const stem = filename.slice(0, -ext.length) + (field === 'url_dark' ? '-dark' : '');
    desired.set(rel, path.posix.join(path.posix.dirname(rel), stem + ext.toLowerCase()));
  }
  const digests = new Map();
  const digest = rel => {
    if (!digests.has(rel)) digests.set(rel, hash(fs.readFileSync(path.join(uploads, rel))));
    return digests.get(rel);
  };
  const targets = new Map(), mapping = new Map();
  // Live records own the short name; unused legacy variants receive a content suffix.
  files.sort((a, b) => Number(desired.has(b)) - Number(desired.has(a)) || a.localeCompare(b, 'en'));
  for (const rel of files) {
    let target = desired.get(rel) || rel;
    if (/^asset\/flag\/[a-z]{2}\.svg$/i.test(rel)) target = 'asset/flag/' + path.basename(rel).toLowerCase();
    if (rel === 'feature/passkey/通行密钥PASSKEY.png') target = 'feature/passkey/passkey.png';
    if (/[^\x00-\x7f]/.test(target) && !/^asset\/stock\/(CN|HK)\//.test(target)) {
      const parent = path.posix.dirname(target).split('/').map(part => /^[\w.-]+$/.test(part) ? part : 'd-' + hash(part).slice(0, 10)).join('/');
      const stem = path.basename(target, path.extname(target));
      const code = /^(?:asset\/market|asset\/flag|asset\/crypto|asset\/metal)\//.test(rel) ? stem.match(/([A-Z][A-Z0-9]*)$/)?.[1] : '';
      target = path.posix.join(parent, (code ? (rel.startsWith('asset/flag/') ? code.toLowerCase() : code) : 'img-' + hash(rel).slice(0, 12)) + path.extname(target).toLowerCase());
      if (rel.startsWith('cards/')) target = 'cards/images/' + hash(rel).slice(0, 16) + path.extname(rel).toLowerCase();
    }
    const previous = targets.get(target) || (available.has(target) ? target : null);
    if (previous && previous !== rel && digest(previous) !== digest(rel)) {
      target = target.slice(0, -path.extname(target).length) + '-' + digest(rel).slice(0, 12) + path.extname(target);
    }
    targets.set(target, rel);
    mapping.set(rel, target);
  }
  // Identical flags share the market URL; never merge different custom images.
  const markets = new Map();
  for (const rel of files.filter(file => /^asset\/market\//.test(file))) {
    if (!markets.has(digest(rel))) markets.set(digest(rel), mapping.get(rel));
  }
  for (const rel of files.filter(file => /^asset\/flag\//.test(file))) {
    if (markets.has(digest(rel))) mapping.set(rel, markets.get(digest(rel)));
  }
  for (const [alias, actual] of caseAliases) mapping.set(alias, mapping.get(actual));
  return { moves: [...mapping].filter(([from, to]) => from !== to).map(([from, to]) => ({ from, to, sha256: digest(from) })), missing: [...new Set(missing)] };
}
export function replaceUrls(value, moves) {
  const map = new Map(moves.flatMap(({ from, to }) => [[urlOf(from), urlOf(to)], ['/uploads/' + from, urlOf(to)]]));
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  if (!keys.length) return value;
  const escaped = keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Only whole URL tokens; labels and logical IDs are not filenames.
  return value.replace(new RegExp('(?:' + escaped.join('|') + ')(?=$|[?#[\\]\\s"\'<>)};,])', 'g'), match => map.get(match));
}
export async function migrateAssets({ dbPath, uploads, apply = false, once = false }) {
  if (dbPath.startsWith('/Volumes/') || uploads.startsWith('/Volumes/')) throw new Error('Run migration on the database host, not SMB');
  const db = new Database(dbPath, { fileMustExist: true, readonly: !apply });
  db.pragma('busy_timeout = 10000');
  try {
    const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asset_migrations'").get();
    if (once && hasMigrations && db.prepare("SELECT 1 FROM asset_migrations WHERE id='short-urls-v2'").get()) return { skipped: true, reason: 'already migrated' };
    const plan = planAssets(db, uploads);
    if (!apply) return { dryRun: true, ...plan };
    const backupDir = path.join(path.dirname(dbPath), 'asset-migration-backups', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    await db.backup(path.join(backupDir, 'fire.db'));
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(plan, null, 2));
    for (const { from, to, sha256 } of plan.moves) {
      const source = path.join(uploads, from), target = path.join(uploads, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (hash(fs.readFileSync(target)) !== sha256) throw new Error('Target mismatch: ' + to);
    }
    let changedCells = 0;
    db.transaction(() => {
      // Legacy seeders search market=''; prevent the old running container from reseeding URLs.
      db.prepare("UPDATE assets SET market='' WHERE type IN ('flag','crypto','metal') AND market='OTHER'").run();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      for (const { name } of tables) {
        const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().filter(c => /TEXT|CHAR|CLOB/i.test(c.type) && !c.pk);
        for (const col of columns) {
          const rows = db.prepare(`SELECT rowid AS _rid, ${quote(col.name)} AS value FROM ${quote(name)} WHERE typeof(${quote(col.name)})='text' AND instr(${quote(col.name)}, '/uploads/') > 0`).all();
          const update = db.prepare(`UPDATE ${quote(name)} SET ${quote(col.name)}=? WHERE rowid=?`);
          for (const row of rows) {
            const next = replaceUrls(row.value, plan.moves);
            if (next !== row.value) { update.run(next, row._rid); changedCells++; }
          }
        }
      }
    }).immediate();
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Database integrity check failed');
    const result = { dryRun: false, copiedAliases: plan.moves.length, changedCells, missing: plan.missing, backupDir };
    if (once && !plan.missing.length) {
      db.exec('CREATE TABLE IF NOT EXISTS asset_migrations (id TEXT PRIMARY KEY, completed_at TEXT NOT NULL)');
      db.prepare('INSERT OR IGNORE INTO asset_migrations VALUES (?,?)').run('short-urls-v2', new Date().toISOString());
    }
    return result;
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
  console.log(JSON.stringify(await migrateAssets({ dbPath: path.resolve(arg('--db', 'data/fire.db')), uploads: path.resolve(arg('--uploads', 'public/uploads')), apply: process.argv.includes('--apply'), once: process.argv.includes('--once') }), null, 2));
}
