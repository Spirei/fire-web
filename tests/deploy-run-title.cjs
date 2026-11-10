const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const mod={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../lib/deployRunTitle.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,mod);
const {deploymentRunTitle,IMAGE_WORKFLOW_NAME}=mod.exports;
const run={id:123,name:'Fire 检查与镜像发布',title:'Fire 检查与镜像发布',workflowPath:'.github/workflows/docker-publish.yml',event:'schedule',status:'completed',conclusion:'success',sha:'abcdef1',updatedAt:'2026-11-06T00:00:00Z'};
const before=JSON.stringify(run);assert.equal(deploymentRunTitle(run),IMAGE_WORKFLOW_NAME);assert.equal(JSON.stringify(run),before);
for(const title of ['Build and publish Alcor image','Build and publish Fire image','Fire 手动发布：检查并构建当前版本','Fire 定时发布：检查并构建最新变更','Fire 构建发布 · '+'a'.repeat(40),'Build and publish Alcor image · 550e8400-e29b-41d4-a716-446655440000'])assert.equal(deploymentRunTitle({...run,title}),IMAGE_WORKFLOW_NAME);
for(const title of ['fix: 保留我的原提交标题','自定义 publish 兼容更新','Check Alcor image','Fire 手动检查：验证当前版本'])assert.equal(deploymentRunTitle({...run,title}),title);
assert.equal(deploymentRunTitle({...run,event:'push'}),run.title);assert.equal(deploymentRunTitle({...run,workflowPath:'.github/workflows/other.yml'}),run.title);
assert.equal(deploymentRunTitle({...run,title:'',name:IMAGE_WORKFLOW_NAME}),IMAGE_WORKFLOW_NAME);
console.log('PASS publish titles: restore known renamed release titles, retain custom/check titles, isolate workflows and preserve historical IDs/results/receipts');

const workflow=fs.readFileSync('.github/workflows/docker-publish.yml','utf8'),runName=workflow.split('\n').find(line=>line.startsWith('run-name:'));assert(runName.includes("'源码检查'"));assert(!runName.includes('head_commit.message'),'Commit bodies must never become workflow list titles');assert(workflow.startsWith('name: Build and publish Alcor image\n'));
