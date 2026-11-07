// Real React + browser against the production memory reducer, with local-only requests.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createStructuredMemory } from '../../lib/structured-memory.js';
import { createMemoryUsage } from '../../lib/memory-usage.js';
const { values } = parseArgs({ options: {
  deps: { type: 'string' }, 'browser-deps': { type: 'string' }, executable: { type: 'string' }, output: { type: 'string' },
} });
assert.ok(values.deps, 'Pass --deps <React/esbuild dependency package.json>');
const deps = createRequire(path.resolve(values.deps));
const browserDeps = values['browser-deps'] ? createRequire(path.resolve(values['browser-deps'])) : deps;
const { buildSync } = deps('esbuild'); const { chromium } = browserDeps('playwright');
const memory = createStructuredMemory();
const add = (content, personaId = 'whale') => memory.mutate({ action: 'add', entry: { kind: 'preference', scope: 'persona', personaId, content } });
const original = add('语气要轻松'); const dragon = add('龙的私有约定', 'dragon');
const sourceText = '我希望先交代结论，再把限定条件说清楚；不是省略解释。';
memory.observe({ sessionId: 's', personaId: 'whale', seq: 1, text: sourceText });
const batch = memory.batch();
memory.commit(batch, [{ kind: 'preference', scope: 'persona', content: '偏好先交代结论再说明条件', evidence: [{ eventId: 's:1', quote: '先交代结论' }] }]);
const candidateId = memory.snapshot().entries.find((e) => e.origin === 'model').id;
const usage = createMemoryUsage();
const used = usage.begin({ personaId: 'whale', sessionId: 's', channel: 'progress',
  selection: memory.selection({ personaId: 'whale', sessionId: 's' }) }); used.sent(); used.finish('generated');
usage.begin({ personaId: 'whale', sessionId: 's', channel: 'report',
  selection: memory.selection({ personaId: 'whale', sessionId: 's' }) }).finish('failed');
const otherUsed = usage.begin({ personaId: 'dragon', sessionId: 's', channel: 'report',
  selection: memory.selection({ personaId: 'dragon', sessionId: 's' }) }); otherUsed.sent(); otherUsed.finish('generated');
