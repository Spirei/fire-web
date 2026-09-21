import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { model } from './fixture.mjs';
import { inspectSource, GPU_FILE_THRESHOLD, PREVIEW_MODE, validDerivative, writeManifest } from '../scripts/showcase-generation.mjs';
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
 console.log('PASS thresholds, texture memory, output fingerprint and malformed input');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
