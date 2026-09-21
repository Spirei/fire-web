/** Pinned official KTX runtime. Kept outside public/Git; never installed system-wide. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const VERSION = '4.4.2';
const RELEASES = {
  'darwin-arm64': ['Darwin-arm64.pkg', '500bd8f9d63358c3f3a0d83b724c8574436a72c37dc0e4bad90ec1ca38032c3c'],
  'darwin-x64': ['Darwin-x86_64.pkg', 'efecc685ab891a6e119a9fdc8cbe038e135f9a367eb2f5d8a059553f947f1fea'],
  'linux-arm64': ['Linux-arm64.tar.bz2', '60382e7b842177b8048bd58ccdc770383f8ef65b94452a25d3afdb55f2405c5a'],
  'linux-x64': ['Linux-x86_64.tar.bz2', 'a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245']
};
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) throw new Error(`${command}: ${(result.stderr || result.error?.message || 'failed').slice(-500)}`);
}
function environment(directory) {
  return { ...process.env, PATH: `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`, LD_LIBRARY_PATH: `${path.join(directory, 'lib')}:${process.env.LD_LIBRARY_PATH ?? ''}` };
}
function available(env) {
  const result = spawnSync('ktx', ['--version'], { env, encoding: 'utf8', timeout: 10000 });
  return result.status === 0 && /(?:^|\s)v?4\.[4-9]\./.test(result.stdout);
}
export async function ensureKtx(directory = path.join(os.homedir(), '.cache', 'fire-tools', `ktx-${VERSION}-${process.platform}-${process.arch}`), installOnly = false) {
  const env = environment(directory);
  if (fs.existsSync(path.join(directory, 'bin', 'ktx')) && available(env)) return env;
  if (!installOnly && available(process.env)) return process.env;
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error('当前平台请先安装 KTX-Software 4.4+ 并加入 PATH');
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(directory), 'ktx-install-'));
  try {
    const filename = `KTX-Software-${VERSION}-${release[0]}`;
    const response = await fetch(`https://github.com/KhronosGroup/KTX-Software/releases/download/v${VERSION}/${filename}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`KTX 工具下载失败：${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== release[1]) throw new Error('KTX 工具 SHA-256 校验失败');
    const archive = path.join(staging, filename); fs.writeFileSync(archive, bytes);
    const output = path.join(staging, 'runtime'); fs.mkdirSync(output);
    if (process.platform === 'darwin') {
      const expanded = path.join(staging, 'expanded');
      run('pkgutil', ['--expand-full', archive, expanded]);
      for (const kind of ['tools', 'library']) {
        const pkg = fs.readdirSync(expanded).find(name => name.endsWith(`-${kind}.pkg`));
        if (!pkg) throw new Error('KTX 安装包缺少运行文件');
        fs.cpSync(path.join(expanded, pkg, 'Payload', 'usr', 'local'), output, { recursive: true, verbatimSymlinks: true });
      }
    } else {
      run('tar', ['-xjf', archive, '-C', output, '--strip-components=1']);
    }
    if (!available(environment(output))) throw new Error('KTX 工具无法执行，请检查系统运行库');
    fs.rmSync(directory, { recursive: true, force: true });
    fs.renameSync(output, directory);
    return env;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await ensureKtx(process.argv[2] ? path.resolve(process.argv[2]) : undefined, true);
  console.log('KTX runtime ready');
}
