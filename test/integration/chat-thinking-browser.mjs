// Real React controls, deterministic metadata and storage; no provider/model call.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { deps: { type: 'string' }, 'browser-deps': { type: 'string' }, executable: { type: 'string' }, output: { type: 'string' } } });
const deps = createRequire(path.resolve(values.deps)), browserDeps = createRequire(path.resolve(values['browser-deps'] ?? values.deps));
const { buildSync } = deps('esbuild'), { chromium } = browserDeps('playwright');
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const entry = [
  'import * as React from ' + JSON.stringify(deps.resolve('react')) + ';',
  'import {createRoot} from ' + JSON.stringify(deps.resolve('react-dom/client')) + ';',
  'const h=React.createElement;let plugin;window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;throw Error(id)})}};',
  source,
  'const host=window.thinkingMock={settings:{chatThinking:true,chatReasoningEffort:"",provider:"p",model:"base",chatProvider:"",chatModel:""},settingsReads:0,metadataReads:[],posts:[],modelCalls:0,mode:"available",defaultEffort:"deep"};',
  'const response=(value,ok=true)=>({ok,status:ok?200:503,json:async()=>structuredClone(value)});',
  'window.fetch=async(url,options={})=>{const parsed=new URL(url,"https://thinking.test"),route=parsed.pathname;',
  'if(route.endsWith("/settings")){if(options.method==="POST"){const patch=JSON.parse(options.body);host.posts.push(patch);if(host.failSave){host.failSave=false;return response({},false)}Object.assign(host.settings,patch);const snapshot=structuredClone(host.settings);if(host.holdSave){host.holdSave=false;await new Promise(r=>host.releaseSave=r)}return response({settings:snapshot})}host.settingsReads++;const snapshot=structuredClone(host.settings);if(host.holdSettings){host.holdSettings=false;await new Promise(r=>host.releaseSettings=r)}host.settingsDelivered=(host.settingsDelivered??0)+1;return response({settings:snapshot})}',
  'if(route.endsWith("/chat-model-options")){const room=parsed.searchParams.get("room"),record={room,aborted:false};host.metadataReads.push(record);options.signal?.addEventListener("abort",()=>record.aborted=true,{once:true});',
  'const body=host.mode==="unknown"?{status:"unknown",error:"metadata-unavailable",efforts:[],defaultEffort:null}:host.mode==="no-route"?{status:"unknown",error:"no-route",efforts:[],defaultEffort:null}:host.mode==="unavailable"?{status:"unavailable",efforts:[],defaultEffort:null}:{provider:"p",model:room==="room-fast"?"fast":room==="room-slow"?"slow":"base",status:"available",efforts:host.mode==="mandatory"?[{id:"standard",name:"标准思考"},{id:"deep",name:"深入思考"},{id:"OFF",name:"自定义 OFF"}]:room==="room-fast"?[{id:"quick",name:"快速思考"}]:[{id:"off",name:"关闭"},{id:"standard",name:"标准思考"},{id:"deep",name:"深入思考"},{id:"deep",name:"重复"}],defaultEffort:host.defaultEffort};',
  'if(host.holdMetadata){host.holdMetadata=false;await new Promise(r=>host.releaseMetadata=r)}return response(body)}',
  'host.modelCalls++;throw Error("Unexpected request "+route)};',
  'function Demo(){const[roomOpen,setRoomOpen]=React.useState(false),[pluginOpen,setPluginOpen]=React.useState(false),[room,setRoom]=React.useState("room-a"),[settings,setSettings]=React.useState(structuredClone(host.settings));',
  'const save=async patch=>{const r=await fetch("/persona-shell/settings",{method:"POST",body:JSON.stringify(patch)});if(!r.ok)return;const value=await r.json();setSettings(value.settings);return value;};',
  'return h(React.Fragment,null,h("nav",null,h("button",{onClick:()=>setRoomOpen(!roomOpen)},roomOpen?"收起聊天室设置":"打开聊天室设置"),h("button",{onClick:()=>setPluginOpen(!pluginOpen)},pluginOpen?"收起插件设置":"打开插件设置"),h("button",{onClick:()=>setRoom("room-slow")},"切换慢模型"),h("button",{onClick:()=>setRoom("room-fast")},"切换快模型"),h("button",{onClick:()=>setRoom("room-a")},"切回原模型")),',
  'h("label",null,"聊天输入",h("textarea",{"aria-label":"聊天输入",defaultValue:"保留的聊天草稿"})),h("div",{"data-quote":""},"引用：保留的原话"),h("main",null,',
  'roomOpen?h("section",{"aria-label":"快捷设置入口"},h("h2",null,"聊天室设置"),h(plugin.__testing.ChatThinkingControls,{roomId:room,routeKey:room})):null,',
  'pluginOpen?h("section",{"aria-label":"插件设置入口"},h("h2",null,"插件设置 · 聊天室"),h(plugin.__testing.ChatThinkingControls,{settings,save})):null));}',
  'createRoot(document.getElementById("app")).render(h(Demo));',
].join('\n');
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } }), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
  await page.setContent('<html><head><meta charset="utf-8"><style>:root{--dsw-alias-label-primary:#243244;--dsw-alias-label-secondary:#697587;--dsw-alias-brand-primary:#386fba;--dsw-alias-bg-layer-1:#fff;--dsw-alias-border-l1:#dce2e9}html[data-theme=dark]{--dsw-alias-label-primary:#e2e7ef;--dsw-alias-label-secondary:#a5b2c4;--dsw-alias-brand-primary:#8aaff1;--dsw-alias-bg-layer-1:#19212e;--dsw-alias-border-l1:#3a4658}body{margin:0;padding:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:14px "Segoe UI","Microsoft YaHei",sans-serif}nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}button{font:inherit}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:18px}section{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px;min-width:0}h2{font-size:16px;margin:0 0 16px}textarea{display:block;box-sizing:border-box;width:100%;padding:10px;font:inherit;border-radius:8px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1)}[data-quote]{margin-top:6px;font-size:12px;opacity:.7}@media(max-width:600px){main{grid-template-columns:1fr}body{padding:14px}}</style></head><body><div id="app"></div></body></html>');
  await page.addScriptTag({ content: bundle });
  const quick = () => page.getByRole('region', { name: '快捷设置入口', exact: true }), plugin = () => page.getByRole('region', { name: '插件设置入口', exact: true });
  const level = region => region.getByRole('combobox', { name: '聊天室思考强度', exact: true }), toggle = region => region.getByRole('checkbox', { name: '开启聊天室思考', exact: true });
  await page.getByRole('button', { name: '打开聊天室设置', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.thinkingMock.settingsReads), 0);
  assert.deepEqual(await page.evaluate(() => window.thinkingMock.metadataReads), [], 'unopened settings perform no metadata work');
  await page.getByRole('button', { name: '打开聊天室设置', exact: true }).click();
  await quick().getByText('默认使用模型的「深入思考」档。', { exact: true }).waitFor();
  assert.equal(await toggle(quick()).isChecked(), true); assert.equal(await level(quick()).inputValue(), '');
  assert.deepEqual(await level(quick()).locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['', 'standard', 'deep']);
  assert.deepEqual(await page.evaluate(() => window.thinkingMock.posts), [], 'opening does not save defaults');
  await page.getByRole('button', { name: '打开插件设置', exact: true }).click();
  await plugin().getByText('默认使用模型的「深入思考」档。', { exact: true }).waitFor();

  const postsBefore = await page.evaluate(() => { window.thinkingMock.holdSave = true; return window.thinkingMock.posts.length; });
  await level(plugin()).selectOption('deep'); await page.waitForFunction(() => !!window.thinkingMock.releaseSave);
  await level(quick()).selectOption('standard');
  assert.equal(await level(plugin()).inputValue(), 'standard');
  assert.equal(await page.evaluate(() => window.thinkingMock.posts.length), postsBefore + 1, 'the second entrance waits for the first write');
  await page.evaluate(() => window.thinkingMock.releaseSave());
  await page.waitForFunction(n => window.thinkingMock.posts.length === n + 2 && window.thinkingMock.settings.chatReasoningEffort === 'standard', postsBefore);
  assert.equal(await level(quick()).inputValue(), 'standard'); assert.equal(await level(plugin()).inputValue(), 'standard');
  await page.evaluate(() => { window.thinkingMock.failSave = true; }); await level(quick()).selectOption('deep');
  await quick().getByText('设置未保存，当前选择已保留。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '收起聊天室设置', exact: true }).click();
  assert.equal(await level(plugin()).inputValue(), 'deep');
  await page.getByRole('button', { name: '打开聊天室设置', exact: true }).click();
  await quick().getByRole('button', { name: '重试保存思考设置', exact: true }).waitFor();
  assert.equal(await level(quick()).inputValue(), 'deep');
  await quick().getByRole('button', { name: '重试保存思考设置', exact: true }).click();
  await page.waitForFunction(() => window.thinkingMock.settings.chatReasoningEffort === 'deep');
  await toggle(plugin()).uncheck(); await page.waitForFunction(() => window.thinkingMock.settings.chatThinking === false);
  assert.equal(await level(quick()).isDisabled(), true); assert.equal(await level(quick()).inputValue(), 'deep');
  await toggle(quick()).check(); await page.waitForFunction(() => window.thinkingMock.settings.chatThinking === true);
  assert.equal(await level(plugin()).isDisabled(), false); assert.equal(await level(plugin()).inputValue(), 'deep');
  await page.getByRole('button', { name: '收起插件设置', exact: true }).click();

  await page.getByRole('button', { name: '收起聊天室设置', exact: true }).click();
  await page.evaluate(() => { window.thinkingMock.mode = 'unknown'; });
  await page.getByRole('button', { name: '打开聊天室设置', exact: true }).click();
  await quick().getByText('暂未读取到模型能力；已保存的选择仍保留，调用时采用提供方兼容策略。', { exact: true }).waitFor();
  assert.equal(await level(quick()).inputValue(), 'deep');
  assert.match(await level(quick()).locator('option:checked').innerText(), /已保存，当前模型未列出/);
  await level(quick()).selectOption(''); await page.waitForFunction(() => window.thinkingMock.settings.chatReasoningEffort === '');
  await page.evaluate(() => { window.thinkingMock.mode = 'available'; window.thinkingMock.defaultEffort = 'off'; });
  await quick().getByRole('button', { name: '重新读取思考选项', exact: true }).click();
  await quick().getByText('该模型默认关闭思考；开启时会采用最低可用思考档。', { exact: true }).waitFor();

  await page.getByRole('button', { name: '收起聊天室设置', exact: true }).click();
  await page.evaluate(() => { window.thinkingMock.holdSettings = true; });
  await page.getByRole('button', { name: '打开聊天室设置', exact: true }).click(); await page.waitForFunction(() => !!window.thinkingMock.releaseSettings);
  await level(quick()).selectOption('standard'); await page.waitForFunction(() => window.thinkingMock.settings.chatReasoningEffort === 'standard');
  await page.waitForFunction(() => !document.querySelector('[data-persona-shell="chat-thinking"]')?.textContent.includes('正在保存'));
  const delivered = await page.evaluate(() => window.thinkingMock.settingsDelivered);
  await page.evaluate(() => window.thinkingMock.releaseSettings());
  await page.waitForFunction(previous => window.thinkingMock.settingsDelivered === previous + 1, delivered);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await level(quick()).inputValue(), 'standard', 'an old settings GET cannot revert a newer acknowledged choice');

  await page.evaluate(() => { window.thinkingMock.holdMetadata = true; window.thinkingMock.defaultEffort = 'deep'; });
  await page.getByRole('button', { name: '切换慢模型', exact: true }).click(); await page.waitForFunction(() => !!window.thinkingMock.releaseMetadata);
  await page.getByRole('button', { name: '切换快模型', exact: true }).click(); await quick().getByText('当前模型：fast · p', { exact: true }).waitFor();
  await page.evaluate(() => window.thinkingMock.releaseMetadata());
  assert.equal(await page.evaluate(() => window.thinkingMock.metadataReads.findLast(read => read.room === 'room-slow').aborted), true);
  assert.deepEqual(await level(quick()).locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['', 'standard', 'quick']);
  await quick().getByText('当前模型未列出这个强度，调用时回到模型默认；已保存的选择仍保留。', { exact: true }).waitFor();
  await quick().getByText('当前模型：fast · p', { exact: true }).waitFor();

  await page.evaluate(() => { window.thinkingMock.holdMetadata = true; window.thinkingMock.releaseMetadata = null; });
  await page.getByRole('button', { name: '切回原模型', exact: true }).click(); await page.waitForFunction(() => !!window.thinkingMock.releaseMetadata);
  const readIndex = await page.evaluate(() => window.thinkingMock.metadataReads.length - 1);
  await page.getByRole('button', { name: '收起聊天室设置', exact: true }).click();
  assert.equal(await page.evaluate(index => window.thinkingMock.metadataReads[index].aborted, readIndex), true);
  await page.getByRole('textbox', { name: '聊天输入', exact: true }).fill('更新后的聊天草稿，不要覆盖');
  await page.evaluate(() => window.thinkingMock.releaseMetadata());
  assert.equal(await page.getByRole('textbox', { name: '聊天输入', exact: true }).inputValue(), '更新后的聊天草稿，不要覆盖');
  assert.equal(await page.getByRole('textbox', { name: '聊天输入', exact: true }).evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('[data-quote]').innerText(), '引用：保留的原话');

  await page.evaluate(() => { window.thinkingMock.mode = 'mandatory'; }); await page.getByRole('button', { name: '打开聊天室设置', exact: true }).click();
  await level(quick()).locator('option[value="OFF"]').waitFor({ state: 'attached' });
  await toggle(quick()).uncheck(); await page.waitForFunction(() => window.thinkingMock.settings.chatThinking === false);
  await quick().getByText('当前模型没有关闭档位，将使用最低可用档；已保存强度仍保留。', { exact: true }).waitFor();
  assert.equal(await level(quick()).isDisabled(), true); assert.equal(await level(quick()).inputValue(), 'standard');
  await toggle(quick()).check(); await page.waitForFunction(() => window.thinkingMock.settings.chatThinking === true);
  await page.getByRole('button', { name: '收起聊天室设置', exact: true }).click();
  await page.evaluate(() => { window.thinkingMock.mode = 'unavailable'; }); await page.getByRole('button', { name: '打开聊天室设置', exact: true }).click();
  await quick().getByText('当前模型没有公开可开启的思考档；设置仍保留，调用时按模型能力兼容。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '收起聊天室设置', exact: true }).click();
  await page.evaluate(() => { window.thinkingMock.mode = 'no-route'; }); await page.getByRole('button', { name: '打开聊天室设置', exact: true }).click();
  await quick().getByText('暂未找到可用的聊天室模型；已保存的设置仍保留。', { exact: true }).waitFor();
  await page.evaluate(() => { window.thinkingMock.mode = 'available'; window.thinkingMock.defaultEffort = null; });
  await quick().getByRole('button', { name: '重新读取思考选项', exact: true }).click();
  await level(quick()).selectOption(''); await page.waitForFunction(() => window.thinkingMock.settings.chatReasoningEffort === '');
  await quick().getByText('模型未公布默认思考档，由提供方决定；不保证已开启思考。', { exact: true }).waitFor();
  if (values.output) {
    mkdirSync(values.output, { recursive: true });
    await page.screenshot({ path: path.join(values.output, 'chat-thinking-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(values.output, 'chat-thinking-mobile-dark.png'), fullPage: true });
  }
  assert.equal(await page.evaluate(() => window.thinkingMock.modelCalls), 0);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ result: 'passed', cases: ['lazy metadata', 'model default and non-off capability choices', 'shared ordered draft acknowledgments', 'failed save survives close and retries', 'off preserves effort', 'unknown capability preserves choice', 'default-off hint', 'stale settings GET discarded', 'stale metadata discarded', 'close abort and input/quote preservation', 'mandatory-thinking fallback and exact off ID', 'no-route/unavailable/unspecified defaults', 'mobile dark layout'], modelCalls: 0, pageErrors: errors }));
} finally { await browser.close(); }