const [usedId, notSentId, otherUsedId] = usage.snapshot().records.map((r) => r.id);
let failNext = false, failRead = false, activePersonaId = 'whale'; const posts = [];
const snapshot = () => ({ ...memory.snapshot(), activePersonaId, activePresetName: activePersonaId === 'whale' ? '鲸鲸' : '龙',
  sessionId: 's', extraction: { status: 'idle', pending: 0 }, usage: { ...usage.snapshot(), persistence: 'local' } });
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const entry = [
  'import * as React from ' + JSON.stringify(deps.resolve('react')) + ';',
  'import { createRoot } from ' + JSON.stringify(deps.resolve('react-dom/client')) + ';',
  'const h=React.createElement;let plugin;',
  'window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;throw Error(id)})}};',
  source,
  'function Demo(){const[settings,setSettings]=React.useState({memory:true,memoryExtraction:false,presetName:"鲸鲸"});',
  'window.changePersona=name=>setSettings(s=>({...s,presetName:name}));',
  'return h(plugin.__testing.MemoryPanel,{settings,presets:[{id:"whale",name:"鲸鲸"},{id:"dragon",name:"龙"}],',
  'save:async patch=>{if(patch.clearMemory)await fetch("/persona-shell/settings",{method:"POST",body:JSON.stringify(patch)});',
  'setSettings(s=>({...s,...patch}));return{settings:{...settings,...patch}}}})}',
  'createRoot(document.getElementById("app")).render(h(Demo));',
].join('\n');
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); const errors = [], external = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const html = '<html><head><meta charset="utf-8"><style>'
    + ':root{--dsw-alias-label-primary:#17293b;--dsw-alias-label-secondary:#506174;--dsw-alias-brand-primary:#2462bd;'
    + '--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f2f5f8;--dsw-alias-border-l1:#c7d4e2}'
    + ':root[data-theme="dark"]{--dsw-alias-label-primary:#edf2f7;--dsw-alias-label-secondary:#b8c6d6;'
    + '--dsw-alias-bg-layer-1:#17212d;--dsw-alias-bg-layer-2:#202b39;--dsw-alias-border-l1:#536479}'
    + '*{box-sizing:border-box}body{margin:0;padding:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);'
    + 'font-family:system-ui}#app{max-width:760px;margin:auto}</style></head><body><main id="app"></main></body></html>';
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://memory.test') { external.push(url.href); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/persona-shell/settings') {
      if (route.request().postDataJSON().clearMemory) { memory.clear(); usage.clear(); }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    assert.equal(url.pathname, '/persona-shell/memory');
    let status = 200, value;
    if (route.request().method() === 'POST') {
      const action = route.request().postDataJSON(); posts.push(action);
      if (failNext) { failNext = false; status = 503; value = { error: 'memory-save-failed' }; }
      else {
        try { const result = memory.mutate(action); value = { ...snapshot(), result }; }
        catch (error) { status = error.message.includes('conflict') ? 409 : 400; value = { error: error.message }; }
      }
    } else if (failRead) { failRead = false; status = 503; value = { error: 'temporary-read-failure' }; }
    else value = snapshot();
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto('http://memory.test/'); await page.addScriptTag({ content: bundle });
  const row = (id) => page.locator('[data-memory-id="' + id + '"]');
  const view = (label) => page.getByRole('group', { name: '记忆状态' }).getByRole('button', { name: new RegExp('^' + label + ' ') }).click();
  const status = (text) => page.getByRole('status').filter({ hasText: text }).waitFor();
  const capture = async (name, width = 1100, dark = false) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((value) => { document.documentElement.dataset.theme = value ? 'dark' : 'light'; }, dark);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page overflow: ' + name);
    if (values.output) { mkdirSync(values.output, { recursive: true }); await page.screenshot({ path: path.join(values.output, name + '.png'), fullPage: true }); }
  };
  await row(original.id).waitFor(); assert.equal(await row(dragon.id).count(), 0, 'private owner hidden by default');
  const usageFold = page.locator('[data-settings-fold="memory-usage"]');
  assert.equal(await usageFold.getAttribute('open'), null, 'usage starts collapsed');
  await usageFold.locator(':scope > summary').click();
  const usagePanel = page.getByRole('region', { name: '记忆使用情况' });
  await usagePanel.locator('[data-memory-usage="' + usedId + '"]').waitFor();
  assert.equal(await usagePanel.locator('[data-memory-usage]').count(), 2, 'default view isolates the current persona');
  assert.equal(await usagePanel.locator('[data-memory-usage="' + otherUsedId + '"]').count(), 0);
  const notSent = usagePanel.locator('[data-memory-usage="' + notSentId + '"]');
  await notSent.locator(':scope > summary').click();
  await notSent.getByText('准备选入的偏好（尚未提供）', { exact: true }).waitFor();
  const usedRecord = usagePanel.locator('[data-memory-usage="' + usedId + '"]');
  await usedRecord.locator(':scope > summary').click();
  await usedRecord.getByText('语气要轻松', { exact: true }).waitFor();
  await usedRecord.getByText('为什么其他 1 条没有选中', { exact: true }).click();
  await usedRecord.getByText('等待确认', { exact: true }).waitFor();
  await page.getByLabel('筛选使用渠道').selectOption('progress');
  assert.equal(await usagePanel.locator('[data-memory-usage]').count(), 1);
  await capture('usage-light'); await capture('usage-mobile', 390); await capture('usage-dark', 1100, true);
  failRead = true; await page.getByRole('button', { name: '刷新使用情况', exact: true }).click();
  await status('暂未更新，已有记录仍保留');
  assert.equal(await usagePanel.locator('[data-memory-usage]').count(), 1, 'failed refresh retains visible records');
  await page.getByRole('button', { name: '刷新使用情况', exact: true }).click(); await status('已刷新');
  assert.equal(await page.getByText('暂时无法读取记忆，请稍后刷新。', { exact: true }).count(), 0);
  await page.getByLabel('筛选使用渠道').selectOption('all');
  await usageFold.locator(':scope > summary').click();
  await row(original.id).getByRole('button', { name: '更正', exact: true }).click();
  const statement = '以前只要轻松口吻；现在请严肃一些。\n必要条件和 25 这个数值不要漏。';
  await page.getByLabel('更正后的记忆内容').fill('语气要严肃，必要条件讲完整');
  await page.getByLabel('本次更正或撤销的原话').fill(statement);
  await page.getByRole('button', { name: '预览更正', exact: true }).click();
  await page.getByRole('region', { name: '待确认更正' }).waitFor();
  assert.equal(memory.select({ personaId: 'whale', sessionId: 's' })[0].content, original.content);
  assert.equal(memory.snapshot().operations[0].evidence[0].quote, statement);
  assert.equal(await page.getByRole('region', { name: '待确认更正' }).locator('blockquote').textContent(), statement);
  await capture('review-light'); await capture('review-mobile', 390); await capture('review-dark', 1100, true);
  failNext = true; await page.getByRole('button', { name: '确认更正', exact: true }).click(); await status('保存失败');
  assert.equal(memory.snapshot().operations[0].status, 'pending');
  await page.getByRole('button', { name: '确认更正', exact: true }).click(); await status('已确认');
  const replacement = memory.select({ personaId: 'whale', sessionId: 's' })[0];
  assert.equal(replacement.content, '语气要严肃，必要条件讲完整');
  await usageFold.locator(':scope > summary').click();
  await usedRecord.getByText('原版本已更改、删除或不再适用，无法展示当时内容。', { exact: true }).waitFor();
  assert.equal(await usedRecord.getByText('语气要轻松', { exact: true }).count(), 0, 'changed memory is not reconstructed by usage');
  await usageFold.locator(':scope > summary').click();
  await view('使用中'); await row(replacement.id).getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByLabel('本次更正或撤销的原话').fill('这条以后不用记了，不需要改成相反的要求。');
  await page.getByRole('button', { name: '预览撤销', exact: true }).click();
  await page.getByRole('button', { name: '放弃这次操作', exact: true }).click(); await status('已放弃');
  assert.equal(memory.select({ personaId: 'whale', sessionId: 's' })[0].id, replacement.id);
  await view('使用中'); await row(replacement.id).getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByLabel('本次更正或撤销的原话').fill('这条不再适用了。');
  await page.getByRole('button', { name: '预览撤销', exact: true }).click();
  await page.getByRole('button', { name: '确认撤销', exact: true }).click(); await status('已确认');
  assert.deepEqual(memory.select({ personaId: 'whale', sessionId: 's' }), []);
  await view('历史'); await row(replacement.id).getByText('查看来源', { exact: true }).click();
  await row(replacement.id).getByText('撤销时的说明', { exact: true }).waitFor();
  await view('待确认'); await row(candidateId).getByRole('button', { name: '核对并采用', exact: true }).click();
  assert.equal(await page.getByRole('region', { name: '待确认采用' }).locator('blockquote').textContent(), sourceText);
  await page.getByRole('button', { name: '确认采用', exact: true }).click(); await status('已确认');
  await page.locator('[data-settings-fold="memory-add"] > summary').click();
  const draft = page.getByLabel('新增记忆内容'); await draft.fill('称呼我为阿晴');
  failNext = true; await page.getByRole('button', { name: '预览新记忆', exact: true }).click(); await status('保存失败');
  assert.equal(await draft.inputValue(), '称呼我为阿晴');
  await page.getByRole('button', { name: '预览新记忆', exact: true }).click(); await page.getByRole('button', { name: '确认采用', exact: true }).waitFor();
  assert.equal(await draft.inputValue(), '');
  await page.getByRole('button', { name: '放弃这次操作', exact: true }).click();
  await view('使用中'); await page.getByLabel('筛选记忆').selectOption('all');
  await usageFold.locator(':scope > summary').click();
  await usagePanel.locator('[data-memory-usage="' + otherUsedId + '"]').waitFor();
  assert.equal(await usagePanel.locator('[data-memory-usage="' + otherUsedId + '"]').count(), 1, 'owner all-persona filter includes other usage');
  await usageFold.locator(':scope > summary').click();
  await row(dragon.id).getByRole('button', { name: '更正', exact: true }).click();
  await page.getByLabel('更正后的记忆内容').fill('龙的新约定'); await page.getByLabel('本次更正或撤销的原话').fill('这是只对龙说的约定');
  await page.getByRole('button', { name: '预览更正', exact: true }).click();
  await page.getByRole('button', { name: '确认更正', exact: true }).focus(); await page.keyboard.press('Enter'); await status('已确认');
  assert.equal(memory.select({ personaId: 'dragon', sessionId: 's' })[0].content, '龙的新约定');
  assert.equal(memory.select({ personaId: 'whale', sessionId: 's' }).some((e) => e.content === '龙的新约定'), false);
  await capture('settings-history-light');
  activePersonaId = 'dragon'; await page.evaluate(() => window.changePersona('龙'));
  await view('使用中'); await page.getByText('龙的新约定', { exact: true }).waitFor();
  const dragonNow = memory.select({ personaId: 'dragon', sessionId: 's' })[0];
  await row(dragonNow.id).getByRole('button', { name: '撤销', exact: true }).click();
  const longStatement = '不是建立相反偏好，只撤销这一条。'.repeat(40);
  await page.getByLabel('本次更正或撤销的原话').fill(longStatement);
  await page.getByRole('button', { name: '预览撤销', exact: true }).click();
  const heading = page.getByRole('region', { name: '待确认撤销' }).locator('.dsh-persona-memory-review-heading');
  await heading.waitFor();
  const listBox = await page.locator('.dsh-persona-memory-list').boundingBox(), headingBox = await heading.boundingBox();
  assert.ok(headingBox.y >= listBox.y && headingBox.y < listBox.y + listBox.height, 'long review opens at the heading');
  assert.equal(await page.getByRole('region', { name: '待确认撤销' }).locator('blockquote').textContent(), longStatement);
  await capture('review-long-mobile', 390); await capture('review-long-dark', 1100, true);
  const fullStatement = page.getByRole('region', { name: '待确认撤销' }).locator('blockquote');
  assert.equal(await fullStatement.isVisible(), false, 'long evidence is collapsed for readability');
  await page.getByText('展开完整说明（' + longStatement.length + ' 字符）', { exact: true }).click();
  assert.equal(await fullStatement.isVisible(), true);
  await page.locator('[data-settings-fold="memory-clear"] > summary').click();
  await page.getByRole('button', { name: '清空记忆', exact: true }).click();
  await page.getByRole('button', { name: '确认清空全部记忆', exact: true }).click();
  await status('已清空记忆');
  assert.equal(usage.snapshot().records.length, 0);
  await usageFold.locator(':scope > summary').click();
  assert.equal(await usagePanel.locator('[data-memory-usage]').count(), 0, 'clear also removes the visible usage history');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ result: 'passed', cases: ['confirmation-first', 'exact evidence', 'save retry', 'retract without inverse',
    'dismiss without changes', 'candidate provenance', 'manual add review', 'private isolation', 'history', 'keyboard', 'light/dark/mobile',
    'usage channel filter', 'usage refresh retry', 'selected versus provided', 'omission reasons', 'stale reference privacy', 'clear usage'], posts: posts.length, pageErrors: errors }));
} finally { await browser.close(); }
