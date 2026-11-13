// Real React with a controlled transport buffer. No provider, work source or profile calls.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { deps: { type: 'string' }, 'browser-deps': { type: 'string' }, executable: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values.deps, 'Pass --deps <React/esbuild dependency package.json>');
const deps = createRequire(path.resolve(values.deps)), browserDeps = createRequire(path.resolve(values['browser-deps'] ?? values.deps));
const { buildSync } = deps('esbuild'), { chromium } = browserDeps('playwright');
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const initial = { instanceId: 'queue-ui', personaId: 'a', ready: true, modelReady: true, chatSchema: 3, discussionVersion: 2,
  epoch: 0, scopeKey: 'scope', running: false, canQueue: true, inputRevision: 0, queuedInputs: [], activeAttemptIds: [],
  userProfile: { avatarMode: 'hidden', revision: 0 }, contacts: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }], rooms: [],
  room: { id: 'room', name: '分条原话与等待', memberIds: ['a', 'b'], targetPersonaId: 'a', targetPersonaIds: ['a'], turns: [], generation: 0, revision: 0, configRevision: 0 } };
const entry = `
import * as React from ${JSON.stringify(deps.resolve('react'))};import * as ReactDOM from ${JSON.stringify(deps.resolve('react-dom'))};import {createRoot} from ${JSON.stringify(deps.resolve('react-dom/client'))};
const h=React.createElement;let plugin;
window.__ModuleLoader__={load(d){plugin=d.factory(id=>{if(id==='react')return React;if(id==='react-dom')return ReactDOM;if(id==='react-dom/client')return{createRoot};throw Error(id)})}};
${source}
const host=window.inputHost={state:${JSON.stringify(initial)},posts:[],reads:0,hold:false};
const snapshot=()=>structuredClone(host.state),reply=value=>({ok:true,status:200,json:async()=>structuredClone(value)});
host.liveWriters=new Set();host.pushLive=value=>{host.liveSnapshot=value;const bytes=new TextEncoder().encode('data: '+JSON.stringify(value)+'\\n\\n');for(const writer of host.liveWriters)writer.enqueue(bytes);};
window.fetch=async(url,options)=>{const route=new URL(url,location.origin).pathname;
 if(route.endsWith('/chat-context'))return reply({id:'context',roomId:'room',revision:0,scopeKey:'scope',initialized:true,sources:[],projects:[],notices:[]});
 if(route.endsWith('/chat/live')){if(!host.liveEnabled)return{ok:false,status:503};let writer;
  return{ok:true,status:200,body:new ReadableStream({start(controller){writer=controller;host.liveWriters.add(writer);if(host.liveSnapshot)writer.enqueue(new TextEncoder().encode('data: '+JSON.stringify(host.liveSnapshot)+'\\n\\n'));},cancel(){host.liveWriters.delete(writer);}})};}
 if(route.endsWith('/chat-rooms')){const body=JSON.parse(options.body);host.posts.push(body);if(body.action!=='update')throw Error('unexpected room action');
  host.state.room.targetPersonaIds=[...body.targetPersonaIds];host.state.room.targetPersonaId=body.targetPersonaIds[0]??null;host.state.room.configRevision++;host.state.room.revision++;return reply(snapshot());}
 if(!route.endsWith('/chat'))throw Error('unexpected request '+route);
 if(!options?.method){host.reads++;return reply(snapshot());}
 const body=JSON.parse(options.body);host.posts.push(body);if(host.hold){host.hold=false;await new Promise(resolve=>host.release=resolve);}
 if(body.action==='send'){
  const part={id:body.requestId,text:body.content,at:Date.now()};let batch=host.state.queuedInputs.at(-1);
  if(!batch||batch.status!=='pending'||!!batch.quote!==!!body.quote){batch={id:body.requestId,parts:[],recipients:[{id:'a',name:'甲'}],status:'pending'};host.state.queuedInputs.push(batch);}
  if(!batch.parts.some(value=>value.id===part.id))batch.parts.push(part);
 }else if(body.action==='retry-input'){host.state.queuedInputs.find(batch=>batch.id===body.requestId).status='pending';}
 else if(body.action==='cancel-input'){host.state.queuedInputs=host.state.queuedInputs.filter(batch=>batch.id!==body.requestId);}
 else if(body.action==='retry-director'){host.state.directorFailure=null;}
 else throw Error('unexpected action '+body.action);
 host.state.inputRevision++;return reply(snapshot());};
const root=createRoot(document.getElementById('app'));
window.refreshInputUI=()=>root.render(h(plugin.__testing.PersonaChatWindow,{roomId:'room',sessionId:'work',initialState:snapshot(),animateEntrance:false,onClose:()=>root.render(null)}));
window.mountBlankInputUI=()=>root.render(h(plugin.__testing.PersonaChatWindow,{roomId:'room',sessionId:'work',animateEntrance:false,onClose:()=>root.render(null)}));
window.closeInputUI=()=>root.render(null);window.refreshInputUI();
window.commitInput=()=>{const batch=host.state.queuedInputs[0],parts=structuredClone(batch.parts);host.state.room.turns.push({id:batch.id,messageId:batch.id,attemptId:'answer-'+batch.id,recipientId:'a',speakerName:'甲',recipients:batch.recipients,memberIdsAtSend:['a','b'],scopeKey:'scope',user:parts.map(part=>part.text).join('\\n'),userParts:parts,at:parts[0].at,status:'ready',assistant:['两句原话都收到了。'],phase:'primary'});host.state.queuedInputs=[];host.state.room.revision++;host.state.inputRevision++;};
`;
const bundle = buildSync({ stdin: { contents: entry, resolveDir: path.dirname(deps.resolve('react')) }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).outputFiles[0].text;
const browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : {}) });
const errors = [], external = [];
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('https://input.test/')) external.push(request.url()); });
  await page.route('https://input.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head><style>:root{--dsw-alias-label-primary:#203044;--dsw-alias-label-secondary:#607086;--dsw-alias-brand-primary:#3d6dcc;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f3f5f8;--dsw-alias-border-l1:#d2dce8}body{margin:0;font:14px system-ui}</style></head><body><div id="app"></div></body></html>' }));
  await page.goto('https://input.test/'); await page.addScriptTag({ content: bundle });
  const dialog = page.getByRole('dialog', { name: '聊天室', exact: true }), input = page.getByLabel('发送给角色的消息', { exact: true });
  const send = async text => { await input.fill(text); await page.getByRole('button', { name: '发送', exact: true }).click(); };
  const captureMobile=async name=>{if(!values.output)return;mkdirSync(values.output,{recursive:true});const before=page.viewportSize();await page.setViewportSize({width:390,height:850});
    await dialog.screenshot({path:path.join(values.output,name+'.png')});await page.setViewportSize(before);};
  await input.waitFor(); await page.waitForFunction(() => !document.querySelector('.dsh-persona-chat-compose textarea')?.disabled);
  await send('第一句原话'); await page.waitForFunction(() => document.querySelector('.dsh-persona-chat-compose textarea').value === '');
  await send('第二句原话'); await page.waitForFunction(() => document.querySelectorAll('[data-queued-input] [data-user=true]').length === 2);
  const parts = await page.evaluate(() => structuredClone(window.inputHost.state.queuedInputs[0].parts));
  await page.evaluate(() => { const host = window.inputHost; host.newerQueue = structuredClone(host.state.queuedInputs); host.state.queuedInputs[0].parts.pop(); host.state.inputRevision--; window.refreshInputUI(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await dialog.locator('[data-queued-input] [data-user=true]').count(), 2, 'a late lower input revision cannot erase a newer acknowledged part');
  await page.evaluate(() => { const host = window.inputHost; host.state.queuedInputs = host.newerQueue; host.state.inputRevision++; window.refreshInputUI(); });
  assert.equal(await dialog.locator('.dsh-persona-chat-empty').count(), 0); assert.equal(await dialog.locator('.dsh-persona-chat-typing').count(), 0, 'transport waiting is not model typing');
  assert.deepEqual(await dialog.locator('[data-queued-input] [data-user=true] .dsh-persona-chat-bubble').allTextContents(), ['@甲第一句原话', '@甲第二句原话']);
  assert.equal(await dialog.locator('[data-queued-input]').getByRole('button', { name: '引用我的消息', exact: true }).count(), 0, 'uncommitted parts cannot be quoted');
  await dialog.getByText('等待回应', { exact: true }).waitFor();
  await captureMobile('chat-user-parts-waiting-mobile');
  const beforeCommit = await page.evaluate(() => window.inputHost.reads); await page.evaluate(() => window.commitInput());
  await dialog.getByText('两句原话都收到了。', { exact: true }).waitFor(); assert.ok(await page.evaluate(() => window.inputHost.reads) > beforeCommit, 'pending transport is observed until it becomes a committed round');
  assert.equal(await dialog.locator('[data-queued-input]').count(), 0); assert.equal(await dialog.locator('[data-user=true]').count(), 2, 'committing preserves each part once');
  await page.evaluate(() => { const state = window.inputHost.state, original = state.room.turns[0];
    state.room.turns.push({ ...structuredClone(original), id: 'peer-reply', messageId: 'peer-batch', attemptId: 'peer-attempt', recipientId: 'b', speakerName: '乙', assistant: ['乙也接上了。'] });
    state.room.turns.push({ ...structuredClone(original), id: 'ai-only', messageId: 'ai-only', attemptId: 'ai-only', userParts: [], phase: 'followup', assistant: ['再接同伴一句。'] });
    state.room.revision++; window.refreshInputUI(); });
  await dialog.getByText('乙也接上了。', { exact: true }).waitFor();
  assert.equal(await dialog.locator('[data-user=true]').count(), 2, 'another persona consuming the same parts or an AI-only continuation does not repeat user bubbles');
  const second = dialog.locator('[data-chat-user-part="' + parts[1].id + '"]'); await second.hover(); await second.getByRole('button', { name: '引用我的消息', exact: true }).click();
  assert.match(await page.getByLabel('正在引用的消息', { exact: true }).innerText(), /第二句原话/);
  await page.getByRole('button', { name: '查看引用原消息', exact: true }).click(); assert.equal(await second.evaluate(node => node.classList.contains('dsh-persona-chat-quoted-highlight')), true);
  await send('沿着第二句聊'); await page.waitForFunction(() => window.inputHost.posts.some(body => body.content === '沿着第二句聊'));
  assert.equal(await page.evaluate(() => window.inputHost.posts.find(body => body.content === '沿着第二句聊').quote.messageId), parts[1].id);
  await page.waitForFunction(() => document.querySelector('.dsh-persona-chat-compose textarea').value === '');
  await page.evaluate(() => { window.inputHost.state.queuedInputs[0].status = 'failed'; window.inputHost.state.inputRevision++; window.refreshInputUI(); });
  const queued = dialog.locator('[data-queued-input]'); await queued.getByRole('button', { name: '重试这组消息', exact: true }).click();
  assert.equal(await page.evaluate(() => window.inputHost.posts.at(-1).action), 'retry-input'); await queued.getByText('等待回应', { exact: true }).waitFor();
  await page.evaluate(() => { window.inputHost.state.queuedInputs[0].status = 'failed'; window.inputHost.state.inputRevision++; window.refreshInputUI(); });
  await queued.getByRole('button', { name: '取消这组消息', exact: true }).click(); await queued.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.inputHost.posts.at(-1).action), 'cancel-input');
  // A late durable acknowledgement clears only its own unchanged draft.
  await page.evaluate(() => { window.inputHost.hold = true; }); await send('等确认的原话');
  await input.fill('已经继续写的新草稿'); await page.evaluate(() => window.inputHost.release());
  await queued.waitFor(); assert.equal(await input.inputValue(), '已经继续写的新草稿');
  // A model-cooling seat has no active model call and must not pretend to type.
  await page.evaluate(() => { const state = window.inputHost.state; state.running = true; state.roundId = 'round'; state.roundMessageId = 'cooling'; state.roundPhase = 'speaking'; state.activeAttemptIds = [];
    state.room.turns.push({ id: 'cooling', messageId: 'cooling', attemptId: 'cooling-a', recipientId: 'a', speakerName: '甲', user: '前一轮', recipients: [{ id: 'a', name: '甲' }], scopeKey: 'scope', at: Date.now(), assistant: [], status: 'pending', phase: 'primary' }); state.room.revision++; window.refreshInputUI(); });
  assert.equal(await dialog.locator('.dsh-persona-chat-typing').count(), 0); await send('回复期间还可以继续说');
  await page.waitForFunction(() => window.inputHost.posts.some(body => body.content === '回复期间还可以继续说')); assert.equal(await input.inputValue(), '');
  assert.equal(await page.evaluate(() => 'afterMessageId' in window.inputHost.posts.at(-1)), false, 'buffering does not impersonate legacy round cancellation');
  // A later canonical seat may be ready before an earlier persona's independent cooldown.
  // Its response is ordered by actual dispatch, while the one user head stays before both.
  await page.evaluate(() => { const state=window.inputHost.state,base={messageId:'fair',user:'先让有空的人应一声',userParts:[{id:'fair-part',text:'先让有空的人应一声',at:Date.now()}],recipients:[{id:'a',name:'甲'}],memberIdsAtSend:['a','b'],scopeKey:'scope',at:Date.now(),assistant:[],status:'pending'};
    state.queuedInputs=[];state.inputRevision++;state.roundMessageId='fair';state.activeAttemptIds=['fair-b'];state.memberActivity=[{id:'b',state:'typing'}];
    state.room.turns.push({...base,id:'fair-a',attemptId:'fair-a',recipientId:'a',speakerName:'甲',phase:'primary'},
      {...base,id:'fair-b',attemptId:'fair-b',recipientId:'b',speakerName:'乙',phase:'reaction',emittedOrder:0});state.room.revision++;window.refreshInputUI(); });
  const fair=dialog.locator('[data-chat-message="fair"]');await dialog.locator('.dsh-persona-chat-member-activity[aria-label="乙：输入中"]').waitFor();
  assert.equal(await fair.locator('[data-chat-turn="fair-a"]').count(),0,'a cooling pending seat cannot block an emitted response');
  assert.equal(await fair.locator('[data-user=true]').count(),1);assert.equal(await fair.locator('[data-chat-user-head]').count(),1);
  await page.evaluate(() => { const state=window.inputHost.state;Object.assign(state.room.turns.find(turn=>turn.id==='fair-b'),{status:'ready',assistant:['乙先应上了。']});
    Object.assign(state.room.turns.find(turn=>turn.id==='fair-a'),{emittedOrder:1});state.activeAttemptIds=['fair-a'];state.memberActivity=[{id:'a',state:'typing'}];state.room.revision++;window.refreshInputUI(); });
  await fair.getByText('乙先应上了。',{exact:true}).waitFor();await dialog.locator('.dsh-persona-chat-member-activity[aria-label="甲：输入中"]').waitFor();
  assert.deepEqual(await fair.locator('[data-chat-turn]').evaluateAll(nodes=>nodes.map(node=>node.dataset.chatTurn)),['fair-b','fair-a']);
  assert.equal(await fair.evaluate(node=>node.firstElementChild.hasAttribute('data-chat-user-head')),true,'user parts are an independent fixed head');
  await page.evaluate(() => { const state=window.inputHost.state;Object.assign(state.room.turns.find(turn=>turn.id==='fair-a'),{status:'ready',assistant:['甲随后接上。']});state.activeAttemptIds=[];state.running=false;state.room.revision++;window.refreshInputUI(); });
  await fair.getByText('甲随后接上。',{exact:true}).waitFor();
  await captureMobile('chat-dispatch-order-mobile');
  await page.evaluate(()=>{const state=window.inputHost.state;Object.assign(state.room.turns.find(turn=>turn.id==='fair-b'),{status:'pending',assistant:[],attemptId:'fair-b-retry',directedPlanId:'retry-original'});
    state.running=true;state.roundMessageId='fair';state.activeAttemptIds=['fair-b-retry'];state.memberActivity=[{id:'b',state:'typing'}];state.room.revision++;window.refreshInputUI();});
  await dialog.locator('.dsh-persona-chat-member-activity[aria-label="乙：输入中"]').waitFor();
  assert.equal(await fair.getByText('甲随后接上。',{exact:true}).isVisible(),true,'retrying an earlier record does not hide an already completed later reply');
  await page.evaluate(()=>{const state=window.inputHost.state;Object.assign(state.room.turns.find(turn=>turn.id==='fair-b'),{status:'ready',assistant:['乙先应上了。']});state.running=false;state.activeAttemptIds=[];state.room.revision++;window.refreshInputUI();});
  await page.evaluate(()=>{const state=window.inputHost.state,base=structuredClone(state.room.turns.find(turn=>turn.id==='fair-a'));
    const neverStarted={...base,id:'fair-cancelled',attemptId:'fair-cancelled',phase:'followup',status:'cancelled',userParts:[],assistant:[]};delete neverStarted.emittedOrder;
    state.room.turns.push(neverStarted,{...neverStarted,id:'fair-stopped',attemptId:'fair-stopped',emittedOrder:2});state.room.revision++;window.refreshInputUI();});
  await fair.locator('[data-chat-turn="fair-stopped"]').waitFor();
  assert.equal(await fair.locator('[data-chat-turn="fair-cancelled"]').count(),0,'an unstarted optional cancellation has no phantom status row');
  if (values.output) { mkdirSync(values.output, { recursive: true }); await page.setViewportSize({ width: 390, height: 850 }); await dialog.screenshot({ path: path.join(values.output, 'chat-queued-input-mobile.png') }); }
  await page.evaluate(()=>{window.closeInputUI();const state=window.inputHost.state;state.contacts=Array.from({length:8},(_,i)=>({id:String.fromCharCode(97+i),name:['甲','乙','丙','丁','戊','己','庚','辛'][i]}));
    state.room.memberIds=state.contacts.map(person=>person.id);state.room.targetPersonaIds=['a'];state.room.targetPersonaId='a';state.running=false;state.activeAttemptIds=[];state.queuedInputs=[];
    state.room.turns=[{id:'directed-user',messageId:'directed-user',attemptId:'directed-user',phase:'anchor',recipientId:'user',speakerName:'我',user:'向整个房间说句话',userParts:[{id:'directed-user',text:'向整个房间说句话',at:Date.now()}],recipients:[],memberIdsAtSend:state.room.memberIds,at:Date.now(),assistant:[],status:'ready',scopeKey:'scope'}];
    state.room.revision++;window.refreshInputUI();});
  const targetGroup=dialog.getByRole('group',{name:'回复对象',exact:true});await targetGroup.waitFor();
  await targetGroup.getByRole('checkbox',{name:'甲',exact:true}).click();await targetGroup.getByText('发给房间',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.inputHost.state.room.targetPersonaIds),[],'the last @ can be removed without silently selecting someone');
  assert.equal(await dialog.locator('[data-chat-turn="directed-user"]').count(),0,'a directed user anchor has no fictional assistant row');
  assert.equal(await dialog.locator('[data-chat-user-part="directed-user"]').count(),1);assert.equal(await dialog.locator('.dsh-persona-chat-typing').count(),0);
  await captureMobile('chat-broadcast-selection-mobile');
  for(const name of ['辛','甲','庚','乙','己','丙','戊','丁'])await targetGroup.getByRole('checkbox',{name,exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.inputHost.state.room.targetPersonaIds),['h','a','g','b','f','c','e','d'],'eight selected addressees retain the order of user selection');
  assert.equal(await targetGroup.getByRole('checkbox',{checked:true}).count(),8);assert.equal(await targetGroup.locator('[aria-disabled=true]').count(),0);
  await page.evaluate(()=>{const state=window.inputHost.state;state.directorFailure={messageId:'directed-user',code:'invalid',reason:'choice'};window.refreshInputUI();});
  await dialog.getByText('暂时没接上，原话已保留',{exact:true}).waitFor();const beforeRetry=await page.evaluate(()=>window.inputHost.posts.length);
  assert.equal(await dialog.getByText('所选接话项不在本次候选中',{exact:true}).isVisible(),true,'the first-answer failure explains the stable server reason');
  await captureMobile('chat-director-retry-mobile');
  await dialog.getByRole('button',{name:'重试回应',exact:true}).click();await dialog.getByText('暂时没接上，原话已保留',{exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.evaluate(index=>window.inputHost.posts[index].action,beforeRetry),'retry-director');
  assert.equal(await page.evaluate(index=>window.inputHost.posts[index].messageId,beforeRetry),'directed-user');
  await page.evaluate(()=>{const state=window.inputHost.state,anchor=state.room.turns[0];state.room.turns.push({...structuredClone(anchor),id:'directed-ready',attemptId:'directed-ready',phase:'reaction',recipientId:'a',speakerName:'甲',assistant:['这句已经回应过了。'],emittedOrder:0,directedPlanId:'one-ready',responsePlan:{kind:'normal',to:'user'}});
    state.directorFailure={messageId:'directed-user',code:'invalid',reason:'stale-event'};state.room.revision++;window.refreshInputUI();});
  await dialog.getByText('后续接话暂未继续',{exact:true}).waitFor();
  assert.equal(await dialog.getByText('暂时没接上，原话已保留',{exact:true}).count(),0,'a later director failure does not relabel a successful answer as missing');
  assert.equal(await dialog.getByText('所选原话已经处理或不再适用',{exact:true}).isVisible(),true);assert.equal(await dialog.getByRole('button',{name:'重试回应',exact:true}).count(),0);
  await captureMobile('chat-director-continuation-failure-mobile');
  await dialog.getByRole('button',{name:'继续接话',exact:true}).click();await dialog.getByText('后续接话暂未继续',{exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>window.inputHost.posts.at(-1).action),'retry-director');
  await captureMobile('chat-directed-selection-mobile');
  // A terminal silent tombstone must retire an already visible provisional reply,
  // even if the canonical snapshot still carries the old pending seat briefly.
  await page.evaluate(()=>{const host=window.inputHost,state=host.state,anchor=state.room.turns[0];host.liveEnabled=true;
    state.running=true;state.roundId='silent-round';state.roundMessageId=anchor.messageId;state.roundPhase='speaking';state.activeAttemptIds=['silent-attempt'];
    state.room.turns.push({...structuredClone(anchor),id:'silent-seat',attemptId:'silent-attempt',phase:'reaction',recipientId:'b',speakerName:'乙',assistant:[],status:'pending',emittedOrder:1,directedPlanId:'silent-plan'});
    host.silentFrame={instanceId:state.instanceId,roomId:'room',turnId:'silent-seat',attemptId:'silent-attempt',personaId:'b',revision:1,status:'streaming',messages:[]};
    host.pushLive({instanceId:state.instanceId,roomId:'room',status:'streaming',frames:[host.silentFrame]});state.room.revision++;window.refreshInputUI();});
  const silentSeat=dialog.locator('[data-chat-turn="silent-seat"]');await silentSeat.waitFor({state:'attached'});
  await page.evaluate(()=>{const host=window.inputHost;host.silentFrame={...host.silentFrame,revision:2,messages:[{text:'尚未提交的片段',complete:false}]};host.pushLive({instanceId:host.state.instanceId,roomId:'room',status:'streaming',frames:[host.silentFrame]});});
  await silentSeat.getByText('尚未提交的片段',{exact:true}).waitFor();
  await page.evaluate(()=>{const host=window.inputHost,frame={...host.silentFrame,revision:3,status:'silent',messages:[{text:'非法空回应替代',complete:true}]};host.pushLive({instanceId:host.state.instanceId,roomId:'room',status:'streaming',frames:[frame]});});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await silentSeat.getByText('尚未提交的片段',{exact:true}).isVisible(),true,'a malformed silent frame cannot discard the real pending reply');
  await page.evaluate(()=>{const host=window.inputHost,frame={...host.silentFrame,turnId:'other-turn',revision:3,status:'silent',messages:[]};host.pushLive({instanceId:host.state.instanceId,roomId:'room',status:'streaming',frames:[frame]});});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await silentSeat.getByText('尚未提交的片段',{exact:true}).isVisible(),true,'a tombstone for a different turn cannot retire this pending reply');
  await page.evaluate(()=>{const host=window.inputHost,base=host.silentFrame,actual=Array.from({length:32},(_,i)=>({...base,turnId:'public-'+i,attemptId:'public-'+i,revision:3,status:'ready',messages:[{text:'已有公开回复 '+i,complete:true}]}));
    const silences=Array.from({length:8},(_,i)=>({...base,personaId:String.fromCharCode(97+i),turnId:i===1?'silent-seat':'silent-'+i,attemptId:i===1?'silent-attempt':'silent-'+i,revision:4,status:'silent',messages:[]}));
    host.pushLive({instanceId:host.state.instanceId,roomId:'room',status:'settled',frames:[...actual,...silences]});});
  await silentSeat.waitFor({state:'hidden'});assert.equal(await dialog.getByText('尚未提交的片段',{exact:true}).count(),0);
  assert.equal(await dialog.getByText('这句已经回应过了。',{exact:true}).isVisible(),true,'other completed replies survive a silent tombstone');
  await page.evaluate(()=>{const state=window.inputHost.state;state.running=false;state.activeAttemptIds=[];state.room.revision++;window.refreshInputUI();});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await silentSeat.count(),0,'a stale pending snapshot cannot resurrect a silent row or retry error');
  assert.equal(await dialog.getByRole('button',{name:'重试回复',exact:true}).count(),0);assert.equal(await dialog.locator('.dsh-persona-chat-typing').count(),0);
  const readyQuote=dialog.getByRole('button',{name:'引用甲的第1条消息',exact:true});assert.equal(await readyQuote.count(),1);
  await captureMobile('chat-silent-tombstone-mobile');
  await page.evaluate(()=>{const state=window.inputHost.state;state.room.turns=state.room.turns.filter(turn=>turn.id!=='silent-seat');state.room.revision++;window.refreshInputUI();});
  // Presence is a projection of Host activity, independent of the next @ selection and message playback.
  await page.evaluate(()=>{
    const state=window.inputHost.state;state.contacts=['甲','乙','丙','丁','戊'].map((name,index)=>({id:['a','b','c','d','e'][index],name}));
    state.queuedInputs=[];state.room.memberIds=state.contacts.map(p=>p.id);state.room.targetPersonaIds=['a','b'];state.room.targetPersonaId='a';
    state.room.turns=Array.from({length:12},(_,index)=>({id:'presence-'+index,messageId:'presence-'+index,attemptId:'presence-attempt-'+index,recipientId:'a',speakerName:'甲',recipients:[{id:'a',name:'甲'}],memberIdsAtSend:[...state.room.memberIds],scopeKey:'scope',user:'原话 '+index,at:Date.now()-300000+index*1000,status:'ready',phase:'primary',assistant:['这是已完成的公开原话。'.repeat(14)]}));
    state.running=true;state.roundId='presence';state.roundMessageId='presence-11';state.roundPhase='listening';state.roundElapsedMs=12000;state.roundModel={provider:'local',model:'m'};
    state.memberActivity=[{id:'a',state:'typing'},{id:'b',state:'listening'}];state.room.revision++;window.refreshInputUI();
  });
  const marks=dialog.locator('.dsh-persona-chat-member-activity');await marks.first().waitFor();
  assert.equal(await marks.count(),2);assert.equal(await marks.locator('i').count(),4);
  assert.equal(await dialog.locator('.dsh-persona-chat-typing,.dsh-persona-chat-wait').count(),0,'room status does not insert a message bubble or an extra wait banner');
  const activeOption=dialog.getByRole('checkbox',{name:'甲',exact:true});assert.match(await activeOption.getAttribute('title'),/输入中.*12 秒.*模型 m/);
  assert.equal(await activeOption.locator('.dsh-persona-chat-recipient-portrait').getAttribute('data-order'),'1');
  assert.equal(await activeOption.evaluate(el=>{const portrait=el.querySelector('.dsh-persona-chat-recipient-portrait'),mark=portrait.querySelector('[data-state]'),badge=getComputedStyle(portrait,'::after');return mark.getBoundingClientRect().bottom<=portrait.getBoundingClientRect().bottom-parseFloat(badge.height)-parseFloat(badge.bottom);}),true,'activity stays above the selected-order badge');
  for(const count of [2,3,5])for(const width of [1100,390,280]){
    await page.evaluate(count=>{const state=window.inputHost.state;state.room.memberIds=state.contacts.slice(0,count).map(p=>p.id);state.room.revision++;window.refreshInputUI();},count);
    await page.setViewportSize({width,height:650});
    const thread=dialog.getByLabel('聊天消息',{exact:true});await thread.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
    const jump=dialog.getByRole('button',{name:/回到最新消息/});await jump.waitFor();
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await dialog.locator('.dsh-persona-chat-compose-row>button').evaluateAll(nodes=>nodes.every(el=>getComputedStyle(el).whiteSpace==='nowrap'||el.scrollHeight<=el.clientHeight)),true);
    assert.equal(await jump.evaluate(el=>getComputedStyle(el).position==='absolute'&&!!el.closest('.dsh-persona-chat-thread-wrap')&&!el.closest('.dsh-persona-chat-compose')),true,'jump control stays floating in the message area');
    const jumpBox=await jump.boundingBox(),threadBox=await thread.boundingBox();
    assert.ok(jumpBox.y>=threadBox.y&&jumpBox.y+jumpBox.height<=threadBox.y+threadBox.height&&jumpBox.x>=threadBox.x&&jumpBox.x+jumpBox.width<=threadBox.x+threadBox.width,'floating jump remains within the message viewport');
    assert.equal(await marks.count(),2);
    if(values.output){mkdirSync(values.output,{recursive:true});await dialog.screenshot({path:path.join(values.output,'chat-member-status-'+count+'-'+width+'.png')});}
  }
  await dialog.getByRole('button',{name:/回到最新消息/}).click();
  await dialog.getByRole('button',{name:/回到最新消息/}).waitFor({state:'hidden'});
  assert.equal(await dialog.getByLabel('聊天消息',{exact:true}).evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight<2),true);
  assert.equal(await marks.count(),2,'returning to the latest message keeps member activity');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await marks.locator('i').evaluateAll(nodes=>nodes.every(el=>getComputedStyle(el).animationName==='none')),true);
  await page.evaluate(()=>{const state=window.inputHost.state;state.running=false;state.room.revision++;window.refreshInputUI();});
  await marks.first().waitFor({state:'hidden'});
  await page.evaluate(() => window.closeInputUI()); await dialog.waitFor({ state: 'hidden' });
  await page.evaluate(()=>window.mountBlankInputUI());await input.waitFor({timeout:3000}).catch(error=>{console.error(JSON.stringify({blankMountErrors:errors}));throw error;});
  await page.waitForFunction(()=>!document.querySelector('.dsh-persona-chat-compose textarea')?.disabled);
  await page.evaluate(()=>window.closeInputUI());await dialog.waitFor({state:'hidden'});
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ result: 'passed', checks: ['separate queued user bubbles and no premature typing', 'continued input while replies are pending', 'buffer observation reaches canonical committed parts', 'part ids survive quote, draft and source jump', 'failed input retry/cancel retain original words', 'late acknowledgement preserves a newer draft', 'cooling is not typing', 'dispatch order bypasses a cooling seat and preserves the fixed user head', 'no legacy cancellation fields on queued send', 'zero through eight ordered addressees without a silent default', 'user-only anchor has no fictional assistant row', 'explicit director retry retains the original message','bounded forty-frame batch retires exact silent attempts without stale snapshot ghosts or loss of other quotes','invalid nonempty or mismatched-turn silent frames cannot discard pending replies','one listening dot and three typing dots follow the Host member','activity and selected-order badges do not overlap','no room typing bubble or wait banner','2/3/5 members at 1100/390/280 widths without overflow','jump floats in message area and returns to latest without changing activity','reduced motion keeps static activity dots','idle ignores stale activity'], pageErrors:errors,screenshots: values.output }));
} finally { await browser.close(); }
