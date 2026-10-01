// Scope and source-palette contract; real cascade/layout is also reviewed in the browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const postcss = require('postcss');
const css = postcss.parse(fs.readFileSync('styles/feed.css', 'utf8'));
const view = fs.readFileSync('components/views/FeedView.tsx', 'utf8');
const base = css.nodes.find(n => n.type === 'rule' && n.selector.startsWith('.feed-theme,'));
const dark = css.nodes.find(n => n.type === 'rule' && n.selector.startsWith('.dark .feed-theme,'));
const values = rule => Object.fromEntries(rule.nodes.filter(n => n.type === 'decl').map(n => [n.prop, n.value]));
const lightValues = values(base), darkValues = values(dark);
for (const [name, light, night] of [
  ['page', '#fcfcfc', '#181819'], ['panel', '#fcfcfc', '#28292b'], ['field', '#f3f4f5', '#181819'],
  ['ink', '#111112', '#fff'], ['secondary', '#00040996', '#f2f7ff87'], ['tertiary', '#0007115e', '#f1f6ff61'],
  ['link', '#0064d4', '#1793ff'], ['fill', '#0000000d', '#ffffff1f'], ['divider', '#0000001a', '#ffffff1f'],
  ['overlay', '#0000001a', '#00000066'], ['close', '#ffffffc2', '#383838cc'], ['reaction', '#ff2b4e', '#ff7d89'],
]) {
  assert.equal(lightValues['--feed-' + name], light, name + ' light');
  assert.equal(darkValues['--feed-' + name], night, name + ' dark');
}
assert.equal(lightValues['--feed-action'], 'color-mix(in srgb,#0064d4 90%,#000)');
assert.equal(darkValues['--feed-action'], '#1793ff');
assert.equal(darkValues['--feed-action-ink'], '#000');
console.log('PASS measured Muse light/dark palette and exact primary-action mix');
css.walkRules(rule => {
  assert.match(rule.selector, /\.feed-|\.alcor-feed/, 'unscoped rule: ' + rule.selector);
  if (rule.selector.includes('.app-shell-main')) assert.match(rule.selector, /\.tab-panel:not\(\[hidden\]\) \.alcor-feed/, 'cached feed scope');
  rule.walkDecls(d => assert(!/^--(?:site|cap|dock)-/.test(d.prop), 'global preference override'));
});
assert.equal((view.match(/className="feed-theme feed-themed-modal feed-/g) || []).length, 4);
assert(view.includes('className="alcor-feed feed-theme"'));
assert(css.nodes.some(n => n.type === 'rule' && n.selector.includes(':has(>.feed-themed-modal)>.modal-scrim')));
console.log('PASS feed-only scope, visible-panel guard and all four body-portal dialogs');
const heading = css.nodes.find(n => n.type === 'rule' && n.selector === 'body .alcor-feed .feed-post .feed-post-content h2');
assert.equal(values(heading)['font-size'], '18px');
assert.equal(values(heading)['font-weight'], '500');
assert(css.nodes.some(n => n.type === 'rule' && n.selector === '.feed-theme .feed-instructions' && n.nodes.some(d => d.prop === 'background' && d.important)));
console.log('PASS generic workspace headings and global dark inputs cannot override feed styling');
const Module = require('node:module');
const ts = require('typescript');
const filename = require('node:path').resolve('lib/palettes.ts');
const paletteModule = new Module(filename, module);
paletteModule.filename = filename;
paletteModule._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename);
const { SITE_PALETTES, PALETTE_KEY, paletteVariables, resolvePalette } = paletteModule.exports;
assert.equal(PALETTE_KEY, 'fire:site-palette');
assert.equal(resolvePalette(undefined).id, 'neutral');
assert.equal(resolvePalette('invalid').id, 'neutral');
assert.deepEqual(SITE_PALETTES.map(p => p.id).filter(id => id !== 'muse'), ['neutral','meta','liquid','ocean','forest','amber','dusk']);
const muse = resolvePalette('muse');
assert.equal(muse.name, 'Muse'); assert.equal(muse.glass, false);
assert.equal(paletteVariables('muse')['--site-bg-light'], '252 252 252');
assert.equal(paletteVariables('muse')['--site-bg-dark'], '24 24 25');
assert.equal(paletteVariables('muse')['--site-accent-light'], '0 100 212');
assert.equal(paletteVariables('muse')['--site-accent-dark'], '23 147 255');
const provider = fs.readFileSync('components/PaletteProvider.tsx', 'utf8');
assert(provider.includes('usePersistedState<PaletteId>(PALETTE_KEY, "neutral")'));
assert(provider.includes('setStored(id)'));
const layout = fs.readFileSync('app/layout.tsx', 'utf8');
assert(layout.includes('resolvePalette(prefs[PALETTE_KEY])') && layout.includes('paletteVariables(palette.id)'));
console.log('PASS Muse is opt-in, keeps all existing IDs/defaults and uses cookie-backed SSR preferences');
const skin = postcss.parse(fs.readFileSync('styles/muse.css', 'utf8'));
skin.walkRules(rule => {
  if(rule.selector === '.muse-color-note') return;
  assert(rule.selector.startsWith('html:root'), rule.selector);
  assert(rule.selector.includes('[data-palette="muse"]'), rule.selector);
  assert(rule.selector.includes('body:has([data-capsule-scope="non-home"])'), rule.selector);
  rule.walkDecls(d => {
    assert(!/^--(?:dock|pnl|gain|loss|site-font|site-entry)/.test(d.prop), 'semantic/preference override: '+d.prop);
    assert(!['width','height','display','grid-template-columns','order','position','font-family'].includes(d.prop), 'layout override: '+d.prop);
  });
});
for(const mode of ['light','dark']) {
  const rule = skin.nodes.find(n => n.type === 'rule' && n.selector === `html:root${mode==='dark'?'.dark':''}[data-palette="muse"] body:has([data-capsule-scope="non-home"])`);
  const vars = values(rule);
  assert.equal(vars['--muse-bg'], mode==='dark'?'#181819':'#fcfcfc');
  assert.equal(vars['--site-action-text'], mode==='dark'?'#000':'#fff');
}
assert(fs.readFileSync('components/PaletteSettings.tsx', 'utf8').includes('palette === "muse"'));
console.log('PASS backend skin cannot change other palettes, homepage, Dock, financial colors or layouts');
const globals = postcss.parse(fs.readFileSync('app/globals.css', 'utf8'));
let hiddenPanel;
globals.walkRules('.records-app:not(.is-settings) .records-content > .tab-panel[hidden]', rule => { hiddenPanel = rule; });
assert.equal(values(hiddenPanel)['content-visibility'], 'hidden');
for(const property of ['height','min-height','max-height']) assert(hiddenPanel.nodes.some(d=>d.prop===property&&d.value==='0'&&d.important));
console.log('PASS a cached settings panel cannot occupy space above the newly active page');
