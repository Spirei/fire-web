import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildGpu } from './build-showcase-gpu.mjs';
import { PREVIEW_MODE, inspectSource, sourceUnchanged, validDerivative, writeManifest, acquireGenerationLock } from './showcase-generation.mjs';

export function generationJobs(root) {
  const showroom = path.join(root, 'public', 'uploads', 'mclaren');
  const jobs = [{ id: 'mcl35m', name: 'MCL35M', input: path.join(root, 'public', 'mclaren', 'mcl35m.glb'), output: path.join(showroom, 'previews', 'builtin-mcl35m-preview.glb'), gpu: path.join(showroom, 'gpu', 'builtin-mcl35m-uastc.glb') }];
  const registryPath = path.join(showroom, 'showroom.json');
  if (fs.existsSync(registryPath)) {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const seen = new Set();
    for (const item of registry.models ?? []) {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.glb$/i.test(item.file) || seen.has(item.file)) continue;
      seen.add(item.file);
      const base = item.file.replace(/\.glb$/i, '');
      jobs.push({ id: item.id, name: item.label || base, input: path.join(showroom, 'models', item.file), output: path.join(showroom, 'previews', `${base}-preview.glb`), gpu: path.join(showroom, 'gpu', `${base}-uastc.glb`) });
    }
  }
  return jobs.filter(item => fs.existsSync(item.input));
}
function optimize(input, output, root) {
  const result = spawnSync(path.join(root, 'node_modules', '.bin', 'gltf-transform'), [
    'optimize', input, output, '--compress', 'meshopt', '--simplify', 'false', '--join', 'false', '--flatten', 'false', '--palette', 'false', '--texture-compress', 'webp', '--texture-size', '1024'
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('首页预览生成失败');
}
export async function generatePreviews({ root = process.cwd(), id, onProgress = () => {}, previewBuilder = optimize, gpuBuilder = buildGpu } = {}) {
  const unlock = acquireGenerationLock(root);
  const summary = { count: 0, reused: 0, gpuCount: 0, gpuReused: 0, failed: 0 };
  try {
    const jobs = generationJobs(root).filter(job => !id || job.id === id), errors = [];
    if (id && jobs.length !== 1) throw new Error("车型不存在或素材缺失");
    for (const job of jobs) {
      const emit = (phase, extra = {}) => onProgress({ ...summary, total: jobs.length, model: job.name, phase, ...extra });
      const temp = `${job.output}.${process.pid}.glb`;
      try {
        emit('scan');
        const identity = await inspectSource(job.input);
        emit("scan", { fileBytes: identity.sourceBytes, textureBytes: identity.rgbaBytes, textureCount: identity.textures.length, needsGpu: identity.needsGpu });
        if (validDerivative(job.input, job.output, PREVIEW_MODE, identity.sourceSha256)) summary.reused++;
        else {
          emit('preview', { fileBytes: identity.sourceBytes, textureBytes: identity.rgbaBytes });
          fs.mkdirSync(path.dirname(job.output), { recursive: true });
          await previewBuilder(job.input, temp, root);
          if (!sourceUnchanged(job.input, identity)) throw new Error('生成期间原模型已改变');
          fs.renameSync(temp, job.output);
          writeManifest(job.output, identity, { mode: PREVIEW_MODE });
        }
        summary.count++;
        if (identity.needsGpu) {
          emit('gpu', { fileBytes: identity.sourceBytes, textureBytes: identity.rgbaBytes });
          const result = await gpuBuilder(job.input, { output: job.gpu, identity, root });
          summary.gpuCount++;
          if (result.reused) summary.gpuReused++;
        }
        emit('complete');
      } catch (error) {
        summary.failed++;
        const message = `${job.name}：${error instanceof Error ? error.message : String(error)}`;
        errors.push(message); emit('error', { error: message });
      } finally { fs.rmSync(temp, { force: true }); }
    }
    onProgress({ ...summary, phase: errors.length ? 'error' : 'done', error: errors.join('\n') || undefined });
    return { ...summary, errors };
  } finally { unlock(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--id' || !/^[a-z0-9][a-z0-9_-]{1,40}$/.test(args[1]))) throw new Error('用法：--id 车型代号');
    const result = await generatePreviews({ id: args[1], onProgress: event => console.log(`SHOWCASE_PROGRESS ${JSON.stringify(event)}`) });
    if (result.errors.length) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
