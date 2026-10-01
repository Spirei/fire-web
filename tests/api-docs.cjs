// Cross-version App protocol and identity tests use only a disposable database.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), Module = require('node:module'), ts = require('typescript');
const deliveries=[];
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-api-docs-')); process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off'; process.env.FIRE_APP_ORIGIN = 'https://account.test.example:18520';
global.fetch = async () => { throw new Error('Network disabled in isolated tests'); };
const load = file => require(path.join(root, file));
const next=load('node_modules/next/server.js'); next.after=fn=>{deliveries.push(fn);};
const auth = load('lib/auth.ts'), native = load('lib/appAuth.ts'), db = load('lib/db.ts').getDb();
const me = load('app/api/v1/auth/me/route.ts'), config = load('app/api/v1/auth/config/route.ts');
const bodies = load('lib/requestBody.ts'), factors = load('lib/totp.ts');
const origin = process.env.FIRE_APP_ORIGIN, oldPassword = 'Owner-old-123';
const row = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
let fixtureIndex = 0, count = 0;
function connect(user, browser, scope = 'portfolio.read') {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const values = { client_id:native.APP_CLIENT_ID, redirect_uri:native.APP_REDIRECT_URI, response_type:'code', code_challenge_method:'S256', code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'), state:crypto.randomBytes(32).toString('base64url'), scope };
  const normalized = native.parseAppAuthorization(values);
  const code = native.issueAppCode(normalized, user.id, browser);
  return { ...native.exchangeAppCode({...values,code,code_verifier:verifier}), values: normalized, code };
}
function fixture(totp = false, admin = false) {
  fixtureIndex++;
  const user = auth.createUser('account_owner_'+fixtureIndex,oldPassword), other = auth.createUser('account_other_'+fixtureIndex,oldPassword);
  auth.updateProfile(user.id,{email:`owner${fixtureIndex}@example.test`}); auth.updateProfile(other.id,{email:`other${fixtureIndex}@example.test`});
  db.prepare('UPDATE users SET role=? WHERE id=?').run(admin?'admin':'user',user.id);
  const secret = factors.generateTotpSecret(), backup = factors.generateBackupCodes(1)[0];
  if(totp) db.prepare('UPDATE users SET totp_enabled=1,totp_secret=?,totp_backup_codes=? WHERE id=?').run(load('lib/secretStorage.ts').encryptSecret(secret),JSON.stringify([factors.hashBackupCode(backup)]),user.id);
  const browser = auth.createSession(user.id), secondBrowser = auth.createSession(user.id), otherBrowser = auth.createSession(other.id);
  return { user, other, browser, secondBrowser, otherBrowser, grant:connect(user,browser), otherGrant:connect(other,otherBrowser), secret, backup };
}
function req(endpoint, body, token, method = endpoint==='auth/email'?'PUT':'POST', extra = {}) {
  return new Request(origin+'/api/v1/'+endpoint,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json',...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
async function test(name, run) { db.prepare('DELETE FROM rate_limit').run(); await run(); count++; console.log('PASS '+name); }
const route=load('app/api/api-docs/route.ts'),versions=load('lib/apiDocsVersion.ts'),policy=load('lib/appApiV2Policy.ts');
fs.mkdirSync('docs');
for(const name of ['api-spec.md','api-spec-v2.md'])fs.copyFileSync(path.join(root,'docs',name),path.join('docs',name));
const request=(version,body,browser,headers={})=>new Request(origin+'/api/api-docs'+(version===undefined?'':'?version='+version),{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(browser?{cookie:'fire_session='+browser,origin}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
const data=async promise=>{const r=await promise;return {status:r.status,body:await r.json()};};
(async()=>{
 await test('default v1 and selected v2 load distinct fixed files with revisions',async()=>{
  const one=(await data(route.GET())).body.data,two=(await data(route.GET(request('v2')))).body.data;
  assert.equal(one.version,1);assert.equal(two.version,2);assert.notEqual(one.content,two.content);assert.equal(two.path,'docs/api-spec-v2.md');assert.match(two.revision,/^[a-f0-9]{64}$/);
  for(const value of ['v3','../other','v1&version=v2',''])assert.equal((await data(route.GET(request(value)))).status,400);
  assert.equal(versions.parseApiDocsVersion('2'),2);
 });
 await test('v2 published catalog matches every allowed method and scope with no extra endpoint',async()=>{
  const md=fs.readFileSync(path.join(root,'docs/api-spec-v2.md'),'utf8');
  const rows=[...md.matchAll(/^\| (GET|POST|PUT|DELETE) \| `([^`]+)` \| ([^|]+) \|$/gm)].map(m=>[m[1],m[2],m[3].trim()]);
  const expected=policy.APP_V2_ROUTES.flatMap(r=>r.methods.map(method=>[method,'/api/v2/'+r.path.replace('[id]','{id}').replace('[jobId]','{jobId}').replace('[postId]','{postId}'),method==='GET'?r.access:r.writeAccess||r.access]));
  const sorted=items=>items.map(JSON.stringify).sort();assert.deepEqual(sorted(rows),sorted(expected));
  assert(!/\| (POST|PUT|DELETE) \| `\/api\/v2\/(assets|brokers)`/.test(md));
  const rendered=load('lib/markdown.ts').renderMarkdown(md);assert(rendered.includes('data-copy-code'));assert(rendered.includes('/api/v2/auth/token'));
 });
 await test('administrators save only the selected version and reject stale revisions',async()=>{
  const f=fixture(false,true),one=fs.readFileSync('docs/api-spec.md','utf8'),two=(await data(route.GET(request('v2')))).body.data;
  assert.equal((await data(route.POST(request('v2',{content:'# Changed v2',expectedRevision:two.revision},f.browser)))).status,200);
  assert.equal(fs.readFileSync('docs/api-spec-v2.md','utf8'),'# Changed v2');assert.equal(fs.readFileSync('docs/api-spec.md','utf8'),one);
  assert.equal((await data(route.POST(request('v2',{content:'# Stale',expectedRevision:two.revision},f.browser)))).status,409);
  assert.equal(fs.readFileSync('docs/api-spec-v2.md','utf8'),'# Changed v2');
  assert.equal((await data(route.POST(request(undefined,{content:'# Legacy',path:'../evil'},f.browser)))).status,400);
  assert.equal((await data(route.POST(request(undefined,{content:'# Legacy'},f.browser)))).status,200);
 });
 await test('anonymous, ordinary App/Web, foreign origin and revoked administrator cannot write',async()=>{
  const admin=fixture(false,true),ordinary=fixture(),before=fs.readFileSync('docs/api-spec.md','utf8');
  assert.equal((await data(route.POST(request(undefined,{content:'NO'})))).status,401);
  assert.equal((await data(route.POST(request(undefined,{content:'NO'},ordinary.browser)))).status,403);
  assert.equal((await data(route.POST(request(undefined,{content:'NO'},undefined,{authorization:'Bearer '+admin.grant.access_token})))).status,401);
  assert.equal((await data(route.POST(request(undefined,{content:'NO'},admin.browser,{origin:'https://foreign.example.test'})))).status,401);
  const read=bodies.readJsonBody;bodies.readJsonBody=async(...args)=>{const value=await read(...args);db.prepare('DELETE FROM sessions WHERE user_id=?').run(admin.user.id);return value;};
  try{assert.equal((await data(route.POST(request(undefined,{content:'NO'},admin.browser)))).status,401);}finally{bodies.readJsonBody=read;}
  assert.equal(fs.readFileSync('docs/api-spec.md','utf8'),before);
 });
 await test('document limits count UTF-8 bytes and malformed JSON cannot overwrite either version',async()=>{
  const f=fixture(false,true),before=fs.readFileSync('docs/api-spec-v2.md','utf8');
  assert.equal((await data(route.POST(request('v2',{content:'文'.repeat(180000)},f.browser)))).status,400);
  const malformed=new Request(origin+'/api/api-docs?version=v2',{method:'POST',headers:{cookie:'fire_session='+f.browser,origin,'content-type':'application/json'},body:'{"content":'});
  assert.equal((await data(route.POST(malformed))).status,400);
  assert.equal(fs.readFileSync('docs/api-spec-v2.md','utf8'),before);
 });
 console.log(`PASS ${count} API document suites`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
