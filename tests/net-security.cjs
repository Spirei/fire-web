/* Local transport fixtures only: no application database or external network. */
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const source = path.resolve(__dirname, '../lib/net.ts');
const loaded = new Module(source, module);
loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, source);
const { proxyFetch, isPrivateHost } = loaded.exports;
const sockets = new Set();
const watch = server => server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const originalFetch = global.fetch;
const previous = { STOCKLOG_PROXY: process.env.STOCKLOG_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };

(async () => {
  const upstream = http.createServer((request, response) => {
    if (request.url === '/slow') return; // Aborted below; no fixture timer left behind.
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ via: request.headers.host, path: request.url }));
  });
  let transfers = 0;
  const proxy = http.createServer((request, response) => {
    const url = new URL(request.url);
    if (url.origin !== `http://fixture.alcor.invalid:${upstream.address().port}`) { response.writeHead(403).end(); return; }
    transfers += 1;
    const forwarded = http.request({ host: '127.0.0.1', port: upstream.address().port, path: url.pathname, method: request.method }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
    });
    forwarded.on('error', () => response.destroy());
    response.on('close', () => forwarded.destroy()); request.pipe(forwarded);
  });
  watch(upstream); watch(proxy);
  let tunnels = 0; let tunnelAgent;
  proxy.on('connect', (request, client, head) => {
    // Never use request.url to connect to an arbitrary host, including on test failure.
    if (request.url !== `fixture.alcor.invalid:${upstream.address().port}`) { client.destroy(); return; }
    tunnels += 1;
    const server = net.connect(upstream.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) server.write(head);
      client.pipe(server); server.pipe(client);
    });
    sockets.add(server); server.on('close', () => sockets.delete(server));
    server.on('error', () => client.destroy()); client.on('error', () => server.destroy());
    client.on('close', () => server.destroy());
  });
  try {
    await listen(upstream); await listen(proxy);
    process.env.STOCKLOG_PROXY = `http://127.0.0.1:${proxy.address().port}`;
    process.env.NO_PROXY = ''; process.env.no_proxy = '';
    let direct = 0;
    global.fetch = async (input, init) => {
      direct += 1;
      if (init?.signal?.aborted) throw new DOMException('Aborted fixture', 'AbortError');
      if (String(input).startsWith('http://127.0.0.1:')) return originalFetch(input, init);
      if (process.env.NO_PROXY) return new Response('no-proxy fixture');
      throw new Error('External direct transport disabled');
    };
    const target = `http://fixture.alcor.invalid:${upstream.address().port}`;
    const result = await proxyFetch(`${target}/patch-check`, { signal: AbortSignal.timeout(3000) });
    assert.equal((await result.json()).path, '/patch-check');
    assert.ok(transfers > 0); assert.equal(direct, 0);
    console.log('PASS installed undici fetch and application ProxyAgent share a working local forward transport');

    const undici = require('undici');
    tunnelAgent = new undici.ProxyAgent({ uri: process.env.STOCKLOG_PROXY, proxyTunnel: true });
    const tunneled = await undici.fetch(`${target}/tunnel`, { dispatcher: tunnelAgent, signal: AbortSignal.timeout(3000) });
    assert.equal((await tunneled.json()).path, '/tunnel'); assert.ok(tunnels > 0);
    console.log('PASS installed ProxyAgent also retains HTTP CONNECT transport');

    const before = transfers + tunnels;
    const local = await proxyFetch(`http://127.0.0.1:${upstream.address().port}/private`, { signal: AbortSignal.timeout(3000) });
    assert.equal((await local.json()).path, '/private'); assert.equal(transfers + tunnels, before);
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.28.41', '172.16.0.1', '169.254.0.1', '100.64.0.1', '[::1]', 'fd00::1']) assert.ok(isPrivateHost(host));
    console.log('PASS loopback transport remains direct and private destinations are not sent to the proxy');

    process.env.NO_PROXY = '.alcor.invalid';
    assert.equal(await (await proxyFetch(`${target}/bypass`)).text(), 'no-proxy fixture');
    assert.equal(transfers + tunnels, before); process.env.NO_PROXY = '';
    console.log('PASS explicit NO_PROXY destinations bypass the proxy');

    await assert.rejects(proxyFetch(`${target}/slow`, { signal: AbortSignal.timeout(30) }), error => error.name === 'AbortError');
    console.log('PASS cancellation terminates an in-flight proxy read without retrying external transport');
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    for (const socket of sockets) socket.destroy();
    if (tunnelAgent) await tunnelAgent.destroy();
    await Promise.all([close(upstream), close(proxy)]);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
