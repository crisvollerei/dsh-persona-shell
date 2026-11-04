// Optional real-React browser coverage for the memory settings panel.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  deps: { type: 'string' }, 'browser-deps': { type: 'string' },
  executable: { type: 'string' }, output: { type: 'string' },
} });
assert.ok(values.deps, 'Pass --deps <React/esbuild dependency package.json>');
const deps = createRequire(path.resolve(values.deps));
const browserDeps = values['browser-deps'] ? createRequire(path.resolve(values['browser-deps'])) : deps;
const { buildSync } = deps('esbuild');
const { chromium } = browserDeps('playwright');
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const entry = [
  'import * as React from ' + JSON.stringify(deps.resolve('react')) + ';',
  'import { createRoot } from ' + JSON.stringify(deps.resolve('react-dom/client')) + ';',
  'const h=React.createElement; let plugin;',
  'window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;throw Error(id)})}};',
  source,
  'const entries=[{id:"candidate",kind:"preference",scope:"persona",personaId:"whale",sessionId:null,',
  'content:"希望先看到结论，再补充条件",origin:"model",status:"candidate",pinned:false,version:1,expiresAt:null,',
  'evidence:[{eventId:"session-"+ "x".repeat(240),quote:"我想先看主要结果"}]},',
  '{id:"private",kind:"preference",scope:"persona",personaId:"dragon",sessionId:null,content:"龙的私有约定",',
  'origin:"manual",status:"active",pinned:false,version:2,expiresAt:null,evidence:[]}];',
  'window.memoryMock={entries,posts:[],failNext:false};',
  'const snapshot=()=>({entries:structuredClone(entries),activePersonaId:"whale",sessionId:"s",revision:1,extraction:{pending:0,status:"idle"}});',
  'window.fetch=async(_url,options)=>{',
  'if(options){const body=JSON.parse(options.body);window.memoryMock.posts.push(body);',
  'if(window.memoryMock.failNext){window.memoryMock.failNext=false;return{ok:false,json:async()=>({error:"memory-save-failed"})}}',
  'if(body.action==="add")entries.push({...body.entry,id:"new-"+entries.length,status:"active",origin:"manual",version:1,expiresAt:null,evidence:[]});',
  'else{const item=entries.find(e=>e.id===body.id);if(body.action==="accept")item.status="active";',
  'if(body.action==="update")Object.assign(item,body,{version:item.version+1});',
  'if(body.action==="delete")entries.splice(entries.indexOf(item),1)}}',
  'return{ok:true,json:async()=>snapshot()}};',
  'function Demo(){const[settings,setSettings]=React.useState({memory:true,memoryExtraction:false,presetName:"鲸鲸"});',
  'return h(plugin.__testing.MemoryPanel,{settings,presets:[{id:"whale",name:"鲸鲸"},{id:"dragon",name:"龙"}],',
  'save:async patch=>{setSettings(s=>({...s,...patch}));return{settings:{...settings,...patch}}}})}',
  'createRoot(document.getElementById("app")).render(h(Demo));',
].join('\n');
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<html><head><meta charset="utf-8"><style>'
    + ':root{--dsw-alias-label-primary:#17293b;--dsw-alias-label-secondary:#506174;'
    + '--dsw-alias-brand-primary:#2462bd;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f2f5f8;'
    + '--dsw-alias-border-l1:#c7d4e2;--dsw-alias-border-primary:#c7d4e2}'
    + ':root[data-theme="dark"]{--dsw-alias-label-primary:#edf2f7;--dsw-alias-label-secondary:#b8c6d6;'
    + '--dsw-alias-bg-layer-1:#17212d;--dsw-alias-bg-layer-2:#202b39;--dsw-alias-border-l1:#536479}'
    + '*{box-sizing:border-box}body{margin:0;padding:24px;color:var(--dsw-alias-label-primary);'
    + 'background:var(--dsw-alias-bg-layer-1);font-family:serif}#app{max-width:760px;margin:auto}'
    + '</style></head><body><main id="app"></main></body></html>');
  await page.addScriptTag({ content: bundle });
  const row = (id) => page.locator('[data-memory-id="' + id + '"]');
  await row('candidate').waitFor();
  await row('candidate').getByRole('button', { name: '采纳', exact: true }).click();
  await page.waitForFunction(() => window.memoryMock.entries[0].status === 'active');
  await page.waitForFunction(() => !document.querySelector('[data-memory-id="candidate"]').textContent.includes('待采纳'));
  await page.evaluate(() => { window.memoryMock.failNext = true; });
  await page.locator('[data-settings-fold="memory-add"] > summary').click();
  const draft = page.getByRole('textbox', { name: '新增记忆内容' });
  await draft.fill('称呼我为阿晴');
  await page.getByRole('button', { name: '添加记忆', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await draft.inputValue(), '称呼我为阿晴');
  await page.getByRole('button', { name: '添加记忆', exact: true }).click();
  await page.waitForFunction(() => window.memoryMock.entries.length === 3);
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="新增记忆内容"]').value === '');
  await page.getByRole('combobox', { name: '筛选记忆' }).selectOption('all');
  await row('private').getByRole('button', { name: '修改', exact: true }).click();
  await page.getByRole('textbox', { name: '修改记忆内容' }).fill('修改后的龙的约定');
  await page.getByRole('button', { name: '保存记忆修改', exact: true }).click();
  await page.waitForFunction(() => window.memoryMock.posts.at(-1).action === 'update');
  assert.equal(await page.evaluate(() => window.memoryMock.posts.at(-1).personaId), 'dragon');
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="修改记忆内容"]'));
  await row('candidate').getByText('查看来源', { exact: true }).click();
  for (const [name, width, theme] of [['desktop-light', 1000, 'light'], ['desktop-dark', 1000, 'dark'], ['mobile', 390, 'light']]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ' has no overflow');
    if (values.output) {
      mkdirSync(values.output, { recursive: true });
      await page.screenshot({ path: path.join(values.output, name + '.png'), fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', cases: ['candidate adoption', 'save failure retry',
    'private owner preserved', 'desktop light/dark', '390px layout with long provenance'], pageErrors: errors }));
} finally { await browser.close(); }
