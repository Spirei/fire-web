// Real routes and SQLite in a temporary account store. No production account writes.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (m, file) => m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true} }).outputText, file);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-auth-abuse-')); process.chdir(temp);
process.env.STOCKLOG_FUTU='off'; process.env.FIRE_TRUST_PROXY_HEADERS='true'; process.env.FIRE_TRUST_PROXY_HOPS='1';
global.fetch=async()=>{throw new Error('Isolated security test: network disabled');};
const load=f=>require(path.join(root,f)), auth=load('lib/auth.ts'), db=load('lib/db.ts').getDb();
const owner=auth.createUser('abuse_owner','owner-password-123'), ownerRole=auth.findUserById(owner.id).role; load('lib/settings.ts').updateSiteSettings({allowRegister:true});
const register=load('app/api/auth/register/route.ts'), login=load('app/api/auth/login/route.ts'), legacy=load('app/api/v1/auth/login/route.ts');
const origin='https://auth.example.test', password='safe-Password-123'; let passed=0;
function req(body, ip='192.0.2.40', extra={}) {return new Request(origin+'/api/auth/register',{method:'POST',headers:{origin,'content-type':'application/json','x-forwarded-for':ip,...extra},body:JSON.stringify(body)});}
const count=table=>db.prepare('SELECT COUNT(*) n FROM '+table).get().n;
const created=()=>db.prepare("SELECT key,count FROM rate_limit WHERE key LIKE 'register-created-%' OR key='global:register-created-day' ORDER BY key").all();
function expireMinute(){db.prepare("UPDATE rate_limit SET reset_at=0 WHERE key LIKE 'register-created-minute:%' OR key LIKE 'register-burst:%'").run();}
async function test(name,fn){db.prepare('DELETE FROM rate_limit').run();await fn();passed++;console.log('PASS '+name);}
(async()=>{try{
 await test('register rejects object coercion, role injection, prototype keys and SQL/XSS usernames without writes',async()=>{
  const before=[count('users'),count('sessions')];
  const bodies=[[],null,{username:['array_user'],password},{username:'object_user',password:{toString:'valid-password-123'}},{username:'numeric_user',password:123456789},
   {username:'promote_user',password,role:'admin'},{username:'other_owner',password,userId:owner.id},{username:'test_string',password,isTest:'true'},
   JSON.parse('{"username":"proto_user","password":"safe-Password-123","__proto__":{"role":"admin"}}'),
   {username:"' OR 1=1--",password},{username:'<script>alert(1)</script>',password},{username:'zero\u0000name',password}];
  for(const body of bodies){db.prepare('DELETE FROM rate_limit').run();const r=await register.POST(req(body));assert.equal(r.status,400);assert.equal(r.headers.get('set-cookie'),null);assert.deepEqual([count('users'),count('sessions')],before);}
 });
 await test('SQL-looking password remains literal data and valid registration keeps the ordinary role',async()=>{
  const secret=`Quotes'"; SELECT 1; --pass123`;
  const r=await register.POST(req({username:'literal_password',password:secret}));assert.equal(r.status,201);assert.equal((await r.json()).user.role,'user');
  assert.equal(auth.authenticateUser('literal_password',secret)?.username,'literal_password');assert.equal(auth.authenticateUser('literal_password','pass123'),null);assert.equal(auth.findUserById(owner.id).role,ownerRole);
 });
 await test('successful registration cooldown is atomic, with exact Retry-After and no duplicate sessions',async()=>{
  const first=await register.POST(req({username:'cooldown_first',password}));assert.equal(first.status,201);const before=[count('users'),count('sessions')], quota=created();
  const duplicate=await register.POST(req({username:'cooldown_first',password}));assert.equal(duplicate.status,409);assert.deepEqual(created(),quota);
  const second=await register.POST(req({username:'cooldown_second',password}));assert.equal(second.status,429);assert(Number(second.headers.get('retry-after'))>0 && Number(second.headers.get('retry-after'))<=60);assert.equal(second.headers.get('cache-control'),'no-store');
  assert.deepEqual([count('users'),count('sessions')],before);assert.deepEqual(created(),quota);
 });
 await test('known-source daily account cap survives memory mode and failed admission consumes no quota',async()=>{
  process.env.RATE_LIMIT_STORE='memory';
  for(let i=0;i<5;i++){expireMinute();const r=await register.POST(req({username:'daily_user_'+i,password},'192.0.2.41'));assert.equal(r.status,201);}
  expireMinute();const before=created();const r=await register.POST(req({username:'daily_user_6',password},'192.0.2.41'));assert.equal(r.status,429);assert(Number(r.headers.get('retry-after'))>86000);assert.deepEqual(created(),before);assert.equal(auth.findUserByUsername('daily_user_6'),undefined);
  process.env.RATE_LIMIT_STORE='sqlite';
 });
 await test('insertion failure rolls back user, session and creation allowance together',async()=>{
  const before=[count('users'),count('sessions')];db.exec("CREATE TRIGGER reject_fixture_registration BEFORE INSERT ON users WHEN NEW.username='failure_user' BEGIN SELECT RAISE(ABORT,'fixture private SQL error'); END");
  const r=await register.POST(req({username:'failure_user',password},'192.0.2.42'));assert.equal(r.status,503);assert(!JSON.stringify(await r.json()).includes('private SQL'));assert.deepEqual([count('users'),count('sessions')],before);assert.deepEqual(created(),[]);
  db.exec('DROP TRIGGER reject_fixture_registration');assert.equal((await register.POST(req({username:'failure_recovered',password},'192.0.2.42'))).status,201);
 });
 await test('session insertion failure also rolls back the newly inserted account and successful quotas',async()=>{
  const before=[count('users'),count('sessions')];db.exec("CREATE TRIGGER reject_fixture_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'fixture session failure'); END");
  const r=await register.POST(req({username:'session_failure',password},'192.0.2.46'));assert.equal(r.status,503);assert.deepEqual([count('users'),count('sessions')],before);assert.deepEqual(created(),[]);assert.equal(auth.findUserByUsername('session_failure'),undefined);
  db.exec('DROP TRIGGER reject_fixture_session');
 });
 await test('non-JSON and oversized bodies never create an account or session',async()=>{
  const before=[count('users'),count('sessions')];
  for(const contentType of ['text/plain','application/x-www-form-urlencoded']){assert.equal((await register.POST(req({username:'content_type',password},'192.0.2.47',{'content-type':contentType}))).status,400);}
  assert.equal((await register.POST(req({username:'oversized',password:'文'.repeat(6000)},'192.0.2.47'))).status,400);
  assert.deepEqual([count('users'),count('sessions')],before);
 });
 await test('spoofed prefixes and IPv6 privacy-address rotation share the same successful-creation allowance',async()=>{
  assert.equal((await register.POST(req({username:'proxy_first',password},'198.51.100.1, 192.0.2.43'))).status,201);
  assert.equal((await register.POST(req({username:'proxy_second',password},'198.51.100.2, 192.0.2.43'))).status,429);
  assert.equal((await register.POST(req({username:'ipv6_first',password},'2001:db8:1234:5678::1'))).status,201);
  assert.equal((await register.POST(req({username:'ipv6_second',password},'2001:db8:1234:5678:ffff::2'))).status,429);
 });
 await test('malformed attempts hit a server budget before hashing or account creation',async()=>{
  const before=count('users');for(let i=0;i<5;i++)assert.equal((await register.POST(req({username:[],password},'192.0.2.44'))).status,400);
  const r=await register.POST(req({username:'burst_blocked',password},'192.0.2.44'));assert.equal(r.status,429);assert(Number(r.headers.get('retry-after'))>0);assert.equal(count('users'),before);
 });
 await test('Web and legacy login reject coercion and SQL strings with uniform errors and no session',async()=>{
  const before=count('sessions');
  for(const handler of [login.POST,legacy.POST])for(const body of [{username:[owner.username],password:'owner-password-123'},{username:owner.username,password:123456789},{username:"' OR 1=1--",password}, {username:'missing_account',password},{username:owner.username,password:'wrong'}]){
   db.prepare('DELETE FROM rate_limit').run();const r=await handler(req(body));assert.equal(r.status,401);assert.equal(r.headers.get('set-cookie'),null);assert.equal(count('sessions'),before);
  }
 });
 await test('all login paths share a persistent burst budget and successful cooldown never auto-replays',async()=>{
  for(let i=0;i<10;i++){const r=await (i%2?legacy.POST:login.POST)(req({username:'missing_'+i,password},'192.0.2.45'));assert.equal(r.status,401);}
  const before=count('sessions'),r=await login.POST(req({username:owner.username,password:'owner-password-123'},'192.0.2.45'));assert.equal(r.status,429);assert(Number(r.headers.get('retry-after'))>0);assert.equal(count('sessions'),before);
 });
 console.log(passed+' authentication abuse suites passed (isolated database)');
}finally{db.close();assert(temp.startsWith(path.join(os.tmpdir(),'alcor-auth-abuse-')));fs.rmSync(temp,{recursive:true,force:true});}})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});
