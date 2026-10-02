// Browser request/state helpers; no running site, account or external provider is used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { feedRequest, FeedRequestError, feedEmptyCopy } = require('../lib/feedClient.ts');
const { restrainedFeedSegments, feedBodyParts } = require('../lib/feedPresentation.ts');
const originalFetch = global.fetch;
let count = 0;
async function test(name, run) { await run(); console.log('PASS ' + name); count++; }
const snapshot = (patch = {}) => ({ posts: [], nextCursor: null, job: null, preferences: { instructions: 'technology', revision: 1, enabled: true, intervalMinutes: 360 }, capabilities: { generate: true, search: 'news-rss', avatar: { image: '', video: null } }, ...patch });
(async () => {
  await test('evidence does not make the whole sentence a link; short highlights are bounded and text is unchanged', () => {
    const sources = [{ id: 's1', url: 'https://news.example/a' }];
    const segments = [{ text: '公司公布了最新季度财报，其中营收同比增长10%，同时提醒下一季度成本压力仍然存在。', sourceId: 's1', linkText: '营收同比增长10%' }];
    const parts = feedBodyParts(segments, sources);
    assert.equal(parts.map(p => p.text).join(''), segments[0].text);
    assert.deepEqual(parts.filter(p => p.sourceId).map(p => p.text), ['营收同比增长10%']);
    const bad = [{ text: '全段链接不能接受。', sourceId: 's1', linkText: '全段链接不能接受。' }, { text: '仍要保留正文与事实引用。', sourceId: 's1', linkText: '编造的子串' }];
    assert(restrainedFeedSegments(bad).every(p => !p.linkText));
    assert(restrainedFeedSegments(bad).every(p => p.sourceId === 's1'));
    assert(feedBodyParts(segments, []).every(p => !p.sourceId));
    const repeated = Array.from({ length: 4 }, () => ({ text: '财报显示关键变化，相关背景仍有不确定性，需要仔细区分预测与实际结果。', sourceId: 's1', linkText: '关键变化' }));
    assert.equal(feedBodyParts(repeated, sources).filter(p => p.sourceId).length, 2);
    const old = [{ text: '路透社报道，某公司公布新变化，同时披露了交易的规模与后续限制。', sourceId: 's1' }];
    assert.deepEqual(feedBodyParts(old, sources).filter(p => p.sourceId).map(p => p.text), ['路透社报道']);
    assert.equal(old[0].linkText, undefined, 'never rewrite old stored content');
    assert(feedBodyParts([{text:'已核实的摘要',sourceId:'s1'}],sources).every(p=>!p.sourceId));
  });
  await test('same-origin feed request uses no-store and never replays a write', async () => {
    let calls = 0;
    global.fetch = async (url, init) => { calls++; assert.equal(url, '/api/v1/feed/preferences'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store'); assert.equal(init.method, 'PUT'); assert.deepEqual(JSON.parse(init.body), { revision: 1 }); return Response.json({ code: 0, data: { revision: 2 } }); };
    assert.deepEqual(await feedRequest('/preferences', 'PUT', { revision: 1 }), { revision: 2 }); assert.equal(calls, 1);
  });
  await test('avatar upload uses multipart boundary and remains a single bounded write',async()=>{
    let calls=0;const form=new FormData();form.set('revision','2');form.set('file',new File(['test'],'image.png'));
    global.fetch=async(url,init)=>{calls++;assert.equal(url,'/api/v1/feed/profile/avatar');assert.equal(init.headers,undefined);assert.equal(init.body,form);return Response.json({code:0,data:{revision:3}});};
    assert.deepEqual(await feedRequest('/profile/avatar','POST',form),{revision:3});assert.equal(calls,1);
  });
  await test('conflicts remain distinguishable without discarding caller-owned drafts', async () => {
    global.fetch = async () => Response.json({ code: 40901, message: '指示已在另一端修改' }, { status: 409 });
    await assert.rejects(() => feedRequest('/preferences', 'PUT', {}), e => e instanceof FeedRequestError && e.status === 409 && e.message.includes('另一端'));
  });
  await test('HTML/invalid success payload is a safe recoverable error, not an internal diagnostic', async () => {
    global.fetch = async () => new Response('<html>private proxy error</html>', { status: 502 });
    await assert.rejects(() => feedRequest(), e => e instanceof FeedRequestError && e.status === 502 && !e.message.includes('private'));
    global.fetch = async () => Response.json({ message: 'invalid' });
    await assert.rejects(() => feedRequest(), FeedRequestError);
  });
  await test('bounded timeout aborts a request and says write result is unknown', async () => {
    let calls = 0, aborted = false;
    global.fetch = async (_url, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true })); };
    await assert.rejects(() => feedRequest('/posts/fp-example', 'PUT', { liked: true }, undefined, 5), e => e instanceof FeedRequestError && e.status === 0 && e.unconfirmed && e.message.includes('尚未确认'));
    assert(aborted); assert.equal(calls, 1);
  });
  await test('broken or proxy write responses require a read before retrying, not blind replay', async () => {
    global.fetch = async () => new Response('broken', { status: 200 });
    await assert.rejects(() => feedRequest('/preferences', 'PUT', {}), e => e instanceof FeedRequestError && e.unconfirmed);
    global.fetch = async () => Response.json({ code: 50201, message: 'Proxy failure' }, { status: 502 });
    await assert.rejects(() => feedRequest('/discussion', 'POST', {}), e => e instanceof FeedRequestError && e.unconfirmed);
    global.fetch = async () => Response.json({ code: 40301, message: 'Rejected' }, { status: 403 });
    await assert.rejects(() => feedRequest('/discussion', 'POST', {}), e => e instanceof FeedRequestError && !e.unconfirmed);
  });
  await test('caller cancellation remains cancellation and listeners do not leak', async () => {
    const controller = new AbortController();
    global.fetch = async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    const result = feedRequest('', 'GET', undefined, controller.signal);
    controller.abort(); await assert.rejects(() => result, e => e.name === 'AbortError');
    global.fetch = async () => Response.json({ code: 0, data: true });
    assert.equal(await feedRequest(), true);
  });
  await test('empty state distinguishes setup, running, no model, error and finished zero', () => {
    assert.equal(feedEmptyCopy(snapshot({ preferences: { instructions: '' } })).title, '你的动态，由你来定义');
    assert.equal(feedEmptyCopy(snapshot({ capabilities: { generate: false } })).title, '准备好你的第一条动态');
    for (const status of ['queued', 'searching', 'writing']) assert.match(feedEmptyCopy(snapshot({ job: { status } })).title, /正在/);
    assert.match(feedEmptyCopy(snapshot({ job: { status: 'error' } })).title, /没有完成/);
    assert(!feedEmptyCopy(snapshot({ job: { status: 'done', added: 0 } })).title.includes('正在'));
    assert.match(feedEmptyCopy(snapshot({ job: { status: 'done', added: 0 } })).body, /没有可显示/);
    assert.match(feedEmptyCopy(snapshot({ job: { status: 'done' }, preferences: { instructions: 'topic', enabled: false } })).body, /手动更新/);
    assert.match(feedEmptyCopy(snapshot()).body, /指示已保存/);
  });
  console.log(`PASS ${count} feed client groups`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; });
