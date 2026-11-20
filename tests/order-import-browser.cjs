const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const postcss = require('postcss');
const tailwind = require('tailwindcss');
const loadConfig = require('tailwindcss/loadConfig');
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
  const config = loadConfig(path.join(root, 'tailwind.config.ts'));
  const cssPath = path.join(root, 'app/globals.css');
  const css = await postcss([tailwind({ ...config, content: [
    'components/TradeOrdersPanel.tsx', 'components/AppModal.tsx', 'components/Capsule.tsx',
  ].map(file => path.join(root, file)) })]).process(fs.readFileSync(cssPath, 'utf8'), { from: cssPath });
  const styles = await esbuild.build({
    stdin: { contents: css.css, resolveDir: path.dirname(cssPath), loader: 'css' },
    bundle: true, write: false, external: ['*.woff2', '*.woff', '*.svg', '*.png', '*.webp', '*.jpg'],
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/panel.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(bundle.outputFiles[0].contents);
    } else if (req.url === '/panel.css') {
      res.setHeader('content-type', 'text/css');
      res.end(styles.outputFiles[0].contents);
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html data-palette="default"><link rel="stylesheet" href="/panel.css"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/panel.js"></script>');
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
    let scenario = 'blocked', plan, requestHeaders, releaseSubmit, releaseReceipt;
    const submitGate = new Promise(resolve => { releaseSubmit = resolve; });
    const receiptGate = new Promise(resolve => { releaseReceipt = resolve; });
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
        if (blocked) plan.rows = Array.from({length:25}, (_,i) => ({...plan.rows[0],rowIndex:i+1}));
        return route.fulfill({ json: plan });
      }
      if (pathname.endsWith('/submissions')) {
        submissions.push(req.postDataJSON());
        if (scenario === 'expired') return route.fulfill({ status: 409, json: { detail: '预览已过期' } });
        await submitGate;
        return route.abort('connectionreset');
      }
      if (pathname.includes('/operations/')) {
        receipts.push(pathname.split('/').pop());
        await receiptGate;
        return route.fulfill({ json: { ...plan, dryRun: false, imported: 1, groups: [{ recordId: 'r', market: 'US', code: 'TEST', action: 'imported', orderCount: 1 }] } });
      }
      return route.fulfill({ status: 404 });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    for (const [title, trigger] of [['导出订单', '导出订单（xlsx）'], ['导入订单', '导入券商订单（xlsx）']]) {
      await page.getByTitle(trigger).focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      await dialog.waitFor({timeout:2500});
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'opening a dialog moves focus inside');
      await page.keyboard.press('Shift+Tab');
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'reverse Tab stays in the dialog');
      await page.keyboard.press('Tab');
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'forward Tab stays in the dialog');
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
      assert(await page.getByTitle(trigger).evaluate(el => document.activeElement === el), 'Escape returns to the original action');
    }
    await page.getByTitle('导入券商订单（xlsx）').click();
    const upload = () => page.locator('input[type=file]').setInputFiles({name:'synthetic.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic')});
    await upload();
    await page.getByText(/请核对费用/).first().waitFor();
    const replace = page.getByRole('button', { name: '选择其他文件' });
    assert(await replace.isEnabled(), 'a blocked preview can be replaced');
    for (const viewport of [{width:320,height:480}, {width:640,height:320}]) {
      await page.setViewportSize(viewport);
      const geometry = await replace.evaluate(el => {
        const dialog = el.closest('[role="dialog"]');
        const box = dialog.querySelector('.app-modal-footer').getBoundingClientRect();
        const bounds = [...dialog.querySelectorAll('.app-modal-footer button')].map(button => button.getBoundingClientRect());
        return {inView: [box, ...bounds].every(r=>r.top>=0 && r.left>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1),
          scrollable: [...dialog.querySelectorAll('.app-modal-body,ul')].some(part=>part.scrollHeight>part.clientHeight+1)};
      });
      assert(geometry.inView && geometry.scrollable, 'a long preview scrolls while all footer actions stay in the viewport');
    }
    assert(await page.getByRole('button', { name: '确认导入 0 笔' }).isDisabled());
    scenario = 'expired';
    await upload();
    await page.getByRole('button', { name: '确认导入 1 笔' }).click();
    await page.getByText('预览已过期', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '确认导入 1 笔' }).isDisabled());
    scenario = 'lost';
    await upload();
    await page.getByRole('button', { name: '确认导入 1 笔' }).click();
    await page.getByRole('status').filter({hasText:'正在导入订单'}).waitFor();
    releaseSubmit();
    await page.getByRole('status').filter({hasText:'正在核对导入回执'}).waitFor();
    await page.keyboard.press('Escape');
    const dialog = page.getByRole('dialog', { name:'导入订单' });
    assert(await dialog.isVisible(), 'an in-flight confirmation stays open');
    assert(await dialog.getByRole('button', {name:'关闭',exact:true}).last().isDisabled());
    releaseReceipt();
    await page.getByText('已导入', { exact: true }).waitFor();
    assert.equal(submissions.length, 2);
    assert.equal(submissions[1].previewId, 'lost-preview');
    assert.deepEqual(receipts, [submissions[1].requestId]);
    assert.equal(requestHeaders['x-alcor-expected-account'], 'fixture-owner');
    assert.equal(requestHeaders['x-csrf-token'], 'fixture-session');
    assert.deepEqual(errors, []);
    console.log('PASS order dialogs retain keyboard focus and visible mobile actions; expired previews can be replaced and lost submit responses recover by receipt');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
