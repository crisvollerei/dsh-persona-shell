// Real React/Chromium over a local intercepted origin. No provider or user profile calls.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { makeReportSource } from '../../lib/report-visualization.js';

const { values } = parseArgs({ options: { deps: { type: 'string' }, 'browser-deps': { type: 'string' }, executable: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values.deps, 'Pass --deps <React/esbuild package.json>');
const deps = createRequire(path.resolve(values.deps)), browserDeps = createRequire(path.resolve(values['browser-deps'] ?? values.deps));
const { buildSync } = deps('esbuild'), { chromium } = browserDeps('playwright');
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const preferenceKey = 'dsh-persona-shell:report-reading-appearance:v1';
const paragraphs = [
  '# 本轮工作结果',
  '已完成本地阅读外观：原文保持完整，主题只调整呈现方式。',
  '## 实现与范围',
  '补充实现甲：阅读位置、展开状态和原始段落仍在本页保留。'.repeat(20),
  '### 局部细节',
  '补充实现乙：章节按原始顺序排列，配色切换只更新局部变量。'.repeat(20),
  '部署前必须人工确认权限，真实模型表现尚未验证；仅在核对后使用。',
  '完整配置位于 `cordis.patch.yml`，请查看[官方说明](https://example.invalid/docs)。',
  '```powershell\nnode --test test/report-reading.test.mjs\n```',
  '## 验证与后续',
  '本地检查全部通过，原始工作流保持原状。',
  '下一步由你确认真实使用表现，之后再决定是否发布。',
  '- 保留原始工作报告。\n- 外观只作用于阅读页面。',
];
const reportSource = makeReportSource({ sessionId: 'work', seq: 10, text: paragraphs.join('\n\n') });
const annotation = (id, index, quote, kind) => ({ id, blockId: 'b' + index, quote, kind, importance: 1, start: reportSource.text.indexOf(quote), end: reportSource.text.indexOf(quote) + quote.length });
const result = { schemaVersion: 2, annotations: [annotation('result', 2, '原文保持完整', 'conclusion'), annotation('risk', 7, '真实模型表现尚未验证', 'risk')], reading: [
  { blockId: 'b2', role: 'result', importance: 1 }, { blockId: 'b4', role: 'detail', importance: 3 }, { blockId: 'b6', role: 'detail', importance: 3 },
  { blockId: 'b7', role: 'risk', importance: 1 }, { blockId: 'b11', role: 'evidence', importance: 2 }, { blockId: 'b12', role: 'next', importance: 2 },
].map(value => ({ ...value, relatedRefs: [] })) };
function FixtureMarkdown({ text }) {
  React.useEffect(() => { window.markdownMounts++; return () => window.markdownUnmounts++; }, []);
  window.markdownRenders++;
  return h('div', { 'data-host-markdown': '' }, ...text.split('\n\n').map((block, index) => {
    if (block.startsWith('```')) return h('div', { key: index, className: 'host-code' }, h('button', { type: 'button' }, '复制代码'), h('pre', null, h('code', null, h('span', { 'data-syntax-token': '', style: { color: '#8767c7' } }, 'node'), block.split('\n')[1].slice(4))));
    const heading = /^(#{1,6}) /.exec(block);
    if (heading) return h('h' + heading[1].length, { key: index }, block.slice(heading[0].length));
    if (block.startsWith('- ')) return h('ul', { key: index }, ...block.split('\n').map((line, n) => h('li', { key: n }, line.slice(2))));
    const parts = []; let at = 0;
    for (const match of block.matchAll(/`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g)) { parts.push(block.slice(at, match.index), match[1] ? h('code', { key: match.index }, match[1]) : h('a', { key: match.index, href: match[3] }, match[2])); at = match.index + match[0].length; }
    parts.push(block.slice(at)); return h('p', { key: index }, ...parts);
  }));
}
const entry = `
import * as React from ${JSON.stringify(deps.resolve('react'))};import * as ReactDOM from ${JSON.stringify(deps.resolve('react-dom'))};import {createRoot} from ${JSON.stringify(deps.resolve('react-dom/client'))};
const h=React.createElement;let plugin;window.markdownMounts=0;window.markdownUnmounts=0;window.markdownRenders=0;
${FixtureMarkdown.toString()}
window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==='react')return React;if(id==='react-dom')return ReactDOM;if(id==='react-dom/client')return{createRoot};if(id==='@deepseek-ai/dsh-client-ui-primitives')return{MarkdownText:FixtureMarkdown};throw Error(id)})}};
${source}
window.themeHost={reads:0,posts:0,cache:true,source:${JSON.stringify(reportSource)},result:${JSON.stringify(result)}};
window.fetch=async(url,options)=>{const route=new URL(url,location.origin).pathname;if(!route.endsWith('/report-visualization'))throw Error('unexpected request '+route);if(options?.method){window.themeHost.posts++;throw Error('unexpected model call')};window.themeHost.reads++;return{ok:true,json:async()=>({available:true,source:window.themeHost.source,result:window.themeHost.cache?window.themeHost.result:undefined,cached:window.themeHost.cache})}};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copiedText=text}});
window.readingRuntime=plugin.__testing.reportReadingRuntime;document.getElementById('open').onclick=()=>window.readingRuntime.open('work',10);
`;
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const styles = `body{margin:0;font:14px/1.7 system-ui,sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}#app{max-width:660px;margin:100px auto;padding:24px}#app h1{font-size:24px;color:inherit}[data-host-markdown]{color:var(--dsw-alias-label-primary)}[data-host-markdown] li::marker{color:var(--dsw-alias-label-secondary)}[data-host-markdown] :not(pre)>code{background:var(--dsw-alias-markdown-inline-code);padding:2px 4px;border-radius:4px}[data-host-markdown] a{color:var(--dsw-alias-brand-primary)}.host-code{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block)}.host-code pre{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);white-space:pre-wrap;font:12px/1.8 ui-monospace,Consolas,monospace}.host-code button{float:right;width:60px;height:24px;min-height:0;padding:0;font:10px/1.5 system-ui;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}`;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) }), errors = [], external = [];
const contexts = [];
async function prepare(options = {}) {
  const { context: existingContext, ...settings } = options; options = settings;
  const context = existingContext ?? await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: options.osDark ? 'dark' : 'light' }); if (!existingContext) contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('https://reading.test/')) external.push(request.url()); });
  await page.route('https://reading.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><style>' + styles + '</style></head><body><main id="app"><h1>源工作汇报</h1><p>工作区正文与输入内容始终保持原样。</p><button id="open">打开阅读页</button></main></body></html>' }));
  await page.goto('https://reading.test/');
  await page.evaluate(({ options, key }) => {
    window.themeStorage = { reads: 0, writes: 0, blockRead: !!options.blockRead, blockWrite: !!options.blockWrite };
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    window.seedThemePreference = value => set.call(localStorage, key, value);
    if ('stored' in options) window.seedThemePreference(options.stored);
    Storage.prototype.getItem = function (name) { if (name === key) { window.themeStorage.reads++; if (window.themeStorage.blockRead) throw new DOMException('blocked', 'SecurityError'); } return get.call(this, name); };
    Storage.prototype.setItem = function (name, value) { if (name === key) { window.themeStorage.writes++; if (window.themeStorage.blockWrite) throw new DOMException('blocked', 'SecurityError'); } return set.call(this, name, value); };
    window.themeObservers = new Set();
    const NativeObserver = window.MutationObserver;
    window.MutationObserver = class extends NativeObserver { observe(target, settings) { if (target === document.documentElement || target === document.body) window.themeObservers.add(this); return super.observe(target, settings); } disconnect() { window.themeObservers.delete(this); return super.disconnect(); } };
    window.setHostAppearance = mode => {
      const dark = mode === 'dark'; document.documentElement.dataset.dsThemeSource = 'system'; document.documentElement.style.colorScheme = mode; document.body.toggleAttribute('data-ds-dark-theme', dark);
      const tokens = dark ? { 'label-primary': '#e2e7ef', 'label-secondary': '#a5b2c4', 'brand-primary': '#8aaff1', 'bg-layer-1': '#19212e', 'bg-layer-2': '#222d3e', 'border-l1': '#364459', 'label-primary-foreground': '#0f1115', 'markdown-code-block': '#1b1b1c', 'markdown-inline-code': '#2a2f37' } : { 'label-primary': '#243244', 'label-secondary': '#697587', 'brand-primary': '#416db5', 'bg-layer-1': '#fff', 'bg-layer-2': '#f5f7fa', 'border-l1': '#dce2e9', 'label-primary-foreground': '#fff', 'markdown-code-block': '#f9fafb', 'markdown-inline-code': '#f0f1f3' };
      for (const [name, value] of Object.entries(tokens)) document.body.style.setProperty('--dsw-alias-' + name, value);
    };
    window.setHostAppearance(options.hostDark ? 'dark' : 'light');
  }, { options, key: preferenceKey });
  await page.addScriptTag({ content: bundle }); return page;
}
const dialog = page => page.getByRole('dialog', { name: '报告阅读页', exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function open(page) { await button(page, '打开阅读页').click(); await dialog(page).locator('.rr-document h1').waitFor(); }
async function appearancePanel(page, opened = true) { const details = dialog(page).locator('.rr-appearance'); if ((await details.getAttribute('open') !== null) !== opened) await details.locator('summary').click(); }
async function assertQuiet(page) {
  assert.equal(await page.evaluate(() => [...(CSS.highlights?.keys() ?? [])].filter(name => name.startsWith('dsh-report-')).length), 0, 'theme never enables sentence highlights');
  assert.equal(await dialog(page).locator('.rr-legend,mark,[data-rr-locate]').count(), 0, 'an untouched document stays free of permanent emphasis and location cues');
  assert.equal(await dialog(page).locator('.rr-document p').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)')), true, 'paragraphs retain a plain background');
}
async function theme(page, id, mode) {
  await appearancePanel(page); const selected = dialog(page).getByLabel('阅读主题', { exact: true }); await selected.focus(); await selected.selectOption(id);
  if (mode && id !== 'system') { const appearance = dialog(page).getByLabel('阅读页外观', { exact: true }); await appearance.focus(); await appearance.selectOption(mode); }
  await page.waitForFunction(({ id, mode }) => { const el = document.querySelector('.dsh-report-reading'); return el?.dataset.readingTheme === id && (!mode || mode === 'auto' || el.dataset.readingAppearance === mode); }, { id, mode });
}
const originalSnapshot = page => page.evaluate(() => {
  const take = selector => { const el = document.querySelector(selector), css = getComputedStyle(el); return { color: css.color, background: css.backgroundColor, width: css.width, height: css.height, padding: css.padding, border: css.border }; };
  return { formal: take('#app'), formalTitle: take('#app h1'), inlineCode: take('.rr-document p>code'), code: take('.host-code'), codeText: take('.host-code pre'), token: take('[data-syntax-token]'), toolbar: take('.host-code button') };
});
const contrastChecks = page => page.evaluate(() => {
  const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number), luminance = value => rgb(value).map(n => { n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const surface = getComputedStyle(document.querySelector('.dsh-report-reading')).backgroundColor;
  return ['.rr-document h1', '.rr-document h2', '.rr-document h3', '.rr-document p', '.rr-document li', '.rr-document a', '.rr-theme-current', '.rr-guide button[data-kind=risk]'].map(selector => ({ selector, ratio: contrast(getComputedStyle(document.querySelector(selector)).color, surface) }));
});
const screenshot = async (page, name, width = 1200) => {
  await page.setViewportSize({ width, height: 900 });
  assert.equal(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth), true, 'no reader horizontal overflow');
  assert.equal(await dialog(page).evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 44 && r.bottom <= innerHeight; }), true, 'reader stays inside safe viewport');
  assert.equal(await dialog(page).locator('.rr-appearance-options').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight; }), true, 'theme controls remain inside the viewport');
  if (values.output) { mkdirSync(values.output, { recursive: true }); await dialog(page).screenshot({ path: path.join(values.output, name + '.png') }); }
};
try {
  const page = await prepare({ osDark: true });
  assert.equal(await page.evaluate(() => window.themeStorage.reads), 0, 'reader preferences are not read before opening');
  assert.equal(await page.evaluate(() => window.themeObservers.size), 0, 'no theme observer before opening');
  assert.equal(await page.evaluate(() => window.themeHost.reads), 0, 'no Host request before opening');
  await open(page); await appearancePanel(page);
  await assertQuiet(page); assert.equal(await dialog(page).locator('.rr-appearance summary').innerText(), '阅读外观');
  assert.equal(await dialog(page).getAttribute('data-reading-theme'), 'system');
  assert.equal(await dialog(page).getAttribute('data-reading-appearance'), 'light', 'native light body beats OS dark');
  assert.equal(await dialog(page).getByLabel('阅读页外观', { exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.themeStorage.reads), 1); assert.equal(await page.evaluate(() => window.themeObservers.size), 1);
  const nativeLight = await originalSnapshot(page), markdownDOM = await dialog(page).locator('.rr-document').innerHTML();
  await page.evaluate(() => { window.originalMarkdownNode = document.querySelector('[data-host-markdown]'); window.originalCodeNode = document.querySelector('.host-code'); });
  const matrix = [];
  for (const id of ['catppuccin', 'nord', 'rosepine']) for (const mode of ['light', 'dark']) {
    await theme(page, id, mode);
    assert.deepEqual(await originalSnapshot(page), nativeLight, 'reader theme does not alter formal report, code card, token or toolbar');
    assert.equal(await dialog(page).locator('.rr-document').innerHTML(), markdownDOM, 'theme does not change original Markdown DOM');
    assert.equal(await page.evaluate(() => window.originalMarkdownNode === document.querySelector('[data-host-markdown]') && window.originalCodeNode === document.querySelector('.host-code')), true);
    await assertQuiet(page);
    const contrast = await contrastChecks(page); for (const entry of contrast) assert.ok(entry.ratio >= 4.5, `${id}/${mode} ${entry.selector} has readable contrast ${entry.ratio}`);
    matrix.push({ id, mode, minContrast: Math.min(...contrast.map(entry => entry.ratio)) });
    await screenshot(page, 'theme-' + id + '-' + mode);
    await screenshot(page, 'theme-' + id + '-' + mode + '-mobile', 390); await page.setViewportSize({ width: 1200, height: 900 });
  }
  assert.equal(await page.evaluate(() => window.markdownMounts), 1); assert.equal(await page.evaluate(() => window.markdownRenders), 1, 'theme switching keeps the memoized renderer');
  assert.equal(await page.evaluate(() => window.themeHost.reads), 1); assert.equal(await page.evaluate(() => window.themeHost.posts), 0, 'switching themes never calls Host or model');
  await theme(page, 'catppuccin', 'auto');
  await page.evaluate(() => window.setHostAppearance('dark')); await page.waitForFunction(() => document.querySelector('.dsh-report-reading')?.dataset.readingAppearance === 'dark');
  assert.equal(await page.locator('body').getAttribute('data-ds-dark-theme'), '', 'native dark is a boolean attribute');
  const nativeDark = await originalSnapshot(page);
  await theme(page, 'catppuccin', 'light'); assert.deepEqual(await originalSnapshot(page), nativeDark, 'explicit light reader leaves native dark code and work UI alone');
  await theme(page, 'system'); assert.equal(await dialog(page).getAttribute('data-reading-appearance'), 'dark'); assert.equal(await dialog(page).getByLabel('阅读页外观', { exact: true }).inputValue(), 'auto');
  await theme(page, 'nord'); assert.equal(await dialog(page).getAttribute('data-reading-appearance'), 'light', 'returning to a fixed theme restores its previous explicit appearance');
  await theme(page, 'nord', 'auto'); await page.evaluate(() => window.setHostAppearance('light')); await page.waitForFunction(() => document.querySelector('.dsh-report-reading')?.dataset.readingAppearance === 'light');
  await page.emulateMedia({ colorScheme: 'dark' }); assert.equal(await dialog(page).getAttribute('data-reading-appearance'), 'light', 'official client appearance remains authoritative after an OS change');
  // Folding, guide cursor, scroll and select focus survive a local theme change.
  await appearancePanel(page, false); await button(page, '重点阅读').click(); await dialog(page).locator('.rr-fold-toggle').first().waitFor();
  await dialog(page).locator('.rr-fold-toggle').first().click(); await dialog(page).getByRole('button', { name: /^查看风险与条件，共 / }).click();
  await appearancePanel(page); await page.waitForFunction(() => !document.querySelector('.rr-document [data-rr-locate]')); const foldedDOM = await dialog(page).locator('.rr-document').innerHTML(), scroll = await dialog(page).locator('.rr-content').evaluate(el => el.scrollTop), guide = await dialog(page).locator('.rr-guide [aria-pressed=true]').getAttribute('data-kind');
  await theme(page, 'rosepine', 'dark');
  assert.equal(await dialog(page).locator('.rr-document').innerHTML(), foldedDOM); assert.equal(await dialog(page).locator('.rr-guide [aria-pressed=true]').getAttribute('data-kind'), guide);
  assert.ok(Math.abs(await dialog(page).locator('.rr-content').evaluate(el => el.scrollTop) - scroll) < 2, 'scroll stays in place');
  assert.equal(await dialog(page).getByLabel('阅读页外观', { exact: true }).evaluate(el => el === document.activeElement), true, 'selection retains focus');
  await button(page, '复制完整原文').click(); assert.equal(await page.evaluate(() => window.copiedText), reportSource.text, 'theme and folding never change copy');
  await screenshot(page, 'theme-rosepine-dark-mobile', 390); await screenshot(page, 'theme-rosepine-dark-narrow', 280);
  await theme(page, 'catppuccin', 'light'); await screenshot(page, 'theme-catppuccin-light-narrow', 280);
  await appearancePanel(page, false); await button(page, '最小化报告阅读页').click(); await button(page, '恢复报告阅读页').waitFor();
  assert.equal(await page.locator('.dsh-report-reading-dock').evaluate(el => getComputedStyle(el).color), await page.locator('.dsh-report-reading').evaluate(el => getComputedStyle(el).color), 'dock uses its own selected reader palette');
  await button(page, '恢复报告阅读页').click(); assert.equal(await button(page, '重点阅读').getAttribute('aria-pressed'), 'true');
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), preferenceKey); assert.equal(saved.theme, 'catppuccin'); assert.equal(saved.appearance, 'light');
  await page.evaluate(() => window.readingRuntime.close()); await dialog(page).waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.themeObservers.size), 0, 'closing disconnects the root/body observer');
  await open(page); assert.equal(await dialog(page).getAttribute('data-reading-theme'), 'catppuccin'); assert.equal(await dialog(page).getAttribute('data-reading-appearance'), 'light', 'choice survives close and reopen');
  await page.evaluate(({ key }) => window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify({ theme: 'nord', appearance: 'dark' }) })), { key: preferenceKey });
  await page.waitForFunction(() => document.querySelector('.dsh-report-reading')?.dataset.readingTheme === 'nord');
  assert.equal(await dialog(page).getAttribute('data-reading-appearance'), 'dark', 'another document can update the local appearance');
  await page.evaluate(() => { window.themeStorage.blockWrite = true; }); await theme(page, 'rosepine', 'light');
  await dialog(page).getByText('本页配色已应用，暂时无法保存在本机。', { exact: true }).waitFor(); assert.equal(await dialog(page).getAttribute('data-reading-theme'), 'rosepine', 'blocked storage never prevents current-page theme');
  await page.evaluate(() => window.readingRuntime.close()); await dialog(page).waitFor({ state: 'hidden' });
  const readsAfterClose = await page.evaluate(() => window.themeStorage.reads);
  await page.evaluate(({ key }) => { window.setHostAppearance('dark'); window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify({ theme: 'catppuccin', appearance: 'auto' }) })); }, { key: preferenceKey });
  assert.equal(await page.evaluate(() => window.themeObservers.size), 0); assert.equal(await page.evaluate(() => window.themeStorage.reads), readsAfterClose);
  const persisted = await prepare({ context: page.context(), hostDark: true }); await open(persisted); assert.equal(await dialog(persisted).getAttribute('data-reading-theme'), 'catppuccin'); assert.equal(await dialog(persisted).getAttribute('data-reading-appearance'), 'light', 'new document restores the real stored choice from the same origin');
  const invalid = await prepare({ stored: '{invalid', hostDark: true }); await open(invalid); assert.equal(await dialog(invalid).getAttribute('data-reading-theme'), 'system'); assert.equal(await dialog(invalid).getAttribute('data-reading-appearance'), 'dark');
  const invalidValues = await prepare({ stored: JSON.stringify({ theme: 'unknown', appearance: 'system' }) }); await open(invalidValues); assert.equal(await dialog(invalidValues).getAttribute('data-reading-theme'), 'system');
  const blocked = await prepare({ blockRead: true }); await open(blocked); assert.equal(await dialog(blocked).getAttribute('data-reading-theme'), 'system'); assert.equal(await dialog(blocked).getByText('本页配色已应用，暂时无法保存在本机。', { exact: true }).count(), 0, 'initial read failure is quiet');
  // A host without native markers still uses concrete theme/class and computed scheme evidence.
  await blocked.evaluate(() => { document.documentElement.removeAttribute('data-ds-theme-source'); document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'light'; });
  await blocked.waitForFunction(() => document.querySelector('.dsh-report-reading')?.dataset.readingAppearance === 'dark');
  await blocked.evaluate(() => { document.documentElement.removeAttribute('data-theme'); document.documentElement.classList.add('theme-light'); });
  await blocked.waitForFunction(() => document.querySelector('.dsh-report-reading')?.dataset.readingAppearance === 'light');
  // Filled controls keep their palette foreground/background pair, including dark palettes.
  await blocked.evaluate(() => { window.themeHost.cache = false; window.readingRuntime.close(); }); await open(blocked); await theme(blocked, 'catppuccin', 'dark');
  const primaryContrast = await blocked.locator('.rr-intro [data-primary]').evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor })); assert.notEqual(primaryContrast.color, 'rgb(255, 255, 255)');
  for (const context of contexts) for (const current of context.pages()) assert.equal(await current.evaluate(() => window.themeHost.posts), 0);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ result: 'passed', matrix, checks: ['lazy preference reads and observer', 'official boolean body appearance beats OS', 'three light/dark contrast palettes', 'native code/card/token/toolbar unchanged', 'work content styles unchanged', 'same original Markdown DOM and memoized renderer', 'fold/nav/scroll/focus retained', 'original copy', '390/280 px controls stay visible', 'dock inherits reader theme', 'close/reopen/new-document persistence', 'cross-document storage event', 'malformed and blocked storage fallback', 'quiet first read failure and gentle user save failure', 'observer cleanup', 'no extra Host/model calls'], screenshots: values.output }));
} finally { await browser.close(); }
