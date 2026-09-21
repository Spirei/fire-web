import { runGltf } from "./gltf-cli.mjs";
export function optimize(input, output) {
  const result = runGltf([
    'optimize', input, output, '--compress', 'meshopt', '--simplify', 'false', '--join', 'false', '--flatten', 'false', '--palette', 'false', '--texture-compress', 'webp', '--texture-size', '1024'
  ]);
  if (result.status !== 0) throw new Error('首页预览生成失败');
}
