// Real React components, local deterministic host. No provider calls or Desktop claims.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import path from 'node:path';
import {makeReportSource} from '../../lib/report-visualization.js';
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
  reportSource:makeReportSource({sessionId:'s',seq:10,text:'原始工作汇报，保留必要条件和风险。'}),
  posts: [], failNext: null, delayed: false,
};
const entry = `
import * as React from ${JSON.stringify(deps.resolve('react'))};
import { createRoot } from ${JSON.stringify(deps.resolve('react-dom/client'))};
const h=React.createElement; let plugin;
window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==='react')return React;if(id==='react-dom/client')return{createRoot};throw Error(id)})}};
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
  if(b.version!==host.row.version||b.personaId!==host.row.speaker?.id||(host.row.sourceHash&&b.sourceHash!==host.row.sourceHash))return reply({error:'report-conflict'},409);
  if(host.delayed)await new Promise(resolve=>window.releaseFeedback=resolve);
  if(host.failNext){const reason=host.failNext;host.failNext=null;return reply({error:reason},422)}
  host.conversation.stateRev++;
    if(b.scope==='once'){host.row.text='新的可读汇报。';host.row.status='ready';host.row.version++;window.repaint()}
  return reply({ok:true,version:host.row.version,personaId:host.row.speaker?.id});
 }
 if(route.endsWith('/report-visualization'))return reply({available:true,source:host.reportSource,cached:false});
 if(route.endsWith('/state'))return reply({instanceId:host.conversation.instanceId,rev:host.conversation.stateRev,rows:[host.row],conversation:host.conversation,settings:{enabled:host.settingsEnabled!==false},sessionEnabled:host.sessionEnabled!==false,switchesReady:true});
 return reply({});
};
plugin.__testing.applyControls({instanceId:'test',controlRev:1,settings:{enabled:true},sessionSwitches:{rev:1,values:{}}},1);
window.refreshConversation=()=>plugin.__testing.refreshState('s');
const originalBlocks=[{kind:'text',text:'原始工作汇报，保留必要条件和风险。'}];
const reportNode={key:'assistant:10',location:{kind:'step',turn:{status:'closed'}},data:{status:'settled',blocks:originalBlocks,finalNode:{seq:10,blocks:originalBlocks},step:1}};
function OfficialReport({node}){React.useEffect(()=>{window.officialReportMounts=(window.officialReportMounts??0)+1;return()=>{window.officialReportUnmounts=(window.officialReportUnmounts??0)+1}},[]);
 return h('p',{'data-preview-report':''},node.data.blocks.find(block=>block.kind==='text').text)}
const officialDelegate={entry:{component:OfficialReport}};
function App(){const[,update]=React.useState(0);window.repaint=()=>{update(n=>n+1);void plugin.__testing.refreshState('s')};
 return h(React.Fragment,null,h('header',null,h(plugin.__testing.SessionPersonaSwitch,{sessionId:'s'})),
  h('article',null,h('h1',null,'一次汇报，一个明确的说话者'),h(plugin.__testing.PersonaStep,{delegate:officialDelegate,sessionId:'s',node:reportNode,renderFactorySlot:()=>null})))
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
  const beforeQuick=await page.evaluate(()=>window.conversationMock.posts.length);
  const thinkingToggle=page.getByRole('checkbox',{name:'本次调整开启思考',exact:true});assert.equal(await thinkingToggle.isChecked(),true);
  await page.getByRole('button',{name:'短一点',exact:true}).click();
  assert.match(await page.getByLabel('表达反馈').inputValue(),/短一点.*条件和风险/);
  assert.equal(await page.evaluate(()=>window.conversationMock.posts.length),beforeQuick,'a shortcut only fills the request');
  assert.equal(await page.getByLabel('表达反馈').evaluate(element=>element===document.activeElement),true);
  assert.equal(await page.getByLabel('表达反馈').getAttribute('maxlength'),'240');
  await page.getByLabel('表达反馈').fill('少一点调侃，先给结论。');
  await close('调整这份汇报的表达'); await page.getByRole('button', { name: '调整表达', exact: true }).click();
  assert.equal(await page.getByLabel('表达反馈').inputValue(), '少一点调侃，先给结论。');
  await page.evaluate(() => { window.conversationMock.failNext = 'feedback-rewrite-failed'; });
  await page.getByRole('button', { name: '重新转述', exact: true }).click();
  await visible('这次调整没有完成，已保留原来的汇报和你的输入。');
  assert.equal(await page.evaluate(()=>window.conversationMock.posts.at(-1).thinking),true);assert.equal(await thinkingToggle.isChecked(),true);
  await page.evaluate(()=>{window.conversationMock.failNext='feedback-thinking-unavailable';});await page.getByRole('button',{name:'重新转述',exact:true}).click();
  await visible('当前模型无法启用思考，原汇报与输入已保留；可更换模型，或关闭本次思考后重试。');assert.equal(await thinkingToggle.isChecked(),true);assert.equal(await page.getByLabel('表达反馈').inputValue(),'少一点调侃，先给结论。');
  await thinkingToggle.click();assert.equal(await thinkingToggle.isChecked(),false);
  assert.equal(await page.locator('[data-preview-report]').textContent(), '原来已经可读的汇报。');
  assert.equal(await page.getByLabel('反馈作用范围').count(), 0);
  assert.equal(await page.getByText('本次参考的偏好（1）', { exact: true }).count(), 0);
  await capture('feedback-light', 1100); await capture('feedback-mobile', 390); await capture('feedback-dark', 1100, true);
  await page.getByRole('button', { name: '重新转述', exact: true }).click();
  await visible('已按这次偏好重新转述。');
  assert.equal(await page.evaluate(()=>window.conversationMock.posts.at(-1).thinking),false);
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
  await close('调整这份汇报的表达');
  // The production PersonaStep must expose the action on a settled fallback, not just a ready rewrite.
  await page.evaluate(async()=>{const h=window.conversationMock;h.row.status='failed';h.row.canRetry=true;h.row.version++;h.conversation.stateRev++;await window.refreshConversation()});
  await visible('原始工作汇报，保留必要条件和风险。');
  assert.equal(await page.getByRole('button',{name:'原文',exact:true}).count(),0,'plain fallback does not offer a meaningless comparison');
  await page.getByRole('button',{name:'调整表达',exact:true}).click();await page.getByRole('button',{name:'先说结论',exact:true}).click();
  await page.getByRole('button',{name:'重新转述',exact:true}).click();await visible('已按这次偏好重新转述。');
  await visible('新的可读汇报。');await close('调整这份汇报的表达');
  for(const [reason,note] of [['source-unavailable','这份旧汇报没有保存原始来源，暂时不能重新转述。'],['persona-not-found','这个人格已经被删除，请重新选择。'],['rewrite-disabled','当前转述已关闭，开启后可以重试。']]){
    await page.evaluate(async reason=>{const h=window.conversationMock;h.row.status='skipped';h.row.version++;h.row.canRetry=false;h.row.retryUnavailableReason=reason;
      h.sessionEnabled=reason!=='rewrite-disabled';h.conversation.stateRev++;await window.refreshConversation()},reason);
    const beforeUnavailable=await page.evaluate(()=>window.conversationMock.posts.length);
    await page.getByRole('button',{name:'调整表达',exact:true}).click();await visible(note);
    await page.getByLabel('表达反馈').fill('这次短一点');assert.equal(await page.getByRole('button',{name:'重新转述',exact:true}).isDisabled(),true);
    assert.equal(await page.evaluate(()=>window.conversationMock.posts.length),beforeUnavailable,'unavailable actions explain rather than dispatch');
    await close('调整这份汇报的表达');
  }
  for(const mode of ['global','session']){
    await page.evaluate(async mode=>{const h=window.conversationMock;h.settingsEnabled=mode!=='global';h.sessionEnabled=mode!=='session';
      h.row.status='skipped';h.row.text='';h.row.sourceHash=h.reportSource.hash;h.row.canRetry=true;delete h.row.retryUnavailableReason;
      h.row.version++;h.conversation.stateRev++;await window.refreshConversation();
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copiedAdjustment=text}});
    },mode);
    await visible('原始工作汇报，保留必要条件和风险。');
    await page.getByRole('button',{name:'阅读报告',exact:true}).click();
    await page.getByRole('dialog',{name:'报告阅读页',exact:true}).waitFor();
    await page.getByLabel('原始报告全文',{exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭报告阅读页',exact:true}).click();
    await page.getByRole('button',{name:'调整表达',exact:true}).click();await page.getByLabel('表达反馈').fill('这次先说结论');
    const count=await page.evaluate(()=>window.conversationMock.posts.length);
    await page.getByRole('button',{name:'重新转述',exact:true}).click();await visible('已按这次偏好重新转述，可在下方查看。');
    const result=page.getByRole('region',{name:'表达结果',exact:true});await result.getByText('新的可读汇报。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'复制调整结果',exact:true}).click();assert.equal(await page.evaluate(()=>window.copiedAdjustment),'新的可读汇报。');
    assert.equal(await page.evaluate(()=>window.conversationMock.posts.length),count+1);
    assert.equal(await page.locator('[data-preview-report]').innerText(),'原始工作汇报，保留必要条件和风险。');
    assert.equal(await page.evaluate(mode=>mode==='global'?window.conversationMock.settingsEnabled:window.conversationMock.sessionEnabled,mode),false);
    if(values.output)await page.screenshot({path:path.join(values.output,'disabled-'+mode+'-report-feedback.png'),fullPage:true});
    await close('调整这份汇报的表达');await page.getByRole('button',{name:'调整表达',exact:true}).click();await result.waitFor();await close('调整这份汇报的表达');
  }
  await page.evaluate(async()=>{const h=window.conversationMock;h.settingsEnabled=true;h.sessionEnabled=true;h.row.status='ready';h.row.canRetry=true;delete h.row.retryUnavailableReason;h.row.version++;h.conversation.stateRev++;await window.refreshConversation()});
  for(const mutation of ['version','speaker']){
    await page.getByRole('button',{name:'调整表达',exact:true}).click();await page.getByLabel('表达反馈').fill('目标变化时仍保留的表达草稿');
    const beforeStale=await page.evaluate(()=>window.conversationMock.posts.length);
    await page.evaluate(async mutation=>{const h=window.conversationMock;if(mutation==='version')h.row.version++;
      else h.row.speaker={id:'Claude小姐',name:'Claude小姐',mode:'voice'};h.conversation.stateRev++;await window.refreshConversation()},mutation);
    await visible('这份汇报的会话、版本或说话者已变化。输入已保留，请关闭后重新打开，核对目标再调整。');
    assert.equal(await page.getByRole('button',{name:'重新转述',exact:true}).isDisabled(),true);
    assert.equal(await page.getByLabel('表达反馈').inputValue(),'目标变化时仍保留的表达草稿');
    assert.equal(await page.evaluate(()=>window.conversationMock.posts.length),beforeStale);
    if(mutation==='speaker')await capture('feedback-stale-target-mobile',390,true);
    await close('调整这份汇报的表达');
  }
  assert.equal(await page.evaluate(()=>window.officialReportMounts),1,'the delegated official body remains continuously mounted');
  assert.equal(await page.evaluate(()=>window.officialReportUnmounts??0),0);
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  console.log(JSON.stringify({ ok: true, checks: ['real PersonaStep action entry','settled fallback retry','shortcut fill without request','unavailable reason without dispatch','version and speaker target pinning','continuously mounted official delegate','late-opening-readiness', 'drafts', 'conflicts', 'relay-cancel', 'raw-report-preservation','disabled global and session controls','source-bound manual preview and copy without enabling automation', 'retry', 'memory-controls-settings-only', 'late-response-draft', 'mobile', 'dark', 'focus', 'escape','adjustment thinking starts checked','thinking choice retained on failure and close','thinking unavailable is explicit with draft retained','one-off opt-out is sent without altering global switches'], screenshots: values.output ?? null }));
} finally { await browser.close(); }
