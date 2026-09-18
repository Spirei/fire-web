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
require.extensions['.tsx'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
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
    const incomplete={id:'draft-model',name:'待配置模型',provider:'deepseek',icon:'',apiUrl:'https://api.deepseek.com/chat/completions',apiKey:'',models:['deepseek-chat']};
    assert.equal((await settingsRoute.PUT(request('admin',{modelServices:[incomplete]},'PUT'))).status,200);
    assert.equal(settings.getSiteSettings().modelServices[0].apiKey,'');
  });
  await test('ordered model services preserve secrets and expose only configured state', async () => {
    const services=[
      {id:'primary',name:'主模型',provider:'deepseek',icon:'',apiUrl:'https://api.deepseek.com/chat/completions',apiKey:'SECRET_PRIMARY',models:['deepseek-chat','deepseek-reasoner']},
      {id:'backup',name:'备用模型',provider:'custom',icon:'',apiUrl:'https://models.example.com/v1/chat/completions',apiKey:'SECRET_BACKUP',models:['backup-fast']}
    ];
    assert.equal((await settingsRoute.PUT(request('admin',{modelServices:services},'PUT'))).status,200);
    const client=await (await settingsRoute.GET(request('admin'))).json();
    assert(!JSON.stringify(client).includes('SECRET_'));
    assert.equal(client.settings.modelServices[0].apiKeyConfigured,true);
    const reordered=[{...client.settings.modelServices[1]},{...client.settings.modelServices[0]}];
    assert.equal((await settingsRoute.PUT(request('admin',{modelServices:reordered},'PUT'))).status,200);
    const saved=settings.getSiteSettings().modelServices;
    assert.deepEqual(saved.map(item=>item.id),['backup','primary']);
    assert.deepEqual(saved.flatMap(item=>item.models),['backup-fast','deepseek-chat','deepseek-reasoner']);
    assert.equal(saved[0].apiKey,'SECRET_BACKUP');
    const {modelAttempts}=require(path.join(root,'lib/modelServices.ts'));
    assert.deepEqual(modelAttempts(settings.getSiteSettings()).map(item=>`${item.service.name}:${item.model}`),['备用模型:backup-fast','主模型:deepseek-chat','主模型:deepseek-reasoner']);
  });
  await test('model connection test uses server-side saved key without exposing it', async () => {
    const modelTestRoute=require(path.join(root,'app/api/settings/model-test/route.ts'));
    const offline=global.fetch;let observed;
    global.fetch=async(url,init)=>{observed={url,auth:init.headers.Authorization,body:JSON.parse(init.body)};return new Response(JSON.stringify({choices:[{message:{content:'OK'}}]}),{status:200,headers:{'Content-Type':'application/json'}});};
    try {
      const req=new Request('http://localhost:3000/api/settings/model-test',{method:'POST',headers:{cookie:`fire_session=${tokens.admin}`,'Content-Type':'application/json'},body:JSON.stringify({serviceId:'backup',apiUrl:'https://models.example.com/v1/chat/completions',model:'backup-fast'})});
      const res=await modelTestRoute.POST(req);const body=await res.json();assert.equal(res.status,200);assert.equal(body.ok,true);
      assert.equal(observed.auth,'Bearer SECRET_BACKUP');assert.equal(observed.body.model,'backup-fast');
    } finally { global.fetch=offline; }
  });
  await test('model service navigation and provider icons stay explicit', () => {
    const source=fs.readFileSync(path.join(root,'components/views/SettingsView.tsx'),'utf8');
    assert(source.includes('label: "模型服务"'));
    assert(source.includes('function ModelProviderIcon'));
    assert(!source.includes('label: "翻译配置"'));
    assert(source.includes('const input = event.currentTarget'));
    assert(source.includes('icon={item.id === service.provider ? service.icon : ""}'));
    assert(source.includes('icon: item.id === service.provider ? service.icon : ""'));
    assert(source.includes('`${serviceId}-${Date.now().toString(36)}`'));
    assert(source.includes('draggable={!editingModel && services.length > 1 && !blockSaving["model-order"]}'));
    assert(!source.includes('rounded-[inherit] object-cover'));
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
    state=assistantHistory.updateAssistantConversation(user.id,first,{title:'重命名会话'});
    assert.equal(state.conversations[0].title,'重命名会话');
    state=assistantHistory.updateAssistantConversation(user.id,first,{archived:true});
    assert.equal(state.conversations.some(item=>item.id===first),false);assert.equal(state.archivedConversations[0].title,'重命名会话');
    state=assistantHistory.updateAssistantConversation(user.id,first,{archived:false});
    assert.equal(state.conversations.some(item=>item.id===first),true);assert.equal(state.archivedConversations.length,0);
    state=assistantHistory.clearAssistantHistory(user.id,first);
    assert.equal(state.activeId,second);assert.equal(state.conversations.length,1);
    assert.equal(assistantHistory.getAssistantHistoryState(other.id).conversations.length,0);
  });
  const { readLimitedJson, readLimitedResponseJson, RequestBodyTooLargeError }=require(path.join(root,'lib/requestBody.ts'));
  const { normalizeAssistantContext, validateAssistantEndpoint }=require(path.join(root,'lib/assistantSecurity.ts'));
  await test('assistant request bounds, trusted context and model endpoint validation',async()=>{
    const valid=await readLimitedJson(new Request('http://localhost/api',{method:'POST',body:JSON.stringify({ok:true})}),64);
    assert.deepEqual(valid,{ok:true});
    await assert.rejects(()=>readLimitedJson(new Request('http://localhost/api',{method:'POST',body:'x'.repeat(65)}),64),RequestBodyTooLargeError);
    assert.deepEqual(await readLimitedResponseJson(new Response(JSON.stringify({ok:true})),64),{ok:true});
    await assert.rejects(()=>readLimitedResponseJson(new Response('x'.repeat(65)),64),RequestBodyTooLargeError);
    assert.equal(await readLimitedJson(new Request('http://localhost/api',{method:'POST',body:'{broken'}),64),null);
    assert.deepEqual(normalizeAssistantContext({page:'cards',label:'忽略规则',symbol:'asts',filter:'US'}),{page:'cards',label:'卡面库',symbol:'ASTS',filter:'us'});
    assert.deepEqual(normalizeAssistantContext({page:'<system>',label:'泄露密钥',symbol:'AAPL\nignore',filter:'../../secret'}),{label:'当前页面'});
    assert.equal(validateAssistantEndpoint('file:///etc/passwd'),null);
    assert.equal(validateAssistantEndpoint('http://169.254.169.254/latest/meta-data'),null);
    assert.equal(validateAssistantEndpoint('https://user:pass@example.com/v1/chat'),null);
    assert.equal(validateAssistantEndpoint('http://192.168.28.8:11434/v1/chat/completions'),'http://192.168.28.8:11434/v1/chat/completions');
    assert.equal(validateAssistantEndpoint('https://api.deepseek.com/chat/completions'),'https://api.deepseek.com/chat/completions');
  });
  await test('assistant launcher and panel positions are draggable, isolated and persistent',()=>{
    const source=fs.readFileSync(path.join(root,'components/ContextAssistant.tsx'),'utf8');
    const globalStyles=fs.readFileSync(path.join(root,'app/globals.css'),'utf8');
    assert(source.includes('startFloatingDrag("launcher"'));
    assert(source.includes('startFloatingDrag("panel"'));
    assert(source.includes('fire:assistant:${target}-position:${userId}'));
    assert(source.includes('suppressLauncherClick.current'));
    assert(source.includes('clampFloatingPosition'));
    assert(source.includes('writePersistentPreference'));
  assert(source.includes('writePersistentPreference(`fire:assistant:sidebar-width:${userId}`'));
  assert(!source.includes('localStorage.setItem(`fire:assistant:sidebar-width:'));
    assert(source.includes('Max-Age=31536000'));
  assert(source.includes('aria-pressed={pinned}'));
  assert(source.includes('onPointerDown={(event) => event.stopPropagation()}'));
  assert(source.includes('你的对话会保留在这里'));
  assert(source.includes('placeholder="搜索对话"'));
  assert(!source.includes('IconMinus'));
  assert(!source.includes('setMinimized'));
  assert(source.includes('M14 4v5l3 3v2H7v-2l3-3V4'));
  assert(!source.includes('>新建对话</button>'));
  assert(source.includes('aria-pressed={open}'));
  assert(source.includes('收起智能助手'));
  assert(source.includes('dark:bg-[#17191d]'));
  assert(source.includes('bg-[#4caf58]'));
  assert(source.includes('aria-label={loading && !input.trim() && pendingImages.length === 0 ? "停止生成" : "发送"}'));
  assert(source.includes('onClick={loading && !input.trim() && pendingImages.length === 0 ? stopGenerating : undefined}'));
  assert(globalStyles.includes('assistant-thinking 1.8s'));
  assert(source.includes('onPaste={(event) =>'));
  assert(source.includes('onDrop={(event) =>'));
  assert(source.includes('IconPaperclip'));
  assert(source.includes('imageInputRef'));
  assert(source.includes('accept="image/*"'));
  assert(source.includes('aria-label="添加附件"'));
  assert(source.includes('20 * 1024 * 1024'));
  assert(source.includes('pendingImageBytesRef.current += reservedBytes'));
  assert(source.includes('pendingImageSequenceRef.current'));
  assert(!source.includes('crypto.randomUUID()'));
  assert(source.includes('aria-label={`查看图片：${image.name}`}'));
  assert(source.includes('aria-label={`图片预览：${previewImage.name}`}'));
  assert(source.includes('if (previewImage) setPreviewImage(null)'));
  assert(!globalStyles.includes('color-scheme: light;\n  border-color: #e1e7e6;\n  background: #fff;'));
    assert(source.includes("closest(\"button, input, textarea, a, [role='button']\")"));
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
  await test('upload security rejects expanded SVG scripts and traversal; stream limits cannot be bypassed', async () => {
    const { isSafeSvg } = require(path.join(root, 'lib/imageSecurity.ts'));
    for (const payload of [
      '<svg xmlns="http://www.w3.org/2000/svg"><s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="&#106;avascript:alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>'
    ]) assert.equal(isSafeSvg(Buffer.from(payload)), false);
    assert.equal(isSafeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><path fill="url(#g)" d="M0 0"/></svg>')), true);
    const { validAssetCode, assetFilePath } = require(path.join(root, 'lib/assetSecurity.ts'));
    assert.equal(validAssetCode('../../proof'), false);
    assert.throws(() => assetFilePath(temp, '../proof'), /无效/);
    const { readJsonBody } = require(path.join(root, 'lib/requestBody.ts'));
    await assert.rejects(() => readJsonBody(new Request('http://localhost', {method:'POST',body:'"'+'x'.repeat(100)+'"'}), 32));
    const { saveAssistantAttachments } = require(path.join(root, 'lib/assistantAttachments.ts'));
    assert.throws(() => saveAssistantAttachments(user.id, 'ac-'+'a'.repeat(24), [{name:'evil',dataUrl:'data:image/svg+xml;base64,'+Buffer.from('<svg onload=alert(1)>').toString('base64')}]), /仅支持/);
    const reports = require(path.join(root, 'app/api/v1/financial-reports/route.ts'));
    assert.equal((await reports.GET(request(null))).status, 401);
    assert.equal((await reports.GET(request('user'))).status, 403);
  });
  await test('ordinary users cannot alter unowned shared assets; legacy unsafe attachments remain removable', async () => {
    const assets = require(path.join(root, 'app/api/assets/add-by-search/route.ts'));
    const call = body => assets.POST(new Request('http://localhost/api/assets/add-by-search', {method:'POST',headers:{cookie:`fire_session=${tokens.user}`,'Content-Type':'application/json'},body:JSON.stringify(body)}));
    assert.equal((await call({type:'crypto',market:'ASSET',code:'BTC',name:'Bitcoin',onlyIfMissing:true})).status,403);
    assert.equal((await call({type:'stock',market:'US',code:'../../proof',name:'Proof',onlyIfMissing:true})).status,400);
    assert.equal((await call({type:'stock',market:'US',code:'UNOWNED',name:'Proof',onlyIfMissing:true})).status,403);
    const attachments = require(path.join(root, 'lib/assistantAttachments.ts'));
    const conversationId='ac-'+'b'.repeat(24);
    const saved=attachments.saveAssistantAttachments(user.id,conversationId,[{name:'pixel.png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII='}])[0];
    const rootDir=path.join(temp,'data','assistant-attachments',user.id,conversationId);
    fs.unlinkSync(path.join(rootDir,saved.id+'.png'));
    const legacy=path.join(rootDir,saved.id+'.svg');fs.writeFileSync(legacy,'<svg onload="alert(1)"/>');
    assert.equal(attachments.getAssistantAttachment(user.id,saved.id),null);
    attachments.deleteConversationAttachments(user.id,conversationId);
    assert.equal(fs.existsSync(legacy),false);
  });
  await test('production initial registration requires the private deployment token', async () => {
    const auth = require(path.join(root, 'lib/auth.ts'));
    const original = auth.needsSetup, environment = process.env.NODE_ENV, token = process.env.FIRE_SETUP_TOKEN;
    auth.needsSetup = () => true;
    process.env.NODE_ENV = 'production';
    const registration = require(path.join(root, 'app/api/auth/register/route.ts'));
    const req = body => new Request('http://localhost/api/auth/register', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    try {
      delete process.env.FIRE_SETUP_TOKEN;
      assert.equal((await registration.POST(req({}))).status, 503);
      process.env.FIRE_SETUP_TOKEN = 'test-install-token-'.repeat(3);
      assert.equal((await registration.POST(req({setupToken:'incorrect'}))).status, 403);
      assert.equal((await registration.POST(req({setupToken:process.env.FIRE_SETUP_TOKEN,username:'install_review',password:'Install-test-1234'}))).status, 201);
    } finally { auth.needsSetup=original; if(environment===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=environment; if(token===undefined)delete process.env.FIRE_SETUP_TOKEN;else process.env.FIRE_SETUP_TOKEN=token; }
  });
  await test('trading square: stock names embedded in longer Chinese words are not linked', () => {
    const { splitTradingText, normalizeTradingText } = require(path.join(root, 'lib/tradingSquareText.ts'));
    const holdings = [{ market: 'HK', code: '00001', name: '长和' }, { market: 'US', code: 'OXY', name: '西方石油' }];
    const text = normalizeTradingText('针对我发起的、由纽约州总检察长和曼哈顿地区检察官主导的案件。西方石油(OXY) 今天涨了。');
    const stocks = splitTradingText(text, holdings).filter((part) => part.type === 'stock');
    // 「总检察长和曼哈顿」里的「长和」不能算提及；四字的「西方石油」照旧命中。
    assert.equal(stocks.some((part) => part.name === '长和'), false);
    assert.equal(stocks.some((part) => part.name === '西方石油' && part.market === 'US' && part.code === 'OXY'), true);
    // 裸写的「名称(代码)」只应产生一个提及，不能连出两个链接。
    const paired = splitTradingText(normalizeTradingText('长和(00001) 今天涨了'), holdings).filter((part) => part.type === 'stock');
    assert.deepEqual(paired.map((part) => `${part.name}:${part.code}`), ['长和:00001']);
    const rendered = splitTradingText(normalizeTradingText('长和(00001) 今天涨了'), holdings)
      .map((part) => (part.type === 'stock' ? `$${part.name}(${part.code})$` : part.value)).join('');
    assert.equal(rendered, '$长和(00001)$ 今天涨了');
  });
  await test('trading square window keeps the pinned position when the layout narrows', () => {
    const { baseRectFrom, clampOffsetX, edgeGutter } = require(path.join(root, 'lib/useDraggableWindow.ts'));
    // 内容区 1440 宽、面板 800 宽居中（左 280~右 1720）：用户右移 200px 正常放行
    const wideBase = { left: 600, right: 1400, width: 800 };
    const wideBounds = { left: 280, right: 1720, width: 1440 };
    assert.equal(clampOffsetX(200, wideBase, wideBounds), 200);
    // 内容区变窄到 1000（换显示器 / 窗口缩小）：显示位置被夹回来……
    const narrowBase = { left: 380, right: 1180, width: 800 };
    const narrowBounds = { left: 280, right: 1280, width: 1000 };
    assert.equal(clampOffsetX(200, narrowBase, narrowBounds), 88);
    // ……但用户位置没被改：内容区变宽后原样生效（这就是「卡片跑到中间」的回归点）
    assert.equal(clampOffsetX(200, wideBase, wideBounds), 200);
    // 内容区比面板还窄：贴左，不越界
    assert.equal(clampOffsetX(200, { left: 285, right: 1085, width: 800 }, { left: 280, right: 1090, width: 810 }), 0);
    assert.equal(edgeGutter(800, 810), 5);
    // baseRectFrom：拿带位移的矩形反推居中基准
    assert.deepEqual(baseRectFrom({ left: 800, right: 1600, width: 800 }, { x: 200, y: 40 }), { left: 600, right: 1400, width: 800 });
    // 关键不变式：夹紧只影响渲染，绝不写回 localStorage（只有拖动结束写一次位置）
    const hook = fs.readFileSync(path.join(root, 'lib/useDraggableWindow.ts'), 'utf8');
    assert.equal((hook.match(/localStorage\.setItem/g) || []).length, 1, '只有拖动结束写位置');
    assert(hook.includes('不写回 localStorage'), '夹紧不得持久化');
  });
  await test('trading square parses the Trump archive page markup (time datetime + extra attributes)', () => {
    const { parseTrumpPage } = require(path.join(root, 'lib/tradingSquareRefresh.ts'));
    // 归档站改版后的真实结构：日期包在 <time datetime> 里、正文容器带 data-post-preview
    const html = [
      '<div class="statuses">',
      '<div class="status" data-status-url="https://www.trumpstruth.org/statuses/1">',
      '<div class="status-info__meta"><a href="#" class="status-info__meta-item">@realDonaldTrump</a> · ',
      '<a href="https://www.trumpstruth.org/statuses/1" class="status-info__meta-item"><time datetime="2026-09-17T13:00:22+00:00">September 17, 2026, 9:00 AM</time></a></div>',
      '<div class="status__content" data-post-preview><p>Hello <b>world</b></p></div>',
      '<a href="https://truthsocial.com/@realDonaldTrump/117287545147440255" rel="nofollow">原文</a>',
      '</div>',
      '</div>'
    ].join('');
    const posts = parseTrumpPage(html, 'https://trumpstruth.org/');
    assert.equal(posts.length, 1, '一页解析出 1 条');
    assert.equal(posts[0].date, '2026-09-17T13:00:22.000Z', '日期要取 time[datetime]');
    assert.equal(posts[0].text, 'Hello world', '正文要容得下额外属性');
    assert(posts[0].originalUrl.includes('117287545147440255'));
    // 旧的纯文本日期写法仍要能解析（向后兼容）
    const legacy = '<div class="status"><div class="status-info__meta-item">September 17, 2026, 9:00 AM</div><div class="status__content"><p>Legacy</p></div></div>';
    assert.equal(parseTrumpPage(legacy, 'https://trumpstruth.org/')[0].date, new Date('September 17, 2026, 9:00 AM').toISOString());
  });
  await test('trading square keeps quote-only reposts and preserves emoji labels', () => {
    const { mapDuanStatus } = require(path.join(root, 'lib/tradingSquareRefresh.ts'));
    const { normalizeTradingText } = require(path.join(root, 'lib/tradingSquareText.ts'));
    // 雪球 emoji 是图片：取 alt，别让整段表情被去标签删掉
    assert.equal(normalizeTradingText('<img src="//assets.imedao.com/emoji.png" title="[很赞]" alt="[很赞]" height="24" />'), '[很赞]');
    assert.equal(normalizeTradingText('今天很好<img src="x" alt="[大笑]">，明天见'), '今天很好 [大笑] ，明天见');
    // 转发别人的帖子：自己的正文只有一个表情、也没有自己的图片 —— 以前会被整条丢掉
    const repost = mapDuanStatus({
      id: 409704400,
      created_at: 1789660143000,
      text: '<img src="//assets.imedao.com/ugc/images/face/emoji_35_like.png?v=1" title="[很赞]" alt="[很赞]" height="24" />',
      retweeted_status: {
        id: 409618513,
        created_at: 1789600000000,
        text: '<p>昨天有幸参观了vivo全球总部（东莞）</p>',
        user: { id: 9914456386, screen_name: '岩木', profile_image_url: 'community/x/a.png,community/x/a.png!50x50.png' }
      }
    });
    assert(repost, '转发+引用型帖子不能被丢弃');
    assert.equal(repost.id, '409704400');
    assert.equal(repost.text, '[很赞]');
    assert.equal(repost.quote.name, '岩木');
    assert(repost.quote.text.includes('vivo全球总部'));
    // 真正空白的状态仍然丢弃
    assert.equal(mapDuanStatus({ id: 1 }), null);
  });
  await test('trading square marks unseen posts consistently', () => {
    const { isUnseenPost, unseenBoundaryIndex, unseenCounts } = require(path.join(root, 'lib/tradingSquareSeen.ts'));
    const seen = { duan: '2026-09-17T00:00:00.000Z', trump: null };
    const posts = [
      { author: 'duan', date: '2026-09-17T01:00:00.000Z' },
      { author: 'duan', date: '2026-09-16T23:00:00.000Z' },
      { author: 'trump', date: '2026-09-04T00:00:00.000Z' }
    ];
    assert.equal(isUnseenPost(posts[0], seen), true, '比已读时间新 → 新');
    assert.equal(isUnseenPost(posts[1], seen), false, '比已读时间旧 → 不算新');
    assert.equal(isUnseenPost(posts[2], seen), true, '从没看过这位作者 → 算新');
    assert.deepEqual(unseenCounts(posts, seen), { duan: 1, trump: 1 });
    assert.equal(isUnseenPost({ author: 'duan', date: 'oops' }, seen), false, '时间解析失败不标记');
    assert.deepEqual(unseenCounts(posts, {}), { duan: 2, trump: 1 }, '首次访问全部算新');
    // 分界线画在最后一条新动态下面：整页都新 / 全都看过时不画线
    const boundary = (list) => unseenBoundaryIndex(list, seen);
    assert.equal(boundary([
      { author: 'duan', date: '2026-09-17T03:00:00.000Z' },
      { author: 'duan', date: '2026-09-17T02:00:00.000Z' },
      { author: 'duan', date: '2026-09-16T23:00:00.000Z' }
    ]), 1, '两条新动态 → 线画在第二条下面');
    assert.equal(boundary([{ author: 'duan', date: '2026-09-16T23:00:00.000Z' }]), -1, '没有新动态 → 不画线');
    assert.equal(boundary([{ author: 'duan', date: '2026-09-17T01:00:00.000Z' }]), -1, '整页都是新动态 → 不画线');
    assert.equal(boundary([]), -1, '空列表 → 不画线');
    // 新动态标记按主流做法：单条只用一个小圆点（不用文字胶囊），交界处画一次分隔线；
    // 颜色必须用站内「未读」色 —— 本站绿色表示下跌，自己发明一枚绿块会和涨跌语义打架
    const square = fs.readFileSync(path.join(root, 'components/views/TradingSquareView.tsx'), 'utf8');
    assert(square.includes('aria-label="上次访问之后的新动态"'), '新动态标记还在');
    assert(square.includes('rounded-full bg-up dark:bg-[#ff8a8a]'), '单条标记是站内未读色的小圆点');
    // 分界标签压在那条本来就有的帖间分隔线上（微信「以下是新消息」的写法），不额外画线、不用红色
    assert(square.includes('relative flex h-0 items-center justify-center'), '分界标签压在原有分隔线上');
    assert(/font-medium text-faint[^>]*>以上 \{newAboveBoundary\} 条为新动态/.test(square), '分界标签是中性灰小字');
    assert(!square.includes('#4caf58'), '不再引入站外的绿色');
  });
  await test('trading square strips scraped page chrome from post text', () => {
    const { normalizeTradingText, stripTradingSquareChrome } = require(path.join(root, 'lib/tradingSquareText.ts'));
    // 开头的「回复@某人:」是回复上下文（雪球页面上的链接），不是作者写的字
    assert.equal(normalizeTradingText('回复@小马种西瓜: 其实是这样'), '其实是这样');
    assert.equal(normalizeTradingText('回复@小马种西瓜： 其实是这样'), '其实是这样');
    assert.equal(normalizeTradingText('回复@科研炒股: 是这个//@科研炒股:同款 查看图片'), '是这个//@科研炒股:同款');
    // 图片 / 外链的链接文案
    assert.equal(normalizeTradingText('这款确实可爱的。查看图片'), '这款确实可爱的。');
    assert.equal(normalizeTradingText('网页链接\n不知道哪个网友收集的'), '不知道哪个网友收集的');
    assert.equal(normalizeTradingText('$泡泡玛特(09992)$ 这款确实可爱的。查看图片'), '$泡泡玛特(09992)$ 这款确实可爱的。');
    // 正文中间的内容要保留：转发链、提及，以及不属于页面文案的方括号标记
    assert.equal(normalizeTradingText('//@小明:转发了这条'), '//@小明:转发了这条');
    assert.equal(stripTradingSquareChrome('好的，谢谢@小明: 我看看'), '好的，谢谢@小明: 我看看');
    assert.equal(stripTradingSquareChrome('回复@小明: 收到[已修改]'), '收到[已修改]');
    // 抓取脚本靠「清洗前的正文」判断是否回复、回复了谁，清洗后必须改用显式字段
    const refresh = fs.readFileSync(path.join(root, 'lib/tradingSquareRefresh.ts'), 'utf8');
    assert(refresh.includes('.match(/^\\s*回复\\s*@('), '清洗前记录回复对象');
    assert(refresh.includes('post.reply === true'), '补抓引用改用 reply 标记');
  });
  await test('trading square comments: avatar url + reply target', () => {
    const { mapXueqiuComment } = require(path.join(root, 'lib/tradingSquareComments.ts'));
    const { normalizeXueqiuAvatar, isAllowedRemoteImageUrl } = require(path.join(root, 'lib/tradingSquareImages.ts'));
    const { replyTargetFromText } = require(path.join(root, 'lib/tradingSquareText.ts'));
    // 雪球头像字段：逗号分隔的多档尺寸、且不带域名（取第一档并补 xavatar 域名，否则前端是破图）
    assert.equal(normalizeXueqiuAvatar('community/20165/a.png,community/20165/a.png!180x180.png'), 'https://xavatar.imedao.com/community/20165/a.png');
    assert.equal(normalizeXueqiuAvatar('https://xavatar.imedao.com/community/a.png'), 'https://xavatar.imedao.com/community/a.png');
    assert.equal(normalizeXueqiuAvatar(''), undefined);
    assert.equal(isAllowedRemoteImageUrl('https://xavatar.imedao.com/community/20165/a.png'), true);
    assert.equal(isAllowedRemoteImageUrl('https://evil.example.com/a.png'), false);
    // 评论：作者、时间、赞数、回复对象、正文里的「回复@x:」前缀要拆出来
    const comment = mapXueqiuComment({
      id: 1,
      created_at: 1789455535000,
      like_count: 18,
      text: '回复@随水而行的Star: 是的，这个位置的人流量在国内也是排前几名的。',
      user: { screen_name: 'neng', profile_image_url: 'community/1/a.png,community/1/a.png!50x50.png' }
    });
    assert.equal(comment.name, 'neng');
    assert.equal(comment.text, '是的，这个位置的人流量在国内也是排前几名的。');
    assert.equal(comment.replyTo, '随水而行的Star');
    assert.equal(comment.likes, 18);
    assert.equal(comment.avatar, 'https://xavatar.imedao.com/community/1/a.png');
    assert.equal(comment.createdAt, new Date(1789455535000).toISOString());
    assert.equal(mapXueqiuComment({ id: 2, text: '   ' }), null);
    assert.equal(replyTargetFromText('回复@小马种西瓜: 正文'), '小马种西瓜');
    assert.equal(replyTargetFromText('//@小明:转发'), undefined);
  });
  await test('sidebar scrollbar stays hidden until hover (dark mode)', () => {
    const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
    // 全站那条「.dark *」滚动条规则与单写一个类的选择器特异性相同（都是 0-1-0），
    // 且位置更靠后 —— 左侧栏的「默认透明」如果不带 .dark 前缀，深色模式下就会被它盖掉、滚动条常显。
    assert.match(css, /\.fire-sidebar-panel,\s*\.dark \.fire-sidebar-panel\s*\{\s*scrollbar-color:\s*transparent transparent;?\s*\}/, '默认隐藏规则必须同时覆盖深色模式');
    assert.match(css, /\.dark \.fire-sidebar-panel::-webkit-scrollbar-thumb\s*\{\s*background:\s*transparent;?\s*\}/, 'webkit 分支同样要覆盖深色模式');
    // 悬停 / 聚焦时仍要显示：深色下由更高特异性的规则接管
    assert.match(css, /\.dark \.fire-sidebar-panel:hover[^{]*\{\s*scrollbar-color:\s*rgba\(255,\s*255,\s*255,\s*\.?0?\.26\)/, '悬停时深色滚动条仍要显示');
  });
  await test('client code never calls crypto.randomUUID (insecure LAN HTTP breaks it)', () => {
    const { clientRandomId } = require(path.join(root, 'lib/randomId.ts'));
    assert.match(clientRandomId('ac-'), /^ac-[0-9a-f]{24}$/);

    const clientFiles = [];
    for (const dir of ['components', 'lib']) {
      for (const name of fs.readdirSync(path.join(root, dir), { recursive: true })) {
        const rel = path.join(dir, String(name));
        if (!/\.(ts|tsx)$/.test(rel)) continue;
        const text = fs.readFileSync(path.join(root, rel), 'utf8');
        if (/^\s*"use client"/.test(text)) clientFiles.push([rel, text]);
      }
    }
    assert(clientFiles.length > 20);
    for (const [rel, text] of clientFiles) assert(!text.includes('crypto.randomUUID('), `${rel} 不能调用 crypto.randomUUID`);

    // 模拟局域网 HTTP（非安全上下文）：randomUUID 不存在、getRandomValues 抛错，都必须仍能拿到 id
    const dialog = require(path.join(root, 'lib/appDialog.ts'));
    const cryptoGlobal = globalThis.crypto;
    const originalRandomUUID = cryptoGlobal.randomUUID;
    const originalGetRandomValues = cryptoGlobal.getRandomValues;
    const events = [];
    const originalWindow = globalThis.window;
    try {
      Object.defineProperty(cryptoGlobal, 'randomUUID', { value: undefined, configurable: true, writable: true });
      globalThis.window = { dispatchEvent: (event) => { events.push(event.detail); return true; } };
      void dialog.appConfirm('删除“这条测试对话”？删除后无法恢复。', { title: '删除对话', danger: true });
      assert.equal(events.length, 1);
      assert.match(events[0].id, /^dlg-[0-9a-f]{24}$/);
      Object.defineProperty(cryptoGlobal, 'getRandomValues', { value: () => { throw new Error('insecure context'); }, configurable: true, writable: true });
      assert.match(clientRandomId(), /^[0-9a-f]{24}$/);
    } finally {
      Object.defineProperty(cryptoGlobal, 'randomUUID', { value: originalRandomUUID, configurable: true, writable: true });
      Object.defineProperty(cryptoGlobal, 'getRandomValues', { value: originalGetRandomValues, configurable: true, writable: true });
      if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    }
  });
  await test('assistant context covers management pages and attaches live site data', async () => {
    const { normalizeAssistantContext } = require(path.join(root, 'lib/assistantSecurity.ts'));
    for (const [page, label] of [['attachments', '附件管理'], ['users', '用户管理'], ['activities', '日志']]) {
      const normalized = normalizeAssistantContext({ page });
      assert.equal(normalized.page, page);
      assert.equal(normalized.label, label);
    }
    assert.equal(normalizeAssistantContext({ page: '../etc/passwd' }).page, undefined);

    const { buildAssistantLiveData } = require(path.join(root, 'lib/assistantLiveData.ts'));
    const lines = await buildAssistantLiveData([{ id: '1', market: 'US', code: 'AAPL', name: '苹果' }], { includeAccount: true, quoteTimeoutMs: 50 });
    assert(Array.isArray(lines));
    assert(lines.every((line) => typeof line === 'string'));
  });
  await test('assistant answers render markdown tables and only safe links', () => {
    const { parseAssistantBlocks, parseInlineSegments } = require(path.join(root, 'lib/assistantMarkdown.ts'));
    const blocks = parseAssistantBlocks([
      '结论：持仓分化',
      '',
      '| 标的 | 现价 | 涨跌 |',
      '| --- | --- | --- |',
      '| 特斯拉 | 420.5 | +1.2% |',
      '| 苹果 | 233.1 | -0.4% |',
      '',
      '> 数据抓取于 09-16 10:20',
      '---',
      '- 风险：单一标的占比过高',
      '1. 继续观察',
      '详见 https://example.com/news 与 [雪球](https://xueqiu.com/a)'
    ].join('\n'));
    const table = blocks.find((block) => block.type === 'table');
    assert.deepEqual(table && table.rows, [['标的', '现价', '涨跌'], ['特斯拉', '420.5', '+1.2%'], ['苹果', '233.1', '-0.4%']]);
    assert(blocks.some((block) => block.type === 'quote'));
    assert(blocks.some((block) => block.type === 'divider'));
    assert(blocks.some((block) => block.type === 'bullet'));
    assert(blocks.some((block) => block.type === 'numbered' && block.marker === '1'));
    assert(!blocks.some((block) => block.type === 'text' && block.text.includes('|')));

    const inline = parseInlineSegments('详见 https://example.com/news 与 [雪球](https://xueqiu.com/a)');
    assert.deepEqual(inline.filter((segment) => segment.type === 'link').map((segment) => segment.href), ['https://example.com/news', 'https://xueqiu.com/a']);
    assert(parseInlineSegments('[危险](javascript:alert(1))').every((segment) => segment.type !== 'link'));
    assert(parseInlineSegments('[伪装](data:text/html;base64,PHN2Zz4=)').every((segment) => segment.type !== 'link'));

    // 真渲染一遍：表格必须变成 <table>、合法链接必须变成 <a>、危险协议只能留文本。
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const AssistantRichText = require(path.join(root, 'components/AssistantRichText.tsx')).default;
    const html = renderToStaticMarkup(React.createElement(AssistantRichText, { text: [
      '| 标的 | 现价 | 涨跌 |',
      '| --- | --- | --- |',
      '| 特斯拉 | 420.5 | +1.2% |',
      '',
      '详见 [雪球](https://xueqiu.com/a) 与 [危险](javascript:alert(1))'
    ].join('\n') }));
    assert(html.includes('assistant-md-table-wrap') && html.includes('<table class="assistant-md-table">'));
    assert(html.includes('<th><span>标的</span></th>') && html.includes('<th><span>涨跌</span></th>'));
    assert(html.includes('<td><span>特斯拉</span></td>') && html.includes('<td><span>+1.2%</span></td>'));
    assert(html.includes('href="https://xueqiu.com/a"'));
    assert(!html.includes('href="javascript:alert(1)"'));

    const source = fs.readFileSync(path.join(root, 'components/ContextAssistant.tsx'), 'utf8');
    const richText = fs.readFileSync(path.join(root, 'components/AssistantRichText.tsx'), 'utf8');
    const styles = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
    const route = fs.readFileSync(path.join(root, 'app/api/assistant/route.ts'), 'utf8');
    assert(source.includes('function pinToLatest()'));
    assert(source.includes('assistant-jump-latest'));
    assert(source.includes('<AssistantRichText text={message.content} />'));
    assert(richText.includes('parseAssistantBlocks(text)'));
    assert(styles.includes('.assistant-md-table'));
    assert(styles.includes('.assistant-jump-latest'));
    assert(styles.includes('.assistant-inline-link'));
    assert(route.includes('回答风格：默认短'));
  });
  await test('runtime-uploaded assets are served back (regression: model service icon 404)', async () => {
    const upload = require(path.join(root, 'app/api/upload/route.ts'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=', 'base64');
    const fd = new FormData();
    fd.set('kind', 'asset');
    fd.set('folder', 'icon');
    fd.set('name', 'DeepSeek');
    fd.set('code', `deepseek-${Date.now().toString(36)}`);
    fd.set('file', new File([png], 'icon.png', { type: 'image/png' }));
    const res = await upload.POST(new Request('http://localhost/api/upload', { method: 'POST', headers: { cookie: `fire_session=${tokens.admin}` }, body: fd }));
    assert.equal(res.status, 200);
    const { url } = await res.json();
    const rel = decodeURIComponent(url.replace(/^\/uploads\//, ''));
    const route = require(path.join(root, 'app/uploads/[...path]/route.ts'));
    const served = await route.GET(new Request(`http://localhost${url}`), { params: Promise.resolve({ path: rel.split('/') }) });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    const missing = await route.GET(new Request('http://localhost/uploads/asset/icon/not-there.png'), { params: Promise.resolve({ path: ['asset', 'icon', 'not-there.png'] }) });
    assert.equal(missing.status, 404);
  });
  await test('entrypoint: unwritable data volume fails loudly, failing seed does not block startup', () => {
    const { spawnSync } = require('node:child_process');
    const entrypoint = path.join(root, 'scripts/entrypoint.sh');
    const seedScript = path.join(root, 'scripts/seed-trading-square.mjs');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-entrypoint-'));
    const dirs = {
      data: path.join(base, 'data'),
      uploads: path.join(base, 'uploads'),
      defaults: path.join(base, 'defaults'),
      cache: path.join(base, 'cache'),
      public: path.join(base, 'public')
    };
    Object.values(dirs).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
    const run = (extraEnv = {}) => spawnSync('sh', [entrypoint, 'echo', 'REACHED_CMD'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FIRE_ENTRYPOINT_DATA_DIR: dirs.data,
        FIRE_ENTRYPOINT_UPLOADS_DIR: dirs.uploads,
        FIRE_ENTRYPOINT_DEFAULTS_DIR: dirs.defaults,
        FIRE_ENTRYPOINT_CACHE_DIR: dirs.cache,
        FIRE_ENTRYPOINT_PUBLIC_DIR: dirs.public,
        FIRE_ENTRYPOINT_SEED_SCRIPT: seedScript,
        ...extraEnv
      }
    });
    try {
      // 数据目录不可写：必须给出中文提示并非零退出，而不是让日志只剩一行英文 EACCES。
      fs.chmodSync(dirs.data, 0o500);
      const blocked = run();
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /数据目录不可写/);
      assert.match(blocked.stderr, /chown -R 1000:1000/);
      assert.equal(blocked.stdout.includes('REACHED_CMD'), false);
      fs.chmodSync(dirs.data, 0o700);
      // 种子步骤失败（用占位目录挡住写入）：只告警，容器命令照常执行。
      fs.mkdirSync(path.join(dirs.data, 'duan-posts.json'), { recursive: true });
      fs.writeFileSync(path.join(dirs.cache, 'duan-posts.json'), JSON.stringify([{ id: '1', date: '2026-09-16T00:00:00Z', text: 'x', originalUrl: 'https://example.com' }]));
      const warned = run();
      assert.equal(warned.status, 0);
      assert.equal(warned.stdout.includes('REACHED_CMD'), true);
      assert.match(warned.stderr, /警告：公开缓存种子合并失败/);
      // 部署素材（插图 / 字体 / 图标 / 分享图）缺失：服务照常启动，但日志必须留一条中文线索，
      // 否则线上只会表现为「FIRE 页面的小丑鱼不见了」这种静默视觉缺失。
      assert.match(warned.stderr, /缺少部署素材： images fonts icons share/);
      for (const media of ['images', 'fonts', 'icons', 'share']) {
        const dir = path.join(dirs.public, media);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'placeholder'), 'x');
      }
      const stocked = run();
      assert.equal(stocked.status, 0);
      assert.equal(stocked.stderr.includes('缺少部署素材'), false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  await test('totp: generate, verify, replay, backup codes, login ticket', async () => {
    const totp = require(path.join(root, 'lib/totp.ts'));
    const totpAuth = require(path.join(root, 'lib/totpAuth.ts'));
    const secret = totp.generateTotpSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    const url = totp.totpOtpauthUrl('Fire', 'review_user', secret);
    assert(url.startsWith('otpauth://totp/Fire:review_user?'));
    assert(url.includes('algorithm=SHA1'));
    assert(url.includes('digits=6'));
    assert(url.includes('period=30'));
    const code = totp.totpCodeAt(secret);
    assert.match(code, /^\d{6}$/);
    const first = totp.verifyTotpCode(secret, code);
    assert.equal(first.ok, true);
    assert.equal(totp.verifyTotpCode(secret, code, first.step).ok, false, '同一时间步不能重放');
    assert.equal(totp.verifyTotpCode(secret, '000000').ok, false);
    const backups = totp.generateBackupCodes();
    assert.equal(backups.length, 8);
    const hashes = backups.map(totp.hashBackupCode);
    const used = totp.verifyBackupCode(backups[0], hashes);
    assert.equal(used.ok, true);
    assert.equal(used.remaining.length, 7);
    assert.equal(totp.verifyBackupCode(backups[0], used.remaining).ok, false, '备用码只能用一次');

    const totpUser = createUser('totp_review', 'Totp-test-1234');
    assert.equal(totpAuth.userTotpEnabled(totpUser.id), false);
    const setup = await totpAuth.beginTotpSetup(totpUser.id, totpUser.username, 'Fire');
    assert(setup.qrSvg.includes('<svg'));
    assert(!setup.otpauthUrl.includes('chart.googleapis'));
    const enableCode = totp.totpCodeAt(setup.secret);
    const enabled = totpAuth.enableTotp(totpUser.id, enableCode);
    assert.equal(enabled.ok, true);
    assert.equal(enabled.backupCodes.length, 8);
    assert.equal(totpAuth.userTotpEnabled(totpUser.id), true);
    const ticket = totpAuth.createLoginTicket(totpUser.id);
    const replay = totpAuth.completeLoginTicket(ticket, enableCode);
    assert.equal(replay.ok, false, '开启时用过的验证码不能再登录');
    const ticket2 = totpAuth.createLoginTicket(totpUser.id);
    const viaBackup = totpAuth.completeLoginTicket(ticket2, enabled.backupCodes[0]);
    assert.equal(viaBackup.ok, true);
    assert.equal(viaBackup.userId, totpUser.id);
    const ticket3 = totpAuth.createLoginTicket(totpUser.id);
    assert.equal(totpAuth.completeLoginTicket(ticket3, enabled.backupCodes[0]).ok, false, '同一备用码不能再用');
    totpAuth.clearTotp(totpUser.id);
    assert.equal(totpAuth.userTotpEnabled(totpUser.id), false);

    const loginForm = fs.readFileSync(path.join(root, 'components/LoginForm.tsx'), 'utf8');
    assert(loginForm.includes('/api/auth/login/totp'));
    assert(loginForm.includes('{!totpTicket && ('));
    const loginRoute = fs.readFileSync(path.join(root, 'app/api/auth/login/route.ts'), 'utf8');
    assert(loginRoute.includes('requires2fa'));
    assert(loginRoute.includes('createLoginTicket'));
    const spec = fs.readFileSync(path.join(root, 'docs/api-spec.md'), 'utf8');
    assert(spec.includes('40104'));
    assert(spec.includes('/api/v1/auth/login/totp'));
  });
  db.close();console.log(`${passed} regression suites passed (isolated database)`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{ fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode || 0); });
