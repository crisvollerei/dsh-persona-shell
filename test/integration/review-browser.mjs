// Optional Chromium regression for the lightweight review popup, including a
// transformed chat scroller and a fixed composer like the Desktop shell.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  deps: { type: 'string' }, 'build-deps': { type: 'string' }, 'browser-deps': { type: 'string' },
  executable: { type: 'string' }, output: { type: 'string' },
} });
assert.ok(values.deps, 'Pass --deps <React dependency package.json>');
const deps = createRequire(path.resolve(values.deps));
const buildDeps = values['build-deps'] ? createRequire(path.resolve(values['build-deps'])) : deps;
const browserDeps = values['browser-deps'] ? createRequire(path.resolve(values['browser-deps'])) : deps;
const { buildSync } = buildDeps('esbuild');
const { chromium } = browserDeps('playwright');
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const entry = `
  import * as React from ${JSON.stringify(deps.resolve('react'))};
  import { createPortal } from ${JSON.stringify(deps.resolve('react-dom'))};
  import { createRoot } from ${JSON.stringify(deps.resolve('react-dom/client'))};
  const h = React.createElement;
  let plugin;
  const MarkdownText = ({ text }) => h('article', null, h('p', null, text),
    h('pre', null, 'long_command_' + 'x'.repeat(400)));
  window.__ModuleLoader__ = { load(definition) {
    plugin = definition.factory(id => {
      if (id === 'react') return React;
      if (id === 'react-dom') return { createPortal };
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText };
      throw Error(id);
    });
  } };
  window.fetch = async () => ({ ok: true, json: async () => ({}) });
  ${source}
  function Demo() {
    const [mounted, setMounted] = React.useState(true);
    React.useEffect(() => { window.__unmountHint = () => setMounted(false); }, []);
    return h(React.Fragment, null,
      h('header', null, 'Persona review preview'),
      h('main', { id: 'chat' },
        h('div', { style: { height: '1200px' } }),
        h('section', { id: 'report' }, h('p', null, 'Personified report stays in the official message.'),
          h('details', { id: 'reasoning', open: true }, h('summary', null, 'Reasoning'), 'Keep disclosure state')),
        h('div', { id: 'hint-holder' }, mounted ? h(plugin.__testing.ReviewHint, {
          original: Array.from({ length: 40 }, (_, i) => '原始汇报第 ' + i + ' 项：检查测试结果，通过后再部署。').join('\\n'),
          review: { editScore: 0.7, reasons: ['condition-change'] }
        }) : null),
        h('div', { style: { height: '1000px' } })),
      h('footer', { id: 'composer' }, h('button', { id: 'outside' }, 'Message composer')));
  }
  createRoot(document.querySelector('#app')).render(h(Demo));
`;
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')), loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<html><head><meta charset="utf-8"><style>
    :root { --dsw-alias-label-primary: #17293b; --dsw-alias-label-secondary: #506174;
      --dsw-alias-label-tertiary: #657185; --dsw-alias-brand-primary: #2462bd;
      --dsw-alias-bg-layer-2: #ffffff; --dsw-alias-border-l1: #c7d4e2; }
    :root[data-theme="dark"] { --dsw-alias-label-primary: #edf2f7; --dsw-alias-label-secondary: #b8c6d6;
      --dsw-alias-label-tertiary: #a7b6ca; --dsw-alias-brand-primary: #8ebaff;
      --dsw-alias-bg-layer-2: #202b39; --dsw-alias-border-l1: #536479; }
    * { box-sizing: border-box; } body { margin: 0; color: var(--dsw-alias-label-primary);
      background: var(--dsw-alias-bg-layer-2); font-family: serif; }
    header { height: 56px; padding: 16px 24px; }
    #chat { position: fixed; inset: 56px 24px 140px; padding: 20px;
      overflow: auto; transform: translateZ(0); border: 1px solid var(--dsw-alias-border-l1); }
    #composer { position: fixed; inset: auto 0 0; height: 140px; padding: 24px;
      z-index: 20; background: var(--dsw-alias-bg-layer-2); border-top: 1px solid var(--dsw-alias-border-l1); }
    #hint-holder { display: flex; flex-direction: column; align-items: stretch; }
    #hint-holder > div { margin-left: auto; } article { white-space: pre-wrap; }
    pre { white-space: pre; } p { line-height: 1.7; }
  </style></head><body><div id="app"></div></body></html>`);
  await page.addScriptTag({ content: bundle });
  const mark = page.getByRole('button', { name: '改写变化提示，查看原文', exact: true });
  const panel = page.locator('[data-persona-shell="review-panel"]');
  await mark.waitFor();
  await page.evaluate(() => { window.__originalReport = document.querySelector('#report'); });
  const positionMark = async (side) => {
    await page.mouse.move(0, 0);
    await page.evaluate((side) => {
      const chat = document.querySelector('#chat');
      const trigger = document.querySelector('[data-persona-shell="review-hint"] button');
      const r = chat.getBoundingClientRect();
      const anchor = trigger.getBoundingClientRect();
      chat.scrollTop += side === 'bottom' ? anchor.bottom - (r.bottom - 30) : anchor.top - (r.top + 30);
    }, side);
  };
  const results = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 700, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await positionMark('bottom');
      await mark.hover();
      await panel.waitFor({ state: 'visible' });
      const dimensions = await panel.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const anchor = document.querySelector('[data-persona-shell="review-hint"]').getBoundingClientRect();
        const chat = document.querySelector('#chat').getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width,
          anchorTop: anchor.top, anchorWidth: anchor.width, chatTop: chat.top,
          parentIsBody: node.parentElement === document.body,
          hitTest: node.contains(document.elementFromPoint(rect.left + 20, rect.top + 20)),
          overflow: document.documentElement.scrollWidth > innerWidth,
          background: getComputedStyle(node).backgroundColor,
          sameReport: document.querySelector('#report') === window.__originalReport,
          reasoningOpen: document.querySelector('#reasoning').open };
      });
      assert.equal(dimensions.parentIsBody, true, 'popup is outside the transformed/clipping chat ancestor');
      assert.ok(dimensions.bottom <= dimensions.anchorTop, 'bottom mark opens upward, clear of the composer');
      assert.ok(dimensions.top >= dimensions.chatTop && dimensions.left >= 12 && dimensions.right <= width - 12 + 1);
      assert.ok(dimensions.anchorWidth <= 32, 'blank row space must not be a hover target');
      assert.equal(dimensions.hitTest, true, 'panel is actually hit-testable, not clipped/covered');
      assert.equal(dimensions.overflow, false);
      assert.equal(dimensions.sameReport, true);
      assert.equal(dimensions.reasoningOpen, true);
      assert.equal(dimensions.background, theme === 'dark' ? 'rgb(32, 43, 57)' : 'rgb(255, 255, 255)');
      await panel.hover();
      await page.waitForTimeout(220);
      assert.equal(await panel.isVisible(), true, 'pointer can cross the gap and rest on the portal');
      await mark.click();
      assert.equal(await panel.getAttribute('role'), 'dialog');
      await panel.locator('article').waitFor();
      const scrollBefore = await page.locator('#chat').evaluate((node) => node.scrollTop);
      await panel.click({ position: { x: 16, y: 80 } });
      assert.equal(await panel.isVisible(), true, 'inside clicks do not count as outside portal clicks');
      await panel.hover();
      await page.mouse.wheel(0, 160);
      await page.waitForTimeout(80);
      assert.equal(await page.locator('#chat').evaluate((node) => node.scrollTop), scrollBefore);
      if (values.output && width === 700) {
        mkdirSync(path.resolve(values.output), { recursive: true });
        await page.screenshot({ path: path.resolve(values.output, `review-${theme}.png`) });
      }
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      assert.equal(await mark.evaluate((node) => node === document.activeElement), true);
      await page.locator('#outside').click();
      await positionMark('top');
      await mark.click();
      await panel.waitFor({ state: 'visible' });
      assert.equal(await panel.evaluate((node) => node.getBoundingClientRect().top
        >= document.querySelector('[data-persona-shell="review-hint"]').getBoundingClientRect().bottom), true,
      'top mark opens downward');
      await page.locator('#outside').click();
      await panel.waitFor({ state: 'detached' });
      results.push({ theme, width, preview: Math.round(dimensions.width) });
    }
  }
  await positionMark('bottom');
  await mark.click();
  await panel.waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 375, height: 640 });
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-persona-shell="review-panel"]')?.getBoundingClientRect();
    return !rect || (rect.left >= 12 && rect.right <= innerWidth - 11 && rect.bottom <= innerHeight);
  });
  await positionMark('bottom');
  if (!(await panel.isVisible())) await mark.click();
  await panel.waitFor({ state: 'visible' });
  await page.locator('#chat').evaluate((node) => { node.scrollTop = 0; });
  await panel.waitFor({ state: 'detached' });
  await positionMark('bottom');
  await mark.click();
  await page.evaluate(() => window.__unmountHint());
  await panel.waitFor({ state: 'detached' });
  assert.deepEqual(errors, [], 'no browser runtime/ResizeObserver errors');
  console.log(JSON.stringify({ browser: 'passed', results, checks: ['up/down placement', 'body portal',
    'transformed scroll clipping', 'fixed composer', 'pointer crossing/selecting', 'local scroll',
    'Escape/outside/focus', 'resize/offscreen/unmount', 'light/dark theme', 'unchanged main DOM'] }));
} finally {
  await browser.close();
}
