/** 保留几何与源尺寸；UASTC 高质量压缩不等于逐像素无损。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const toolRoot = fileURLToPath(new URL('../', import.meta.url));
import { verifyGpuDerivative } from './showcase-gpu-verify.mjs';
import { ensureKtx } from './showcase-ktx.mjs';
import { GPU_MODE, inspectSource, sourceUnchanged, validDerivative, writeManifest } from './showcase-generation.mjs';

export async function buildGpu(input, { output, identity } = {}) {
  input = path.resolve(input);
  identity ??= await inspectSource(input);
  output ??= path.join(path.dirname(path.dirname(input)), 'gpu', `${path.basename(input, '.glb')}-uastc.glb`);
  if (validDerivative(input, output, GPU_MODE, identity.sourceSha256)) return { reused: true, output };
  const env = await ensureKtx();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.glb`;
  try {
    const result = spawnSync(path.join(toolRoot, 'node_modules', '.bin', 'gltf-transform'), [
      'uastc', input, temp, '--level', '3', '--rdo', 'false', '--zstd', '18', '--jobs', '2'
    ], { stdio: 'inherit', env });
    if (result.status !== 0) throw new Error('GPU 压缩失败，原文件未改动');
    if (!sourceUnchanged(input, identity)) throw new Error('转换期间原文件已改变，请重新生成');
    const verified = await verifyGpuDerivative(fs.readFileSync(input), fs.readFileSync(temp));
    fs.renameSync(temp, output);
    writeManifest(output, identity, { mode: GPU_MODE, preservesTextureDimensions: true, preservesGeometry: true, pixelLossless: false, verified });
    return { reused: false, output };
  } finally { fs.rmSync(temp, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]?.endsWith('.glb')) throw new Error('用法：node scripts/build-showcase-gpu.mjs <模型.glb>');
  const result = await buildGpu(process.argv[2]);
  console.log(`${result.reused ? '复用' : '已生成'} GPU 副本：${result.output}；原文件保留。`);
}
