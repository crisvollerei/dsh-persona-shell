// Optional real-React settings regression with a local mock Host and no model calls.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BUILTIN_PRESETS, normalizePack } from '../../lib/pack.js';
import { avatarContent, avatarUrl, builtinAvatar } from '../../lib/avatar.js';
import { roomCharacterContext } from '../../lib/character-roster.js';
import { createModelUsage } from '../../lib/model-usage.js';
import { parseGeneratedPreset } from '../../lib/preset.js';

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
const generatedPreset = {
  name: '清风', identity: '虚构守夜人，自称「吾」，偏爱安静地听雨。',
  narration: { mode: 'voice', assistant: '原助手' }, report: ['保留原报告的条件、未知与执行者归属。'],
  voice: ['正式转述语气：清楚、自然，不用聊天动作解释工作。'],
  samples: ['原文：本地检查通过，真实设备尚未验证。\n表达：本地检查已经通过，不过真实设备还没验证。'],
  avoid: ['不编造用户的动作或反馈。'], address: { user: '你', subagent: '帮手' },
  chat: { voice: ['聊天室语气：先听眼前这句话，偶尔偏爱雨声。'], samples: [],
    dialogueExamples: [{ turns: [{ speaker: 'user', text: '窗外还在下雨。' }, { speaker: 'self', text: '吾想再听一会儿，不急着关窗。' },
      { speaker: 'user', text: '给这阵雨留一个名字吧。' }, { speaker: 'self', text: '先叫它“窗边慢信”。'+ 'rain_window_ticket_'.repeat(14) }] },
      { turns: [{ speaker: 'user', text: '今天要把窗关上吗？' }, { speaker: 'self', text: '吾想再听一会儿，不过你先说冷不冷。' }, { speaker: 'user', text: '我还没决定。' }] }],
    workDialogueExamples: [{ turns: [{ speaker: '同伴', text: '本地检查通过，真机还没验。' }, { speaker: 'self', text: '吾偏向先看真机操作，不过目前只是建议。' }, { speaker: 'user', text: '先聊看法，不用执行。' }] }] },
};
const zeroExamplesPreset = { name: '零示例清风', ...normalizePack({ ...generatedPreset,
  chat: { voice: ['仍可用的独立聊天语气。'], samples: [], dialogueExamples: [], workDialogueExamples: [] } }) };
