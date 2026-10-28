// Optional real-browser layout probe. Modal is the published rc.3 component;
// Markdown leaves are deliberately oversized test fixtures, not a parser test.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  fixtures: { type: 'string' }, deps: { type: 'string' },
  'react-deps': { type: 'string' }, 'build-deps': { type: 'string' },
  'browser-deps': { type: 'string' }, executable: { type: 'string' }, output: { type: 'string' },
} });
assert.ok(values.fixtures && values.deps, 'Pass --fixtures <rc.3 fixtures> --deps <test package.json>');
const requireFrom = (file) => createRequire(path.resolve(file));
const deps = requireFrom(values.deps);
const reactDeps = values['react-deps'] ? requireFrom(values['react-deps']) : deps;
const buildDeps = values['build-deps'] ? requireFrom(values['build-deps']) : deps;
const browserDeps = values['browser-deps'] ? requireFrom(values['browser-deps']) : deps;
const { buildSync } = buildDeps('esbuild');
const { chromium } = browserDeps('playwright');
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const primitiveDir = path.resolve(values.fixtures, 'primitives-rc3/package');
assert.equal(JSON.parse(readFileSync(path.join(primitiveDir, 'package.json'), 'utf8')).version, '0.2.1-rc.3');
const primitiveSource = readFileSync(path.join(primitiveDir, 'lib/index.js'), 'utf8');
const modalCSS = readFileSync(path.join(primitiveDir, 'lib/Modal.module.css'), 'utf8');
const modalNames = Object.fromEntries([...modalCSS.matchAll(/\.([a-z][\w-]*)/gi)]
  .map((match) => [match[1], `official-modal-${match[1]}`]));
