import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { model } from './fixture.mjs';
import { inspectSource, GPU_FILE_THRESHOLD, PREVIEW_MODE, validDerivative, writeManifest } from '../scripts/showcase-generation.mjs';
import { exportModel } from '../export.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-local-test-'));
try {
 const input = path.join(root, 'car.glb');
 await model(input, 8, 8, GPU_FILE_THRESHOLD - 1); assert.equal((await inspectSource(input)).needsGpu, false);
 await model(input, 8, 8, GPU_FILE_THRESHOLD); assert.equal((await inspectSource(input)).needsGpu, true);
 await model(input, 8192, 8192); const identity = await inspectSource(input); assert.equal(identity.needsGpu, true);
 const output = path.join(root, 'preview.glb'); fs.writeFileSync(output, 'preview'); writeManifest(output, identity, { mode: PREVIEW_MODE });
 assert(validDerivative(input, output, PREVIEW_MODE, identity.sourceSha256));
 fs.writeFileSync(output, 'damaged'); assert.equal(validDerivative(input, output, PREVIEW_MODE, identity.sourceSha256), false);
 fs.writeFileSync(input, 'broken'); await assert.rejects(inspectSource(input), /无效 GLB/);
 // Use only disposable sentinel paths; the rejected model must never reach NodeIO/builders.
 const sentinel = path.join(root, 'private-fixture.bin'); fs.writeFileSync(sentinel, 'SENTINEL');
 function glb(json) {
   const raw = Buffer.from(JSON.stringify(json)), length = Math.ceil(raw.length / 4) * 4;
   const bytes = Buffer.alloc(28 + length + 8);
   bytes.writeUInt32LE(0x46546c67); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(length, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
   bytes.fill(32, 20, 20 + length); raw.copy(bytes, 20); bytes.writeUInt32LE(8, 20 + length); bytes.writeUInt32LE(0x004e4942, 24 + length);
   fs.writeFileSync(input, bytes);
 }
 let builderCalls = 0;
 for (const uri of [sentinel, '../private-fixture.bin', 'file://' + sentinel, 'https://127.0.0.1/private', 'data:application/octet-stream;base64,U0VOVElORUw=']) {
   glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8, uri }] });
   await assert.rejects(inspectSource(input), /外部文件引用/);
   await assert.rejects(exportModel(input, path.join(root, 'rejected'), { progress() {}, previewBuilder() { builderCalls++; }, gpuBuilder() { builderCalls++; } }), /外部文件引用/);
 }
 glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }], images: [{ bufferView: 0, uri: sentinel }] });
 await assert.rejects(inspectSource(input), /外部文件引用/);
 assert.equal(builderCalls, 0); assert(!fs.existsSync(path.join(root, 'rejected'))); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'SENTINEL');
 console.log('PASS thresholds, texture memory, output fingerprint and malformed input');
 console.log('PASS uploaded GLB external buffers/images are rejected before filesystem-reading optimizer stages');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
