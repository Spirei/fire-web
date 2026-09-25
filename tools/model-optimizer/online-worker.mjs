/** NAS-side, single-process queue consumer. No HTTP listener and no access to the web app's secrets. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspectSource, sourceUnchanged, validDerivative, PREVIEW_MODE, GPU_MODE, GPU_MESHOPT_MODE } from './scripts/showcase-generation.mjs';

const root = path.resolve(process.env.FIRE_SHOWCASE_DIR || '/app/public/uploads/mclaren');
const jobsRoot = path.join(root, 'processing', 'jobs');
const modelsRoot = path.join(root, 'models');
const safeId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const safeFile = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.glb$/i.test(value) && !value.startsWith('.');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function readJob(directory) { try { return JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8')); } catch { return null; } }
function writeJob(directory, job, status, message, extra = {}) {
  const next = { ...job, ...extra, status, message: String(message).slice(0, 240), updatedAt: new Date().toISOString() };
  const temp = path.join(directory, `job.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(next)); fs.renameSync(temp, path.join(directory, 'job.json'));
  return next;
}
function stillRegistered(job) {
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'showroom.json'), 'utf8'));
  return registry.models?.some(model => model.id === job.modelId && model.file === job.file);
}
function publishFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try { fs.copyFileSync(source, temporary); fs.renameSync(temporary, destination); }
  finally { fs.rmSync(temporary, { force: true }); }
}
async function runJob(directory, initial) {
  let job = initial;
  const cancelFile = path.join(directory, 'cancel');
  if (!safeId(job.modelId) || !safeFile(job.file) || !stillRegistered(job)) throw new Error('车型已从清单变更，请重新提交');
  const source = path.join(modelsRoot, job.file);
  const stat = fs.statSync(source);
  if (stat.size !== job.sourceBytes || stat.mtimeMs !== job.sourceMtimeMs || stat.size > 250 * 1024 * 1024) throw new Error('原模型已改变，请重新提交');
  if (fs.existsSync(cancelFile)) { writeJob(directory, job, 'cancelled', '已取消'); return; }
  const identity = await inspectSource(source);
  job = writeJob(directory, job, 'running', '检测模型与贴图…');
  const outputRoot = path.join(directory, 'output');
  fs.mkdirSync(outputRoot, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'worker.mjs'), source, outputRoot], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, UV_THREADPOOL_SIZE: '2' } });
    const stopGroup = signal => { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } };
    let buffer = '', lastError = '', result = '';
    const timer = setTimeout(() => { stopGroup('SIGKILL'); reject(new Error('处理超过两小时，已停止任务')); }, 2 * 60 * 60 * 1000);
    const cancelCheck = setInterval(() => { if (fs.existsSync(cancelFile)) stopGroup('SIGKILL'); }, 1500);
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let line;
      while ((line = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, line); buffer = buffer.slice(line + 1);
        if (!raw.startsWith('FIRE_EVENT ')) continue;
        try {
          const event = JSON.parse(raw.slice(11));
          if (event.message) job = writeJob(directory, job, 'running', event.message);
          if (event.error) lastError = event.error;
          if (event.output) result = event.output;
        } catch { /* Ignore tool chatter. */ }
      }
    });
    child.stderr.on('data', chunk => { lastError = chunk.toString().slice(-300); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer); clearInterval(cancelCheck);
      if (fs.existsSync(cancelFile)) reject(new Error('已取消'));
      else if (code !== 0 || !result) reject(new Error(lastError || '在线处理失败'));
      else resolve(result);
    });
  }).then(async result => {
    if (!result.startsWith(`${outputRoot}${path.sep}`)) throw new Error('产物路径无效');
    if (!stillRegistered(job) || !sourceUnchanged(source, identity)) throw new Error('处理期间原车型已改变，请重新提交');
    const report = JSON.parse(fs.readFileSync(path.join(result, 'report.json'), 'utf8'));
    const preview = path.join(result, report.preview), gpu = path.join(result, report.model);
    if (!validDerivative(source, preview, PREVIEW_MODE, identity.sourceSha256)) throw new Error('1K 预览校验失败');
    const previewInfo = await inspectSource(preview);
    if (previewInfo.textures.some(item => item.width > 1024 || item.height > 1024) || fs.statSync(preview).size > 32 * 1024 * 1024) throw new Error('1K 预览超出上传标准');
    const stem = job.file.replace(/\.glb$/i, '');
    if (identity.needsGpu) {
      const mode = identity.sourceBytes >= 50 * 1024 * 1024 ? GPU_MESHOPT_MODE : GPU_MODE;
      if (!validDerivative(source, gpu, mode, identity.sourceSha256)) throw new Error('高清副本校验失败');
      const gpuInfo = await inspectSource(gpu);
      if (gpuInfo.textures.length !== identity.textures.length || gpuInfo.textures.some((item, index) => !item.compressed || item.width !== identity.textures[index].width || item.height !== identity.textures[index].height)) throw new Error('高清副本贴图校验失败');
    }
    if (fs.existsSync(cancelFile)) throw new Error('已取消');
    const previewDest = path.join(root, 'previews', `${stem}-preview.glb`);
    publishFile(preview, previewDest);
    fs.rmSync(`${previewDest}.json`, { force: true });
    if (identity.needsGpu) {
      const gpuDest = path.join(root, 'gpu', `${stem}-uastc.glb`);
      if (fs.existsSync(gpuDest) && fs.existsSync(`${gpuDest}.json`)) {
        fs.copyFileSync(gpuDest, `${gpuDest}.previous`);
        fs.copyFileSync(`${gpuDest}.json`, `${gpuDest}.json.previous`);
      }
      fs.rmSync(`${gpuDest}.json`, { force: true });
      publishFile(gpu, gpuDest);
      publishFile(`${gpu}.json`, `${gpuDest}.json`);
    }
    writeJob(directory, job, 'done', identity.needsGpu ? '1K 预览与高清副本已就绪' : '1K 预览已就绪；原件无需压缩', { preview: true, gpu: identity.needsGpu });
  });
}

export async function pollOnce() {
  if (!fs.existsSync(jobsRoot)) return false;
  const directories = fs.readdirSync(jobsRoot).filter(name => /^[a-f0-9-]{36}$/.test(name)).map(name => path.join(jobsRoot, name));
  for (const directory of directories) {
    const job = readJob(directory);
    if (job?.status !== 'queued' && job?.status !== 'running') continue;
    if (job.status === 'running') {
      // A restarted sidecar may have interrupted export; retry once from its intact source.
      if (job.restarted) { writeJob(directory, job, 'failed', '处理服务重启，请点击重试'); continue; }
      writeJob(directory, job, 'queued', '处理服务恢复，重新排队', { restarted: true });
    }
    try { await runJob(directory, readJob(directory)); }
    catch (error) { writeJob(directory, readJob(directory), fs.existsSync(path.join(directory, 'cancel')) ? 'cancelled' : 'failed', error instanceof Error ? error.message : '处理失败'); }
    finally { fs.rmSync(path.join(directory, 'output'), { recursive: true, force: true }); }
    return true;
  }
  return false;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  for (;;) { if (!await pollOnce()) await delay(3000); }
}
