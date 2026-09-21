import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const toolRoot = fileURLToPath(new URL('../', import.meta.url));
export function optimize(input, output) {
  const result = spawnSync(path.join(toolRoot, 'node_modules', '.bin', 'gltf-transform'), [
    'optimize', input, output, '--compress', 'meshopt', '--simplify', 'false', '--join', 'false', '--flatten', 'false', '--palette', 'false', '--texture-compress', 'webp', '--texture-size', '1024'
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('首页预览生成失败');
}
