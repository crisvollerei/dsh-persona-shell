// Real React components, local deterministic host. No provider calls or Desktop claims.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import path from 'node:path';
const { values } = parseArgs({ options: { deps: { type: 'string' }, 'browser-deps': { type: 'string' },
  executable: { type: 'string' }, output: { type: 'string' } } });
const deps = createRequire(path.resolve(values.deps));
const browserDeps = createRequire(path.resolve(values['browser-deps'] ?? values.deps));
const { buildSync } = deps('esbuild');
const { chromium } = browserDeps('playwright');
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const seed = {
  conversation: { sessionId: 's', instanceId: 'test', stateRev: 1, revision: 0, personaId: null, trigger: 'inherit', relay: null, ready: true,
    effectivePersonaId: '大肥鱼（默认）', effectivePersonaName: '大肥鱼（默认）', effectiveTrigger: 'step',
    presets: [{ id: '大肥鱼（默认）', name: '大肥鱼（默认）' }, { id: 'Claude小姐', name: 'Claude小姐' }, { id: '鲸鲸（实验性）', name: '小肥鱼（实验性）' }] },
  row: { seq: 10, version: 1, final: true, status: 'ready', text: '原来已经可读的汇报。', canRetry: true,
    speaker: { id: '大肥鱼（默认）', name: '大肥鱼（默认）', mode: 'voice' }, memories: [{ id: 'm', scope: 'persona', content: '先说结论' }] },
  posts: [], failNext: null, delayed: false,
};
const entry = `
import * as React from ${JSON.stringify(deps.resolve('react'))};
import { createRoot } from ${JSON.stringify(deps.resolve('react-dom/client'))};
const h=React.createElement; let plugin;
window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==='react')return React;throw Error(id)})}};
${source}
const host=window.conversationMock=${JSON.stringify(seed)};
const reply=(body,status=200)=>({ok:status<300,status,json:async()=>structuredClone(body)});
window.fetch=async(url,options)=>{
 const route=new URL(url,'https://local.invalid').pathname;
 if(route.endsWith('/conversation')){
  if(!options){const snapshot=structuredClone(host.conversation);if(host.delayRead){host.delayRead=false;await new Promise(resolve=>window.releaseConversationRead=resolve)}host.readReturned=true;return reply(snapshot)}
  const b=JSON.parse(options.body);host.posts.push(b);
  if(host.failNext){const reason=host.failNext;host.failNext=null;return reply({error:reason},503)}
  if(b.revision!==host.conversation.revision)return reply({error:'conversation-conflict',conversation:host.conversation},409);
  const c=host.conversation;c.revision++;c.stateRev++;
  if(b.action==='select'){c.personaId=b.personaId;c.trigger=b.trigger;c.effectivePersonaId=b.personaId||'大肥鱼（默认）';c.effectivePersonaName=c.effectivePersonaId;if(c.relay?.status==='pending')c.relay.status='cancelled'}
  if(b.action==='relay')c.relay={id:'relay1',status:'pending',toPersonaId:b.toPersonaId};
  if(b.action==='cancel')c.relay.status='cancelled';
  return reply(c);
 }
 if(route.endsWith('/feedback')){
  const b=JSON.parse(options.body);host.posts.push(b);
  if(host.delayed)await new Promise(resolve=>window.releaseFeedback=resolve);
  if(host.failNext){const reason=host.failNext;host.failNext=null;return reply({error:reason},422)}
  host.conversation.stateRev++;
  if(b.scope==='once'){host.row.text='新的可读汇报。';host.row.version++;window.repaint()}
  return reply({ok:true});
 }
 if(route.endsWith('/state'))return reply({instanceId:host.conversation.instanceId,rev:host.conversation.stateRev,rows:[host.row],conversation:host.conversation,settings:{enabled:true},sessionEnabled:true,switchesReady:true});
 return reply({});
};
plugin.__testing.applyControls({instanceId:'test',controlRev:1,settings:{enabled:true},sessionSwitches:{rev:1,values:{}}},1);
window.refreshConversation=()=>plugin.__testing.refreshState('s');
function App(){const[open,setOpen]=React.useState(null);const[,update]=React.useState(0);window.repaint=()=>update(n=>n+1);
 return h(React.Fragment,null,h('header',null,h(plugin.__testing.SessionPersonaSwitch,{sessionId:'s'})),
  h('article',null,h('h1',null,'一次汇报，一个明确的说话者'),h('p',{'data-preview-report':''},host.row.text),
   h('button',{onClick:()=>setOpen('feedback')},'调整表达')),
  open==='feedback'?h(plugin.__testing.ReportFeedback,{sessionId:'s',row:host.row,onClose:()=>setOpen(null)}):null)
}
createRoot(document.getElementById('app')).render(h(App));`;
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  await page.setContent(`<html><head><meta charset="utf-8"><style>
    :root{--dsw-alias-label-primary:#243244;--dsw-alias-label-secondary:#697587;--dsw-alias-brand-primary:#386fba;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f6f8fb;--dsw-alias-border-l1:#dce2e9}
    :root[data-theme=dark]{--dsw-alias-label-primary:#e2e7ef;--dsw-alias-label-secondary:#a5b2c4;--dsw-alias-brand-primary:#8aaff1;--dsw-alias-bg-layer-1:#19212e;--dsw-alias-bg-layer-2:#222d3e;--dsw-alias-border-l1:#364459}
    body{margin:0;padding:24px;font:14px/1.7 'Segoe UI','Microsoft YaHei',sans-serif;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
    header{display:flex;justify-content:flex-end;gap:8px;overflow:hidden;transform:translateZ(0);font-size:24px}article{max-width:680px;margin:70px auto}h1{font-size:22px}
  </style></head><body><main id="app"></main></body></html>`);
  await page.addScriptTag({ content: bundle });
  const visible = (text) => page.getByText(text, { exact: true }).waitFor();
  const openConversation = () => page.getByRole('button', { name: /设置$/ }).click();
  assert.equal((await page.locator('header').innerText()).replace(/\s+/g, ''), '人格开会话设置聊天室');
  for (const name of ['会话设置', '聊天室']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).evaluate((e) => {
      const s=getComputedStyle(e); return e.getBoundingClientRect().height===24 && s.fontSize==='12px' && parseFloat(s.borderTopWidth)>0;
    }), true, name + ' is a compact outlined button independent of the header font');
  }
  const close = (title) => page.getByRole('button', { name: '关闭' + title, exact: true }).click();
  const capture = async (name, width = 1100, dark = false) => {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((d) => { document.documentElement.dataset.theme = d ? 'dark' : 'light'; }, dark);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('dialog').evaluate((e) => e.scrollWidth <= e.clientWidth), true);
    const bounds = await page.locator('dialog').evaluate((e) => {
      const d=e.getBoundingClientRect();
      return [...e.querySelectorAll('h3,label,select,button')].filter(n=>n.getClientRects().length).every(n=>{
        const r=n.getBoundingClientRect(); return r.left>=d.left && r.right<=d.right+1 && r.top>=d.top && r.bottom<=d.bottom+1;
      });
    });
    assert.equal(bounds, true, 'session controls fit the top-layer dialog even inside a clipped header');
    if (values.output) { mkdirSync(values.output, { recursive: true }); await page.screenshot({ path: path.join(values.output, name + '.png'), fullPage: true }); }
  };
  // A stale opening read must not undo a newer pushed readiness state.
  await page.evaluate(async () => {
    const c = window.conversationMock.conversation; c.ready = false; c.stateRev++;
    window.conversationMock.delayRead = true; window.conversationMock.readReturned = false;
    await window.refreshConversation();
  });
  await openConversation();
  await page.waitForFunction(() => typeof window.releaseConversationRead === 'function');
  assert.equal(await page.getByRole('button', { name: '保存会话选择', exact: true }).isDisabled(), true);
  await page.evaluate(async () => {
    const c = window.conversationMock.conversation; c.ready = true; c.stateRev++;
    await window.refreshConversation();
  });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((b) => b.textContent === '保存会话选择').disabled);
  await page.evaluate(() => window.releaseConversationRead());
  await page.waitForFunction(() => window.conversationMock.readReturned === true);
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole('button', { name: '保存会话选择', exact: true }).isDisabled(), false);
  await page.getByLabel('会话人格', { exact: true }).selectOption('Claude小姐');
  await page.getByLabel('会话转述范围').selectOption('report');
  await close('当前会话的人格'); await openConversation();
  assert.equal(await page.getByLabel('会话人格', { exact: true }).inputValue(), 'Claude小姐', 'closing preserves unsaved choices');
  await page.evaluate(() => { window.conversationMock.failNext = 'storage-not-ready'; });
  await page.getByRole('button', { name: '保存会话选择', exact: true }).click();
  await visible('保存服务尚未就绪，请稍后重试。输入已经保留。');
  assert.equal(await page.getByLabel('会话转述范围').inputValue(), 'report');
  await page.evaluate(() => { window.conversationMock.conversation.revision++; window.conversationMock.conversation.stateRev++; });
  await page.getByRole('button', { name: '保存会话选择', exact: true }).click();
  await visible('会话选择已在别处更新。已读入最新状态，请核对后重新保存。');
  await page.getByRole('button', { name: '保存会话选择', exact: true }).click();
  await visible('已保存，从后续汇报开始生效。');
  assert.equal(await page.evaluate(() => window.conversationMock.conversation.personaId), 'Claude小姐');
  await page.getByText('交给另一位角色', { exact: true }).click();
  await page.getByLabel('接手角色').selectOption('鲸鲸（实验性）');
  await page.getByRole('button', { name: '安排下一份汇报接力', exact: true }).click();
  await visible('已安排，下一份符合范围的原始汇报到达后接手。');
  assert.equal(await page.getByRole('button', { name: '安排下一份汇报接力', exact: true }).isDisabled(), true);
  await capture('conversation-relay-light'); await capture('conversation-relay-mobile', 390); await capture('conversation-relay-dark', 1100, true);
  await page.getByRole('button', { name: '取消接力', exact: true }).click();
  await visible('已取消等待中的接力。');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog').count(), 0);
  assert.match(await page.evaluate(() => document.activeElement.textContent), /设置/);
  await page.getByRole('button', { name: '调整表达', exact: true }).click();
  await page.getByLabel('表达反馈').fill('少一点调侃，先给结论。');
  await close('调整这份汇报的表达'); await page.getByRole('button', { name: '调整表达', exact: true }).click();
  assert.equal(await page.getByLabel('表达反馈').inputValue(), '少一点调侃，先给结论。');
  await page.evaluate(() => { window.conversationMock.failNext = 'feedback-rewrite-failed'; });
  await page.getByRole('button', { name: '重新转述', exact: true }).click();
  await visible('这次调整没有完成，已保留原来的汇报和你的输入。');
  assert.equal(await page.locator('[data-preview-report]').textContent(), '原来已经可读的汇报。');
  assert.equal(await page.getByLabel('反馈作用范围').count(), 0);
  assert.equal(await page.getByText('本次参考的偏好（1）', { exact: true }).count(), 0);
  await capture('feedback-light', 1100); await capture('feedback-mobile', 390); await capture('feedback-dark', 1100, true);
  await page.getByRole('button', { name: '重新转述', exact: true }).click();
  await visible('已按这次偏好重新转述。');
  assert.equal(await page.locator('[data-preview-report]').textContent(), '新的可读汇报。');
  assert.equal(await page.getByLabel('表达反馈').inputValue(), '', 'a reopened submitted draft is cleared');
  // Closing during a one-off rewrite preserves a newer reopened draft.
  await page.getByLabel('表达反馈').fill('旧请求的偏好');
  await page.evaluate(() => { window.conversationMock.delayed = true; });
  await page.getByRole('button', { name: '重新转述', exact: true }).click();
  await close('调整这份汇报的表达'); await page.getByRole('button', { name: '调整表达', exact: true }).click();
  await page.getByLabel('表达反馈').fill('重新打开后继续输入的新草稿');
  await page.evaluate(() => { window.conversationMock.delayed = false; window.releaseFeedback(); });
  await page.waitForTimeout(50);
  await close('调整这份汇报的表达'); await page.getByRole('button', { name: '调整表达', exact: true }).click();
  assert.equal(await page.getByLabel('表达反馈').inputValue(), '重新打开后继续输入的新草稿');
  assert.equal(await page.getByRole('button', { name: '记住这条偏好', exact: true }).count(), 0);
  const focused = await page.evaluate(() => document.activeElement.closest('dialog') !== null);
  assert.equal(focused, true, 'focus stays inside modal');
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  console.log(JSON.stringify({ ok: true, checks: ['late-opening-readiness', 'drafts', 'conflicts', 'relay-cancel', 'raw-report-preservation', 'retry', 'memory-controls-settings-only', 'late-response-draft', 'mobile', 'dark', 'focus', 'escape'], screenshots: values.output ?? null }));
} finally { await browser.close(); }
