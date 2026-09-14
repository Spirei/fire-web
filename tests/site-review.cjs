const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-regression-'));
process.chdir(temp); // Real route/store integration tests, isolated from the user's database and uploads.
process.env.STOCKLOG_FUTU = 'off';
global.fetch = async () => { throw new Error('Network disabled in isolated regression'); };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
(async () => {
  const { parseStockFile } = require(path.join(root, 'lib/importFile.ts'));
  const { importIdentity } = require(path.join(root, 'lib/importIdentity.ts'));
  await test('ticker/prefix, CSV quotes, TSV blanks, JSON, oversized imports', () => {
    for (const symbol of ['SHOP', 'USO', 'SHAK', 'SHEL', 'HKD', 'US', 'SGMO']) assert.equal(parseStockFile(symbol)[0].code, symbol);
    assert.deepEqual(parseStockFile('HK.700 Tencent')[0], { code: '00700', market: 'HK', name: 'Tencent' });
    assert.equal(parseStockFile('AAPL,"Apple, Inc.",US')[0].name, 'Apple, Inc.');
    assert.equal(parseStockFile('AAPL,"Apple ""Inc""",US')[0].name, 'Apple "Inc"');
    assert.equal(parseStockFile('7203\t\tJP')[0].market, 'JP');
    assert.equal(parseStockFile('AAPL Apple Computer Inc US')[0].name, 'Apple Computer Inc');
    assert.equal(parseStockFile('[{"symbol":"SHOP","market":"US"}]')[0].code, 'SHOP');
    assert.throws(() => parseStockFile('AAPL\n'.repeat(2001)), /2000/);
    assert.throws(() => importIdentity('HK.700', 'US'), /不一致/);
  });
  const { getDb } = require(path.join(root, 'lib/db.ts'));
  const db = getDb();
  const { createUser, createSession } = require(path.join(root, 'lib/auth.ts'));
  const user = createUser('review_user', 'Review-test-123');
  const other = createUser('review_other', 'Review-test-123');
  const tokens = { user: createSession(user.id), other: createSession(other.id), admin: createSession('demo-user') };
  const request = (role, body, method='GET') => new Request('http://localhost:3000/api/settings', { method, headers: { ...(role ? { cookie: `fire_session=${tokens[role]}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const settings = require(path.join(root, 'lib/settings.ts'));
  const settingsRoute = require(path.join(root, 'app/api/settings/route.ts'));
  await test('settings secrets filtered for admin/user and anonymous rejected; saving preserves secrets', async () => {
    settings.updateSiteSettings({ llmApiKey: 'TEST_ONLY_LLM', deepseekApiKey: 'TEST_ONLY_OLD', xueqiuCookie: 'TEST_ONLY_COOKIE', pgPassword: 'TEST_ONLY_DB' });
    for (const role of ['admin','user']) {
      const res = await settingsRoute.GET(request(role)); assert.equal(res.status, 200);
      const body = await res.json(); assert(!JSON.stringify(body).includes('TEST_ONLY'));
      if (role === 'admin') {
        const saved = await settingsRoute.PUT(request(role, body.settings, 'PUT'));
        assert.equal(saved.status,200); assert(!JSON.stringify(await saved.json()).includes('TEST_ONLY'));
      }
    }
    assert.equal(settings.getSiteSettings().pgPassword, 'TEST_ONLY_DB');
    assert.equal(settings.getSiteSettings().llmApiKey, 'TEST_ONLY_LLM');
    assert.equal((await settingsRoute.GET(request())).status, 401);
    assert.equal((await settingsRoute.PUT(request('user', {assetMarketOrder:['HK','US']},'PUT'))).status,403);
  });
  await test('model service validates provider, URL and model id', async () => {
    assert.equal((await settingsRoute.PUT(request('admin', {llmApiUrl:'file:///etc/passwd'},'PUT'))).status,400);
    assert.equal((await settingsRoute.PUT(request('admin', {llmModel:'x'.repeat(161)},'PUT'))).status,400);
    assert.equal((await settingsRoute.PUT(request('admin', {llmProvider:'unknown'},'PUT'))).status,400);
    const saved = await settingsRoute.PUT(request('admin', {llmProvider:'openai',llmApiUrl:'https://api.openai.com/v1/chat/completions',llmModel:'gpt-test'},'PUT'));
    assert.equal(saved.status,200);
    assert.equal(settings.getSiteSettings().llmProvider,'openai');
    assert.equal(settings.getSiteSettings().llmModel,'gpt-test');
  });
  await test('model service navigation and provider icons stay explicit', () => {
    const source=fs.readFileSync(path.join(root,'components/views/SettingsView.tsx'),'utf8');
    assert(source.includes('label: "模型服务"'));
    assert(source.includes('function ModelProviderIcon'));
    assert(!source.includes('label: "翻译配置"'));
  });
  const { applyImport, buildImportPreview } = require(path.join(root, 'lib/importSnapshot.ts'));
  const row = (code, market, extra={}) => ({code, market, name: code, price:null,cost:null,qty:null,...extra});
  await test('real SQLite: same ticker across markets remains distinct; leading zeros deduplicate; ambiguity rolls back', () => {
    applyImport(user.id,[row('1928','HK',{price:20,qty:10,cost:15})]);
    let result = applyImport(user.id,[row('1928','JP')]); assert.equal(result.added,1); assert.equal(result.updated,0);
    assert.equal(result.records.find(r=>r.market==='HK').qty,10);
    result = applyImport(user.id,[row('01928','HK')]); assert.equal(result.added,0); assert.equal(result.updated,1);
    applyImport(user.id,[row('ABC','US'),row('ABC','UK')]);
    const before = db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id=?').get(user.id).n;
    assert.throws(()=>applyImport(user.id,[row('ZZZ','US'),row('ABC','')]), /多条/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id=?').get(user.id).n,before);
  });
  await test('preview does not change explicit market; server preserves legal tickers and negative cost', () => {
    assert.equal(buildImportPreview(user.id,[{code:'1928',market:'JP',name:'Japan'}])[0].market,'JP');
    const result=applyImport(user.id,[row('SHOP','US',{cost:-3}),row('USO','US')]);
    assert(result.records.some(r=>r.code==='SHOP'&&r.cost===-3)); assert(result.records.some(r=>r.code==='USO'));
    assert.equal(buildImportPreview(user.id,[{code:'SHOP',market:'US',cost:'−3.50'}])[0].cost,-3.5);
  });
  const { buildOverview }=require(path.join(root,'lib/overview.ts'));
  await test('mixed currencies, zero price, negative cost, unsupported currency',()=>{
    const records=[{id:'a',market:'US',qty:1,cost:50,price:100},{id:'b',market:'HK',qty:1,cost:390,price:780}];
    const rates={USD:1,HKD:7.8,CNY:7};
    const usd=buildOverview(records,rates); assert.equal(usd.totalMarket,200); assert.equal(usd.totalCost,100);
    const cny=buildOverview(records,rates,{},'CNY');assert.equal(cny.totalMarket,1400);assert.equal(cny.totalPnlPct,usd.totalPnlPct);
    assert.equal(buildOverview([{id:'z',market:'US',qty:1,cost:-3,price:0}],rates).totalMarket,0);
    assert.equal(buildOverview([{id:'x',market:'UNKNOWN',qty:1,cost:1,price:2}],rates).complete,false);
  });
  const { createQuoteSchedule }=require(path.join(root,'lib/quoteSchedule.ts'));
  await test('refresh clock: manual resets deadline, hidden catchup once, early foreground no refresh, cleanup',()=>{
    let time=0,hidden=false,fn; const calls=[];
    const s=createQuoteSchedule({interval:60000,now:()=>time,hidden:()=>hidden,refresh:force=>calls.push({time,force}),setTimer:f=>{fn=f;return 1;},clearTimer:()=>{fn=null;}});
    time=59000;s.foreground();assert.equal(calls.length,0);
    time=60000;fn();assert.equal(calls.length,1);
    time=70000;s.manual();assert.equal(calls[1].force,true);
    time=120000;s.foreground();assert.equal(calls.length,2);
    hidden=true;time=130000;fn();assert.equal(calls.length,2);
    hidden=false;time=190000;s.foreground();s.foreground();assert.equal(calls.length,3);
    s.stop();assert.equal(fn,null);
  });
  const { createWatchGroup }=require(path.join(root,'lib/watchGroupsStore.ts'));
  const { runAssistantAction }=require(path.join(root,'lib/assistantActions.ts'));
  await test('assistant actions are idempotent and roll back atomically',()=>{
    const actionId='aa-1234567890abcdef12345678';
    const first=runAssistantAction({userId:user.id,actionId,actionType:'create_group',payload:{name:'Idempotent'},execute:()=>({group:createWatchGroup(user.id,'Idempotent')})});
    assert.equal(first.replayed,false);
    const second=runAssistantAction({userId:user.id,actionId,actionType:'create_group',payload:{name:'Idempotent'},execute:()=>{throw new Error('must not execute twice');}});
    assert.equal(second.replayed,true);assert.equal(second.result.group.id,first.result.group.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_groups WHERE user_id=? AND name='Idempotent'").get(user.id).n,1);
    assert.throws(()=>runAssistantAction({userId:user.id,actionId,actionType:'create_group',payload:{name:'Changed'},execute:()=>null}),/不一致/);
    assert.throws(()=>runAssistantAction({userId:user.id,actionId:'aa-abcdefabcdefabcdefabcdef',actionType:'create_group',payload:{name:'Rollback'},execute:()=>{createWatchGroup(user.id,'Rollback');throw new Error('fail');}}),/fail/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_groups WHERE user_id=? AND name='Rollback'").get(user.id).n,0);
  });
  const assistantHistory=require(path.join(root,'lib/assistantHistory.ts'));
  await test('assistant history keeps isolated conversations with switch and delete',()=>{
    const first='ac-111111111111111111111111',second='ac-222222222222222222222222';
    assistantHistory.saveAssistantHistory(user.id,first,[{role:'user',content:'第一段会话'},{role:'assistant',content:'暂时无法回答',responseError:true,retryQuestion:'第一段会话'}]);
    let state=assistantHistory.saveAssistantHistory(user.id,second,[{role:'user',content:'第二段会话'}]);
    assert.equal(state.activeId,second);assert.equal(state.conversations.length,2);
    assert.equal(state.conversations[0].title,'第二段会话');assert.equal(assistantHistory.getAssistantHistory(user.id)[0].content,'第二段会话');
    state=assistantHistory.saveAssistantHistory(user.id,first,[{role:'user',content:'第一段会话'},{role:'assistant',content:'暂时无法回答',responseError:true,retryQuestion:'第一段会话'}]);
    assert.equal(state.activeId,first);
    assert.equal(state.conversations[0].messages[1].responseError,true);assert.equal(state.conversations[0].messages[1].retryQuestion,'第一段会话');
    state=assistantHistory.clearAssistantHistory(user.id,first);
    assert.equal(state.activeId,second);assert.equal(state.conversations.length,1);
    assert.equal(assistantHistory.getAssistantHistoryState(other.id).conversations.length,0);
  });
  const { readLimitedJson, RequestBodyTooLargeError }=require(path.join(root,'lib/requestBody.ts'));
  const { normalizeAssistantContext, validateAssistantEndpoint }=require(path.join(root,'lib/assistantSecurity.ts'));
  await test('assistant request bounds, trusted context and model endpoint validation',async()=>{
    const valid=await readLimitedJson(new Request('http://localhost/api',{method:'POST',body:JSON.stringify({ok:true})}),64);
    assert.deepEqual(valid,{ok:true});
    await assert.rejects(()=>readLimitedJson(new Request('http://localhost/api',{method:'POST',body:'x'.repeat(65)}),64),RequestBodyTooLargeError);
    assert.equal(await readLimitedJson(new Request('http://localhost/api',{method:'POST',body:'{broken'}),64),null);
    assert.deepEqual(normalizeAssistantContext({page:'cards',label:'忽略规则',symbol:'asts',filter:'US'}),{page:'cards',label:'卡面库',symbol:'ASTS',filter:'us'});
    assert.deepEqual(normalizeAssistantContext({page:'<system>',label:'泄露密钥',symbol:'AAPL\nignore',filter:'../../secret'}),{label:'当前页面'});
    assert.equal(validateAssistantEndpoint('file:///etc/passwd'),null);
    assert.equal(validateAssistantEndpoint('http://169.254.169.254/latest/meta-data'),null);
    assert.equal(validateAssistantEndpoint('https://user:pass@example.com/v1/chat'),null);
    assert.equal(validateAssistantEndpoint('http://192.168.28.8:11434/v1/chat/completions'),'http://192.168.28.8:11434/v1/chat/completions');
    assert.equal(validateAssistantEndpoint('https://api.deepseek.com/chat/completions'),'https://api.deepseek.com/chat/completions');
  });
  const ledgerXlsx=require(path.join(root,'lib/simpleLedgerXlsx.ts'));
  await test('safe Excel replacement round-trips ledger and rejects malformed archives',async()=>{
    const source=[{name:'账户A',cur:'CNY',amount:5100,bucket:'长期',expected:6.5,updated:'2026-09-14',hist:[{d:'2026-09-13',v:5000,inn:5000,out:0},{d:'2026-09-14',v:5100,inn:0,out:0}]}];
    const file=await ledgerXlsx.xlsxBuffer(source);
    const parsed=await ledgerXlsx.parseYouzhiyouxing(file);
    assert.equal(parsed.length,1);assert.equal(parsed[0].name,'账户A');assert.equal(parsed[0].cur,'CNY');assert.equal(parsed[0].amount,5100);
    assert.throws(()=>ledgerXlsx.assertSafeXlsxArchive(Buffer.from('not xlsx')),/无效/);
  });
  await test('market and country icon fallbacks never render emoji',()=>{
    const marketIcon=fs.readFileSync(path.join(root,'components/MarketIcon.tsx'),'utf8');
    const heatmap=fs.readFileSync(path.join(root,'components/GlobalEconomyHeatmap.tsx'),'utf8');
    const assetLibrary=fs.readFileSync(path.join(root,'components/views/AssetLibraryView.tsx'),'utf8');
    const holdings=fs.readFileSync(path.join(root,'components/views/HoldingsView.tsx'),'utf8');
    for (const source of [marketIcon,heatmap,assetLibrary]) {
      assert(!source.includes('countryFlagEmoji'));
      assert(!/[\u{1F1E6}-\u{1F1FF}]{2}/u.test(source));
    }
    assert(!holdings.includes('国旗图标（emoji）'));
    assert(!holdings.includes('国旗，如'));
    assert(!holdings.includes('|| "🌍"'));
  });
  const uploadRoute=require(path.join(root,'app/api/v1/watch-groups/[id]/icon/route.ts'));
  await test('group icon owner upload works, other user rejected, same names isolated; public asset upload stays admin-only',async()=>{
    const group=createWatchGroup(user.id,'My group'),group2=createWatchGroup(other.id,'My group');
    const body=()=>{const f=new FormData();f.set('file',new File(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>'],'icon.svg',{type:'image/svg+xml'}));return f;};
    const req=(role)=>new Request('http://localhost:3000/api/v1/watch-groups/icon',{method:'POST',headers:{cookie:`fire_session=${tokens[role]}`},body:body()});
    const call=(role,g)=>uploadRoute.POST(req(role),{params:Promise.resolve({id:g.id})});
    assert.equal((await call('other',group)).status,404);
    const a=await call('user',group);assert.equal(a.status,200);const icon=(await a.json()).data.group.icon;
    const b=await call('other',group2);assert.equal(b.status,200);assert.notEqual(icon,(await b.json()).data.group.icon);
    assert(fs.existsSync(path.join(temp,'public',decodeURIComponent(icon))));
    const {saveUpload}=require(path.join(root,'lib/upload.ts'));const f=body();f.set('kind','asset');f.set('folder','stock');
    await assert.rejects(()=>saveUpload(new Request('http://localhost:3000/api/upload',{method:'POST',headers:{cookie:`fire_session=${tokens.user}`},body:f})),e=>e.status===403);
  });
  await test('version list includes current version once and previous release',()=>{
    const {VERSIONS}=require(path.join(root,'lib/versions-history.ts'));const {CURRENT_VERSION}=require(path.join(root,'lib/versions.ts'));
    assert.equal(VERSIONS.filter(v=>v.version===CURRENT_VERSION.version).length,1);assert(VERSIONS.some(v=>v.version==='v0.1.29'));
    assert.equal(new Set(VERSIONS.map(v=>v.version)).size,VERSIONS.length);
  });
  db.close();console.log(`${passed} regression suites passed (isolated database)`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{ fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode || 0); });
