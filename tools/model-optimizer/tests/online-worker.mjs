import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { model } from './fixture.mjs';

async function sceneModel(file) {
  await model(file, 8, 8);
  const original = fs.readFileSync(file);
  const originalJsonLength = original.readUInt32LE(12);
  const originalJson = JSON.parse(original.subarray(20, 20 + originalJsonLength).toString());
  const image = original.subarray(28 + originalJsonLength, 28 + originalJsonLength + originalJson.bufferViews[0].byteLength);
  const imageLength = Math.ceil(image.length / 4) * 4;
  const positions = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const json = {
    asset: { version: '2.0' }, buffers: [{ byteLength: imageLength + positions.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: image.length }, { buffer: 0, byteOffset: imageLength, byteLength: positions.length, target: 34962 }],
    accessors: [{ bufferView: 1, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    images: [{ bufferView: 0, mimeType: 'image/png' }], textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0
  };
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const paddedJson = Math.ceil(jsonBytes.length / 4) * 4;
  const size = 28 + paddedJson + imageLength + positions.length;
  const output = Buffer.alloc(size);
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(size, 8);
  output.writeUInt32LE(paddedJson, 12); output.writeUInt32LE(0x4e4f534a, 16);
  output.fill(32, 20, 20 + paddedJson); jsonBytes.copy(output, 20);
  output.writeUInt32LE(imageLength + positions.length, 20 + paddedJson); output.writeUInt32LE(0x004e4942, 24 + paddedJson);
  image.copy(output, 28 + paddedJson); positions.copy(output, 28 + paddedJson + imageLength);
  fs.writeFileSync(file, output);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-online-worker-test-'));
process.env.FIRE_SHOWCASE_DIR = root;
const { pollOnce } = await import('../online-worker.mjs');
try {
  const file = 'test-car.glb', id = randomUUID(), source = path.join(root, 'models', file), directory = path.join(root, 'processing', 'jobs', id);
  await sceneModel(source);
  const original = fs.readFileSync(source);
  fs.writeFileSync(path.join(root, 'showroom.json'), JSON.stringify({ models: [{ id: 'test-car', file }] }));
  fs.mkdirSync(directory, { recursive: true });
  const stat = fs.statSync(source);
  fs.writeFileSync(path.join(directory, 'job.json'), JSON.stringify({ id, modelId: 'test-car', file, sourceBytes: stat.size, sourceMtimeMs: stat.mtimeMs, status: 'queued', createdAt: new Date().toISOString() }));
  assert.equal(await pollOnce(), true);
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8'));
  assert.equal(result.status, 'done', result.message);
  assert.equal(result.preview, true);
  assert.equal(result.gpu, false);
  assert(fs.existsSync(path.join(root, 'previews', 'test-car-preview.glb')));
  assert.deepEqual(fs.readFileSync(source), original, 'source unchanged');
  assert.equal(fs.existsSync(path.join(directory, 'output')), false, 'generated staging released');
  assert.equal(await pollOnce(), false);
  const cancelledId = randomUUID(), cancelledDirectory = path.join(root, 'processing', 'jobs', cancelledId);
  fs.mkdirSync(cancelledDirectory, { recursive: true });
  fs.writeFileSync(path.join(cancelledDirectory, 'job.json'), JSON.stringify({ id: cancelledId, modelId: 'test-car', file, sourceBytes: stat.size, sourceMtimeMs: stat.mtimeMs, status: 'queued', createdAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(cancelledDirectory, 'cancel'), '1');
  assert.equal(await pollOnce(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cancelledDirectory, 'job.json'), 'utf8')).status, 'cancelled');
  console.log('PASS online worker completes queued preview, preserves source, cleans staging and cancels safely');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
