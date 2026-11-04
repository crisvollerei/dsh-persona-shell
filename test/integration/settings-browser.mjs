// Optional real-React settings regression with a local mock Host and no model calls.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BUILTIN_PRESETS, normalizePack } from '../../lib/pack.js';

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
const presets = BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true, pack: normalizePack(p.pack) }));
const seed = {
  settings: { enabled: true, includeToolSteps: true, processToolUsage: false,
    progressNotices: false, progressMinutes: 5, reviewHints: true, reviewThreshold: 0.55,
    subagentSteps: false, subagentReports: false, memory: true, memoryExtraction: false,
    provider: '', model: '', presetName: presets[0].name, pack: presets[0].pack },
  presets, entries: [], settingsPosts: [], presetPosts: [], failSettings: false, failPreset: false,
};
const entry = [
  'import * as React from ' + JSON.stringify(deps.resolve('react')) + ';',
  'import { createRoot } from ' + JSON.stringify(deps.resolve('react-dom/client')) + ';',
  'const h=React.createElement;let plugin;',
  'window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;throw Error(id)})}};',
  source,
  'const host=window.settingsMock=' + JSON.stringify(seed) + ';',
  'const snapshot=()=>({settings:structuredClone(host.settings),presets:structuredClone(host.presets),active:host.settings.presetName,memory:[],memoryStats:{messages:0,stated:0}});',
  'const reply=(body,ok=true)=>({ok,status:ok?200:503,json:async()=>structuredClone(body)});',
  'window.fetch=async(url,options)=>{const route=new URL(url,"https://example.invalid").pathname;',
  'if(route.endsWith("/settings")){if(options){const patch=JSON.parse(options.body);host.settingsPosts.push(patch);',
  'if(host.failSettings){host.failSettings=false;return reply({error:"storage-not-ready"},false)}',
  'Object.assign(host.settings,patch);if(patch.pack){let active=host.presets.find(p=>p.name===host.settings.presetName);',
  'if(active.builtin){active={id:"edited",name:active.name+" · 我的版本",builtin:false,pack:patch.pack};host.presets.push(active);host.settings.presetName=active.name}',
  'else active.pack=patch.pack}}return reply(snapshot())}',
  'if(route.endsWith("/presets")){if(options){const body=JSON.parse(options.body);host.presetPosts.push(body);',
  'if(host.failPreset){host.failPreset=false;return reply({error:"storage-not-ready"},false)}',
  'if(body.action==="generate")return reply({ok:true,preset:{name:"清风",identity:"自然、温和地转述工作进展",report:["先说结果"],samples:["这部分已经处理好了。"]}});',
  'if(body.action==="save"){host.presets.push({id:"generated",name:body.name,pack:body.pack,builtin:false});host.settings.pack=body.pack;host.settings.presetName=body.name}',
  'if(body.action==="apply"){const p=host.presets.find(p=>p.id===body.id);host.settings.pack=p.pack;host.settings.presetName=p.name}}return reply({ok:true,...snapshot()})}',
  'if(route.endsWith("/models"))return reply({providers:[{provider:"local",name:"示例提供方"}],models:[{id:"rewrite-small",name:"示例转述模型"}]});',
  'if(route.endsWith("/memory")){if(options){const b=JSON.parse(options.body);if(b.action==="add")host.entries.push({...b.entry,id:"memory1",status:"active",origin:"manual",version:1,expiresAt:null,evidence:[]})}',
  'return reply({entries:host.entries,activePersonaId:host.presets.find(p=>p.name===host.settings.presetName).id,activePresetName:host.settings.presetName,sessionId:"main",extraction:{pending:0,status:"idle"}})}',
  'return reply({})};',
  'createRoot(document.getElementById("app")).render(h(plugin.__testing.SettingsSection));',
].join('\n');
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = []; const external = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (/^https?:/.test(r.url())) external.push(r.url()); });
  await page.setContent('<html><head><meta charset="utf-8"><style>'
    + ':root{--dsw-alias-label-primary:#243244;--dsw-alias-label-secondary:#697587;--dsw-alias-label-tertiary:#788493;'
    + '--dsw-alias-brand-primary:#386fba;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f6f8fb;--dsw-alias-border-l1:#dce2e9}'
    + ':root[data-theme="dark"]{--dsw-alias-label-primary:#e2e7ef;--dsw-alias-label-secondary:#a5b2c4;--dsw-alias-label-tertiary:#8b9aaf;'
    + '--dsw-alias-brand-primary:#8aaff1;--dsw-alias-bg-layer-1:#19212e;--dsw-alias-bg-layer-2:#222d3e;--dsw-alias-border-l1:#364459}'
    + 'body{margin:0;padding:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);'
    + 'font-family:"Segoe UI","Microsoft YaHei",sans-serif}#app{max-width:880px;margin:auto}button{font:inherit}'
    + '@media(max-width:600px){body{padding:16px}}'
    + '</style></head><body><main id="app"></main></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.locator('.dsh-persona-preset[data-active="true"]').waitFor();
  assert.equal(await page.locator('textarea:visible').count(), 0, 'the first view does not expose editors');
  assert.equal(await page.locator('input[type="number"]:visible').count(), 0, 'quiet timing stays hidden while disabled');
  for (const id of ['memory', 'advanced', 'create-persona', 'edit-persona']) {
    assert.equal(await page.locator('[data-settings-fold="' + id + '"]').evaluate((e) => e.open), false);
  }
  const capture = async (name, width, theme) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ' fits');
    if (values.output) {
      mkdirSync(values.output, { recursive: true });
      await page.screenshot({ path: path.join(values.output, name + '.png'), fullPage: true });
    }
  };
  const initialHeight = await page.locator('[data-persona-shell="settings"]').evaluate((e) => Math.round(e.getBoundingClientRect().height));
  assert.ok(initialHeight < 1450, 'the default settings view stays compact');
  await capture('settings-desktop-light', 1100, 'light');
  await capture('settings-desktop-dark', 1100, 'dark');
  await capture('settings-mobile', 390, 'light');
  await page.setViewportSize({ width: 1100, height: 1000 });
  const fold = (id) => page.locator('[data-settings-fold="' + id + '"]');
  await page.getByRole('checkbox', { name: '静默状态播报', exact: true }).check();
  const minutes = page.getByRole('spinbutton');
  await minutes.waitFor();
  await minutes.fill('12');
  await page.getByRole('heading', { name: '日常转述', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.progressMinutes === 12);
  await page.getByRole('checkbox', { name: '静默状态播报', exact: true }).uncheck();
  await page.waitForFunction(() => window.settingsMock.settings.progressNotices === false);
  assert.equal(await minutes.isVisible(), false);
  await fold('edit-persona').locator(':scope > summary').click();
  const identity = page.getByRole('textbox', { name: '身份', exact: true });
  await page.evaluate(() => { window.settingsMock.failSettings = true; });
  await identity.fill('这份输入在收起后仍然应该保留');
  await fold('edit-persona').locator(':scope > summary').click();
  await page.locator('.dsh-persona-save-state').filter({ hasText: '保存失败' }).waitFor();
  await fold('edit-persona').locator(':scope > summary').click();
  assert.equal(await identity.inputValue(), '这份输入在收起后仍然应该保留');
  await identity.focus(); await page.getByRole('heading', { name: '日常转述', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.pack.identity === '这份输入在收起后仍然应该保留');
  await fold('edit-persona').locator(':scope > summary').click();
  await fold('create-persona').locator(':scope > summary').click();
  await page.getByRole('textbox', { name: '人设提示词', exact: true }).fill('一个自然、温和又简洁的角色，转述时保留所有条件和风险，先说结果再补充解释。');
  await page.getByRole('button', { name: '生成预设', exact: true }).click();
  const name = page.getByRole('textbox', { name: '新预设名称', exact: true });
  await name.fill('我的清风');
  await page.evaluate(() => { window.settingsMock.failPreset = true; });
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await page.getByText('失败：storage-not-ready', { exact: true }).waitFor();
  assert.equal(await name.inputValue(), '我的清风');
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.presetName === '我的清风');
  await page.locator('.dsh-persona-preset[data-active="true"]').filter({ hasText: '我的清风' }).waitFor();
  await fold('advanced').locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: '改写所用模型', exact: true }).selectOption('local');
  await page.getByRole('combobox', { name: '模型', exact: true }).selectOption('rewrite-small');
  await page.waitForFunction(() => window.settingsMock.settings.model === 'rewrite-small');
  await fold('advanced').locator(':scope > summary').click();
  await fold('memory').locator(':scope > summary').click();
  await fold('memory-add').locator(':scope > summary').click();
  const memoryDraft = page.getByRole('textbox', { name: '新增记忆内容' });
  await memoryDraft.fill('这个草稿在折叠后依然保留');
  await fold('memory').locator(':scope > summary').click();
  await fold('memory').locator(':scope > summary').click();
  assert.equal(await memoryDraft.inputValue(), '这个草稿在折叠后依然保留');
  await capture('settings-memory-open', 1100, 'light');
  await capture('settings-memory-mobile', 390, 'light');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ result: 'passed', initialHeight, defaultVisibleEditors: 0,
    cases: ['progressive disclosure', 'failed save retains hidden draft', 'generated preset retry',
      'conditional quiet timing', 'keyboard disclosure', 'model selection', 'memory draft retention', 'desktop/mobile themes'],
    pageErrors: errors, externalRequests: external }));
} finally { await browser.close(); }