const css = modalCSS.replace(/\.([a-z][\w-]*)/gi, (match, name) => `.${modalNames[name]}`);
const regions = ['keyboard-composition', 'focus', 'useModalLayer', 'Modal'].map((file) => {
  const marker = `//#region lib/types/${file}.js`;
  const start = primitiveSource.indexOf(marker);
  assert.ok(start >= 0);
  return primitiveSource.slice(start + marker.length, primitiveSource.indexOf('//#endregion', start));
}).join('\n');
const entry = `
  import * as React from ${JSON.stringify(reactDeps.resolve('react'))};
  import { useRef, useLayoutEffect } from ${JSON.stringify(reactDeps.resolve('react'))};
  import { jsx, jsxs, Fragment } from ${JSON.stringify(reactDeps.resolve('react/jsx-runtime'))};
  import { createPortal } from ${JSON.stringify(reactDeps.resolve('react-dom'))};
  import { createRoot } from ${JSON.stringify(reactDeps.resolve('react-dom/client'))};
  const h = React.createElement;
  const css$18 = ${JSON.stringify(modalNames)};
  const clsx = (...names) => names.filter(Boolean).join(' ');
  ${regions}
  let mounts = 0;
  const MarkdownText = ({text}) => {
    React.useEffect(() => { mounts += 1; }, []);
    return h('div', null, h('p', null, text),
      h('pre', null, 'long_unbroken_command_' + 'x'.repeat(400)),
      h('table', {style:{width:'1400px'}}, h('tbody', null, h('tr',null,h('td',null,'wide table fixture')))),
      Array.from({length:35}, (_,i) => h('p',{key:i},'Paragraph ' + i + ': ' + text)));
  };
  let plugin;
  window.__ModuleLoader__ = {load(definition) {
    plugin = definition.factory(id => {
      if(id === 'react') return React;
      if(id === '@deepseek-ai/dsh-client-ui-primitives') return {Modal: window.__native ? undefined : Modal, MarkdownText};
      throw Error(id);
    });
  }};
  window.fetch = async () => ({ok:true,json:async () => ({})});
  ${source}
  function Demo() {
    const [open,setOpen] = React.useState(false);
    const [mounted,setMounted] = React.useState(true);
    React.useEffect(() => { window.__unmountComparison = () => setMounted(false); }, []);
    return h(React.Fragment,null,
      h('main',{id:'chat',style:{maxWidth:'840px',margin:'0 auto',padding:'24px',height:'1800px'}},
        h('p',null,'Main conversation'),
        h('div',{style:{height:'320px'}}),
        h('button',{id:'trigger',onClick:()=>setOpen(true)},'原文'),
        h('details',{id:'reasoning',open:true},h('summary',null,'Reasoning'),h('p',null,'Keep this open'))),
      mounted && open ? h(plugin.__testing.ComparisonDialog,{
        original:'原始汇报：先检查测试结果，通过以后再部署。',
        persona:'人格转述：鲸鲸会先检查测试结果，确认通过以后再部署哦。',
        onClose:()=>setOpen(false)
      }) : null);
  }
  createRoot(document.querySelector('#app')).render(h(Demo));
  window.__mountCount = () => mounts;
`;
const output = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(reactDeps.resolve('react')), loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
const errors = [];
try {
  for (const native of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<html><head><meta charset="utf-8"><style>
      :root { --dsw-alias-label-primary:#17293b; --dsw-alias-label-secondary:#506174;
        --dsw-alias-bg-layer-2:#f8fbff; --dsw-alias-border-l1:#c7d4e2;
        --dsw-alias-interactive-bg-hover:#e8eef5; --dsw-alias-bg-mask-1:#14243866;
        --dsw-radius-panel:12px; --dsw-elevation-prominent:0 12px 50px #17293b33; }
      * { box-sizing:border-box; } body { margin:0; font-family:serif; color:#17293b; background:#eaf0f8; }
      pre { white-space:pre; } p { line-height:1.7; } td { padding:16px; }
      ${css}
    </style></head><body><div id="app"></div></body></html>`);
    await page.evaluate((native) => { window.__native = native; }, native);
    await page.addScriptTag({ content: output });
    await page.locator('#trigger').waitFor();
    await page.evaluate(() => {
      window.__mainNode = document.querySelector('#chat');
      window.__mainWidth = window.__mainNode.getBoundingClientRect().width;
      window.__styleBefore = [document.documentElement, document.body].map(node => node.style.cssText);
      window.scrollTo(0, 250);
    });
    await page.locator('#trigger').click();
    await page.locator('.persona-shell-comparison').waitFor();
    const widths = [];
    for (const width of [1440, 900, 700, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction((narrow) => document.querySelector('.persona-shell-comparison-surface').dataset.narrow === String(narrow), width - 48 < 720);
      const dimensions = await page.evaluate(() => {
        const dialog = document.querySelector('.persona-shell-comparison');
        const rect = dialog.getBoundingClientRect();
        return { left:rect.left, right:rect.right, width:rect.width, height:rect.height,
          viewport:innerWidth, documentWidth:document.documentElement.scrollWidth,
          panes:[...dialog.querySelectorAll('.persona-shell-comparison-pane')].filter(p=>!p.hidden).length,
          localOverflow:[...dialog.querySelectorAll('.persona-shell-comparison-scroll')].some(p=>p.scrollWidth>p.clientWidth),
          mounts:window.__mountCount(), sameMain:window.__mainNode===document.querySelector('#chat') };
      });
      assert.ok(dimensions.left >= 0 && dimensions.right <= width + 1, `dialog fits ${width}px`);
      assert.ok(dimensions.width <= 1101 && dimensions.height <= 720);
      assert.ok(dimensions.documentWidth <= width + 1, 'oversized leaves cannot widen the document');
      assert.equal(dimensions.panes, width - 48 < 720 ? 1 : 2);
      assert.equal(dimensions.localOverflow, true, 'wide content scrolls only in its own pane');
      assert.equal(dimensions.mounts, 2, 'resizing never remounts the two previews');
      assert.equal(dimensions.sameMain, true);
      if (width === 1440) assert.equal(await page.evaluate(() => document.querySelector('#chat').getBoundingClientRect().width),
        await page.evaluate(() => window.__mainWidth), 'opening must not resize the background chat');
      widths.push({ viewport:width, dialog:Math.round(dimensions.width), panes:dimensions.panes });
      if (values.output && !native && [1440,375].includes(width)) {
        mkdirSync(path.resolve(values.output), { recursive:true });
        await page.screenshot({ path:path.resolve(values.output, `comparison-${width}.png`) });
      }
    }
    const original = page.locator('[data-comparison-side="original"]');
    await original.evaluate(node => { node.scrollTop=280; node.dispatchEvent(new Event('scroll',{bubbles:true})); });
    await page.getByRole('tab', { name:'人格版', exact:true }).click();
    await page.locator('[data-comparison-side="persona"]').evaluate(node => { node.scrollTop=160; node.dispatchEvent(new Event('scroll',{bubbles:true})); });
    await page.getByRole('tab', { name:'原文', exact:true }).click();
    assert.equal(await original.evaluate(node=>node.scrollTop),280);
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab', {name:'人格版',exact:true}).getAttribute('aria-selected'),'true');
    await page.keyboard.press('Escape');
    await page.locator('.persona-shell-comparison').waitFor({state:'detached'});
    assert.equal(await page.locator('#trigger').evaluate(node=>node===document.activeElement),true);
    assert.equal(await page.locator('#reasoning').evaluate(node=>node.open),true);
    assert.equal(await page.evaluate(() => [document.documentElement, document.body].every((node,i) => node.style.cssText === window.__styleBefore[i])),
      true, 'close restores the exact previous inline scroll styles');
    await page.setViewportSize({width:1440,height:960});
    await page.locator('#trigger').click();
    const scrollBefore = await page.evaluate(()=>scrollY);
    await page.locator('.persona-shell-comparison-header').hover();
    await page.mouse.wheel(0,500);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>scrollY),scrollBefore,'scrolling the modal header must not move the background');
    await page.getByRole('button',{name:'关闭原文对照',exact:true}).focus();
    await page.keyboard.press('PageDown');
    assert.equal(await page.evaluate(()=>scrollY),scrollBefore,'page keys must not scroll the background either');
    await page.getByRole('button',{name:'关闭原文对照',exact:true}).click();
    await page.locator('#trigger').click();
    await page.evaluate(()=>window.__unmountComparison());
    await page.locator('.persona-shell-comparison').waitFor({state:'detached'});
    assert.equal(await page.evaluate(() => [document.documentElement, document.body].every((node,i) => node.style.cssText === window.__styleBefore[i])),
      true, 'unmount also releases the page scroll lock');
    console.log(JSON.stringify({browser:'passed',native,widths}));
    await page.close();
  }
  assert.deepEqual(errors,[],'no browser runtime errors');
} finally {
  await browser.close();
}
