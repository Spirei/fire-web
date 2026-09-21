import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请安装 Node.js 22 或更高版本');
const lock = fs.readFileSync(path.join(root, 'package-lock.json'));
const stamp = path.join(root, 'node_modules', '.fire-lock');
const fingerprint = JSON.stringify({ platform: process.platform, arch: process.arch, node: process.versions.modules, lock: crypto.createHash('sha256').update(lock).digest('hex') });
if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== fingerprint) {
  const npm = process.env.npm_execpath;
  if (!npm || !fs.existsSync(npm)) throw new Error('请在工具目录使用 npm start 启动');
  console.log('首次准备本地依赖，之后复用缓存…');
  const result = spawnSync(process.execPath, [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('本地依赖安装失败，请检查网络后重试');
  fs.writeFileSync(stamp, fingerprint);
}
await import('./app.mjs');
