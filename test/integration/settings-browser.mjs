// Optional real-React settings regression with a local mock Host and no model calls.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BUILTIN_PRESETS, normalizePack } from '../../lib/pack.js';
import { avatarContent, avatarUrl, builtinAvatar } from '../../lib/avatar.js';
import { roomCharacterContext } from '../../lib/character-roster.js';
import { createModelUsage } from '../../lib/model-usage.js';

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
const presets = BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true, pack: normalizePack(p.pack),
  avatar: avatarUrl({ id: p.id, avatar: builtinAvatar(p.id) }) }));
for(const preset of presets){const context=roomCharacterContext(preset,presets);preset.character={...context.self,relations:context.relationships};}
const metrics = (calls, usageCalls, totalTokens, failedCalls = 0) => ({
  calls, usageCalls, totalTokens, failedCalls, inputTokens: Math.floor(totalTokens * .8),
  outputTokens: totalTokens - Math.floor(totalTokens * .8), cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
});
const ledger = createModelUsage({ now: () => new Date(2026, 10, 7, 12) });
ledger.restore({ version: 1, rows: [
  { date: '2026-11-01', purpose: 'rewrite', provider: 'deepseek', model: 'deepseek-v4-flash', ...metrics(2, 2, 4600) },
  { date: '2026-11-02', purpose: 'rewrite', provider: 'deepseek', model: 'deepseek-v4-flash', ...metrics(3, 2, 4100, 1) },
  { date: '2026-11-05', purpose: 'rewrite', provider: 'deepseek', model: 'deepseek-v4-flash', ...metrics(4, 4, 9900), reasoningTokens: 120 },
  { date: '2026-11-06', purpose: 'chat', provider: 'anthropic', model: 'claude-sonnet', ...metrics(5, 4, 6400) },
  { date: '2026-11-03', purpose: 'chat-participation', provider: 'local', model: 'small-judge', ...metrics(2, 0, 0) },
  { date: '2026-11-06', purpose: 'memory', provider: 'deepseek', model: 'deepseek-v4-flash', ...metrics(1, 1, 200), reasoningTokens: 16 },
] });
const periods = Object.fromEntries([1, 7, 30].map((days) => [days, { ...ledger.report(days), persistence: 'local' }]));
const seed = {
  settings: { enabled: true, includeToolSteps: true, processToolUsage: false,
    progressNotices: false, progressMinutes: 5, reviewHints: true, reviewThreshold: 0.55,
    subagentSteps: false, subagentReports: false, memory: true, memoryExtraction: false,
    provider: '', model: '', presetName: presets[0].name, pack: presets[0].pack },
  presets, entries: [], settingsPosts: [], presetPosts: [], failSettings: false, failPreset: false, periods, usageReads: [],
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
  'if(route.endsWith("/model-usage")){const days=+new URL(url,"https://example.invalid").searchParams.get("days");host.usageReads.push(days);if(host.holdUsage===days)await new Promise(r=>host.resumeUsage=r);if(host.failUsage){host.failUsage=false;return reply({},false)}return reply(host.periods[days])}',
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
  const assets = new Map(presets.map(p => [new URL(p.avatar, 'https://persona.test').href, avatarContent(builtinAvatar(p.id)).file]));
  await page.route('https://persona.test/**', route => {
    const file = assets.get(route.request().url());
    return file ? route.fulfill({ contentType: 'image/webp', body: readFileSync(file) }) : route.abort();
  });
  page.on('request', (r) => { if (/^https?:/.test(r.url()) && !assets.has(r.url())) external.push(r.url()); });
  await page.setContent('<html><head><meta charset="utf-8"><base href="https://persona.test/"><style>'
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
  assert.equal(await page.getByRole('tabpanel').count(), 1, 'one category is visible at a time');
  for (const id of ['create-persona', 'edit-persona']) {
    assert.equal(await page.locator('[data-settings-fold="' + id + '"]').evaluate((e) => e.open), false);
  }
  const capture = async (name, width, theme) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ' fits');
    if (values.output) {
      mkdirSync(values.output, { recursive: true });
      await page.screenshot({ path: path.join(values.output, name + '.png'), fullPage: true, animations: 'disabled' });
    }
  };
  const initialHeight = await page.locator('[data-persona-shell="settings"]').evaluate((e) => Math.round(e.getBoundingClientRect().height));
  assert.ok(initialHeight < 900, 'the default settings view stays compact');
  const cat=page.locator('.dsh-persona-preset[data-preset-id="Gemini"]');
  await cat.getByRole('img',{name:'Gemini头像'}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.dsh-persona-preset img')].filter(i=>i.complete&&i.naturalWidth>0).length===5);
  assert.equal(await cat.locator('.dsh-persona-preset-description').textContent(),'猫猫，好奇心旺，接梗快');
  assert.equal(await cat.locator('img').evaluate(i=>getComputedStyle(i).objectPosition),'50% 7%');
  // Changing the active card may change its status, never its slot or the size of its neighbours.
  const cards=page.locator('.dsh-persona-preset');
  const geometry=()=>cards.evaluateAll(nodes=>nodes.map(el=>{
    const b=el.getBoundingClientRect(),grid=el.parentElement.getBoundingClientRect();
    return [el.dataset.presetId, b.x-grid.x, b.y-grid.y, b.width, b.height];
  }));
  const selectPreset=async id=>{
    const card=page.locator('.dsh-persona-preset[data-preset-id="'+id+'"]');
    await card.getByRole('button',{name:'启用',exact:true}).click();
    await card.locator('.dsh-persona-selected-label').waitFor();
  };
  for(const width of [1100,390]){
    await page.setViewportSize({width,height:1000});
    const before=await geometry();
    assert.deepEqual(before.map(([id])=>id),presets.map(p=>p.id));
    assert.ok(before.every(row=>Math.abs(row[3]-before[0][3])<1&&Math.abs(row[4]-before[0][4])<1),'all builtins have equal cards at '+width+'px');
    for(const id of ['大肥龙','Gemini',presets[0].id]){
      await selectPreset(id);assert.deepEqual(await geometry(),before,'switching to '+id+' must not change card layout');
    }
  }
  await capture('settings-desktop-light', 1100, 'light');
  await capture('settings-desktop-dark', 1100, 'dark');
  await capture('settings-mobile', 390, 'light');
  assert.equal(await page.locator('.dsh-persona-preset-grid').evaluate(el=>el.scrollHeight<=el.clientHeight+1),true,'all five stock cards fit without a nested scroll area');
  const characterGuide=page.locator('.dsh-persona-character-guide');
  assert.equal(await characterGuide.evaluate(e=>e.open),false,'character lore stays collapsed by default');
  await characterGuide.locator('summary').click();assert.equal(await characterGuide.locator('article').count(),5);
  const lore=await characterGuide.textContent();assert.match(lore,/姐妹/);assert.match(lore,/对GPT：/);assert.match(lore,/对猫猫：/);
  await capture('settings-characters-mobile',390,'light');await capture('settings-characters-dark',1100,'dark');
  await characterGuide.locator('summary').click();
  await page.setViewportSize({ width: 1100, height: 1000 });
  const fold = (id) => page.locator('[data-settings-fold="' + id + '"]');
  const tab = (label) => page.getByRole('tab', { name: label, exact: true }).click();
  await tab('转述');
  await capture('settings-rewrite', 1100, 'light');
  await page.getByRole('checkbox', { name: '静默状态播报', exact: true }).check();
  const minutes = page.getByRole('spinbutton');
  await minutes.waitFor();
  await minutes.fill('12');
  await page.getByRole('heading', { name: '日常转述', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.progressMinutes === 12);
  await page.getByRole('checkbox', { name: '静默状态播报', exact: true }).uncheck();
  await page.waitForFunction(() => window.settingsMock.settings.progressNotices === false);
  assert.equal(await minutes.isVisible(), false);
  await tab('人格');
  await fold('edit-persona').locator(':scope > summary').click();
  const identity = page.getByRole('textbox', { name: '身份', exact: true });
  await page.evaluate(() => { window.settingsMock.failSettings = true; });
  await identity.fill('这份输入在收起后仍然应该保留');
  await fold('edit-persona').locator(':scope > summary').click();
  await page.locator('.dsh-persona-save-state').filter({ hasText: '保存失败' }).waitFor();
  await fold('edit-persona').locator(':scope > summary').click();
  assert.equal(await identity.inputValue(), '这份输入在收起后仍然应该保留');
  await identity.focus(); await page.getByRole('heading', { name: '默认人格', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.pack.identity === '这份输入在收起后仍然应该保留');
  await page.getByRole('combobox', { name: '发言关系', exact: true }).selectOption('relay');
  await page.waitForFunction(() => window.settingsMock.settings.pack.narration.mode === 'relay');
  await page.getByRole('textbox', { name: '原助手称呼', exact: true }).fill('姐姐');
  await page.getByRole('heading', { name: '默认人格', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.pack.narration.assistant === '姐姐');
  await tab('转述');
  await page.getByRole('combobox', { name: '默认转述范围', exact: true }).selectOption('report');
  await page.waitForFunction(() => window.settingsMock.settings.trigger === 'report');
  await tab('人格');
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
  await page.getByRole('tab', { name: '人格', exact: true }).focus();
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: '高级', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('combobox', { name: '改写所用模型', exact: true }).selectOption('local');
  await page.getByRole('combobox', { name: '模型', exact: true }).selectOption('rewrite-small');
  await page.waitForFunction(() => window.settingsMock.settings.model === 'rewrite-small');
  await tab('聊天室');
  assert.equal(await page.getByRole('combobox',{name:'聊天室模型',exact:true}).inputValue(),'');
  assert.equal(await page.getByRole('checkbox',{name:'开启聊天室思考',exact:true}).isChecked(),false);
  await page.getByRole('combobox',{name:'聊天室模型',exact:true}).selectOption('local');
  await page.getByRole('combobox',{name:'聊天室模型名称',exact:true}).selectOption('rewrite-small');
  await page.getByRole('checkbox',{name:'开启聊天室思考',exact:true}).check();
  await page.waitForFunction(()=>window.settingsMock.settings.chatThinking===true&&window.settingsMock.settings.chatModel==='rewrite-small');
  assert.equal(await page.evaluate(()=>window.settingsMock.settings.provider),'local');
  await capture('settings-chat-model',1100,'light');await capture('settings-chat-model-mobile',390,'light');await capture('settings-chat-model-dark',1100,'dark');
  await tab('记忆');
  await fold('memory-add').locator(':scope > summary').click();
  const memoryDraft = page.getByRole('textbox', { name: '新增记忆内容' });
  await memoryDraft.fill('这个草稿在折叠后依然保留');
  await tab('人格');
  await tab('记忆');
  assert.equal(await memoryDraft.inputValue(), '这个草稿在折叠后依然保留');
  await capture('settings-memory-open', 1100, 'light');
  await capture('settings-memory-mobile', 390, 'light');
  await tab('外观');
  await capture('settings-appearance', 1100, 'light');
  assert.equal(await page.getByRole('checkbox', { name: '启用角色消息区（默认关闭）', exact: true }).count(), 0);
  assert.equal(await page.locator('.dsh-persona-preset[data-preset-id="generated"] .dsh-persona-preset-avatar').count(), 0, 'presets without a supplied avatar stay as text cards');
  assert.deepEqual(await page.evaluate(() => window.settingsMock.usageReads), [], 'normal settings do not request model usage');
  await tab('用量');
  const usage = page.getByRole('region', { name: '模型用量', exact: true });
  await usage.getByText('25,200', { exact: true }).waitFor();
  const unknown = usage.locator('details.mu-model').filter({ hasText: 'small-judge' });
  assert.match(await unknown.locator('summary').textContent(), /token 未上报/);
  const model = usage.locator('details.mu-model').filter({ hasText: 'deepseek-v4-flash' });
  await model.locator('summary').click();
  for (const name of ['汇报改写', '记忆提取']) await model.getByText(name, { exact: true }).waitFor();
  await model.getByText('其中推理 136（已含在输出，不重复计入）', { exact: true }).waitFor();
  await capture('settings-usage-light', 1100, 'light');
  await capture('settings-usage-dark', 1100, 'dark');
  await capture('settings-usage-mobile', 390, 'light');
  const usageFilter = usage.getByRole('combobox', { name: '筛选模型用途' });
  await usageFilter.selectOption('rewrite');
  assert.equal(await usage.locator('.mu-model').count(), 1);
  assert.match(await model.locator('summary').textContent(), /9 次18,600 token/);
  assert.equal(await model.getByText('记忆提取', { exact: true }).count(), 0);
  await model.getByText('其中推理 120（已含在输出，不重复计入）', { exact: true }).waitFor();
  await usageFilter.selectOption('chat');
  assert.equal(await usage.locator('.mu-model').count(), 2);
  await usageFilter.selectOption('all');
  const range = name => usage.getByRole('button', { name, exact: true });
  await page.evaluate(() => { window.settingsMock.holdUsage = 30; });
  await range('近 30 天').click();
  await usage.getByText('正在读取用量…').waitFor();
  await range('今天').click();
  await usage.getByText('这段时间还没有调用记录').waitFor();
  await page.evaluate(() => { window.settingsMock.resumeUsage(); window.settingsMock.holdUsage = null; });
  await page.waitForFunction(() => document.querySelector('.dsh-model-usage button[aria-pressed=true]')?.textContent === '今天');
  assert.equal(await usage.locator('.mu-model').count(), 0, 'a late old response cannot overwrite the selected range');
  await page.evaluate(() => { window.settingsMock.failUsage = true; });
  await range('近 30 天').click();
  await usage.getByText('暂时读不到用量').waitFor();
  await range('刷新').click();
  await usage.getByText('25,200', { exact: true }).waitFor();
  assert.equal(await usage.locator('.mu-bars i').count(), 30);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ result: 'passed', initialHeight, defaultVisibleEditors: 0,
    cases: ['progressive disclosure', 'failed save retains hidden draft', 'generated preset retry',
      'conditional quiet timing', 'narration relationship', 'default report scope', 'keyboard disclosure', 'model selection', 'memory draft retention', 'no message gate', 'desktop/mobile themes',
      'lazy usage statistics', 'usage coverage and model details', 'empty, stale and failed usage queries'],
    pageErrors: errors, externalRequests: external }));
} finally { await browser.close(); }
