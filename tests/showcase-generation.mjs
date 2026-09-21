import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { inspectSource, GPU_FILE_THRESHOLD, PREVIEW_MODE, GPU_MODE, validDerivative, writeManifest, acquireGenerationLock } from '../scripts/showcase-generation.mjs';
import { generatePreviews } from '../scripts/build-showcase-previews.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-generation-test-'));
async function model(file, width, height, minBytes = 0) {
  const image = await sharp({ create: { width, height, channels: 4, background: '#abc' } }).png().toBuffer();
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: image.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: image.length }], images: [{ bufferView: 0, mimeType: 'image/png' }] }));
  const padded = Math.ceil(json.length / 4) * 4, size = Math.max(28 + padded + Math.ceil(image.length / 4) * 4, minBytes);
  const bytes = Buffer.alloc(size); bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(size, 8); bytes.writeUInt32LE(padded, 12); bytes.writeUInt32LE(0x4e4f534a, 16); bytes.fill(32, 20, 20 + padded); json.copy(bytes, 20); bytes.writeUInt32LE(size - 28 - padded, 20 + padded); bytes.writeUInt32LE(0x004e4942, 24 + padded); image.copy(bytes, 28 + padded);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
try {
  const input = path.join(root, 'public/mclaren/mcl35m.glb');
  await model(input, 8, 8, GPU_FILE_THRESHOLD - 1); assert.equal((await inspectSource(input)).needsGpu, false);
  await model(input, 8, 8, GPU_FILE_THRESHOLD); assert.equal((await inspectSource(input)).needsGpu, true);
  await model(input, 8192, 8192); const original = fs.readFileSync(input); assert.equal((await inspectSource(input)).needsGpu, true);
  const broken = path.join(root, 'broken.glb');
  fs.writeFileSync(broken, Buffer.from('short'));
  await assert.rejects(inspectSource(broken), /无效 GLB/);
  const badHeader = Buffer.from(original); badHeader.writeUInt32LE(original.length + 4, 8); fs.writeFileSync(broken, badHeader);
  await assert.rejects(inspectSource(broken), /无效 GLB/);
  const badBin = Buffer.from(original), binHeader = 20 + badBin.readUInt32LE(12);
  badBin.writeUInt32LE(4, binHeader); fs.writeFileSync(broken, badBin);
  await assert.rejects(inspectSource(broken), /无效 GLB BIN/);
  const unlock = acquireGenerationLock(root); assert.throws(() => acquireGenerationLock(root), /正在运行/); unlock();
  let previews = 0, gpu = 0; const events = [];
  const options = { root, id: 'mcl35m', onProgress: e => events.push(e), previewBuilder: async (_in, out) => { previews++; fs.writeFileSync(out, 'preview'); }, gpuBuilder: async (source, { output, identity }) => { if (validDerivative(source, output, GPU_MODE, identity.sourceSha256)) return { reused: true }; gpu++; fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, 'gpu'); writeManifest(output, identity, { mode: GPU_MODE }); return { reused: false }; } };
  assert.equal((await generatePreviews(options)).gpuCount, 1); assert.deepEqual(fs.readFileSync(input), original);
  const reused = await generatePreviews(options); assert.equal(reused.reused, 1); assert.equal(reused.gpuReused, 1); assert.equal(previews, 1); assert.equal(gpu, 1);
  assert(events.some(e => e.phase === 'gpu')); assert.equal(events.at(-1).phase, 'done');
  const previewPath = path.join(root, 'public/uploads/mclaren/previews/builtin-mcl35m-preview.glb');
  fs.writeFileSync(previewPath, 'damaged'); // Same byte length as 'preview'.
  assert.equal(validDerivative(input, previewPath, PREVIEW_MODE), false, 'same-size corruption must not be reused');
  const repaired = await generatePreviews(options);
  assert.equal(repaired.reused, 0); assert.equal(repaired.gpuReused, 1); assert.equal(previews, 2);
  assert.equal(fs.readFileSync(previewPath, 'utf8'), 'preview');
  fs.utimesSync(input, new Date(), new Date(Date.now() + 1000));
  const failed = await generatePreviews({ ...options, gpuBuilder: async () => { throw new Error('encoder failed'); } });
  assert.equal(failed.failed, 1); assert.equal(failed.count, 1); assert.equal(events.at(-1).phase, 'error');
  assert.deepEqual(fs.readFileSync(input), original); assert.equal(fs.existsSync(path.join(root, 'data/showcase-generation.lock')), false);
  await assert.rejects(generatePreviews({ ...options, id: 'missing' }), /车型不存在/);
  assert.equal(validDerivative(input, path.join(root, 'public/uploads/mclaren/previews/builtin-mcl35m-preview.glb'), PREVIEW_MODE), true);
  const legacy = JSON.parse(fs.readFileSync(`${previewPath}.json`, 'utf8')); delete legacy.outputSha256;
  fs.writeFileSync(`${previewPath}.json`, JSON.stringify(legacy));
  assert.equal(validDerivative(input, previewPath, PREVIEW_MODE), false, 'legacy records need an integrity baseline');
  console.log('PASS: thresholds, texture memory, per-model selection, original preservation, caching, invalidation, lock and partial failure');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
