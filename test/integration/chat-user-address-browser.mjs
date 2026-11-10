// Actual Host profile routes and real React; no generated model response or account-name inference.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fixture, domain } from '../helpers/persona-chat-host.mjs';
import { makeAvatar } from '../helpers/avatar-fixture.mjs';
import { normalizeUserAddress } from '../../lib/chat-profile.js';

const { values } = parseArgs({ options: { deps: { type: 'string' }, 'browser-deps': { type: 'string' }, executable: { type: 'string' }, output: { type: 'string' } } });
const deps = createRequire(path.resolve(values.deps)), browserDeps = createRequire(path.resolve(values['browser-deps'] ?? values.deps));
const { buildSync } = deps('esbuild'), { chromium } = browserDeps('playwright');
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8'), cleanups = [], requests = [];
let failProfile = false, holdGet = false, holdSave = false, releaseGet, releaseSave;
const f = fixture({ after(fn) { cleanups.push(fn); } }, { storage: domain(Promise.resolve(), { fail: key => key === 'chatUserProfile' && failProfile }),
  script() { assert.fail('profile presentation must never generate a model response'); } });
await f.ready();
const entry = [
  'import * as React from ' + JSON.stringify(deps.resolve('react')) + ';',
  'import {createRoot} from ' + JSON.stringify(deps.resolve('react-dom/client')) + ';',
  'const h=React.createElement;let plugin;window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==="react")return React;throw Error(id)})}};',
  source,
  'window.profileUI=plugin.__testing;plugin.__testing.accountAvatarSource.bind({account:{getState:async()=>({ok:true,value:{status:"credential-stored"}}),getProfile:async()=>({ok:true,value:{status:"ready",value:{name:"ACCOUNT_NAME_NEVER_USE_AS_ADDRESS",avatarUrl:null}}})}},()=>({version:"test",locale:"zh-CN",timezoneOffsetSeconds:0}));',
  'window.fetch=async(url,options={})=>{const parsed=new URL(url,"https://profile.test");let aborted;const cancelled=new Promise((_,reject)=>{aborted=()=>reject(new DOMException("Aborted","AbortError"));options.signal?.addEventListener("abort",aborted,{once:true});if(options.signal?.aborted)aborted()});try{const result=await Promise.race([window.profileHttp({path:parsed.pathname+parsed.search,body:options.method==="POST"?JSON.parse(options.body):undefined}),cancelled]);window.profileDelivered=(window.profileDelivered??0)+1;return{ok:result.status>=200&&result.status<300,status:result.status,json:async()=>result.value}}finally{options.signal?.removeEventListener("abort",aborted)}};',
  'function Demo(){const[room,setRoom]=React.useState(false),[settings,setSettings]=React.useState(false);return h(React.Fragment,null,h("nav",null,h("button",{onClick:()=>setRoom(!room)},room?"收起聊天室设置":"打开聊天室设置"),h("button",{onClick:()=>setSettings(!settings)},settings?"收起插件外观":"打开插件外观")),',
  'h("label",null,"工作输入",h("textarea",{"aria-label":"工作输入",defaultValue:"独立的工作草稿"})),h("div",{"data-quote":""},"引用作者：我"),h("main",null,room?h("section",{"aria-label":"聊天室资料入口"},h(plugin.__testing.ChatUserSettings)):null,settings?h("section",{"aria-label":"插件资料入口"},h(plugin.__testing.ChatUserSettings)):null));}',
  'createRoot(document.getElementById("app")).render(h(Demo));',
].join('\n');
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } }), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('profileHttp', async ({ path: pathname, body }) => {
    assert.ok(pathname.startsWith('/persona-shell/chat-profile'), 'profile controls have no memory, report or chat route');
    requests.push({ path: pathname, body });
    const result = await f.request(pathname.slice('/persona-shell/'.length), body);
    if (body && holdSave) { holdSave = false; await new Promise(resolve => { releaseSave = resolve; }); }
    if (!body && holdGet) { holdGet = false; await new Promise(resolve => { releaseGet = resolve; }); }
    return result;
  });
  await page.route('https://profile.test/persona-shell/chat-profile/avatar?**', async route => {
    const url = new URL(route.request().url()), result = await f.request('chat-profile/avatar' + url.search);
    await route.fulfill({ status: result.status, contentType: 'image/png', body: result.value });
  });
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('https://profile.test/persona-shell/chat-profile/avatar?')) external.push(request.url()); });
  await page.setContent('<html><head><meta charset="utf-8"><base href="https://profile.test"><style>:root{--dsw-alias-label-primary:#243244;--dsw-alias-label-secondary:#697587;--dsw-alias-brand-primary:#386fba;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f6f8fb;--dsw-alias-border-l1:#dce2e9}html[data-theme=dark]{--dsw-alias-label-primary:#e2e7ef;--dsw-alias-label-secondary:#a5b2c4;--dsw-alias-brand-primary:#8aaff1;--dsw-alias-bg-layer-1:#19212e;--dsw-alias-bg-layer-2:#222c3b;--dsw-alias-border-l1:#3a4658}body{margin:0;padding:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:14px "Segoe UI","Microsoft YaHei",sans-serif}nav{display:flex;gap:10px;margin-bottom:16px}button{font:inherit}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:18px}section{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px;min-width:0}textarea{display:block;box-sizing:border-box;width:100%;padding:10px;font:inherit;border-radius:8px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1)}[data-quote]{margin-top:6px;font-size:12px;opacity:.7}@media(max-width:600px){main{grid-template-columns:1fr}body{padding:14px}}</style></head><body><div id="app"></div></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.clock.install();
  const room = () => page.getByRole('region', { name: '聊天室资料入口', exact: true }), settings = () => page.getByRole('region', { name: '插件资料入口', exact: true });
  const input = scope => scope.getByRole('textbox', { name: '角色怎么称呼你', exact: true }), save = scope => scope.getByRole('button', { name: '保存称呼', exact: true });
  const profile = async () => (await f.request('chat-profile')).value;
  holdGet = true;
  await page.getByRole('button', { name: '打开聊天室设置', exact: true }).click(); await input(room()).waitFor();
  for (let i = 0; i < 30 && !releaseGet; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(releaseGet);
  await page.clock.fastForward(10_001); await room().getByText('个人资料暂时无法读取，可以刷新重试。', { exact: true }).waitFor();
  await room().getByRole('button', { name: '重新读取个人资料', exact: true }).click(); releaseGet(); releaseGet = undefined;
  await page.waitForFunction(() => !document.querySelector('[aria-label="角色怎么称呼你"]')?.disabled);
  assert.equal(await input(room()).inputValue(), ''); assert.equal(await input(room()).getAttribute('placeholder'), '不指定，按人设自然称呼');
  await page.getByRole('button', { name: '打开插件外观', exact: true }).click();
  await input(settings()).waitFor();
  const beforeTyping = requests.filter(value => value.body).length;
  await input(room()).fill('  阿晴 👩‍💻  ');
  assert.equal(await input(settings()).inputValue(), '  阿晴 👩‍💻  ', 'both entrances edit the same unsaved profile draft');
  assert.equal(requests.filter(value => value.body).length, beforeTyping, 'typing never posts a profile change');
  await save(settings()).click(); await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="角色怎么称呼你"]')].every(node => node.value === '阿晴 👩‍💻'));
  assert.equal((await profile()).userAddress, '阿晴 👩‍💻');
  assert.deepEqual(Object.keys(requests.filter(value => value.body).at(-1).body).sort(), ['revision', 'userAddress']);
  await room().getByLabel('用户头像显示').selectOption('hidden');
  await page.waitForFunction(() => document.querySelector('[data-persona-shell="user-profile"] select')?.value === 'hidden');
  assert.equal((await profile()).userAddress, '阿晴 👩‍💻', 'display changes preserve the optional address');

  await room().getByRole('button', { name: '修改我的头像', exact: true }).click();
  const editor = room().getByRole('group', { name: '编辑我的头像', exact: true });
  await editor.getByLabel('选择头像图片').setInputFiles({ name: 'user.png', mimeType: 'image/png', buffer: Buffer.from(makeAvatar().split(',')[1], 'base64') });
  await editor.getByRole('button', { name: '保存我的头像', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  const withAvatar = await profile(); assert.equal(withAvatar.userAddress, '阿晴 👩‍💻'); assert.equal(withAvatar.avatarMode, 'custom'); assert.ok(withAvatar.avatar);

  holdSave = true; releaseSave = undefined;
  await input(room()).fill('待确认的称呼'); await save(room()).click();
  for (let i = 0; i < 30 && !releaseSave; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(releaseSave);
  await input(settings()).fill('刚输入的新称呼'); assert.equal(await save(settings()).isDisabled(), true, 'one profile address save is shared across both entrances');
  releaseSave();
  await settings().getByText('上次称呼已保存，当前输入尚未保存。', { exact: true }).waitFor();
  assert.equal(await input(room()).inputValue(), '刚输入的新称呼'); assert.equal(await input(settings()).inputValue(), '刚输入的新称呼');
  await save(settings()).click(); await page.waitForFunction(() => document.querySelector('[data-persona-shell="user-profile"]')?.textContent.includes('称呼已保存。'));
  assert.equal((await profile()).userAddress, '刚输入的新称呼'); assert.equal((await profile()).avatar, withAvatar.avatar);

  await page.getByRole('button', { name: '收起聊天室设置', exact: true }).click(); holdGet = true; releaseGet = undefined;
  await page.getByRole('button', { name: '打开聊天室设置', exact: true }).click();
  for (let i = 0; i < 30 && !releaseGet; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(releaseGet);
  await input(settings()).fill('晚读取不能覆盖'); await save(settings()).click();
  await settings().getByText('称呼已保存。', { exact: true }).waitFor();
  const delivered = await page.evaluate(() => window.profileDelivered); releaseGet();
  await page.waitForFunction(previous => window.profileDelivered > previous, delivered); await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await input(room()).inputValue(), '晚读取不能覆盖');

  failProfile = true; await input(room()).fill('失败后保留的草稿'); await save(room()).click();
  await room().getByText('称呼未能保存，输入仍保留，可以重试。', { exact: true }).waitFor(); failProfile = false;
  await page.getByRole('button', { name: '收起聊天室设置', exact: true }).click(); await page.getByRole('button', { name: '收起插件外观', exact: true }).click();
  await page.getByRole('button', { name: '打开插件外观', exact: true }).click();
  assert.equal(await input(settings()).inputValue(), '失败后保留的草稿');
  await save(settings()).click(); await settings().getByText('称呼已保存。', { exact: true }).waitFor();
  await input(settings()).fill('发生冲突时的草稿');
  const current = await profile(); assert.equal((await f.request('chat-profile', { revision: current.revision, userAddress: '外部确认值' })).status, 200);
  await save(settings()).click(); await settings().getByText('个人资料已在别处更新，输入仍保留。请核对后重试保存。', { exact: true }).waitFor();
  assert.equal(await input(settings()).inputValue(), '发生冲突时的草稿'); await save(settings()).click();
  await settings().getByText('称呼已保存。', { exact: true }).waitFor(); assert.equal((await profile()).userAddress, '发生冲突时的草稿');

  holdSave = true; releaseSave = undefined;
  await input(settings()).fill('超时后核对的称呼'); await save(settings()).click();
  for (let i = 0; i < 30 && !releaseSave; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(releaseSave);
  await page.clock.fastForward(10_001);
  await settings().getByText('未能确认保存，输入已保留。请核对后重试。', { exact: true }).waitFor();
  assert.equal(await save(settings()).isDisabled(), false); assert.equal(await input(settings()).inputValue(), '超时后核对的称呼');
  assert.equal((await profile()).userAddress, '超时后核对的称呼', 'the timeout may follow a committed server write');
  await save(settings()).click(); await settings().getByText('称呼已保存。', { exact: true }).waitFor(); releaseSave();
  assert.equal(await input(settings()).inputValue(), '超时后核对的称呼', 'an explicit idempotent retry confirms without an automatic write replay');

  await input(settings()).fill('😊'.repeat(40)); assert.equal(await save(settings()).isDisabled(), false);
  await save(settings()).click(); await settings().getByText('称呼已保存。', { exact: true }).waitFor(); assert.equal((await profile()).userAddress, '😊'.repeat(40));
  await input(settings()).fill('😊'.repeat(41)); await settings().getByText('最多 40 个字符，复杂表情可能占多个字符。', { exact: true }).waitFor(); assert.equal(await save(settings()).isDisabled(), true);
  for (const candidate of ['阿晴\u200b', '阿\u202e晴', '阿晴\ufeff', '阿晴\u0007', '阿晴\ud800']) {
    assert.equal(normalizeUserAddress(candidate), null);
    assert.ok(await page.evaluate(value => !!window.profileUI.userAddressProblem(value), candidate));
  }
  assert.equal(await page.evaluate(() => window.profileUI.userAddressProblem('阿晴👩‍💻')), '');
  await input(settings()).fill(''); await save(settings()).click(); await settings().getByText('称呼已保存。', { exact: true }).waitFor();
  assert.equal((await profile()).userAddress, ''); assert.equal((await profile()).avatar, withAvatar.avatar);
  assert.equal(await page.getByRole('textbox', { name: '工作输入', exact: true }).inputValue(), '独立的工作草稿'); assert.equal(await page.locator('[data-quote]').innerText(), '引用作者：我');
  if (values.output) {
    mkdirSync(values.output, { recursive: true });
    await page.screenshot({ path: path.join(values.output, 'user-address-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(values.output, 'user-address-mobile-dark.png'), fullPage: true });
  }
  assert.equal(f.requests.length, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ result: 'passed', modelCalls: 0, pageErrors: errors, cases: ['bounded profile read with explicit retry', 'optional empty default without account-name inference', 'explicit save and Unicode trimming', 'shared unsaved draft across entrances', 'avatar/mode and address updates preserve each other', 'late save acknowledgment cannot overwrite new typing', 'late profile GET cannot restore old confirmation', 'failed save survives close and retries', 'CAS conflict preserves draft', 'unconfirmed save timeout and explicit idempotent retry', '40 Unicode code points and invisible/control rejection', 'clear restores default address', 'work input and author attribution unchanged', 'mobile dark layout'] }));
} finally { releaseGet?.(); releaseSave?.(); await browser.close(); for (const dispose of cleanups.reverse()) await dispose(); }
