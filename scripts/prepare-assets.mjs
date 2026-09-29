import fs from 'node:fs';
import path from 'node:path';
import { migrateAssets } from './rename-assets.mjs';
const dbPath = path.resolve('data/fire.db'), uploads = path.resolve('public/uploads');
if (fs.existsSync(dbPath) && fs.existsSync(uploads)) {
  try { console.log('[assets]', await migrateAssets({ dbPath, uploads, apply: true, once: true })); }
  catch (error) { console.warn('[assets] 自动升级未完成，保留旧地址，下次启动重试：', error.message); }
}
