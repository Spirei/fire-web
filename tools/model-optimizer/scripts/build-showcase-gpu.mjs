/** 保留几何与源尺寸；UASTC 高质量压缩不等于逐像素无损。 */
import fs from 'node:fs';
import path from 'node:path';
import { runGltf } from "./gltf-cli.mjs";
import { pathToFileURL } from 'node:url';
import { verifyGpuDerivative } from './showcase-gpu-verify.mjs';
import { ensureKtx } from './showcase-ktx.mjs';
import { GPU_MODE, GPU_MESHOPT_MODE, inspectSource, sourceUnchanged, validDerivative, writeManifest } from './showcase-generation.mjs';

export async function buildGpu(input, { output, identity, onProgress } = {}) {
  input = path.resolve(input);
  identity ??= await inspectSource(input);
  output ??= path.join(path.dirname(path.dirname(input)), 'gpu', `${path.basename(input, '.glb')}-uastc.glb`);
  const largeGeometry = identity.sourceBytes >= 50 * 1024 * 1024;
  const mode = largeGeometry ? GPU_MESHOPT_MODE : GPU_MODE;
  if (validDerivative(input, output, mode, identity.sourceSha256)) return { reused: true, output };
  const env = await ensureKtx(undefined, false, onProgress);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.glb`;
  const packed = `${output}.${process.pid}.meshopt.glb`;
  try {
    const result = runGltf([
      'uastc', input, temp, '--level', '3', '--rdo', 'false', '--zstd', '18', '--jobs', '2'
    ], env);
    if (result.status !== 0) throw new Error('GPU 压缩失败，原文件未改动');
    if (!sourceUnchanged(input, identity)) throw new Error('转换期间原文件已改变，请重新生成');
    const verified = await verifyGpuDerivative(fs.readFileSync(input), fs.readFileSync(temp));
    let selected = temp;
    let geometryOptimized = false;
    if (largeGeometry) {
      const compressed = runGltf(['meshopt', temp, packed, '--level', 'high', '--quantize-position', '16', '--quantize-normal', '12', '--quantize-texcoord', '14']);
      if (compressed.status !== 0) throw new Error('大模型几何压缩失败，原文件未改动');
      const packedInfo = await inspectSource(packed);
      const sameTextures = packedInfo.textures.length === verified.textures.length
        && packedInfo.textures.every((texture, index) => texture.compressed && texture.width === verified.textures[index].width && texture.height === verified.textures[index].height);
      if (!sameTextures) throw new Error('几何压缩改变了贴图尺寸，已拒绝导出');
      if (fs.statSync(packed).size < fs.statSync(temp).size * 0.8) { selected = packed; geometryOptimized = true; }
    }
    fs.renameSync(selected, output);
    writeManifest(output, identity, { mode, preservesTextureDimensions: true, preservesGeometry: !geometryOptimized, preservesTopology: true, geometryOptimized, pixelLossless: false, verified });
    return { reused: false, output };
  } finally { fs.rmSync(temp, { force: true }); fs.rmSync(packed, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]?.endsWith('.glb')) throw new Error('用法：node scripts/build-showcase-gpu.mjs <模型.glb>');
  const result = await buildGpu(process.argv[2]);
  console.log(`${result.reused ? '复用' : '已生成'} GPU 副本：${result.output}；原文件保留。`);
}
