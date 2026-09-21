import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

// Offline derivative triggers, not rendering limits and never a reason to lower user quality.
export const GPU_FILE_THRESHOLD = 50 * 1024 * 1024;
export const GPU_TEXTURE_THRESHOLD = 256 * 1024 * 1024;
export const PREVIEW_MODE = 'preview-webp-1024-meshopt-v1';
export const GPU_MODE = 'UASTC level 3, RDO off, Zstd 18';
export function sourceIdentity(input) {
  const stat = fs.statSync(input);
  return { sourceBytes: stat.size, sourceMtimeMs: stat.mtimeMs };
}
export function sourceUnchanged(input, identity) {
  const current = sourceIdentity(input);
  return current.sourceBytes === identity.sourceBytes && current.sourceMtimeMs === identity.sourceMtimeMs;
}
export function fileSha256(file) {
  const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
export function validDerivative(input, output, mode, sourceSha256) {
  try {
    const manifest = JSON.parse(fs.readFileSync(`${output}.json`, 'utf8'));
    return sourceUnchanged(input, manifest) && fs.statSync(output).size === manifest.outputBytes
      && manifest.mode === mode && (!sourceSha256 || manifest.sourceSha256 === sourceSha256)
      && typeof manifest.outputSha256 === "string" && fileSha256(output) === manifest.outputSha256;
  } catch { return false; }
}
export async function inspectSource(input) {
  const identity = sourceIdentity(input), bytes = fs.readFileSync(input);
  if (bytes.length < 28 || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error('无效 GLB 文件');
  const jsonLength = bytes.readUInt32LE(12);
  if (jsonLength % 4 || jsonLength > bytes.length - 28) throw new Error("无效 GLB JSON 区块");
  const binHeader = 20 + jsonLength;
  if (bytes.readUInt32LE(binHeader + 4) !== 0x004e4942 || bytes.readUInt32LE(binHeader) !== bytes.length - binHeader - 8) throw new Error("无效 GLB BIN 区块");
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binStart = 28 + jsonLength;
  let rgbaBytes = 0, compressed = 0;
  const textures = [];
  for (const image of json.images ?? []) {
    const view = json.bufferViews?.[image.bufferView];
    if (!view || (view.buffer ?? 0) !== 0) throw new Error('请使用内嵌贴图的 GLB');
    const start = binStart + (view.byteOffset ?? 0), end = start + view.byteLength;
    if (start < binStart || end > bytes.length) throw new Error('GLB 贴图数据越界');
    const imageBytes = bytes.subarray(start, end);
    let width, height;
    if (image.mimeType === 'image/ktx2') {
      width = imageBytes.readUInt32LE(20); height = imageBytes.readUInt32LE(24); compressed++;
    } else ({ width, height } = await sharp(imageBytes).metadata());
    if (!width || !height) throw new Error('无法读取贴图尺寸');
    textures.push({ width, height, compressed: image.mimeType === "image/ktx2" });
    for (let w = width, h = height;; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
      rgbaBytes += w * h * 4;
      if (w === 1 && h === 1) break;
    }
  }
  if (!sourceUnchanged(input, identity)) throw new Error('扫描期间原模型已改变，请重新生成');
  const needsGpu = textures.length > compressed && (identity.sourceBytes >= GPU_FILE_THRESHOLD || rgbaBytes >= GPU_TEXTURE_THRESHOLD);
  return { ...identity, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'), rgbaBytes, textures, needsGpu };
}
export function writeManifest(output, identity, extra) {
  const temp = `${output}.json.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...identity, outputBytes: fs.statSync(output).size, outputSha256: fileSha256(output), ...extra, generatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(temp, `${output}.json`);
  } finally { fs.rmSync(temp, { force: true }); }
}