function generationWire(card) {
  const records = [['persona', 1], ['name', card.name], ['identity', card.identity],
    ['narration', card.narration.mode, card.narration.assistant], ['address', card.address.user, card.address.subagent],
    ...card.report.map(line => ['report', line]), ...card.voice.map(line => ['voice', line]),
    ...card.samples.map(line => { const [, original, expression] = /^原文：([\s\S]*?)\n表达：([\s\S]*)$/.exec(line); return ['sample', original, expression]; }),
    ...card.avoid.map(line => ['avoid', line]), ...card.chat.voice.map(line => ['chat_voice', line])];
  if (Object.hasOwn(card.chat, 'gender')) records.push(['gender', card.chat.gender]);
  for (const [key, tag] of [['dialogueExamples', 'daily'], ['workDialogueExamples', 'work']])
    for (const [index, group] of card.chat[key].entries()) for (const turn of group.turns) records.push([tag, index, turn.speaker, turn.text]);
  records.push(['end']);return records.map(record => JSON.stringify(record)).join('\n');
}
const seed = {
  settings: { enabled: true, includeToolSteps: true, processToolUsage: false,
    progressNotices: false, progressMinutes: 5, reviewHints: true, reviewThreshold: 0.55,
    subagentSteps: false, subagentReports: false, memory: true, memoryExtraction: false,
    provider: '', model: '', chatThinking: true, chatReasoningEffort: '', presetName: presets[0].name, pack: presets[0].pack },
  presets, generatedPreset, entries: [], settingsPosts: [], presetPosts: [], failSettings: false, failPreset: false,
  holdGenerate: false, failGenerate: false, periods, usageReads: [],
  userProfile:{instanceId:'settings-profile',revision:0,avatar:'/persona-shell/chat-profile/avatar?v=fixture',avatarMode:'custom',userAddress:'',userGender:'unset'},profilePosts:[],
  failProfile:false,conflictProfile:false,
  settingsGetFailures:[503,403,401,'network'],settingsReads:0,
  modelDirectoryReads:0,modelDirectoryFailure:true,modelListFailure:true,modelReads:[],modelAborts:[],holdModel:null,
};
const entry = [
  'import * as React from ' + JSON.stringify(deps.resolve('react')) + ';',
  'import { createRoot } from ' + JSON.stringify(deps.resolve('react-dom/client')) + ';',
  'import { parseGeneratedPreset as parseFixtureGenerated } from ' + JSON.stringify(fileURLToPath(new URL('../../lib/preset.js', import.meta.url))) + ';',
  'import { normalizePack as normalizeFixturePack } from ' + JSON.stringify(fileURLToPath(new URL('../../lib/pack.js', import.meta.url))) + ';',
  generationWire.toString(),
  'const h=React.createElement;let plugin;',
  'window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;throw Error(id)})}};',
  source,
  'const host=window.settingsMock=' + JSON.stringify(seed) + ';',
  'const snapshot=()=>({settings:structuredClone(host.settings),settingsPersistence:host.settingsPersistence||"saved",presets:structuredClone(host.presets),active:host.settings.presetName,memory:[],memoryStats:{messages:0,stated:0}});',
  'const reply=(body,ok=true)=>({ok,status:ok?200:503,json:async()=>structuredClone(body)});',
  'window.fetch=async(url,options)=>{const route=new URL(url,"https://example.invalid").pathname;',
  'if(route.endsWith("/model-usage")){const days=+new URL(url,"https://example.invalid").searchParams.get("days");host.usageReads.push(days);if(host.holdUsage===days)await new Promise(r=>host.resumeUsage=r);if(host.failUsage){host.failUsage=false;return reply({},false)}return reply(host.periods[days])}',
  'if(route.endsWith("/settings")){if(options?.method==="POST"){const patch=JSON.parse(options.body);host.settingsPosts.push(patch);',
  'if(host.failSettings){host.failSettings=false;return reply({error:"storage-not-ready"},false)}',
  'if(host.failAppliedSettings){host.failAppliedSettings=false;Object.assign(host.settings,patch);return reply({error:"settings-save-failed",appliedSettings:structuredClone(host.settings)},false)}',
  'if(host.holdSettings)await new Promise(r=>host.resumeSettings=r);',
  'if(patch.pack)patch.pack=normalizeFixturePack(patch.pack);Object.assign(host.settings,patch);if(patch.pack){let active=host.presets.find(p=>p.name===host.settings.presetName);',
  'if(active.builtin){active={id:"edited",name:active.name+" · 我的版本",builtin:false,pack:patch.pack};host.presets.push(active);host.settings.presetName=active.name}',
  'else active.pack=patch.pack}}else{host.settingsReads++;if(host.settingsGetFailures.length){const code=host.settingsGetFailures.shift();if(code==="network")throw Error("PRIVATE_NETWORK_ERROR");return{ok:false,status:code,json:async()=>({})}}}return reply(snapshot())}',
  'if(route.endsWith("/presets")){if(options){const body=JSON.parse(options.body);host.presetPosts.push(body);',
  'if(host.failPreset){host.failPreset=false;return reply({error:"storage-not-ready"},false)}',
  'if(body.action==="generate"){if(host.holdGenerate)await new Promise(r=>host.resumeGenerate=r);if(host.failGenerate){host.failGenerate=false;return reply({ok:false,reason:"generation-invalid-jsonl"})}return reply(parseFixtureGenerated(generationWire(host.generatedPreset),body.prompt))}',
  'if(body.action==="save"){const pack=normalizeFixturePack(body.pack),existing=host.presets.find(p=>!p.builtin&&p.name===body.name),entry={id:existing?.id||"generated",name:body.name,pack,builtin:false};if(existing)host.presets=host.presets.map(p=>p.id===existing.id?entry:p);else host.presets.push(entry);host.settings.pack=pack;host.settings.presetName=body.name}',
  'if(body.action==="avatar"){const p=host.presets.find(p=>p.id===body.id);if(body.expectedAvatar!==p.avatar)return reply({error:"avatar-conflict"},false);p.originalAvatar??=p.avatar;p.avatar=body.avatar??p.originalAvatar;p.avatarOverridden=p.builtin&&!!body.avatar}',
  'if(body.action==="apply"){const p=host.presets.find(p=>p.id===body.id);host.settings.pack=p.pack;host.settings.presetName=p.name}}return reply({ok:true,...snapshot()})}',
  'if(route.endsWith("/models")){const provider=new URL(url,"https://example.invalid").searchParams.get("provider");if(!provider){host.modelDirectoryReads++;if(host.modelDirectoryFailure){host.modelDirectoryFailure=false;return reply({providers:[],models:[],error:"models-unavailable"})}}else{host.modelReads.push(provider);options?.signal?.addEventListener("abort",()=>host.modelAborts.push(provider),{once:true});if(host.holdModel===provider)await new Promise(r=>host.resumeModel=r);if(host.modelListFailure){host.modelListFailure=false;return reply({providers:[],models:[],error:"models-unavailable"})}}return reply({providers:[{provider:"local",name:"示例提供方"},{provider:"slow",name:"延迟提供方"},{provider:"fast",name:"当前提供方"}],models:[{id:provider==="slow"?"late-model":provider==="fast"?"fresh-model":"rewrite-small",name:provider==="slow"?"过时模型":provider==="fast"?"当前模型":"示例转述模型"}]})}',
  'if(route.endsWith("/chat-model-options"))return reply({provider:host.settings.chatProvider||host.settings.provider,model:host.settings.chatModel||host.settings.model,status:"available",efforts:[{id:"off",name:"关闭"},{id:"low",name:"低"},{id:"high",name:"高"}],defaultEffort:"high"});',
  'if(route.endsWith("/chat-profile")){if(options?.method==="POST"){const patch=JSON.parse(options.body);host.profilePosts.push(patch);if(host.failProfile){host.failProfile=false;return reply({error:"storage-not-ready"},false)}if(host.conflictProfile){host.conflictProfile=false;Object.assign(host.userProfile,{revision:host.userProfile.revision+1,userGender:"female",userAddress:"另一处已更新的称呼"})}if(patch.revision!==host.userProfile.revision)return{ok:false,status:409,json:async()=>({error:"profile-conflict",state:structuredClone(host.userProfile)})};Object.assign(host.userProfile,patch,{revision:host.userProfile.revision+1})}return reply(host.userProfile)}',
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
  assets.set(new URL(seed.userProfile.avatar, 'https://persona.test').href, avatarContent(builtinAvatar(presets[0].id)).file);
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
  for(const message of ['暂时无法读取设置，请重试。','设置未能读取。请重新连接 DSH 后重试。','设置未能读取。请重新连接 DSH 后重试。','暂时无法读取设置，请重试。']){
    await page.getByText(message,{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.settingsMock.settingsPosts),[],'a read retry never resends a settings write');
    assert.equal(await page.evaluate(()=>window.settingsMock.modelDirectoryReads),0,'provider discovery waits until authenticated settings are available');
    await page.getByRole('button',{name:'重新读取设置',exact:true}).click();
  }
  await page.locator('.dsh-persona-preset[data-active="true"]').waitFor();
  assert.equal(await page.evaluate(()=>window.settingsMock.settingsReads),5);
  assert.equal(await page.evaluate(()=>window.settingsMock.modelDirectoryReads),0,'the persona page does not prefetch model metadata');
  assert.deepEqual(await page.evaluate(()=>window.settingsMock.modelReads),[]);
  assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE_NETWORK_ERROR/);
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
  const avatarBefore=await page.evaluate(()=>({active:window.settingsMock.settings.presetName,pack:window.settingsMock.settings.pack,ids:window.settingsMock.presets.map(p=>p.id),character:window.settingsMock.presets.find(p=>p.id==='Gemini').character}));
  await cat.getByRole('button',{name:'修改Gemini头像',exact:true}).click();
  await page.getByRole('group',{name:'编辑人格头像',exact:true}).getByText('只覆盖这位内置人格在本机的显示头像，可恢复原图。身份、默认选择、房间成员与私人记忆归属保持不变。',{exact:true}).waitFor();
  await page.getByLabel('选择头像图片',{exact:true}).setInputFiles({name:'avatar.webp',mimeType:'image/webp',buffer:readFileSync(avatarContent(builtinAvatar(presets[0].id)).file)});
  await page.getByRole('button',{name:'保存头像',exact:true}).click();
  await page.waitForFunction(()=>window.settingsMock.presets.find(p=>p.id==='Gemini').avatarOverridden===true);
  assert.deepEqual(await page.evaluate(()=>({active:window.settingsMock.settings.presetName,pack:window.settingsMock.settings.pack,ids:window.settingsMock.presets.map(p=>p.id),character:window.settingsMock.presets.find(p=>p.id==='Gemini').character})),avatarBefore,'builtin avatar overlays do not create or select a persona');
  await cat.getByRole('button',{name:'修改Gemini头像',exact:true}).click();await page.getByRole('button',{name:'恢复原头像',exact:true}).click();
  await page.waitForFunction(()=>window.settingsMock.presets.find(p=>p.id==='Gemini').avatarOverridden===false);
  assert.deepEqual(await page.evaluate(()=>window.settingsMock.presets.map(p=>p.id)),avatarBefore.ids);
  const fold = (id) => page.locator('[data-settings-fold="' + id + '"]');
  const tab = (label) => page.getByRole('tab', { name: label, exact: true }).click();
  await tab('转述');
  const colloquial = page.getByRole('checkbox', { name: '口语化转述', exact: true });
  assert.equal(await colloquial.isChecked(), true, 'missing stored values use the enabled default');
  const colloquialHint = await colloquial.getAttribute('aria-describedby');
  assert.equal(await page.locator('[id="' + colloquialHint + '"]').textContent(), '把书面说明讲得顺口一些，事实、条件和风险完整保留。关闭后更贴近原文句式。');
  await colloquial.uncheck(); await page.waitForFunction(() => window.settingsMock.settings.colloquialReports === false);
  await tab('人格'); await tab('转述'); assert.equal(await colloquial.isChecked(), false, 'the saved choice survives category changes');
  await page.evaluate(() => { window.settingsMock.failSettings = true; }); await colloquial.click();
  await page.locator('.dsh-persona-save-state').filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await colloquial.isChecked(), false, 'failed save does not pretend the option was enabled');
  await colloquial.check(); await page.waitForFunction(() => window.settingsMock.settings.colloquialReports === true);
  await page.evaluate(() => { window.settingsMock.holdSettings = true; });
  await colloquial.click(); await page.waitForFunction(() => !!window.settingsMock.resumeSettings);
  assert.equal(await page.locator('.dsh-persona-save-state').innerText(), '正在保存…', 'delayed acknowledgement cannot display saved');
  await page.evaluate(() => { window.settingsMock.holdSettings = false; window.settingsMock.resumeSettings(); delete window.settingsMock.resumeSettings; });
  await page.waitForFunction(() => window.settingsMock.settings.colloquialReports === false);
  await page.evaluate(() => { window.settingsMock.failAppliedSettings = true; });
  await colloquial.check();
  await page.getByText('当前已生效，但保存失败。', { exact: true }).waitFor();
  assert.equal(await colloquial.isChecked(), true, 'the failure reports the actual live setting');
  const retrySettings = page.getByRole('button', { name: '重试保存当前设置', exact: true });
  await retrySettings.waitFor();
  await capture('settings-save-failure', 1100, 'light');
  await capture('settings-save-failure-mobile', 390, 'light'); await capture('settings-save-failure-dark', 390, 'dark');
  await retrySettings.click(); await page.waitForFunction(() => JSON.stringify(window.settingsMock.settingsPosts.at(-1)) === '{}');
  await page.getByText('已保存', { exact: true }).waitFor(); assert.equal(await retrySettings.count(), 0);
  for (const persistence of ['pending', 'memory-only']) {
    await page.evaluate(value => { window.settingsMock.settingsPersistence = value; }, persistence);
    await colloquial.click();
    await page.getByText(persistence === 'pending' ? '当前已生效，存储尚未就绪。' : '仅本次生效，当前没有可用存储。', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('.dsh-persona-save-state').innerText(), /已保存/);
  }
  await page.evaluate(() => { window.settingsMock.settingsPersistence = 'saved'; });
  await capture('settings-rewrite', 1100, 'light');
  await capture('settings-rewrite-mobile', 390, 'light'); await capture('settings-rewrite-dark', 1100, 'dark');
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
  const personaGender = page.getByRole('combobox', { name: '人格性别（聊天室）', exact: true });
  assert.equal(await personaGender.inputValue(), 'female');
  assert.equal(await personaGender.isDisabled(), true, 'builtin gender is fixed rather than an editable custom field');
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
  const processSteps = page.getByRole('checkbox', { name: '同时改写阶段性输出', exact: true });
  const processInfo = page.getByRole('checkbox', { name: '允许过程转述参考运行信息', exact: true });
  await processInfo.check(); await page.waitForFunction(() => window.settingsMock.settings.processToolUsage === true);
  await page.getByRole('combobox', { name: '默认转述范围', exact: true }).selectOption('report');
  await page.waitForFunction(() => window.settingsMock.settings.trigger === 'report');
  assert.equal(await processSteps.isDisabled(), true); assert.equal(await processInfo.isDisabled(), true);
  assert.equal(await processSteps.isChecked(), true); assert.equal(await processInfo.isChecked(), true);
  await page.getByText('仅最终汇报不使用以下过程选项，原选择已保留；独立设为全部汇报的会话仍沿用这些选择。', { exact: true }).waitFor();
  await capture('settings-final-only', 1100, 'light'); await capture('settings-final-only-mobile', 390, 'dark');
  await page.getByRole('combobox', { name: '默认转述范围', exact: true }).selectOption('step');
  await page.waitForFunction(() => window.settingsMock.settings.trigger === 'step');
  assert.equal(await processSteps.isDisabled(), false); assert.equal(await processInfo.isDisabled(), false);
  assert.equal(await processInfo.isChecked(), true);
  await processSteps.uncheck(); await page.waitForFunction(() => window.settingsMock.settings.includeToolSteps === false);
  assert.equal(await processInfo.isDisabled(), true); assert.equal(await processInfo.isChecked(), true);
  await processSteps.check(); await page.waitForFunction(() => window.settingsMock.settings.includeToolSteps === true);
  await tab('人格');
  await fold('edit-persona').locator(':scope > summary').click();
  await fold('create-persona').locator(':scope > summary').click();
  const generationSource = '一个自然、温和又简洁的虚构守夜人，自称吾，喜欢听雨；聊天保留自己的偏好，转述时保留所有条件和风险。角色卡标识：' + 'source_reference_'.repeat(12);
  const expectedGenerated = parseGeneratedPreset(generationWire(generatedPreset), generationSource);
  assert.equal(expectedGenerated.ok, true, 'the fixture is a complete production-valid generated card');
  const expectedReviewed = structuredClone(expectedGenerated.preset);
  expectedReviewed.chat.source.enabled = false;
  expectedReviewed.chat.gender = 'none';
  const beforeGeneration = await page.evaluate(() => ({ pack: window.settingsMock.settings.pack,
    active: window.settingsMock.settings.presetName, count: window.settingsMock.presets.length,
    writes: window.settingsMock.settingsPosts.length }));
  await page.getByRole('textbox', { name: '人设提示词', exact: true }).fill(generationSource);
  await page.getByRole('button', { name: '生成预设', exact: true }).click();
  const name = page.getByRole('textbox', { name: '新预设名称', exact: true });
  const previewIdentity = page.getByRole('textbox', { name: '生成身份摘要', exact: true });
  const previewNarration = page.getByRole('combobox', { name: '生成发言关系', exact: true });
  const previewAssistant = page.getByRole('textbox', { name: '生成原助手称呼', exact: true });
  const previewUser = page.getByRole('textbox', { name: '生成用户称呼', exact: true });
  const previewSubagent = page.getByRole('textbox', { name: '生成子代理称呼', exact: true });
  const previewGender = page.getByRole('combobox', { name: '生成人格性别（聊天室）', exact: true });
  const generatedReview = page.getByRole('dialog', { name: '核对生成的人格', exact: true });
  const generatedReviewSummary = fold('create-persona').locator('summary').filter({ hasText: /^核对生成结果（未保存）$/ });
  await generatedReview.waitFor();
  assert.equal(await generatedReview.evaluate(element => element.ownerDocument.activeElement === element), true,
    'successful generation focuses the editable review once');
  assert.equal(await previewGender.locator('option[value="unset"]').textContent(), '不指定');
  assert.equal(await previewGender.locator('option[value="none"]').textContent(), '无性别（如明确无性别的智能助手）');
  await generatedReview.getByText('不指定表示不作判断；无性别是明确设定，并非所有 AI 都无性别。男娘、假小子是表达风格，不能从气质、衣着或外形推定性别；请按原设或自行选择。', { exact: true }).waitFor();
  await name.fill('我的清风');
  await page.keyboard.press('Escape');
  await generatedReview.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '生成预设', exact: true }).evaluate(element => element.ownerDocument.activeElement === element), true,
    'Escape returns focus to the generation button without saving');
  await generatedReviewSummary.click();
  await generatedReview.waitFor();
  assert.equal(await name.inputValue(), '我的清风', 'reopening uses the same unsaved draft');
  assert.equal(await generatedReview.evaluate(element => element.ownerDocument.activeElement === element), true);
  await generatedReview.getByRole('button', { name: '稍后编辑', exact: true }).click();
  await generatedReview.waitFor({ state: 'hidden' });
  assert.equal(await generatedReviewSummary.evaluate(element => element.ownerDocument.activeElement === element), true,
    'closing a manually reopened review returns focus to its disclosure');
  await generatedReviewSummary.click();
  await generatedReview.waitFor();
  assert.equal(await previewGender.inputValue(), 'unset', 'old generation wire without gender remains valid and does not infer gender');
  await previewGender.selectOption('none');
  assert.deepEqual(await page.evaluate(() => ({ pack: window.settingsMock.settings.pack,
    active: window.settingsMock.settings.presetName, count: window.settingsMock.presets.length,
    writes: window.settingsMock.settingsPosts.length })), beforeGeneration, 'generation previews without saving or changing the active persona');
  const generatedChat = fold('create-persona').locator('[aria-label="生成的聊天表达"]');
  await generatedChat.getByText(generatedPreset.chat.voice[0], { exact: true }).waitFor();
  await generatedChat.getByText('日常多轮示例：2组；工作讨论示例：1组。', { exact: true }).waitFor();
  assert.equal(await previewIdentity.inputValue(), generatedPreset.identity);
  assert.equal(await previewNarration.inputValue(), 'voice');
  assert.equal(await previewAssistant.inputValue(), '原助手');
  assert.equal(await previewUser.inputValue(), '你');
  assert.equal(await previewSubagent.inputValue(), '帮手');
  await fold('create-persona').getByText('工作转述', { exact: true }).waitFor();
  await fold('create-persona').getByText('语气：' + generatedPreset.voice[0], { exact: true }).waitFor();
  await generatedChat.getByText('示例是虚构风格参考，不是实际经历或记忆。', { exact: true }).waitFor();
  assert.equal(await generatedChat.locator('details[open]').count(), 0, 'fictional examples are initially collapsed');
  const previewSource = generatedChat.getByRole('checkbox', { name: '生成预览参考原始人设', exact: true });
  assert.equal(await previewSource.isChecked(), true);
  const previewSourceDetails = generatedChat.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^原始人设参考/ }) });
  await previewSourceDetails.locator('summary').click();
  await previewSourceDetails.getByText(generationSource, { exact: true }).waitFor();
  assert.equal(await previewSourceDetails.locator('input,textarea,[contenteditable="true"]').count(), 0, 'the source is read-only role material');
  await previewSourceDetails.getByText('仅作虚构角色资料，当前身份、语气和用户本次原话优先；不是实际经历、长期记忆或工具权限，不提供给工作转述。', { exact: true }).waitFor();
  await previewSource.uncheck();
  await previewSourceDetails.getByText('原始人设参考（未启用）', { exact: true }).waitFor();
  await generatedChat.getByText('日常虚构示例', { exact: true }).click();
  await generatedChat.getByText('工作讨论虚构示例', { exact: true }).click();
  await generatedChat.getByText('本人：吾偏向先看真机操作，不过目前只是建议。', { exact: false }).waitFor();
  await fold('create-persona').getByText('转述示例', { exact: true }).click();
  await fold('create-persona').getByText('表达边界', { exact: true }).click();
  await fold('create-persona').getByText(generatedPreset.avoid[0], { exact: true }).waitFor();
  await capture('settings-generated-channels', 1100, 'light');
  await capture('settings-generated-channels-mobile', 390, 'light');
  if (values.output) await fold('create-persona').screenshot({ path: path.join(values.output, 'settings-generated-preview-detail-mobile.png'), animations: 'disabled' });
  await capture('settings-generated-channels-mobile-dark', 390, 'dark');
  const mobileReview = await generatedReview.evaluate(element => ({ visible: element.clientHeight, content: element.scrollHeight,
    viewport: innerHeight, width: element.clientWidth, contentWidth: element.scrollWidth }));
  assert.ok(mobileReview.content > mobileReview.visible && mobileReview.visible <= mobileReview.viewport * 0.74,
    'the long review has a bounded independent scroll area on mobile');
  assert.ok(mobileReview.contentWidth <= mobileReview.width + 1, 'review controls and long text fit the mobile width');
  await generatedReview.getByRole('button', { name: '保存并启用', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await generatedReview.evaluate(element => element.scrollTop > 0), true, 'the review footer remains reachable by scrolling');
  if (values.output) await generatedReview.screenshot({ path: path.join(values.output, 'settings-generated-review-footer-mobile.png'), animations: 'disabled' });
  await generatedReview.evaluate(element => { element.scrollTop = 0; });
  if (values.output) await generatedReview.screenshot({ path: path.join(values.output, 'settings-generated-review-top-mobile.png'), animations: 'disabled' });
  assert.equal(await generatedChat.locator('details > div').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true,
    'expanded long example text wraps inside 390px details');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.getByRole('textbox', { name: '人设提示词', exact: true }).fill('后来编辑的另一份人设材料，不属于当前已经生成的待保存结果。');
  await page.evaluate(() => { window.settingsMock.holdGenerate = true; window.settingsMock.failGenerate = true; });
  await page.getByRole('button', { name: '生成预设', exact: true }).click();
  await page.waitForFunction(() => typeof window.settingsMock.resumeGenerate === 'function');
  assert.equal(await name.inputValue(), '我的清风', 'in-flight regeneration keeps the previous preview name');
  assert.equal(await name.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '保存并启用', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '丢弃', exact: true }).isDisabled(), true);
  assert.equal(await previewSource.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '稍后编辑', exact: true }).isDisabled(), true);
  for (const field of [previewIdentity, previewNarration, previewAssistant, previewUser, previewSubagent, previewGender]) {
    assert.equal(await field.isDisabled(), true, 'generation locks the editable identity, narration and names too');
  }
  await page.evaluate(() => { window.settingsMock.holdGenerate = false; window.settingsMock.resumeGenerate(); delete window.settingsMock.resumeGenerate; });
  await page.getByText('模型返回的结构或多轮示例不完整，未采用。输入和已有预览已保留，可调整后重新生成。', { exact: true }).waitFor();
  assert.equal(await name.inputValue(), '我的清风');
  assert.equal(await name.isDisabled(), false);
  assert.equal(await previewSource.isChecked(), false, 'strict generation failure preserves the old preview source preference');
  assert.equal(await page.getByRole('textbox', { name: '人设提示词', exact: true }).inputValue(), '后来编辑的另一份人设材料，不属于当前已经生成的待保存结果。');
  await generatedChat.getByText(generatedPreset.chat.voice[0], { exact: true }).waitFor();
  await page.evaluate(() => { window.settingsMock.failPreset = true; });
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await page.getByText('失败：storage-not-ready', { exact: true }).waitFor();
  assert.equal(await generatedReview.isVisible(), true, 'failed save leaves the review and its corrected draft available');
  assert.equal(await name.inputValue(), '我的清风');
  await generatedChat.getByText(generatedPreset.chat.voice[0], { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack), beforeGeneration.pack, 'failed save keeps the active card');
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.presetName === '我的清风');
  await page.locator('.dsh-persona-preset[data-active="true"]').filter({ hasText: '我的清风' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.settingsMock.presetPosts.filter(p => p.action === 'save').map(p => ({ pack: p.pack, source: p.source }))),
    [{ pack: expectedReviewed, source: generationSource }, { pack: expectedReviewed, source: generationSource }],
    'failed save and retry both carry the complete reviewed card and its original source');
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.chat), expectedReviewed.chat);
  assert.equal(await name.count(), 0, 'successful save closes the generated preview');
  assert.equal(await fold('create-persona').locator(':scope > summary').evaluate(element => element.ownerDocument.activeElement === element), true,
    'saving returns focus to the visible creation disclosure rather than hidden or removed controls');

  await fold('edit-persona').locator(':scope > summary').click();
  assert.equal(await personaGender.isDisabled(), false);
  assert.equal(await personaGender.inputValue(), 'none', 'preview gender is saved into the custom card');
  await personaGender.selectOption('male');
  await page.waitForFunction(() => window.settingsMock.settings.pack.chat.gender === 'male');
  await personaGender.selectOption('none');
  await page.waitForFunction(() => window.settingsMock.settings.pack.chat.gender === 'none');
  await selectPreset('Gemini');
  if (!await fold('edit-persona').evaluate(element => element.open)) await fold('edit-persona').locator(':scope > summary').click();
  assert.equal(await personaGender.inputValue(), 'female'); assert.equal(await personaGender.isDisabled(), true);
  await selectPreset('generated');
  if (!await fold('edit-persona').evaluate(element => element.open)) await fold('edit-persona').locator(':scope > summary').click();
  assert.equal(await personaGender.inputValue(), 'none', 'custom gender survives switching away from a builtin and back');
  const reportVoice = page.getByRole('textbox', { name: '通用语感', exact: true });
  const chatVoice = page.getByRole('textbox', { name: '聊天室语气', exact: true });
  const independentChat = fold('edit-persona').locator('[aria-label="独立聊天表达"]');
  const sourceToggle = independentChat.getByRole('checkbox', { name: '聊天室参考原始人设', exact: true });
  const savedSourceDetails = independentChat.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^原始人设参考/ }) });
  assert.equal(await reportVoice.inputValue(), generatedPreset.voice.join('\n'));
  assert.equal(await chatVoice.inputValue(), generatedPreset.chat.voice.join('\n'));
  assert.equal(await sourceToggle.isChecked(), false, 'the preview opt-out survives saving');
  await savedSourceDetails.locator('summary').click();
  await savedSourceDetails.getByText(generationSource, { exact: true }).waitFor();
  assert.equal(await savedSourceDetails.locator('input,textarea,[contenteditable="true"]').count(), 0);
  await sourceToggle.check();
  await page.waitForFunction(() => window.settingsMock.settings.pack.chat.source.enabled === true);
  assert.equal(await sourceToggle.isChecked(), true);
  const activeChatBeforeEdit = await page.evaluate(() => window.settingsMock.settings.pack.chat);
  await reportVoice.fill('只更新正式转述的语气，不动聊天材料。');
  await page.getByRole('heading', { name: '默认人格', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.pack.voice[0] === '只更新正式转述的语气，不动聊天材料。');
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.chat), activeChatBeforeEdit, 'editing the top report voice preserves chat source binding');
  assert.equal(await sourceToggle.isChecked(), true);

  const editedIdentity = generatedPreset.identity + '现在也会留意风声。';
  await identity.fill(editedIdentity); await page.getByRole('heading', { name: '默认人格', exact: true }).click();
  await page.waitForFunction(value => window.settingsMock.settings.pack.identity === value, editedIdentity);
  assert.equal(await sourceToggle.isChecked(), false, 'manual identity changes invalidate the old source snapshot');
  assert.equal(await page.evaluate(() => window.settingsMock.settings.pack.chat.source.enabled), true, 'enabled alone is insufficient when its identity snapshot no longer matches');
  assert.equal(await page.evaluate(() => window.settingsMock.settings.pack.chat.source.text), generationSource);
  await savedSourceDetails.getByText('原始人设参考（未启用）', { exact: true }).waitFor();
  await sourceToggle.check();
  await page.waitForFunction(value => window.settingsMock.settings.pack.chat.source.identity === value, editedIdentity);
  assert.equal(await sourceToggle.isChecked(), true, 'explicit use rebinds to the current saved identity');
  await sourceToggle.uncheck();
  await page.waitForFunction(() => window.settingsMock.settings.pack.chat.source.enabled === false);
  assert.equal(await sourceToggle.isChecked(), false);
  await sourceToggle.check();
  await page.waitForFunction(() => window.settingsMock.settings.pack.chat.source.enabled === true);
  const boundChatBeforeVoiceEdit = await page.evaluate(() => window.settingsMock.settings.pack.chat);

  await page.evaluate(() => { window.settingsMock.failSettings = true; });
  await chatVoice.fill('只更新聊天的语气，仍然保留多轮示例。');
  await fold('edit-persona').locator(':scope > summary').click();
  await page.locator('.dsh-persona-save-state').filter({ hasText: '保存失败' }).waitFor();
  await fold('edit-persona').locator(':scope > summary').click();
  assert.equal(await chatVoice.inputValue(), '只更新聊天的语气，仍然保留多轮示例。', 'failed chat save keeps the hidden input draft');
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.chat), boundChatBeforeVoiceEdit, 'failed chat save does not claim to persist the draft');
  await chatVoice.focus(); await page.getByRole('heading', { name: '默认人格', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.pack.chat.voice[0] === '只更新聊天的语气，仍然保留多轮示例。');
  let afterChatEdit = await page.evaluate(() => window.settingsMock.settings.pack);
  assert.deepEqual(afterChatEdit.voice, ['只更新正式转述的语气，不动聊天材料。'], 'chat voice edit leaves report voice intact');
  assert.deepEqual(afterChatEdit.chat.dialogueExamples, generatedPreset.chat.dialogueExamples);
  assert.deepEqual(afterChatEdit.chat.workDialogueExamples, generatedPreset.chat.workDialogueExamples);
  assert.deepEqual(afterChatEdit.chat.samples, generatedPreset.chat.samples);
  assert.equal(await sourceToggle.isChecked(), false, 'manual chat voice changes invalidate the source snapshot');
  assert.equal(afterChatEdit.chat.source.enabled, true, 'the stale voice snapshot is checked separately from its enabled flag');
  assert.equal(afterChatEdit.chat.source.text, generationSource, 'invalidating does not delete the original text');
  await sourceToggle.check();
  await page.waitForFunction(() => window.settingsMock.settings.pack.chat.source.voice[0] === '只更新聊天的语气，仍然保留多轮示例。');
  assert.equal(await sourceToggle.isChecked(), true, 'explicit use rebinds the current saved chat voice');
  afterChatEdit = await page.evaluate(() => window.settingsMock.settings.pack);
  await independentChat.getByText('日常虚构示例', { exact: true }).click();
  await independentChat.getByText('工作讨论虚构示例', { exact: true }).click();
  await capture('settings-chat-editor-mobile', 390, 'light');
  if (values.output) await independentChat.screenshot({ path: path.join(values.output, 'settings-chat-editor-detail-mobile.png'), animations: 'disabled' });
  await capture('settings-chat-editor-mobile-dark', 390, 'dark');
  await page.setViewportSize({ width: 1100, height: 1000 });
  const loadStoredGenerated = async pack => {
    await selectPreset('Gemini');
    await page.evaluate(value => { window.settingsMock.presets.find(persona => persona.id === 'generated').pack = value; }, pack);
    await selectPreset('generated');
    if (!await fold('edit-persona').evaluate(element => element.open)) await fold('edit-persona').locator(':scope > summary').click();
  };
  const bindingLimitHint = '重新启用需要身份摘要在4000字内、有效聊天语气最多8条且每条400字；请调整后再启用，原始材料仍保留。';
  for (const variant of ['identity-4001', 'inherited-voice-10', 'inherited-line-401']) {
    const stored = structuredClone(afterChatEdit);
    if (variant === 'identity-4001') stored.identity = '身'.repeat(4001);
    else {
      delete stored.chat.voice;
      stored.voice = variant === 'inherited-voice-10' ? Array.from({ length: 10 }, (_, index) => '基础语气' + index) : ['长'.repeat(401)];
    }
    await loadStoredGenerated(stored);
    assert.equal(await sourceToggle.isChecked(), false, variant + ' cannot match the old snapshot');
    assert.equal(await sourceToggle.isDisabled(), true, variant + ' blocks use before any write');
    await independentChat.getByText(bindingLimitHint, { exact: true }).waitFor();
    const oldSource = structuredClone(stored.chat.source), beforeSkipWrites = await page.evaluate(() => window.settingsMock.settingsPosts.length);
    assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.chat.source), oldSource, 'over-limit current fields do not delete the valid old source');
    const skipSource = independentChat.getByRole('button', { name: '停用这份原始参考', exact: true });
    assert.equal(await skipSource.isDisabled(), false, 'skip remains available outside the binding limits');
    if (variant === 'identity-4001') {
      await capture('settings-source-binding-limit-mobile', 390, 'light');
      if (values.output) await independentChat.screenshot({ path: path.join(values.output, 'settings-source-binding-limit-detail-mobile.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 1100, height: 1000 });
    }
    await skipSource.click();
    await page.waitForFunction(() => window.settingsMock.settings.pack.chat.source.enabled === false);
    assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.chat.source), { ...oldSource, enabled: false });
    assert.equal(await page.evaluate(() => window.settingsMock.settingsPosts.length), beforeSkipWrites + 1, 'skip is an explicit single settings write');
    assert.equal(await sourceToggle.isDisabled(), true);
  }

  const paddedInherited = structuredClone(afterChatEdit);
  delete paddedInherited.chat.voice;
  paddedInherited.voice = ['  慢一些  '];
  await loadStoredGenerated(paddedInherited);
  assert.equal(await sourceToggle.isChecked(), false);
  assert.equal(await sourceToggle.isDisabled(), false);
  await sourceToggle.check();
  await page.waitForFunction(() => window.settingsMock.settings.pack.chat.source.voice[0] === '  慢一些  ');
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.voice), ['  慢一些  ']);
  assert.equal(await sourceToggle.isChecked(), true, 'inherited top voice keeps its original whitespace in the snapshot and after Host normalization');

  const queuedBindingPack = structuredClone(afterChatEdit);
  queuedBindingPack.identity = '当前可绑定但尚未重绑的新身份';
  await loadStoredGenerated(queuedBindingPack);
  assert.equal(await sourceToggle.isChecked(), false);
  assert.equal(await sourceToggle.isDisabled(), false);
  const avoid = page.getByRole('textbox', { name: '避免出现', exact: true });
  const retainedOtherDraft = '这条其他字段的失败草稿必须在绑定拒绝后继续保留。';
  await page.evaluate(() => { window.settingsMock.failSettings = true; });
  await avoid.fill(retainedOtherDraft); await page.getByRole('heading', { name: '默认人格', exact: true }).click();
  await page.locator('.dsh-persona-save-state').filter({ hasText: '保存失败' }).waitFor();
  const queuedSource = structuredClone(queuedBindingPack.chat.source);
  const writesBeforeQueuedIdentity = await page.evaluate(() => window.settingsMock.settingsPosts.length);
  await page.evaluate(() => { window.settingsMock.holdSettings = true; });
  await identity.fill('身'.repeat(4001)); await page.getByRole('heading', { name: '默认人格', exact: true }).click();
  await page.waitForFunction(() => typeof window.settingsMock.resumeSettings === 'function');
  assert.equal(await sourceToggle.isDisabled(), false, 'the preceding identity write has not acknowledged yet');
  await sourceToggle.click();
  await page.evaluate(() => { window.settingsMock.holdSettings = false; window.settingsMock.resumeSettings(); delete window.settingsMock.resumeSettings; });
  await page.getByText('当前身份或聊天语气超出原始参考的绑定范围，未启用，原文仍保留。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.settingsMock.settingsPosts.length), writesBeforeQueuedIdentity + 1,
    'queued use validates the final pack and does not dispatch an invalid binding write');
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.chat.source), queuedSource);
  assert.equal(await avoid.inputValue(), retainedOtherDraft, 'binding refusal cannot clear another field draft');
  // Applying another card flushes remaining drafts: a stale failed use intent must not block this.
  await selectPreset('Gemini'); await selectPreset('generated');
  if (!await fold('edit-persona').evaluate(element => element.open)) await fold('edit-persona').locator(':scope > summary').click();
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.avoid), [retainedOtherDraft]);
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.chat.source), queuedSource);
  await independentChat.getByRole('button', { name: '停用这份原始参考', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.pack.chat.source.enabled === false);
  assert.equal(await page.evaluate(() => window.settingsMock.settings.pack.chat.source.text), generationSource);
  await loadStoredGenerated(afterChatEdit);
  assert.equal(await sourceToggle.isChecked(), true, 'valid saved binding is restored for the remaining unchanged regressions');
  assert.equal(await personaGender.inputValue(), 'none');
  await independentChat.getByRole('button', { name: '恢复基础表达并清除聊天示例', exact: true }).click();
  await page.waitForFunction(() => Object.keys(window.settingsMock.settings.pack.chat || {}).length === 1
    && window.settingsMock.settings.pack.chat.gender === 'none');
  const { chat: genderResetChat, ...genderResetBase } = afterChatEdit;
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack), { ...genderResetBase, chat: { gender: 'none' } },
    'restoring base expression retains explicit gender while removing chat voice, examples and source');
  assert.equal(await personaGender.inputValue(), 'none');
  assert.equal(await sourceToggle.count(), 0);
  await capture('settings-persona-gender-reset-mobile', 390, 'light');
  await page.setViewportSize({ width: 1100, height: 1000 });
  const legacyChatWithoutGender = structuredClone(afterChatEdit);
  delete legacyChatWithoutGender.chat.gender;
  await loadStoredGenerated(legacyChatWithoutGender);
  afterChatEdit = legacyChatWithoutGender;
  assert.equal(await personaGender.inputValue(), 'unset', 'legacy cards without gender retain the unset default');
  assert.equal(await sourceToggle.isChecked(), true);
  const writesBeforeLimit = await page.evaluate(() => window.settingsMock.settingsPosts.length);
  for (const value of [Array.from({ length: 9 }, (_, i) => '第' + (i + 1) + '条').join('\n'), '长'.repeat(401)]) {
    await chatVoice.fill(value); await page.getByRole('heading', { name: '默认人格', exact: true }).click();
    await page.getByText('聊天室语气最多8条，每条400字；请缩短后保存。', { exact: true }).waitFor();
    assert.equal(await chatVoice.inputValue(), value, 'over-limit input remains a local draft');
    assert.equal(await page.evaluate(() => window.settingsMock.settingsPosts.length), writesBeforeLimit, 'over-limit voice cannot dispatch a settings write');
    assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack), afterChatEdit);
  }
  await page.evaluate(() => { window.settingsMock.failSettings = true; });
  await chatVoice.fill('这条失败草稿在恢复基础表达后不能复活。');
  await page.getByRole('heading', { name: '默认人格', exact: true }).click();
  await page.locator('.dsh-persona-save-state').filter({ hasText: '保存失败' }).waitFor();
  await independentChat.getByRole('button', { name: '恢复基础表达并清除聊天示例', exact: true }).click();
  await page.waitForFunction(() => !Object.hasOwn(window.settingsMock.settings.pack, 'chat'));
  const { chat: removedChat, ...expectedBase } = afterChatEdit;
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack), expectedBase, 'restore removes only chat expression and examples');
  assert.equal(await chatVoice.count(), 0);
  assert.equal(await sourceToggle.count(), 0, 'restoring base chat removes the source reference too');
  await independentChat.getByRole('button', { name: '从基础语感设置聊天表达', exact: true }).waitFor();
  await selectPreset('Gemini'); await selectPreset('generated');
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack), expectedBase, 'switching cards cannot resurrect a failed chat draft after reset');
  assert.equal(await chatVoice.count(), 0);
  await independentChat.getByRole('button', { name: '从基础语感设置聊天表达', exact: true }).click();
  await page.waitForFunction(() => !!window.settingsMock.settings.pack.chat);
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.chat), { samples: [], voice: expectedBase.voice }, 'explicitly rebuilding chat starts from the base without old examples');
  await page.evaluate(() => { window.settingsMock.holdSettings = true; });
  await independentChat.getByRole('button', { name: '恢复基础表达并清除聊天示例', exact: true }).click();
  await page.waitForFunction(() => typeof window.settingsMock.resumeSettings === 'function');
  await chatVoice.fill('恢复请求开始以后才写下的新聊天草稿。');
  await page.evaluate(() => { window.settingsMock.holdSettings = false; window.settingsMock.resumeSettings(); delete window.settingsMock.resumeSettings; });
  await page.waitForFunction(() => !Object.hasOwn(window.settingsMock.settings.pack, 'chat'));
  assert.equal(await chatVoice.inputValue(), '恢复请求开始以后才写下的新聊天草稿。', 'a reset acknowledgement must preserve later edits');
  await page.getByRole('heading', { name: '默认人格', exact: true }).click();
  await page.waitForFunction(() => window.settingsMock.settings.pack.chat?.voice[0] === '恢复请求开始以后才写下的新聊天草稿。');
  assert.deepEqual(await page.evaluate(() => window.settingsMock.settings.pack.voice), expectedBase.voice);
  assert.equal(await page.evaluate(() => window.settingsMock.presetPosts.filter(p => p.action === 'generate').length), 2, 'save/edit/reset retries never add generation calls');

  // A successful later generation replaces an existing preview only after its response.
  if (!await fold('create-persona').evaluate(element => element.open)) await fold('create-persona').locator(':scope > summary').click();
  const replacementSource = '另一份独立的人设材料，只用于验证成功生成后替换预览；修正角色身份时不改写这份原始材料。';
  await page.getByRole('textbox', { name: '人设提示词', exact: true }).fill(replacementSource);
  await page.getByRole('button', { name: '生成预设', exact: true }).click();
  await name.fill('旧的待替换预览');
  await page.evaluate(() => { window.settingsMock.holdGenerate = true; window.settingsMock.generatedPreset = { ...window.settingsMock.generatedPreset, name: '第二份清风', identity: '第二份虚构预览身份', chat:{...window.settingsMock.generatedPreset.chat,gender:'none'} }; });
  await page.getByRole('button', { name: '生成预设', exact: true }).click();
  await page.waitForFunction(() => typeof window.settingsMock.resumeGenerate === 'function');
  assert.equal(await name.inputValue(), '旧的待替换预览');
  await page.evaluate(() => { window.settingsMock.holdGenerate = false; window.settingsMock.resumeGenerate(); delete window.settingsMock.resumeGenerate; });
  await page.waitForFunction(() => document.querySelector('[aria-label="新预设名称"]')?.value === '第二份清风');
  assert.equal(await previewIdentity.inputValue(), '第二份虚构预览身份');
  assert.equal(await previewGender.inputValue(), 'none', 'the optional JSONL gender record reaches the preview');
  assert.equal(await page.evaluate(() => window.settingsMock.settings.presetName), '我的清风');

  const beforePreviewCorrection = await page.evaluate(() => ({ pack: window.settingsMock.settings.pack,
    active: window.settingsMock.settings.presetName, saves: window.settingsMock.presetPosts.filter(post => post.action === 'save').length }));
  const savePreview = page.getByRole('button', { name: '保存并启用', exact: true });
  for (const field of [previewIdentity, previewAssistant, previewUser, previewSubagent]) {
    const prior = await field.inputValue();
    await field.fill('');
    assert.equal(await savePreview.isDisabled(), true, 'an empty critical field cannot fall back to another persona on save');
    await field.fill(prior);
    assert.equal(await savePreview.isDisabled(), false);
  }
  for (const field of [previewAssistant, previewUser, previewSubagent]) assert.equal(await field.getAttribute('maxlength'), '20');
  const correctedIdentity = '女性守夜人，自称「吾」，保留安静听雨的偏好。';
  await previewIdentity.fill('  ' + correctedIdentity + '  ');
  await previewNarration.selectOption('relay');
  await previewAssistant.fill('师姐'); await previewUser.fill('阁下'); await previewSubagent.fill('协作者');
  assert.equal(await previewSource.isChecked(), false, 'editing the preview identity invalidates the old source snapshot');
  if (!await previewSourceDetails.evaluate(element => element.open)) await previewSourceDetails.locator('summary').click();
  await previewSourceDetails.getByText(replacementSource, { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => ({ pack: window.settingsMock.settings.pack,
    active: window.settingsMock.settings.presetName, saves: window.settingsMock.presetPosts.filter(post => post.action === 'save').length })),
    beforePreviewCorrection, 'all preview corrections are local until explicit save');
  await previewSource.check();
  assert.equal(await previewSource.isChecked(), true, 'explicit preview use binds the normalized corrected identity');
  await name.fill('我的清风');
  await capture('settings-corrected-preview-mobile', 390, 'light');
  if (values.output) await fold('create-persona').screenshot({ path: path.join(values.output, 'settings-corrected-preview-detail-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1100, height: 1000 });
  await savePreview.click();
  await page.waitForFunction(value => window.settingsMock.settings.pack.identity === value, correctedIdentity);
  const corrected = await page.evaluate(() => ({ saved: window.settingsMock.settings.pack,
    request: window.settingsMock.presetPosts.filter(post => post.action === 'save').at(-1) }));
  assert.equal(corrected.request.pack.identity.trim(), correctedIdentity);
  assert.deepEqual(corrected.request.pack.narration, { mode: 'relay', assistant: '师姐' });
  assert.deepEqual(corrected.request.pack.address, { user: '阁下', subagent: '协作者' });
  assert.equal(corrected.request.source, replacementSource);
  assert.deepEqual(corrected.saved.narration, { mode: 'relay', assistant: '师姐' });
  assert.deepEqual(corrected.saved.address, { user: '阁下', subagent: '协作者' });
  assert.equal(corrected.saved.chat.source.text, replacementSource, 'manual corrections never rewrite the original source');
  assert.equal(corrected.saved.chat.source.identity, correctedIdentity);
  assert.deepEqual(corrected.saved.chat.source.voice, corrected.saved.chat.voice);
  assert.equal(corrected.saved.chat.source.enabled, true);
  if (!await fold('edit-persona').evaluate(element => element.open)) await fold('edit-persona').locator(':scope > summary').click();
  assert.equal(await sourceToggle.isChecked(), true, 'the saved normalized card actually keeps the explicitly rebound source active');

  // Keep a complete unsaved preview for the existing strict-failure regression.
  if (!await fold('create-persona').evaluate(element => element.open)) await fold('create-persona').locator(':scope > summary').click();
  await page.getByRole('button', { name: '生成预设', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="新预设名称"]')?.value === '第二份清风');

  const beforeIncompletePreview = await page.evaluate(() => ({ active: window.settingsMock.settings.presetName,
    pack: window.settingsMock.settings.pack, count: window.settingsMock.presets.length,
    saves: window.settingsMock.presetPosts.filter(post => post.action === 'save').length }));
  await generatedReview.getByRole('button', { name: '稍后编辑', exact: true }).click();
  await generatedReview.waitFor({ state: 'hidden' });
  await tab('转述'); await tab('人格');
  assert.equal(await generatedReview.count(), 0, 'ordinary settings navigation does not repeat the reminder');
  if (!await fold('create-persona').evaluate(element => element.open)) await fold('create-persona').locator(':scope > summary').click();
  await page.evaluate(preset => { window.settingsMock.generatedPreset = preset; }, zeroExamplesPreset);
  const incompleteSource = '这是用于验证不完整多轮输出会被严格拒绝的独立素材，不保存、不修复旧结果。';
  await page.getByRole('textbox', { name: '人设提示词', exact: true }).fill(incompleteSource);
  await page.getByRole('button', { name: '生成预设', exact: true }).click();
  await page.getByText('模型返回的结构或多轮示例不完整，未采用。输入和已有预览已保留，可调整后重新生成。', { exact: true }).waitFor();
  assert.equal(await generatedReview.count(), 0, 'failed generation does not reopen a postponed review');
  await generatedReviewSummary.click();
  await generatedReview.waitFor();
  assert.equal(await name.inputValue(), '第二份清风', 'an incomplete response cannot replace the previous complete card');
  assert.equal(await page.getByRole('textbox', { name: '人设提示词', exact: true }).inputValue(), incompleteSource);
  await generatedChat.getByText('日常多轮示例：2组；工作讨论示例：1组。', { exact: true }).waitFor();
  assert.equal(await generatedChat.getByText('日常多轮示例：0组；工作讨论示例：0组。', { exact: true }).count(), 0);
  assert.doesNotMatch(await fold('create-persona').innerText(), /generation-incomplete-examples/);
  assert.deepEqual(await page.evaluate(() => ({ active: window.settingsMock.settings.presetName,
    pack: window.settingsMock.settings.pack, count: window.settingsMock.presets.length,
    saves: window.settingsMock.presetPosts.filter(post => post.action === 'save').length })), beforeIncompletePreview,
    'strict failure neither saves nor repairs an incomplete output');
  await capture('settings-strict-generation-failure', 1100, 'light');
  await capture('settings-strict-generation-failure-mobile', 390, 'light');
  if (values.output) await fold('create-persona').screenshot({ path: path.join(values.output, 'settings-strict-generation-failure-detail-mobile.png'), animations: 'disabled' });
  await capture('settings-strict-generation-failure-mobile-dark', 390, 'dark');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.getByRole('button', { name: '丢弃', exact: true }).click();
  assert.equal(await name.count(), 0);
  await page.getByRole('tab', { name: '人格', exact: true }).focus();
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: '高级', exact: true }).getAttribute('aria-selected'), 'true');
  const advancedModels=page.getByRole('region',{name:'高级设置',exact:true});
  await advancedModels.getByText('模型提供方列表暂时无法读取，已保存选择仍保留。',{exact:true}).waitFor();
  await advancedModels.getByRole('button',{name:'重新读取模型目录',exact:true}).click();
  await page.getByRole('combobox',{name:'改写所用模型',exact:true}).locator('option[value="local"]').waitFor({state:'attached'});
  await page.getByRole('combobox', { name: '改写所用模型', exact: true }).selectOption('local');
  await advancedModels.getByText('模型列表暂时无法读取，已保存选择仍保留。',{exact:true}).waitFor();
  await advancedModels.getByRole('button',{name:'重新读取模型目录',exact:true}).click();
  await page.getByRole('combobox',{name:'模型',exact:true}).locator('option[value="rewrite-small"]').waitFor({state:'attached'});
  await page.getByRole('combobox', { name: '模型', exact: true }).selectOption('rewrite-small');
  await page.waitForFunction(() => window.settingsMock.settings.model === 'rewrite-small');
  await page.evaluate(()=>window.settingsMock.holdModel='slow');
  await page.getByRole('combobox',{name:'改写所用模型',exact:true}).selectOption('slow');
  await page.waitForFunction(()=>!!window.settingsMock.resumeModel);
  await page.getByRole('combobox',{name:'改写所用模型',exact:true}).selectOption('fast');
  await page.getByRole('combobox',{name:'模型',exact:true}).locator('option[value="fresh-model"]').waitFor({state:'attached'});
  assert.equal(await page.evaluate(()=>window.settingsMock.modelAborts.includes('slow')),true,'switching provider aborts its old metadata query');
  await page.evaluate(()=>{window.settingsMock.holdModel=null;window.settingsMock.resumeModel();});
  await page.waitForTimeout(20);
  assert.equal(await page.getByRole('combobox',{name:'模型',exact:true}).locator('option[value="late-model"]').count(),0,'late model metadata cannot overwrite the active provider');
  await page.getByRole('combobox',{name:'改写所用模型',exact:true}).selectOption('local');
  await page.getByRole('combobox',{name:'模型',exact:true}).selectOption('rewrite-small');
  await tab('聊天室');
  const researchToggle=page.getByRole('checkbox',{name:'允许调查资料',exact:true}),reasonToggle=page.getByRole('checkbox',{name:'允许深入推演',exact:true});
  assert.equal(await researchToggle.isChecked(),false);assert.equal(await reasonToggle.isChecked(),false);
  assert.equal(await page.getByRole('combobox',{name:'深入推演提供方',exact:true}).count(),0);
  await researchToggle.check();await reasonToggle.check();await page.getByRole('combobox',{name:'深入推演提供方',exact:true}).selectOption('local');
  await page.getByRole('combobox',{name:'深入推演模型名称',exact:true}).selectOption('rewrite-small');
  await page.waitForFunction(()=>window.settingsMock.settings.chatResearchEnabled===true&&window.settingsMock.settings.chatDeepReasoningModel==='rewrite-small');
  await tab('人格');await tab('聊天室');assert.equal(await reasonToggle.isChecked(),true);
  assert.equal(await page.getByRole('combobox',{name:'深入推演模型名称',exact:true}).inputValue(),'rewrite-small');
  await researchToggle.uncheck();await reasonToggle.uncheck();await page.waitForFunction(()=>window.settingsMock.settings.chatDeepReasoningEnabled===false);
  assert.equal(await page.getByRole('combobox',{name:'聊天室模型',exact:true}).inputValue(),'');
  assert.equal(await page.getByRole('checkbox',{name:'开启聊天室思考',exact:true}).isChecked(),true);
  assert.equal(await page.getByRole('combobox',{name:'聊天室思考强度',exact:true}).inputValue(),'');
  await page.getByRole('combobox',{name:'聊天室模型',exact:true}).selectOption('local');
  await page.getByRole('combobox',{name:'聊天室模型名称',exact:true}).selectOption('rewrite-small');
  await page.getByRole('checkbox',{name:'开启聊天室思考',exact:true}).check();
  await page.getByRole('combobox',{name:'聊天室思考强度',exact:true}).selectOption('high');
  await page.waitForFunction(()=>window.settingsMock.settings.chatThinking===true&&window.settingsMock.settings.chatModel==='rewrite-small');
  await page.waitForFunction(()=>window.settingsMock.settings.chatReasoningEffort==='high');
  assert.equal(await page.evaluate(()=>window.settingsMock.settings.provider),'local');
  await capture('settings-chat-model',1100,'light');await capture('settings-chat-model-mobile',390,'light');await capture('settings-chat-model-dark',1100,'dark');
  await tab('记忆');
  await page.getByText('从已启用的主工作会话识别明确偏好，供适用的人格表达参考。聊天室不会自动提炼长期记忆；可在这里手动管理。关闭后停止采集和使用，已有记录与房间聊天分别保留。',{exact:true}).waitFor();
  await fold('memory-add').locator(':scope > summary').click();
  const memoryDraft = page.getByRole('textbox', { name: '新增记忆内容' });
  await memoryDraft.fill('这个草稿在折叠后依然保留');
  await tab('人格');
  await tab('记忆');
  assert.equal(await memoryDraft.inputValue(), '这个草稿在折叠后依然保留');
  await capture('settings-memory-open', 1100, 'light');
  await capture('settings-memory-mobile', 390, 'light');
  await tab('外观');
  await page.getByRole('textbox',{name:'角色怎么称呼你',exact:true}).fill('小晴');
  assert.equal(await page.evaluate(()=>window.settingsMock.profilePosts.length),0,'editing an optional address waits for explicit save');
  await page.getByRole('button',{name:'保存称呼',exact:true}).click();
  await page.waitForFunction(()=>window.settingsMock.userProfile.userAddress==='小晴');
  const userGender = page.getByRole('combobox', { name: '你的性别（聊天室）', exact: true });
  assert.equal(await userGender.locator('option[value="unset"]').textContent(), '不指定');
  assert.equal(await userGender.locator('option[value="none"]').textContent(), '无性别');
  assert.equal(await userGender.inputValue(), 'unset', 'gender is optional and starts unspecified');
  const originalProfile = await page.evaluate(() => window.settingsMock.userProfile);
  for (const gender of ['male', 'female', 'none', 'unset']) {
    await userGender.selectOption(gender);
    await page.waitForFunction(value => window.settingsMock.userProfile.userGender === value, gender);
    await page.getByText('性别设置已保存，只影响之后的聊天回复。', { exact: true }).waitFor();
    const saved = await page.evaluate(() => window.settingsMock.userProfile);
    assert.equal(saved.avatar, originalProfile.avatar); assert.equal(saved.avatarMode, originalProfile.avatarMode);
    assert.equal(saved.userAddress, '小晴'); assert.equal(await userGender.inputValue(), gender);
    assert.deepEqual(Object.keys(await page.evaluate(() => window.settingsMock.profilePosts.at(-1))).sort(), ['revision', 'userGender']);
  }
  const beforeGenderFailure = await page.evaluate(() => ({ profile: window.settingsMock.userProfile, writes: window.settingsMock.profilePosts.length }));
  await page.evaluate(() => { window.settingsMock.failProfile = true; });
  await userGender.selectOption('male');
  await page.getByText('未能确认性别设置已保存，请核对后重试。', { exact: true }).waitFor();
  assert.equal(await userGender.inputValue(), 'unset');
  assert.deepEqual(await page.evaluate(() => window.settingsMock.userProfile), beforeGenderFailure.profile);
  assert.equal(await page.evaluate(() => window.settingsMock.profilePosts.length), beforeGenderFailure.writes + 1, 'failed gender save is not automatically retried');
  assert.equal(await page.getByText('性别设置已保存，只影响之后的聊天回复。', { exact: true }).count(), 0);
  const beforeGenderConflict = await page.evaluate(() => ({ profile: window.settingsMock.userProfile, writes: window.settingsMock.profilePosts.length }));
  await page.evaluate(() => { window.settingsMock.conflictProfile = true; });
  await userGender.selectOption('male');
  await page.getByText('个人资料已在别处更新，请核对当前性别选择后重试。', { exact: true }).waitFor();
  assert.equal(await userGender.inputValue(), 'female', 'conflict adopts the acknowledged server state rather than the rejected local choice');
  assert.equal(await page.evaluate(() => window.settingsMock.profilePosts.length), beforeGenderConflict.writes + 1, 'revision conflict never silently retries with a new revision');
  assert.equal(await page.evaluate(() => window.settingsMock.userProfile.userAddress), '另一处已更新的称呼');
  assert.equal(await page.evaluate(() => window.settingsMock.userProfile.avatar), originalProfile.avatar);
  assert.equal(await page.getByText('性别设置已保存，只影响之后的聊天回复。', { exact: true }).count(), 0);
  await userGender.selectOption('none');
  await page.waitForFunction(() => window.settingsMock.userProfile.userGender === 'none');
  assert.equal(await page.evaluate(() => window.settingsMock.profilePosts.at(-1).revision), beforeGenderConflict.profile.revision + 1,
    'only the explicit user retry uses the acknowledged new revision');
  assert.equal(await page.evaluate(() => window.settingsMock.userProfile.userAddress), '另一处已更新的称呼');
  await capture('settings-user-gender-mobile', 390, 'light');
  if (values.output) await page.locator('[data-persona-shell="user-profile"]').screenshot({ path: path.join(values.output, 'settings-user-gender-detail-mobile.png'), animations: 'disabled' });
  await capture('settings-user-gender-mobile-dark', 390, 'dark');
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
    cases: ['delayed persistence acknowledgement', 'applied settings failure and empty-patch retry', 'pending and memory-only feedback', 'final-only process dependencies preserve choices', 'initial settings 503/auth/network failures and explicit read retry', 'provider discovery waits for authenticated settings', '200 metadata error and manual catalogue/list retry', 'progressive disclosure', 'colloquial report default, autosave and retry', 'failed save retains hidden draft', 'generated preset retry',
      'generation previews without activation', 'chat and report preview sections', 'fictional daily/work and report details at 390px', 'complete generated chat and source save/retry',
      'top voice preserves chat profile', 'chat voice edits preserve report and examples', 'failed chat save retains hidden draft and retries', 'restore clears only chat profile',
      'failed regeneration keeps prior preview and blocks mid-flight save', 'successful regeneration replaces preview only on receipt', 'complete strict two/one generated examples are readable',
      'chat voice limits block writes and retain drafts', 'reset retires older failed drafts across card switches', 'reset acknowledgement retains later draft edits',
      'strict incomplete generation is refused and preserves the old complete preview',
      'original role source is readable and read-only', 'preview source opt-out survives save', 'saved source can be explicitly enabled and stopped',
      'identity and chat voice edits deactivate old source snapshots without deleting text', 'report voice edits keep source active', 'source use explicitly rebinds saved identity and chat voice',
      'identity 4001 blocks source use but keeps source and allows skip', 'inherited ten-line or 401-character voice blocks use while skip preserves source',
      'queued source use validates the final pack and retires only its failed intent',
      'preview identity gender narration and names are local editable corrections with unchanged source',
      'critical preview fields block empty saves and source rebinding remains active after normalization',
      'optional user gender unset male female and none preserve avatar and address', 'user gender save failures and revision conflicts never claim success or auto-overwrite',
      'generated persona gender none survives preview save and is locked during generation', 'custom persona gender survives card switching while builtins stay fixed female',
      'restoring base expression preserves explicit none gender while legacy cards still remove chat',
      'successful generation opens the same editable review and Escape returns focus without adopting it',
      'postponed review survives navigation and generation failure without repeated opening',
      'mobile review scrolls independently to its footer and gender styles are not inferred from appearance',
      'conditional quiet timing', 'narration relationship', 'default report scope', 'keyboard disclosure', 'model selection', 'memory draft retention', 'no message gate', 'desktop/mobile themes',
      'lazy usage statistics', 'usage coverage and model details', 'empty, stale and failed usage queries',
      'auxiliary capabilities default off', 'research and reasoning enable independently', 'reasoning separate model persists across navigation', 'disabled helper model selection is retained'],
    pageErrors: errors, externalRequests: external }));
} finally { await browser.close(); }
