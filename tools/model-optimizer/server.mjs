import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
const root = fileURLToPath(new URL('./', import.meta.url));
const MAX_BYTES = 512 * 1024 * 1024;

export async function startServer({ openBrowser = true, outputRoot = path.join(root, 'output'), worker = path.join(root, 'worker.mjs') } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'fire-local-models-'));
  const jobs = new Map();
  let active, closing = false, origin;
  const view = job => ({ id: job.id, name: job.name, state: job.state, message: job.message, createdAt: job.createdAt, finishedAt: job.finishedAt, files: job.files?.map(file => ({ name: file.name, size: file.size })) });
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  async function next() {
    if (active || closing) return;
    const job = [...jobs.values()].find(item => item.state === 'queued');
    if (!job) return;
    active = job; job.state = 'running'; job.message = '检测模型与贴图…';
    const child = spawn(process.execPath, [worker, job.input, outputRoot], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    job.child = child;
    let pending = '', output, failure;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk; const lines = pending.split('\n'); pending = lines.pop() ?? '';
      if (pending.length > 16384) pending = pending.slice(-16384);
      for (const line of lines) {
        if (!line.startsWith('FIRE_EVENT ')) continue;
        try {
          const event = JSON.parse(line.slice(11));
          if (event.message) job.message = event.message;
          if (event.error) failure = event.error;
          if (event.output) output = event.output;
        } catch { /* Encoder logs are not events. */ }
      }
    });
    child.stderr.on('data', chunk => { console.error(String(chunk).trim()); });
    child.on('error', error => { failure = error.message; });
    child.on('close', async code => {
      try {
        if (code !== 0 || failure || !output) throw new Error(failure || '处理未完成，请重新选择原文件');
        const resolved = path.resolve(output);
        if (!resolved.startsWith(path.resolve(outputRoot) + path.sep)) throw new Error('导出目录异常');
        const names = (await fsp.readdir(resolved)).filter(name => /\.(glb|txt)$/.test(name));
        job.files = await Promise.all(names.map(async name => ({ name, path: path.join(resolved, name), size: (await fsp.stat(path.join(resolved, name))).size })));
        job.state = 'done'; job.message = '导出完成，请分别下载高清版与首页预览';
      } catch (error) { job.state = 'error'; job.message = error.message; }
      finally {
        job.finishedAt = Date.now();
        await fsp.rm(path.dirname(job.input), { recursive: true, force: true }).catch(() => {});
        active = undefined; void next();
      }
    });
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    // Loopback only, exact Host + Origin, and per-run secret: remote pages cannot start work or read files.
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, { error: '仅允许从本地工具页面操作' });
    const url = new URL(req.url, origin);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end((await fsp.readFile(path.join(root, 'ui.html'), 'utf8')).replaceAll('__TOKEN__', token));
      }
      if ((req.headers['x-fire-token'] ?? url.searchParams.get('token')) !== token) return json(res, 403, { error: '请重新打开本地工具页面' });
      if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, [...jobs.values()].map(view));
      if (req.method === 'GET' && url.pathname === '/download') {
        const job = jobs.get(url.searchParams.get('id')), file = job?.files?.find(item => item.name === url.searchParams.get('file'));
        if (job?.state !== 'done' || !file) return json(res, 404, { error: '文件不存在' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
        await pipeline(fs.createReadStream(file.path), res); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        if ([...jobs.values()].filter(job => ['uploading', 'queued', 'running'].includes(job.state)).length >= 8) return json(res, 429, { error: '最多同时排队 8 个模型，请稍后再添加' });
        const name = url.searchParams.get('name') ?? '';
        if (!name.toLowerCase().endsWith('.glb') || name.length > 200 || /[\/\\\x00-\x1f]/.test(name)) return json(res, 400, { error: '请选择 GLB 文件' });
        if (Number(req.headers['content-length']) > MAX_BYTES) return json(res, 413, { error: '单个模型不能超过 512 MiB' });
        const id = crypto.randomUUID(), directory = path.join(temporary, id);
        // Safe fixed disk name; original label remains in the job and export naming.
        const safeName = (name.slice(0, -4).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64) || 'model') + '.glb';
        const job = { id, name, input: path.join(directory, safeName), state: 'uploading', message: '接收本机文件…', createdAt: Date.now() };
        jobs.set(id, job);
        try {
          await fsp.mkdir(directory); const file = await fsp.open(job.input, 'wx'); let size = 0;
          try { for await (const chunk of req) { size += chunk.length; if (size > MAX_BYTES) throw new Error('单个模型不能超过 512 MiB'); await file.writeFile(chunk); } }
          finally { await file.close(); }
          if (!size) throw new Error('文件为空');
          job.state = 'queued'; job.message = '已排队，模型会逐个处理'; json(res, 202, view(job)); void next();
        } catch (error) {
          jobs.delete(id); await fsp.rm(directory, { recursive: true, force: true });
          if (!res.destroyed) json(res, 400, { error: error.message });
        }
        return;
      }
      json(res, 404, { error: '不存在此操作' });
    } catch (error) { if (!res.headersSent) json(res, 500, { error: error.message }); else res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`本地模型工具：${origin}\n文件只在本机处理；关闭此终端即可退出。导出目录：${outputRoot}`);
  if (openBrowser) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', origin] : [origin];
    const browser = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    browser.on('error', () => console.log(`请手动打开 ${origin}`)); browser.unref();
  }
  return { server, origin, async close() {
    closing = true;
    if (active?.child && active.child.exitCode === null && active.child.signalCode === null) await new Promise(resolve => {
      const child = active.child; child.once('close', resolve);
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
    });
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(temporary, { recursive: true, force: true });
  } };
}
