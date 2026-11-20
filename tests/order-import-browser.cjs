const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require('@playwright/test');

(async () => {
  const root = path.resolve(__dirname, '..');
  const bundle = await esbuild.build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
        import Panel from '@/components/TradeOrdersPanel';
        createRoot(document.getElementById('root')).render(<Panel ownerId="fixture-owner" orders={[]}/>);`,
      resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, jsx: 'automatic', alias: { '@': root },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/panel.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(bundle.outputFiles[0].contents);
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/panel.js"></script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true, executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
    });
    const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
    const submissions = [], receipts = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let scenario = 'blocked', plan, requestHeaders;
    const preview = '/api/trading/history/import/preview';
    await page.route('**/api/**', async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname;
      if (pathname === '/api/fire/session') return route.fulfill({ json: { csrf: 'fixture-session' } });
      requestHeaders = req.headers();
      if (pathname === preview) {
        const blocked = scenario === 'blocked';
        plan = { dryRun: true, fileName: 'synthetic.xlsx', previewId: scenario + '-preview', totalFilled: 1,
          imported: 0, skipped: blocked ? 1 : 0, duplicated: 0, groups: [],
          rows: [{ rowIndex: 1, state: blocked ? 'blocked' : 'ready', market: 'US', code: 'TEST', quantity: '2', fees: '1', currency: 'USD', reason: '请核对费用' }] };
        return route.fulfill({ json: plan });
      }
      if (pathname.endsWith('/submissions')) {
        submissions.push(req.postDataJSON());
        if (scenario === 'expired') return route.fulfill({ status: 409, json: { detail: '预览已过期' } });
        return route.abort('connectionreset');
      }
      if (pathname.includes('/operations/')) {
        receipts.push(pathname.split('/').pop());
        return route.fulfill({ json: { ...plan, dryRun: false, imported: 1, groups: [{ recordId: 'r', market: 'US', code: 'TEST', action: 'imported', orderCount: 1 }] } });
      }
      return route.fulfill({ status: 404 });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByTitle('导入券商订单（xlsx）').click();
    const upload = () => page.locator('input[type=file]').setInputFiles({name:'synthetic.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic')});
    await upload();
    await page.getByText(/请核对费用/).waitFor();
    const replace = page.getByRole('button', { name: '选择其他文件' });
    assert(await replace.isEnabled(), 'a blocked preview can be replaced');
    assert(await page.getByRole('button', { name: '确认导入 0 笔' }).isDisabled());
    scenario = 'expired';
    await upload();
    await page.getByRole('button', { name: '确认导入 1 笔' }).click();
    await page.getByText('预览已过期', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '确认导入 1 笔' }).isDisabled());
    scenario = 'lost';
    await upload();
    await page.getByRole('button', { name: '确认导入 1 笔' }).click();
    await page.getByText('已导入', { exact: true }).waitFor();
    assert.equal(submissions.length, 2);
    assert.equal(submissions[1].previewId, 'lost-preview');
    assert.deepEqual(receipts, [submissions[1].requestId]);
    assert.equal(requestHeaders['x-alcor-expected-account'], 'fixture-owner');
    assert.equal(requestHeaders['x-csrf-token'], 'fixture-session');
    assert.deepEqual(errors, []);
    console.log('PASS order upload can replace blocked and expired previews and recovers a confirmed fill by the original receipt after a lost response');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
