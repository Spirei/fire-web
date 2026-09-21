/** 保留几何体与贴图尺寸；UASTC 高质量压缩不是逐像素无损。需要 KTX-Software 4.4+。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { verifyGpuDerivative } from './showcase-gpu-verify.mjs';

const input = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !input.endsWith('.glb') || !fs.statSync(input).isFile()) {
  throw new Error('用法：node scripts/build-showcase-gpu.mjs public/uploads/mclaren/models/<车型>.glb');
}
const outputDir = path.join(path.dirname(path.dirname(input)), 'gpu');
fs.mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, `${path.basename(input, '.glb')}-uastc.glb`);
const temp = `${output}.${process.pid}.glb`;
const before = fs.statSync(input);
try {
  const result = spawnSync(path.resolve('node_modules/.bin/gltf-transform'), [
    'uastc', input, temp, '--level', '3', '--rdo', 'false', '--zstd', '18', '--jobs', '2'
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('GPU 压缩失败，原文件未改动；请确认 ktx 在 PATH 中');
  const after = fs.statSync(input);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('转换期间原文件已改变，请重新生成');
  const source = fs.readFileSync(input), compressed = fs.readFileSync(temp);
  const verified = await verifyGpuDerivative(source, compressed);
  fs.renameSync(temp, output);
  fs.writeFileSync(`${output}.json`, JSON.stringify({
    sourceBytes: before.size, sourceMtimeMs: before.mtimeMs,
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    outputBytes: compressed.length, mode: 'UASTC level 3, RDO off, Zstd 18',
    preservesTextureDimensions: true, preservesGeometry: true,
    pixelLossless: false, verified, generatedAt: new Date().toISOString()
  }, null, 2));
  console.log(`原始 ${(source.length / 1048576).toFixed(1)} MiB → GPU 副本 ${(compressed.length / 1048576).toFixed(1)} MiB；原文件保留。`);
} finally { fs.rmSync(temp, { force: true }); }
