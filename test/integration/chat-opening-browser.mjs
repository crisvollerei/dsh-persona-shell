// Optional real-React/Chromium opening-motion regression. No real provider or user profile.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fixture, newRoom } from '../helpers/persona-chat-host.mjs';
import { makeReportSource } from '../../lib/report-visualization.js';

const { values } = parseArgs({ options: {
  deps: { type: 'string' }, 'browser-deps': { type: 'string' }, executable: { type: 'string' },
  output: { type: 'string' }, diagnose: { type: 'boolean' },
} });
assert.ok(values.deps, 'Pass --deps <React/esbuild dependency package.json>');
const deps = createRequire(path.resolve(values.deps));
const browserDeps = createRequire(path.resolve(values['browser-deps'] ?? values.deps));
const { buildSync } = deps('esbuild'), { chromium } = browserDeps('playwright');
const stops = [];
const host = fixture({ after: stop => stops.push(stop) });
await host.ready();
const binding = await newRoom(host, ['大肥鱼（默认）'], '开窗回归', 'opening-room');
const original = makeReportSource({ sessionId: 'work', seq: 10, text: '本轮工作已经完成。保留完整原文，仅在用户点击后标注重点。' });
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const entry = `
import * as React from ${JSON.stringify(deps.resolve('react'))};
import * as ReactDOM from ${JSON.stringify(deps.resolve('react-dom'))};
import { createRoot } from ${JSON.stringify(deps.resolve('react-dom/client'))};
const h=React.createElement;let plugin;
window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==='react')return React;if(id==='react-dom')return ReactDOM;if(id==='react-dom/client')return{createRoot};throw Error(id)})}};
${source}
window.readingRuntime=plugin.__testing.reportReadingRuntime;
const root=createRoot(document.getElementById('app'));
root.render(h('main',null,h('h1',null,'原始工作页面'),h('textarea',{'aria-label':'工作输入框',defaultValue:'保持原有工作输入'}),h(plugin.__testing.PersonaChatLauncher,{sessionId:'work',conversation:{effectivePersonaId:'大肥鱼（默认）'}})));
`;
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) },
  bundle: true, platform: 'browser', format: 'iife', write: false,
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
const cases = [], errors = [], reads = [];
let chatDelay = 180;
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  const html = '<html><head><meta charset="utf-8"><style>'
    + ':root{--dsw-alias-label-primary:#203044;--dsw-alias-label-secondary:#607086;--dsw-alias-brand-primary:#3d6dcc;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f3f5f8;--dsw-alias-border-l1:#d2dce8}'
    + 'body{margin:0;padding:24px;font:14px/1.7 system-ui}main>textarea{display:block;width:300px;height:90px;margin-bottom:20px}'
    + '</style></head><body><div id="app"></div></body></html>';
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'https://opening.test') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/persona-shell/chat/live') return route.abort();
    const pathname = url.pathname.replace('/persona-shell/', '') + url.search;
    reads.push({ path: url.pathname, method: request.method() });
    if (url.pathname === '/persona-shell/report-visualization') return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ available: true, source: original, result: { schemaVersion: 2, annotations: [] }, cached: true }) });
    if (url.pathname === '/persona-shell/chat' && request.method() === 'GET' && chatDelay) await new Promise(resolve => setTimeout(resolve, chatDelay));
    const answer = await host.request(pathname, request.method() === 'POST' ? request.postDataJSON() : undefined);
    return route.fulfill({ status: answer.status, contentType: Buffer.isBuffer(answer.value) ? 'image/webp' : 'application/json',
      body: Buffer.isBuffer(answer.value) ? answer.value : JSON.stringify(answer.value) });
  });
  await page.goto('https://opening.test/');
  await page.evaluate(() => {
    window.openingProbe = { frames: [], animations: [], active: false, kind: '' };
    const originalAnimate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (this.matches('.dsh-persona-chat,.dsh-persona-chat-dock')) window.openingProbe.animations.push({
        kind: window.openingProbe.kind, at: performance.now(), type: this.className,
        frames: structuredClone(frames), duration: typeof options === 'number' ? options : options?.duration,
      });
      return originalAnimate.call(this, frames, options);
    };
    let frame;
    window.startOpeningProbe = kind => {
      cancelAnimationFrame(frame);Object.assign(window.openingProbe,{ frames: [], animations: [], active: true, kind });
      const sample = () => {
        const panel = document.querySelector('.dsh-persona-chat');
        let opacity=panel?1:null;
        for(let element=panel;element;element=element.parentElement)opacity*=Number(getComputedStyle(element).opacity);
        window.openingProbe.frames.push({ at: performance.now(), count: document.querySelectorAll('.dsh-persona-chat').length,
          opacity,
          transform: panel ? getComputedStyle(panel).transform : null,
          loaded: !!document.querySelector('#dsh-persona-chat-input'),
          status: panel?.querySelector('[role=status]')?.textContent ?? '',
          top: panel?.getBoundingClientRect().top ?? null,
          width: panel?.offsetWidth ?? null,height: panel?.offsetHeight ?? null,wide:panel?.dataset.wide??null,
        });
        if (window.openingProbe.active) frame = requestAnimationFrame(sample);
      };sample();
    };
    window.stopOpeningProbe = () => { window.openingProbe.active = false;cancelAnimationFrame(frame);return structuredClone(window.openingProbe); };
  });
  await page.addScriptTag({ content: bundle });
  const launch = page.getByRole('button', { name: '聊天室', exact: true });
  const input = page.getByRole('textbox', { name: '发送给角色的消息', exact: true });
  const dialog = page.getByRole('dialog', { name: '聊天室', exact: true });
  const endMotion = () => page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      const finite = document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
      await Promise.all(finite.map(animation => animation.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  });
  const sample = async (name, action, expectedLayout) => {
    await page.evaluate(name => window.startOpeningProbe(name), name);
    await action();await input.waitFor();await input.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#dsh-persona-chat-input')?.disabled);
    await endMotion();
    const trace = await page.evaluate(() => window.stopOpeningProbe());
    let shown = false;
    const drops = trace.frames.filter(frame => {
      if (frame.opacity !== null && frame.opacity > .85) shown = true;
      return shown && frame.opacity !== null && frame.opacity < .2;
    });
    const entrances = trace.animations.filter(animation => animation.type === 'dsh-persona-chat');
    const sizeChanges=expectedLayout?trace.frames.filter(frame=>frame.width!==null&&(frame.width!==expectedLayout.width||frame.height!==expectedLayout.height||frame.wide!=='true')):[];
    const failures = [
      ...(drops.length ? ['visible shell became transparent again'] : []),
      ...(entrances.length > 1 ? ['opening restarted its entrance animation'] : []),
      ...(trace.frames.some(frame => frame.count > 1) ? ['duplicate visible room surfaces'] : []),
      ...(sizeChanges.length ? ['reopening flashed a different room size'] : []),
    ];
    cases.push({ name, ok: failures.length === 0, failures, entrances: entrances.length, drops: drops.length,sizeChanges:sizeChanges.length, trace });
  };
  await launch.waitFor();
  assert.equal(reads.some(read => ['/persona-shell/chat','/persona-shell/chat-context','/persona-shell/chat-rooms','/persona-shell/report-visualization'].includes(read.path)), false, 'not opening still avoids chat/source/report initialization');
  await sample('cold-open', () => launch.click());
  await input.fill('动效中保留的草稿');
  await dialog.getByRole('button', { name: '关闭聊天室', exact: true }).click();await dialog.waitFor({ state: 'hidden' });await endMotion();
  await sample('close-and-open', () => launch.click());
  assert.equal(await input.inputValue(), '动效中保留的草稿');
  await dialog.getByRole('button',{name:'放大',exact:true}).click();await endMotion();
  const wideLayout=await dialog.evaluate(element=>({width:element.offsetWidth,height:element.offsetHeight}));
  await dialog.getByRole('button', { name: '关闭聊天室', exact: true }).click();await dialog.waitFor({ state: 'hidden' });await endMotion();
  await sample('wide-close-and-delayed-open',()=>launch.click(),wideLayout);
  await dialog.getByRole('button',{name:'还原',exact:true}).click();await endMotion();
  chatDelay = 0;
  await input.evaluate(element => { element.focus();element.setSelectionRange(2, 7); });
  await dialog.getByRole('button', { name: '最小化聊天室', exact: true }).click();
  await page.locator('.dsh-persona-chat-dock').waitFor();await endMotion();
  await sample('dock-restore', () => page.locator('.dsh-persona-chat-dock button').first().click());
  assert.equal(await input.inputValue(), '动效中保留的草稿');
  assert.deepEqual(await input.evaluate(element => [element === document.activeElement, element.selectionStart, element.selectionEnd]), [true, 2, 7]);
  await page.evaluate(() => window.readingRuntime.open('work', 10));await page.getByRole('dialog', { name: '报告阅读页', exact: true }).waitFor();await endMotion();
  await sample('reader-to-chat', () => launch.click());
  assert.equal(await page.getByRole('button', { name: '恢复报告阅读页', exact: true }).count(), 1);
  await sample('rapid-close-reopen', () => page.evaluate(() => {
    document.querySelector('.dsh-persona-chat [aria-label="关闭聊天室"]').click();
    [...document.querySelectorAll('button')].find(button=>button.textContent==='聊天室'&&!button.closest('.dsh-persona-chat-dock')).click();
  }));
  assert.equal(await input.inputValue(), '动效中保留的草稿');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dialog.getByRole('button', { name: '关闭聊天室', exact: true }).click();await dialog.waitFor({ state: 'hidden' });
  await sample('reduced-motion-open', () => launch.click());
  assert.equal(cases.at(-1).entrances, 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined }));
  await dialog.getByRole('button', { name: '最小化聊天室', exact: true }).click();await page.locator('.dsh-persona-chat-dock').waitFor();
  await sample('no-native-transition-restore', () => page.locator('.dsh-persona-chat-dock button').first().click());
  await dialog.getByRole('button', { name: '关闭聊天室', exact: true }).click();await dialog.waitFor({ state: 'hidden' });
  await sample('no-native-transition-open', () => launch.click());
  assert.equal(await input.inputValue(), '动效中保留的草稿');
  assert.equal(await page.getByRole('textbox', { name: '工作输入框', exact: true }).inputValue(), '保持原有工作输入');
  assert.equal(host.calls.length, 0);assert.equal(host.judgements.length, 0);assert.equal(host.selections.length, 0);
  assert.deepEqual(errors, []);
  if (values.output) {
    mkdirSync(values.output, { recursive: true });
    writeFileSync(path.join(values.output, 'opening-motion.json'), JSON.stringify({ cases, errors, reads, modelCalls: host.calls.length }, null, 2));
    await dialog.screenshot({ path: path.join(values.output, 'chat-opening-final.png') });
  }
  console.log(JSON.stringify({ result: cases.every(entry => entry.ok) ? 'passed' : 'failed',
    cases: cases.map(({ trace, ...entry }) => entry), pageErrors: errors, modelCalls: host.calls.length, output: values.output }));
  if (!values.diagnose) assert.equal(cases.every(entry => entry.ok), true, 'opening should not hide an already visible surface or restart its entrance');
} finally {
  await browser.close();for (const stop of [...stops].reverse()) await stop();
}
