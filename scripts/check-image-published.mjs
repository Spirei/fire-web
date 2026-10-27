import { findPublishedRun } from '../lib/deployPublication.mjs';
import { appendFileSync } from 'node:fs';

const { GH_TOKEN, REPOSITORY, CURRENT_SHA, GITHUB_OUTPUT } = process.env;
if (!GH_TOKEN || !REPOSITORY || !CURRENT_SHA || !GITHUB_OUTPUT) throw new Error('Missing release gate configuration');
const run = await findPublishedRun(async path => {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${GH_TOKEN}` }
  });
  if (!response.ok) throw new Error(`GitHub publication check failed: ${response.status}`);
  return response.json();
}, CURRENT_SHA);
appendFileSync(GITHUB_OUTPUT, `should_publish=${!run}\n`);
console.log(run ? '当前提交已有成功发布的镜像，复用已有镜像。' : '当前提交尚无成功发布的镜像，继续构建。');
