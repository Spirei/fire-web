import fs from 'node:fs';
import path from 'node:path';
import { inspectSource, writeManifest, PREVIEW_MODE, sourceUnchanged, fileSha256 } from './scripts/showcase-generation.mjs';
import { optimize } from './scripts/preview.mjs';
import { buildGpu } from './scripts/build-showcase-gpu.mjs';

export async function exportModel(input, directory, { progress = console.log, previewBuilder = optimize, gpuBuilder = buildGpu } = {}) {
  input = path.resolve(input); directory = path.resolve(directory);
  if (!input.toLowerCase().endsWith('.glb')) throw new Error('请选择 GLB 模型');
  progress('检测模型与贴图…');
  const identity = await inspectSource(input);
  // Re-encoding an already GPU-compressed GLB cannot recreate a clean low-res preview.
  if (identity.textures.some(texture => texture.compressed)) throw new Error('请选择原始 PNG/JPEG/WebP 贴图的 GLB，避免重复有损压缩');
  const stem = path.basename(input, path.extname(input)).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').slice(0, 64) || 'model';
  fs.mkdirSync(directory, { recursive: true });
  const staging = fs.mkdtempSync(path.join(directory, '.fire-export-'));
  const final = path.join(directory, `${stem}-fire-${Date.now()}`);
  try {
    const model = path.join(staging, `${stem}-optimized.glb`), preview = path.join(staging, `${stem}-preview.glb`);
    progress(`文件 ${(identity.sourceBytes / 1048576).toFixed(1)} MiB · 贴图展开 ${(identity.rgbaBytes / 1048576).toFixed(1)} MiB`);
    progress('1/2 生成首页轻量预览…');
    await previewBuilder(input, preview);
    writeManifest(preview, identity, { mode: PREVIEW_MODE });
    progress(identity.needsGpu ? '2/2 生成保留原尺寸的高清优化版…' : '2/2 模型未达到阈值，高清版保持原文件内容…');
    if (identity.needsGpu) await gpuBuilder(input, { output: model, identity });
    else fs.copyFileSync(input, model, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(staging, '上传说明.txt'), `1. 在网站车型导入页选择 ${path.basename(model)}，完成参数设置并保存。\n2. 在该车型卡片点击“上传首页预览”，选择 ${path.basename(preview)}。\n\n原文件：${path.basename(input)}（未修改）\n高清版${identity.needsGpu ? '使用 UASTC 高质量有损压缩，保留贴图尺寸与几何；不是逐像素无损。' : '与原文件内容一致。'}\n首页预览为 1K 轻量版，不应作为高清车型导入。\n压缩主要降低贴图 GPU 内存，下载文件不一定更小。\n`);
    fs.writeFileSync(path.join(staging, 'report.json'), JSON.stringify({ input: path.basename(input), sourceSha256: identity.sourceSha256, sourceBytes: identity.sourceBytes, textureBytes: identity.rgbaBytes, compressed: identity.needsGpu, model: path.basename(model), preview: path.basename(preview) }, null, 2));
    if (!sourceUnchanged(input, identity) || fileSha256(input) !== identity.sourceSha256) throw new Error('处理期间原文件发生变化，请重新导出');
    fs.renameSync(staging, final);
    return final;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
