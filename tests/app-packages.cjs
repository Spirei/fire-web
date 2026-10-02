const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f);
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-packages-')));process.chdir(temp);
fs.mkdirSync('data'); fs.writeFileSync('data/backup-config.json','{"enabled":false}');process.env.STOCKLOG_FUTU='off';global.fetch=async()=>{throw Error('Network disabled')};
const auth = require(path.join(root,'lib/auth.ts')), db = require(path.join(root,'lib/db.ts')).getDb();
const admin=auth.createUser('package_admin','Package-test-123'),user=auth.createUser('package_user','Package-test-123');db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
const sessions=new Map([admin,user].map(u=>[u.id,auth.createSession(u.id)]));
const api=require(path.join(root,'app/api/app-packages/route.ts')),download=require(path.join(root,'app/api/app-packages/download/[id]/route.ts'));
function readRequest(endpoint,u=admin) { return new Request('https://packages.test'+endpoint,{headers:u?{cookie:'fire_session='+sessions.get(u.id)}:{}}); }
function request(u, bytes=Buffer.from('504b030400010203','hex'), extra={}) { return new Request('https://packages.test/api/app-packages',{method:'POST',body:bytes,headers:{'x-file-name':encodeURIComponent('测试.apk'),'content-length':String(bytes.length),...(u?{cookie:'fire_session='+sessions.get(u.id)}:{}),...extra}}); }
(async()=>{
 assert.equal((await api.POST(request(null))).status,401);
 assert.equal((await api.POST(request(user))).status,403);
 assert.equal((await api.POST(request(admin,undefined,{origin:'https://evil.test'}))).status,401);
 assert.equal((await api.POST(request(admin,Buffer.from('invalid')))).status,400);
 assert.equal((await api.POST(request(admin,undefined,{'x-file-name':'../x.apk'}))).status,400);
 assert.equal((await api.POST(request(admin,undefined,{'content-length':'99999999999'}))).status,413);
 assert.equal((await api.POST(request(admin,undefined,{'content-length':'12'}))).status,400);
 assert.equal(fs.readdirSync('data/app-packages').filter(n=>n!=='files').length,0);
 const io=require('node:fs/promises'),original=io.copyFile;
 io.copyFile=async(_from,to)=>{fs.writeFileSync(to,'partial');throw Error('disk failure')};
 try { assert.equal((await api.POST(request(admin))).status,400);assert.equal(fs.readdirSync('data/app-packages/files').length,0);assert.equal(fs.readdirSync('data/app-packages').filter(n=>n!=='files').length,0); } finally {io.copyFile=original;}
 const r=await api.POST(request(admin));assert.equal(r.status,201);const item=await r.json();
 assert.equal((await api.GET(readRequest('/api/app-packages',null))).status,403);assert.equal((await api.GET(readRequest('/api/app-packages',user))).status,403);
 const listed=await (await api.GET(readRequest('/api/app-packages'))).json();assert.equal(listed.canUpload,true);assert.equal(listed.packages.length,1);
 const file=await download.GET(readRequest('/api/app-packages/download/test'),{params:Promise.resolve({id:item.id})});assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),Buffer.from('504b030400010203','hex'));
 assert.equal((await download.GET(readRequest('/api/app-packages/download/test'),{params:Promise.resolve({id:'../bad'})})).status,404);
 const page=require(path.join(root,'app/alcor-test/route.ts'));
 assert.equal((await page.GET(readRequest('/alcor-test',null))).status,403);assert.equal((await page.GET(readRequest('/alcor-test',user))).status,403);assert.equal((await page.GET(readRequest('/alcor-test'))).status,200);
 assert.equal((await download.GET(readRequest('/download',null),{params:Promise.resolve({id:item.id})})).status,403);assert.equal((await download.GET(readRequest('/download',user),{params:Promise.resolve({id:item.id})})).status,403);
 fs.mkdirSync('public/uploads/alcor-test',{recursive:true});fs.writeFileSync('public/uploads/alcor-test/private-test.txt','legacy private fixture');
 const raw=require(path.join(root,'app/api/upload-files/[...path]/route.ts'));
 for(const who of [null,user]) { const denied=await raw.GET(readRequest('/uploads/alcor-test/packages/'+item.id,who),{params:Promise.resolve({path:['alcor-test','private-test.txt']})});assert.equal(denied.status,403); }
 const protectedFile=await raw.GET(readRequest('/uploads/alcor-test/packages/'+item.id),{params:Promise.resolve({path:['alcor-test','private-test.txt']})});assert.equal(protectedFile.status,200);assert.equal(protectedFile.headers.get('cache-control'),'private, no-store');await protectedFile.arrayBuffer();
 const old=new Date(Date.now()-7*86400000);fs.utimesSync('data/app-packages/files/'+item.id,old,old);require(path.join(root,'lib/fileCleanup.ts')).cleanupOrphanFiles();assert(fs.existsSync('data/app-packages/files/'+item.id));
 console.log('PASS app packages: permissions, CSRF, limits, interrupted upload cleanup, private page/list/download/direct file, traversal, retention');
 db.close();process.chdir(root);fs.rmSync(temp,{recursive:true,force:true});process.exit(0);
})().catch(e=>{console.error(e);db.close();process.chdir(root);fs.rmSync(temp,{recursive:true,force:true});process.exit(1)});
