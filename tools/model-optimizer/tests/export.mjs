import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { model } from './fixture.mjs';
import { exportModel } from '../export.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-export-test-'));
try {
 const input = path.join(root, 'original.glb'), output = path.join(root, 'exports');
 await model(input, 8, 8); const original = fs.readFileSync(input);
 let gpuCalls = 0;
 const options = { progress: () => {}, previewBuilder: async (_in, out) => fs.writeFileSync(out, 'preview'), gpuBuilder: async (_in, { output }) => { gpuCalls++; fs.writeFileSync(output, 'gpu'); } };
 const exported = await exportModel(input, output, options);
 assert.deepEqual(fs.readFileSync(path.join(exported, 'original-optimized.glb')), original);
 assert.deepEqual(fs.readFileSync(input), original); assert.equal(gpuCalls, 0);
 assert(fs.readFileSync(path.join(exported, '上传说明.txt'), 'utf8').includes('上传首页预览'));
 await assert.rejects(exportModel(input, output, { ...options, previewBuilder: async () => { throw new Error('encoder failed'); } }), /encoder failed/);
 assert.equal(fs.readdirSync(output).length, 1, 'failed staging removed, prior export preserved');
 await model(input, 8192, 8192); await exportModel(input, output, options); assert.equal(gpuCalls, 1);
 await assert.rejects(exportModel(input, output, { ...options, previewBuilder: async (source, out) => { fs.writeFileSync(out, 'preview'); fs.appendFileSync(source, 'changed'); } }), /原文件发生变化/);
 const named = path.join(root, '中文车模.glb'); await model(named, 8, 8);
 const namedExport = await exportModel(named, output, options); assert(fs.existsSync(path.join(namedExport, 'model-optimized.glb')), 'non-Latin input gets a valid upload filename');
 console.log('PASS small original copy, large GPU dispatch, original preservation, complete bundle, failure cleanup and source mutation');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
