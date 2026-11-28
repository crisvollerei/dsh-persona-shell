import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };
const output = (text = '这份原始汇报已经重新表达。', finish = 'stop') => (async function* () {
  yield { type: 'text-delta', text }; yield { type: 'finish', reason: { kind: finish } };
})();
function fixture(t, { tables = new Map(), gate = Promise.resolve(), withoutStorage=false, script, failWrite = () => false, beforeWrite = async () => {}, config = {},modelInfo=async()=>({reasoning:{efforts:[{id:'off',name:'off'},{id:'low',name:'low'}]}}) } = {}) {
  const bus = new EventEmitter(), routes = [], disposers = [], calls = [];
  const services = new Map([
    ['storageDomain', { async open() { await gate; return { table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const own = tables.get(name);
      return { get: (id) => structuredClone(own.get(id)), entries: () => own.entries(),
        async put(id, value) { await beforeWrite(id); if (failWrite(id)) throw Error('disk'); own.set(id, structuredClone(value)); },
        delete: async (id) => own.delete(id) };
    }, close: async () => {} }; } }],
    ['webServer', { register(route) { routes.push(route); return () => {}; } }],
    ['connection', { requestRejection: ({ headers }) => headers.authorization === 'owner' ? undefined : 403 }],
    ['llm', { listModels: async () => [{ id: 'm' }],resolveModelInfo:modelInfo, stream(options) { calls.push(options); return script?.(options, calls.length) ?? output(); } }],
  ]);
  if (withoutStorage) services.delete('storageDomain');
  apply({ get: (id) => services.get(id), provide: (id, value) => services.set(id,value),
    on(type, fn) { bus.on(type, fn); return () => bus.off(type, fn); },
    inject(names, fn) { if (names.every((id) => services.has(id))) fn({ get: (id) => services.get(id) }); },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); }, logger: { warn() {} },
  }, { provider: 'p', model: 'm', ...config });
  let disposed = false;
  const dispose = async () => { if (disposed) return; disposed = true; for (const stop of [...disposers].reverse()) await stop(); };
  t.after(dispose);
  const request = async (path, body, auth = true) => {
    let status, value;
    await routes[0].handler({ url: '/persona-shell/' + path, method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: auth ? 'owner' : '' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } },
    { writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } });
    return { status, value };
  };
  const event = (id, type, seq, data, header = {}) => bus.emit('session/event', { id, header, append() { assert.fail('read only'); } }, { type, seq, data });
  const report = (id = 's', seq = 10, text = '这是一份需要保留原始事实的汇报。', header) => event(id, 'assistant/message', seq,
    { message: { role: 'assistant', content: [{ type: 'text', text }] } }, header);
  return { tables, calls, request, report, event, dispose, ready: flush, services, personaShell:services.get('personaShell'),
    conversation: async (id = 's') => (await request('conversation?session=' + id)).value,
    state: async (id = 's') => (await request('state?session=' + id)).value,
  };
}
async function choose(f, id, personaId, trigger = 'inherit') {
  const state = await f.conversation(id);
  const result = await f.request('conversation', { action: 'select', sessionId: id, revision: state.revision, personaId, trigger });
  assert.equal(result.status, 200); return result.value;
}
async function feedback(f, extra = {}) {
  const row = (await f.state()).rows[0];
  return f.request('feedback', { sessionId: 's', seq: row.seq, version: row.version, personaId: row.speaker.id,
    scope: 'once', ...(row.sourceHash?{sourceHash:row.sourceHash}:{}), content: '少一点调侃，先说结论', ...extra });
}

test('a report with several text blocks needs exactly one nonempty replacement target', async t=>{
  const f=fixture(t);await f.ready();
  const send=(seq,parts)=>f.event('s','assistant/message',seq,{message:{role:'assistant',content:parts.map(text=>({type:'text',text}))}});
  send(10,['  ','这是一份需要保留原始事实的汇报。','']);await flush();
  assert.equal(f.calls.length,1);
  send(11,['第一份有独立正文。','第二份也有独立正文。']);await flush();
  assert.equal(f.calls.length,1);
});

test('three persona trials accept an unsaved card and leave report history, presets and memory intact', async t=>{
  const f=fixture(t,{script:opts=>{
    if(opts.messages.some(m=>m.content.some(c=>c.text.includes('chat-control'))))return output('{"messages":["陪你聊聊。"]}');
    const raw=opts.messages[0].content[0].text.replace(/^待改写：\n/u,'');return output(raw);
  }});await f.ready();
  await f.request('memory',{action:'add',entry:{kind:'preference',content:'仅保存的私密偏好',scope:'shared'}});
  const before=(await f.request('presets')).value, memory=(await f.request('memory')).value;
  for(const mode of ['report','strict','chat']){
    const result=await f.request('presets',{action:'preview',mode,pack:{identity:'临时草稿里的试说身份'},personaId:before.presets[0].id});
    assert.equal(result.status,200,JSON.stringify(result.value));assert.ok(result.value.text);
    assert.match(f.calls.at(-1).system,/临时草稿里的试说身份/);assert.doesNotMatch(JSON.stringify(f.calls.at(-1)),/仅保存的私密偏好/);
    if(mode==='strict')assert.ok(result.value.reasons.includes('self-reference'));
  }
  assert.equal(f.calls.length,3);assert.deepEqual((await f.request('presets')).value.presets,before.presets);
  assert.deepEqual((await f.request('memory')).value.entries,memory.entries);assert.deepEqual((await f.state()).rows,[]);
});

test('manual adjustment defaults to thinking independently of automatic rewrite and accepts an explicit one-off opt-out',async t=>{
 const f=fixture(t);await f.ready();f.report();await flush();assert.equal(f.calls.at(-1).reasoningEffort,'off');
 assert.equal((await feedback(f)).status,200);assert.equal(f.calls.at(-1).reasoningEffort,'low');
 assert.equal((await feedback(f,{thinking:false})).status,200);assert.equal(f.calls.at(-1).reasoningEffort,'off');
 const before=f.calls.length;assert.equal((await feedback(f,{thinking:'false'})).status,400);assert.equal(f.calls.length,before);
 assert.equal((await f.request('settings')).value.settings.reasoningEffort,'');
});
test('manual adjustment cannot silently fall back to an unknown thinking mode and retains the old report',async t=>{
 const f=fixture(t,{modelInfo:async()=>({})});await f.ready();f.report();await flush();const old=(await f.state()).rows[0],before=f.calls.length;
 const failed=await feedback(f);assert.equal(failed.status,422);assert.equal(failed.value.error,'feedback-thinking-unavailable');assert.equal(f.calls.length,before);
 const kept=(await f.state()).rows[0];assert.equal(kept.text,old.text);assert.equal(kept.version,old.version);assert.equal(kept.retrying,false);
 assert.equal((await feedback(f,{thinking:false})).status,200);
});

test('conversation endpoints are owner-only and startup mutations are explicitly refused', async (t) => {
  let release; const f = fixture(t, { gate: new Promise((r) => { release = r; }) });
  assert.equal((await f.request('conversation?session=s', undefined, false)).status, 403);
  assert.equal((await f.request('conversation', { sessionId: 's' })).status, 503);
  release(); await f.ready();
  assert.equal((await f.conversation()).ready, true);
});
test('session choices and report scope survive restart and do not change the global default', async (t) => {
  const f = fixture(t); await f.ready();
  await choose(f, 's', 'Claude小姐', 'report');
  f.report(); f.report('other'); await flush();
  assert.equal(f.calls.length, 1);
  f.event('s', 'turn/end', 11, { reason: { kind: 'completed' } }); await flush();
  assert.equal(f.calls.length, 2); assert.match(f.calls[1].system, /理科才女/);
  assert.equal((await f.state()).rows[0].speaker.name, 'Claude小姐');
  assert.equal((await f.conversation('other')).effectivePersonaId, '大肥鱼（默认）');
  await f.dispose(); const next = fixture(t, { tables: f.tables }); await next.ready();
  assert.equal((await next.conversation()).effectiveTrigger, 'report');
  assert.equal((await next.state()).rows[0].speaker.id, 'Claude小姐');
});
test('changing a session only cancels that session; changing the default leaves pinned sessions running', async (t) => {
  const f = fixture(t, { script: (options) => (async function* () {
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
  })() }); await f.ready();
  await choose(f, 's', 'Claude小姐'); await choose(f, 'pinned', '大肥龙');
  f.report(); f.report('pinned'); f.report('inherited'); await flush();
  await choose(f, 's', '大肥鱼（默认）');
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.calls[1].signal.aborted, false);
  await f.request('presets', { action: 'apply', id: '鲸鲸（实验性）' });
  assert.equal(f.calls[1].signal.aborted, false);
  assert.equal(f.calls[2].signal.aborted, true);
});
test('relay rewrites the next raw source once, preserving old signature and isolating private memory', async (t) => {
  const f = fixture(t, { script: (_, n) => output(n === 1 ? '前一个角色独有的改写稿。' : '新角色直接转述原始汇报。') }); await f.ready();
  await f.request('memory', { action: 'add', entry: { kind: 'preference', scope: 'persona', personaId: '大肥鱼（默认）', content: '原角色私有用词' } });
  await f.request('memory', { action: 'add', entry: { kind: 'preference', scope: 'shared', content: '称呼我为小晴' } });
  f.report(); await flush();
  const c = await f.conversation();
  assert.equal((await f.request('conversation', { sessionId: 's', action: 'relay', revision: c.revision, toPersonaId: 'Claude小姐' })).status, 200);
  assert.equal((await f.conversation()).relay.status, 'pending');
  f.report('s', 10); await flush(); assert.equal(f.calls.length, 1);
  f.report('s', 12, '下一份独立的原始汇报，包含条件。'); await flush();
  const prompt = f.calls[1];
  assert.match(JSON.stringify(prompt.messages), /下一份独立的原始汇报/);
  assert.doesNotMatch(JSON.stringify(prompt.messages), /前一个角色独有/);
  assert.doesNotMatch(prompt.system, /原角色私有用词/);
  assert.match(prompt.system, /称呼我为小晴/);
  const rows = (await f.state()).rows;
  assert.equal(rows[0].speaker.id, '大肥鱼（默认）'); assert.equal(rows[1].speaker.id, 'Claude小姐');
  assert.equal((await f.conversation()).relay.consumedSeq, 12);
  assert.match(prompt.system, /"relayFrom":"大肥鱼（默认）"/);
  f.report('s', 13); await flush(); assert.doesNotMatch(f.calls[2].system, /"relayFrom"/);
});

test('a relay card is bound to one report, rejects private records and closes on cancellation',async t=>{
  const f=fixture(t);await f.ready();await f.request('settings',{memory:true});
  const target='Claude小姐', path='memory/handoffs?session=s&persona='+encodeURIComponent(target);
  const privateEntry=(await f.request('memory',{action:'add',entry:{scope:'persona',personaId:'大肥龙',kind:'episode',content:'私有经历'}})).value.result;
  const schedule=async(ids=[])=>f.request('conversation',{action:'relay',sessionId:'s',revision:(await f.conversation()).revision,
    toPersonaId:target,handoff:{summary:'协调前先核实环境',memoryIds:ids}});
  assert.equal((await schedule([privateEntry.id])).value.error,'private-handoff-memory');
  const cancelled=(await schedule()).value.relay;
  await f.request('conversation',{action:'cancel',sessionId:'s',revision:(await f.conversation()).revision,relayId:cancelled.id});await flush();
  assert.equal((await f.request(path)).value.handoffs[0].status,'closed');
  assert.equal((await schedule()).status,200);f.report();await flush();f.report('s',11);await flush();
  assert.match(f.calls[0].system,/协调前先核实环境/);assert.doesNotMatch(f.calls[1].system,/协调前先核实环境/);
  assert.ok((await f.request(path)).value.handoffs.every(h=>h.status==='closed'));
  await f.dispose();
  const saved=f.tables.get('profile').get('structuredMemory');saved.handoffs.at(-1).status='pending';
  const next=fixture(t,{tables:f.tables});await next.ready();await flush();assert.equal((await next.request(path)).value.handoffs.at(-1).status,'closed');
});

test('clearing a pending relay card still lets the next persona rewrite its first report',async t=>{
  const f=fixture(t);await f.ready();await f.request('settings',{memory:true});
  const target='Claude小姐',summary='这段交接说明应随清空消失';
  const scheduled=await f.request('conversation',{action:'relay',sessionId:'s',revision:(await f.conversation()).revision,
    toPersonaId:target,handoff:{summary,memoryIds:[]}});
  assert.ok(scheduled.value.relay.handoffId);assert.equal((await f.request('settings',{clearMemory:true})).status,200);
  f.report();await flush();const [row]=(await f.state()).rows;
  assert.equal(row.status,'ready');assert.equal(row.speaker.id,target);assert.equal(f.calls.length,1);
  assert.match(f.calls[0].system,/"relayFrom"/);assert.ok(!f.calls[0].system.includes(summary));
});

test('report address opt-in survives restart and local subscribers receive only automatic rewrite receipts', async t => {
  const tables = new Map();
  const f = fixture(t, {tables, script: (_, n) => n === 2 ? output('', 'error') : output()});
  await f.ready();
  const service = f.personaShell;
  assert.equal(service.apiVersion, 1);
  assert.equal(service.getActivePersona('s').id, '大肥鱼（默认）');
  const receipts = [];
  const stop = service.subscribe(value => receipts.push(value));
  service.subscribe(() => { throw Error('consumer failure'); });
  assert.equal((await f.request('chat-profile',{revision:0,userAddress:'阿晴'})).status,200);
  f.report(); await flush(); assert.doesNotMatch(f.calls[0].system,/阿晴/);
  assert.equal((await f.request('chat-profile',{revision:1,reportAddress:true})).status,200);
  f.report('s',11); await flush(); assert.match(f.calls[1].system,/"userAddress":"阿晴"/);
  assert.deepEqual(receipts.map(e=>e.type),['rewrite:started','rewrite:ready','rewrite:started','rewrite:fallback']);
  assert.deepEqual(Object.keys(receipts[0]).sort(),['personaId','seq','sessionId','type','version']);
  stop(); f.report('s',12); await flush(); assert.equal(receipts.length,4);
  await f.dispose(); assert.equal(service.getActivePersona('s'),null);
  const restored = fixture(t,{tables}); await restored.ready();
  restored.report('s',13); await flush(); assert.match(restored.calls[0].system,/阿晴/);
});
test('local events distinguish disabled, pure literal, missing model and committed persona changes',async t=>{
  const f=fixture(t);await f.ready();const events=[],service=f.personaShell;
  service.subscribe(()=>{throw Error('consumer')});service.subscribe(e=>events.push(e));
  assert.deepEqual(events,[]);await choose(f,'s','Claude小姐');
  assert.deepEqual(events.splice(0),[{version:1,type:'persona:switched',sessionId:'s',personaId:'Claude小姐',enabled:true}]);
  await f.request('session-switch',{sessionId:'s',enabled:false});assert.equal(service.getActivePersona('s').enabled,false);
  events.length=0;f.report();await flush();assert.deepEqual(events,[]);
  await f.request('session-switch',{sessionId:'s',enabled:true});events.length=0;
  f.report('s',11,'```js\nconst x=1;\n```');await flush();assert.deepEqual(events,[]);
  f.services.delete('llm');f.report('s',12);await flush();assert.deepEqual(events.map(e=>e.type),['rewrite:started','rewrite:fallback']);
  assert.equal(events.at(-1).category,'failed');events.length=0;
  await f.request('settings',{enabled:false});assert.equal(events.length,1);assert.equal(events[0].sessionId,null);
  assert.equal(service.getActivePersona('s'.repeat(200)).enabled,false);
});

test('a memory-only host exposes runtime persona switches while memory collection stays closed',async t=>{
  const f=fixture(t,{withoutStorage:true});const events=[];f.personaShell.subscribe(e=>events.push(e));
  assert.equal(f.personaShell.getActivePersona('s').enabled,true);
  await f.request('settings',{enabled:false});assert.equal(f.personaShell.getActivePersona('s').enabled,false);
  assert.deepEqual(events.map(e=>[e.type,e.enabled]),[['persona:switched',false]]);
  f.event('s','user/message',1,{content:[{type:'text',text:'以后叫我 Alice'}]});
  assert.deepEqual((await f.request('memory')).value.entries,[]);
  const gate=Promise.withResolvers(),opening=fixture(t,{gate:gate.promise});
  assert.equal(opening.personaShell.getActivePersona('s'),null);gate.resolve();await opening.ready();
  assert.equal(opening.personaShell.getActivePersona('s').enabled,true);
});

test('strict relay keeps a validated draft ready with a self-reference review reason',async t=>{
  const f=fixture(t,{script:()=>output('姐姐改好了超时，我看了下测试，有两项失败。')});await f.ready();
  const pack=(await f.request('settings')).value.settings.pack;
  assert.equal((await f.request('settings',{pack:{...pack,narration:{mode:'relay',assistant:'姐姐',selfReference:'none'}}})).status,200);
  f.report('s',10,'我改好了超时，并且检查了测试结果，有两项失败。');await flush();
  const row=(await f.state()).rows[0];assert.equal(row.status,'ready',row.reason);assert.ok(row.review.reasons.includes('self-reference'));
  assert.ok(!Object.hasOwn(row,'rev'));
});

test('a memory change during a rewrite produces one skipped fallback event', async t => {
  const {promise,resolve}=Promise.withResolvers();
  const f=fixture(t,{script:()=>(async function*(){await promise;yield* output();})()});
  t.after(resolve);await f.ready();
  await f.request('settings',{memory:true});
  const events=[];f.personaShell.subscribe(event=>events.push(event));
  f.report();await flush();assert.equal(f.calls.length,1);
  assert.equal((await f.request('settings',{memory:false})).status,200);
  await flush();resolve();await flush();
  assert.deepEqual(events.map(event=>[event.type,event.category]),[['rewrite:started',undefined],['rewrite:fallback','skipped']]);
  assert.equal((await f.state()).rows[0].reason,'memory-changed');
});

test('a failed relay write does not consume the relay or spend a model call', async (t) => {
  let fail = false;
  const f = fixture(t, { failWrite: (key) => fail && key === 'conversations' }); await f.ready();
  await f.request('conversation', { action: 'relay', sessionId: 's', revision: 0, toPersonaId: 'Claude小姐' });
  fail = true; f.report(); await flush();
  assert.equal(f.calls.length, 0); assert.equal((await f.conversation()).relay.status, 'pending');
  fail = false; f.report('s', 12); await flush();
  assert.equal(f.calls.length, 1); assert.equal((await f.conversation()).relay.status, 'active');
});

test('consecutive raw reports arriving during relay persistence all use the new speaker', async (t) => {
  const f = fixture(t); await f.ready();
  await f.request('conversation', { action: 'relay', sessionId: 's', revision: 0, toPersonaId: 'Claude小姐' });
  f.report('s', 10); f.report('s', 11); await flush();
  assert.equal(f.calls.length, 2);
  assert.equal((await f.state()).rows.every((r) => r.status === 'ready' && r.speaker.id === 'Claude小姐'), true);
  assert.equal((await f.conversation()).relay.consumedSeq, 10);
});
test('one-off feedback uses original text and keeps old report on failed or truncated retry', async (t) => {
  const f = fixture(t, { script: (_, n) => output(n === 1 ? '原来已完成的可读汇报。' : '不完整的新稿', n === 1 ? 'stop' : 'max-tokens') }); await f.ready();
  f.report(); await flush(); const before = (await f.state()).rows[0];
  const result = await feedback(f); assert.equal(result.status, 422);
  const after = (await f.state()).rows[0];
  assert.equal(after.text, before.text); assert.equal(after.version, before.version); assert.equal(after.retrying, false);
  assert.match(f.calls[1].system, /少一点调侃/);
  assert.match(JSON.stringify(f.calls[1].messages), /保留原始事实/);
  assert.doesNotMatch(JSON.stringify(f.calls[1].messages), /原来已完成的可读汇报/);
  assert.equal((await f.request('memory')).value.entries.length, 0);
});
test('successful retry replaces only its row, increments version, and rejects stale feedback', async (t) => {
  const f = fixture(t, { script: (_, n) => output(n === 1 ? '原来的可读汇报。' : '调整后的可读汇报。') }); await f.ready();
  f.report(); await flush(); const row = (await f.state()).rows[0];
  assert.equal((await feedback(f)).status, 200);
  const after = (await f.state()).rows[0]; assert.equal(after.version, 2); assert.match(after.text, /调整后/);
  assert.equal((await feedback(f, { version: row.version })).status, 409);
  assert.equal(f.calls.length, 2);
});

test('a final report that fell back to its original can be restated once without changing memory or the source',async t=>{
  const raw='修改尚未完成，测试仍有失败；需要用户确认之后才能继续。';
  const f=fixture(t,{script:(_,n)=>output(n===1?'被截断且不能采用的改写':'尚未完成，测试未过；确认后才能继续。',n===1?'max-tokens':'stop')});
  await f.ready();f.report('s',10,raw);f.event('s','turn/end',11,{reason:{kind:'completed'}});await flush();
  const before=(await f.state()).rows[0];assert.equal(before.status,'skipped');assert.equal(before.final,true);assert.equal(before.canRetry,true);
  const result=await feedback(f,{content:'短一点，但保留未完成、测试失败和确认条件'});
  assert.equal(result.status,200);assert.equal(result.value.version,before.version+1);assert.equal(result.value.personaId,before.speaker.id);
  const after=(await f.state()).rows[0];assert.equal(after.status,'ready');assert.equal(after.final,true);
  assert.match(f.calls[1].messages[0].content[0].text,/修改尚未完成/);assert.doesNotMatch(f.calls[1].messages[0].content[0].text,/被截断且不能采用/);
  assert.equal((await f.request('memory')).value.entries.length,0);
  await f.dispose();assert.equal(f.tables.get('sessions').get('s')[0].original,raw);
});

test('failed restatement from a fallback retains its original status and version for another explicit retry',async t=>{
  const f=fixture(t,{script:()=>output('未完整结束的文本','max-tokens')});await f.ready();f.report();
  f.event('s','turn/end',11,{reason:{kind:'completed'}});await flush();const before=(await f.state()).rows[0];
  assert.equal((await feedback(f)).status,422);const after=(await f.state()).rows[0];
  assert.equal(after.status,before.status);assert.equal(after.text,before.text);assert.equal(after.version,before.version);
  assert.equal(after.canRetry,true);assert.equal(after.retrying,false);assert.match(after.feedbackError,/保留/);
});

test('manual retry remains available while automatic rewriting is off and never trusts client source text',async t=>{
  const f=fixture(t);await f.ready();f.report();await flush();
  await f.request('settings',{enabled:false});let row=(await f.state()).rows[0];
  assert.equal(row.canRetry,true);
  const count=f.calls.length;assert.equal((await feedback(f)).status,200);assert.equal(f.calls.length,count+1);
  assert.equal((await f.request('settings')).value.settings.enabled,false);
  await f.request('settings',{enabled:true});await f.dispose();delete f.tables.get('sessions').get('s')[0].original;
  const next=fixture(t,{tables:f.tables});await next.ready();row=(await next.state()).rows[0];
  assert.equal(row.canRetry,false);assert.equal(row.retryUnavailableReason,'source-unavailable');
  assert.equal((await feedback(next,{original:'伪造的客户端原文',text:'伪造的当前正文'})).value.error,'source-unavailable');
  assert.equal(next.calls.length,0);
});

test('disabled startup exposes completed-source tools without creating rewrite rows or automatic requests',async t=>{
  const seed=fixture(t);await seed.ready();await seed.request('settings',{enabled:false});await seed.dispose();
  const f=fixture(t,{tables:seed.tables});await f.ready();f.report();
  assert.equal((await f.state()).rows.length,0,'an unfinished report is not a manual candidate');
  f.event('s','turn/end',11,{reason:{kind:'completed'}});await flush();
  const before=(await f.state()).rows[0];assert.equal(before.final,true);assert.equal(before.canRetry,true);
  assert.ok(before.sourceHash);assert.equal(f.calls.length,0);assert.equal(f.tables.get('sessions')?.get('s'),undefined);
  assert.equal((await feedback(f)).status,200);assert.equal(f.calls.length,1);
  assert.equal((await f.request('settings')).value.settings.enabled,false);
  f.event('s','turn/start',12,{});f.report('s',20);f.event('s','turn/end',21,{reason:{kind:'completed'}});await flush();
  assert.equal(f.calls.length,1,'the next completed report is still not automatically rewritten');
  assert.equal((await f.state()).rows.find(row=>row.seq===20).status,'skipped');
  await f.dispose();const next=fixture(t,{tables:f.tables});await next.ready();
  const restored=(await next.state()).rows.find(row=>row.seq===10);assert.equal(restored.status,'ready');assert.equal(restored.version,2);
  assert.equal(restored.canRetry,true);assert.equal(next.calls.length,0);
});

test('session-off manual adjustment keeps the switch off and does not resume user-memory observation',async t=>{
  const f=fixture(t);await f.ready();await f.request('session-switch',{sessionId:'s',enabled:false});
  f.event('s','user/message',1,{message:{role:'user',content:[{type:'text',text:'以后请先说结论。'}]}});
  f.report();f.event('s','turn/end',11,{reason:{kind:'completed'}});await flush();
  assert.equal(f.calls.length,0);assert.equal((await feedback(f)).status,200);assert.equal(f.calls.length,1);
  const state=await f.state();assert.equal(state.sessionEnabled,false);
  assert.equal((await f.request('settings')).value.settings.enabled,true);
  assert.equal((await f.request('memory')).value.entries.length,0);
});

test('unmaterialized manual reports require the real source hash and current persona before dispatch',async t=>{
  const f=fixture(t);await f.ready();await f.request('settings',{enabled:false});f.report();f.event('s','turn/end',11,{reason:{kind:'completed'}});await flush();
  const row=(await f.state()).rows[0],body={sessionId:'s',seq:row.seq,version:row.version,personaId:row.speaker.id,sourceHash:row.sourceHash,scope:'once',content:'先说结论'};
  assert.equal((await f.request('feedback',body,false)).status,403);
  for(const patch of [{sourceHash:'forged'},{sourceHash:undefined},{version:2},{personaId:'Claude小姐'}]){
    assert.equal((await f.request('feedback',{...body,...patch,original:'伪造原文'})).status,409);
  }
  assert.equal(f.calls.length,0);assert.equal(f.tables.get('sessions')?.get('s'),undefined);
  assert.equal((await f.request('feedback',body)).status,200);assert.equal(f.calls.length,1);
});

test('an unfinished initial rewrite has no retry capability and cannot dispatch another one-off request',async t=>{
  let release;const gate=new Promise(r=>{release=r;});t.after(()=>release());
  const f=fixture(t,{script:()=> (async function*(){await gate;yield*output();})()});await f.ready();f.report();await flush();
  const row=(await f.state()).rows[0];assert.equal(row.status,'pending');assert.equal(row.canRetry,false);
  assert.equal(row.retryUnavailableReason,'feedback-in-progress');assert.equal((await feedback(f)).status,409);assert.equal(f.calls.length,1);release();
});

test('a report containing only protected technical literals explains why expression adjustment is unavailable',async t=>{
  const f=fixture(t);await f.ready();f.report('s',10,'`npm test`');f.event('s','turn/end',11,{reason:{kind:'completed'}});await flush();
  const row=(await f.state()).rows[0];assert.equal(row.reason,'no-prose');assert.equal(row.canRetry,false);
  assert.equal(row.retryUnavailableReason,'report-no-prose');assert.equal((await feedback(f)).value.error,'report-no-prose');assert.equal(f.calls.length,0);
});

test('successive one-off adjustments always use the same original instead of rewriting the preceding persona text',async t=>{
  const f=fixture(t,{script:(_,n)=>output(['初稿表达。','再次表达。','调整后的表达。'][n-1])});await f.ready();f.report();await flush();
  assert.equal((await feedback(f,{content:'短一点'})).status,200);assert.equal((await feedback(f,{content:'先说结论'})).status,200);
  for(const call of f.calls.slice(1)){assert.match(call.messages[0].content[0].text,/保留原始事实/);assert.doesNotMatch(call.messages[0].content[0].text,/初稿表达|再次表达/);}
  assert.equal((await f.request('memory')).value.entries.length,0);
});
test('historical persona feedback stays with its speaker after a session switch; session feedback is shared only in that session', async (t) => {
  const f = fixture(t); await f.ready(); f.report(); await flush();
  await choose(f, 's', 'Claude小姐');
  assert.equal((await feedback(f, { scope: 'persona', content: '原角色的专属偏好' })).status, 200);
  assert.equal((await feedback(f, { scope: 'session', content: '当前会话专用偏好' })).status, 200);
  const entries = (await f.request('memory')).value.entries;
  assert.equal(entries.find((e) => e.content === '原角色的专属偏好').personaId, '大肥鱼（默认）');
  f.report('s', 12); f.report('other', 13); await flush();
  assert.doesNotMatch(f.calls[1].system, /原角色的专属偏好/); assert.match(f.calls[1].system, /当前会话专用偏好/);
  assert.doesNotMatch(f.calls[2].system, /当前会话专用偏好/);
});
test('deleted preferences do not reappear via historical row metadata', async (t) => {
  const f = fixture(t); await f.ready();
  await f.request('memory', { action: 'add', entry: { kind: 'preference', scope: 'shared', content: '称呼我为小晴' } });
  f.report(); await flush(); assert.equal((await f.state()).rows[0].memories.length, 1);
  const entry = (await f.request('memory')).value.entries[0];
  await f.request('memory', { action: 'delete', id: entry.id, version: entry.version });
  assert.deepEqual((await f.state()).rows[0].memories, []);
});
test('experimental narration preserves explicit source attribution and uses a separate subagent label', async (t) => {
  const f = fixture(t, { config: { subagentReports: true } }); await f.ready(); await choose(f, 's', '鲸鲸（实验性）');
  f.report(); await flush();
  assert.match(f.calls[0].system, /实际工作者称为 "姐姐"/);
  assert.equal((await f.state()).rows[0].speaker.mode, 'relay');
  f.report('s', 12, '这是子代理的原始汇报。', { delegationDepth: 1, origin: 'subagent' }); await flush();
  assert.match(f.calls[1].system, /实际工作者称为 "小鲸鲸"/);
});

test('a pending relay can be cancelled and never consumes the next source', async (t) => {
  const f = fixture(t); await f.ready();
  const queued = await f.request('conversation', { sessionId: 's', action: 'relay', revision: 0, toPersonaId: 'Claude小姐' });
  const cancel = { sessionId: 's', action: 'cancel', revision: queued.value.revision, relayId: queued.value.relay.id };
  assert.equal((await f.request('conversation', cancel)).status, 200);
  assert.equal((await f.request('conversation', cancel)).status, 409);
  f.report(); await flush();
  assert.equal((await f.state()).rows[0].speaker.id, '大肥鱼（默认）');
});
test('session changes cancel a feedback retry without losing the previous ready report', async (t) => {
  let release;
  const f = fixture(t, { script: (options, n) => n === 1 ? output('已经可读的旧汇报。') : (async function* () {
    await new Promise((resolve) => { release = resolve; });
    yield { type: 'text-delta', text: '不该落地的迟到新稿。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })() }); await f.ready(); f.report(); await flush();
  const retry = feedback(f); await flush();
  assert.equal((await f.state()).rows[0].retrying, true);
  assert.equal((await feedback(f)).status, 409);
  await choose(f, 's', 'Claude小姐');
  const result = await retry; assert.equal(result.status, 422);
  release(); await flush();
  assert.equal((await f.state()).rows[0].text, '已经可读的旧汇报。');
  assert.equal(f.calls.length, 2);
});
test('one-off historical feedback uses the historical speaker even after selecting another one', async (t) => {
  const f = fixture(t); await f.ready(); f.report(); await flush();
  await choose(f, 's', 'Claude小姐');
  f.event('s', 'turn/start', 11, { turn: 2 });
  f.event('s', 'tool/call', 12, { name: '不属于旧汇报的当前阶段工具' });
  assert.equal((await feedback(f)).status, 200);
  assert.match(f.calls[1].system, /蓝色鲸鱼娘女仆/);
  assert.doesNotMatch(f.calls[1].system, /理科才女/);
  assert.doesNotMatch(JSON.stringify(f.calls[1].messages), /不属于旧汇报的当前阶段工具/);
  assert.equal((await f.state()).rows[0].speaker.id, '大肥鱼（默认）');
});
test('deleting an inactive custom persona cancels its pinned rewrite and falls back explicitly', async (t) => {
  const f = fixture(t, { script: (options) => (async function* () {
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
  })() }); await f.ready();
  const created = await f.request('presets', { action: 'save', name: '测试自定义', pack: { identity: '测试角色' } });
  const custom = created.value.presets.find((p) => p.name === '测试自定义');
  await choose(f, 's', custom.id);
  await f.request('presets', { action: 'apply', id: '大肥鱼（默认）' });
  f.report(); await flush(); assert.equal(f.calls[0].signal.aborted, false);
  await f.request('presets', { action: 'delete', id: custom.id }); await flush();
  assert.equal(f.calls[0].signal.aborted, true);
  const state = await f.conversation(); assert.equal(state.missingPersona, true);
  assert.equal(state.effectivePersonaId, '大肥鱼（默认）');
});
for (const restarted of [false,true]) test('a deleted persona retires queued extraction and both sides of open handoffs '+(restarted?'on recovery':'immediately'),async t=>{
  const f=fixture(t,{config:{memory:true,memoryExtraction:true}});await f.ready();
  const saved=await f.request('presets',{action:'save',name:'即将删除的人格',pack:{identity:'临时身份'}});
  const custom=saved.value.presets.find(p=>p.name==='即将删除的人格').id;
  f.event('s','user/message',1,{content:[{type:'text',text:'以后叫我 Alice'}]});
  const other='Claude小姐';
  for (const [fromPersonaId,toPersonaId] of [[custom,other],[other,custom]]) {
    const card=await f.request('memory/handoffs',{action:'create',sessionId:'s',fromPersonaId,toPersonaId,memoryIds:[],summary:'交接事项'});
    assert.equal(card.status,200);
  }
  const before=(await f.request('memory')).value;assert.equal(before.extraction.pending,1);
  let current=f;
  if (restarted) {
    await f.dispose();f.tables.get('presets').delete(custom);
    current=fixture(t,{tables:f.tables});await current.ready();
  } else {
    assert.equal((await f.request('presets',{action:'delete',id:custom})).status,200);
  }
  const after=(await current.request('memory')).value;
  assert.equal(after.extraction.pending,0);
  for(const id of [custom,other]) {
    const response=await current.request('memory/handoffs?session=s&persona='+encodeURIComponent(id));
    assert.deepEqual(response.value.handoffs.map(h=>h.status),['closed']);
  }
  assert.deepEqual(after.entries,before.entries);
});

test('default report scope persists and cannot change a separately selected session scope', async (t) => {
  const f = fixture(t); await f.ready(); await choose(f, 'pinned', 'Claude小姐', 'step');
  await f.request('settings', { trigger: 'report' });
  f.report('s'); f.report('pinned'); await flush(); assert.equal(f.calls.length, 1);
  f.event('s', 'turn/end', 11, { reason: { kind: 'completed' } }); await flush(); assert.equal(f.calls.length, 2);
  await f.dispose(); const next = fixture(t, { tables: f.tables }); await next.ready();
  assert.equal((await next.conversation()).effectiveTrigger, 'report');
  assert.equal((await next.conversation('pinned')).effectiveTrigger, 'step');
});

test('changing the default scope cannot discard the final candidate of an independent session', async (t) => {
  const f = fixture(t); await f.ready(); await choose(f, 's', 'Claude小姐', 'report');
  f.report(); await f.request('settings', { trigger: 'report' });
  f.event('s', 'turn/end', 11, { reason: { kind: 'completed' } }); await flush();
  assert.equal(f.calls.length, 1); assert.equal((await f.state()).rows[0].final, true);
});
test('disposal during relay storage prevents late model dispatch and drains its owned write', async (t) => {
  let release; let blocked = false;
  const f = fixture(t, { beforeWrite: async (key) => {
    if (blocked && key === 'conversations') await new Promise((r) => { release = r; });
  } }); await f.ready();
  await f.request('conversation', { sessionId: 's', action: 'relay', revision: 0, toPersonaId: 'Claude小姐' });
  blocked = true; f.report(); await flush();
  const stopping = f.dispose(); let stopped = false; void stopping.then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false, 'unload waits for the owned storage write');
  release(); await stopping; await flush();
  assert.equal(f.calls.length, 0);
});

test('a failed feedback preference save does not silently affect later prompts', async (t) => {
  let fail = false;
  const f = fixture(t, { failWrite: (key) => fail && key === 'structuredMemory' }); await f.ready();
  f.report(); await flush(); fail = true;
  assert.equal((await feedback(f, { scope: 'persona', content: '未保存的特殊表达偏好' })).status, 503);
  assert.equal((await f.request('memory')).value.entries.length, 0);
  f.report('s', 12); await flush();
  assert.doesNotMatch(f.calls[1].system, /未保存的特殊表达偏好/);
  fail = false;
  assert.equal((await feedback(f, { scope: 'persona', content: '未保存的特殊表达偏好' })).status, 200);
  assert.equal((await f.request('memory')).value.entries.length, 1);
});
test('clearing memory during a slow feedback save wins both live and durable state', async (t) => {
  let blocked = false, release;
  const f = fixture(t, { beforeWrite: async (key) => {
    if (blocked && key === 'structuredMemory') await new Promise((r) => { release = r; });
  } }); await f.ready(); f.report(); await flush(); blocked = true;
  const saving = feedback(f, { scope: 'shared', content: '即将被清空的表达偏好' }); await flush();
  const clearing = f.request('settings', { clearMemory: true }); await flush();
  blocked = false; release();
  assert.equal((await saving).status, 409); assert.equal((await clearing).status, 200);
  assert.equal((await f.request('memory')).value.entries.length, 0);
  assert.equal(f.tables.get('profile').get('structuredMemory').entries.length, 0);
});

test('a row evicted while feedback is running cannot report a false successful replacement', async (t) => {
  let release;
  const f = fixture(t, { config: { maxRowsPerSession: 20 }, script: (_, n) => n === 2 ? (async function* () {
    await new Promise((r) => { release = r; }); yield* output();
  })() : output() }); await f.ready(); f.report(); await flush();
  const retry = feedback(f); await flush();
  for (let seq = 12; seq < 33; seq++) f.report('s', seq);
  await flush(); release();
  assert.equal((await retry).status, 409);
  assert.equal((await f.state()).rows.some((r) => r.seq === 10), false);
});

for (const action of ['delete', 'save', 'edit', 'preference', 'rename']) {
  test(`historical retries bind cancellation to their actual persona on ${action}`, async (t) => {
    const releases = new Map();
    const f = fixture(t, { script: (_, n) => n === 1 ? output('原来已经可读的历史汇报。') : (async function* () {
      await new Promise((resolve) => releases.set(n, resolve)); yield* output('新的角色表达。');
    })() });
    await f.ready();
    const created = await f.request('presets', { action: 'save', name: '历史人格A', pack: { identity: '历史人格A的口吻' } });
    const id = created.value.presets.find((p) => p.name === '历史人格A').id;
    f.report(); await flush(); await choose(f, 's', 'Claude小姐');
    const retry = feedback(f); await flush(); f.report('s', 12); await flush();
    if (action === 'edit') await f.request('settings', { pack: { identity: '修改后的历史人格A' } });
    else if (action === 'preference') await feedback(f, { scope: 'persona', content: '语气更克制' });
    else await f.request('presets', { action, id, name: action === 'rename' ? '改名后的历史人格A' : '历史人格A', pack: { identity: '修改后的历史人格A' } });
    const oldAborted = f.calls[1].signal.aborted, currentAborted = f.calls[2].signal.aborted;
    for (const release of releases.values()) release();
    const result = await retry; await flush();
    assert.equal(oldAborted, action !== 'rename', 'content changes cancel historical requests; renaming alone keeps them');
    assert.equal(currentAborted, false, 'the current persona request in the same session remains running');
    assert.equal(result.status, action === 'rename' ? 200 : 422);
    assert.equal((await f.state()).rows[0].text, action === 'rename' ? '新的角色表达。' : '原来已经可读的历史汇报。');
  });
}

test('a slow session pin compares effective choices at commit after a concurrent default change', async (t) => {
  let block = false, releaseWrite, releaseStream;
  const f = fixture(t, { beforeWrite: async (key) => {
    if (block && key === 'conversations') await new Promise((r) => { releaseWrite = r; });
  }, script: () => (async function* () { await new Promise((r) => { releaseStream = r; }); yield* output(); })() });
  await f.ready(); block = true;
  const pin = f.request('conversation', { action: 'select', sessionId: 's', revision: 0, personaId: '大肥鱼（默认）', trigger: 'inherit' });
  await flush(); await f.request('presets', { action: 'apply', id: 'Claude小姐' }); f.report(); await flush();
  block = false; releaseWrite(); assert.equal((await pin).status, 200);
  const aborted = f.calls[0].signal.aborted;
  releaseStream(); await flush();
  assert.equal((await f.conversation()).effectivePersonaId, '大肥鱼（默认）');
  assert.equal(aborted, true, 'a request started under the temporary default cannot settle after the pin commits');
  assert.equal((await f.state()).rows[0].status, 'skipped');
});

test('relay activation preserves the next turn final candidate while its own storage write is pending', async (t) => {
  let block = false, release;
  const f = fixture(t, { beforeWrite: async (key) => {
    if (block && key === 'conversations') await new Promise((r) => { release = r; });
  } });
  await f.ready(); await choose(f, 's', null, 'report');
  const state = await f.conversation();
  await f.request('conversation', { action: 'relay', sessionId: 's', revision: state.revision, toPersonaId: 'Claude小姐' });
  block = true; f.report('s', 10); f.event('s', 'turn/end', 11, { reason: { kind: 'completed' } }); await flush();
  f.event('s', 'turn/start', 12, { turn: 2 }); f.report('s', 13);
  block = false; release(); await flush();
  f.event('s', 'turn/end', 14, { reason: { kind: 'completed' } }); await flush();
  assert.equal(f.calls.length, 2);
  assert.deepEqual((await f.state()).rows.map((r) => r.seq), [10, 13]);
});

test('repeated relay write failures keep both live and durable result caches bounded', async (t) => {
  let fail = false;
  const f = fixture(t, { config: { maxRowsPerSession: 20 }, failWrite: (key) => fail && key === 'conversations' });
  await f.ready();
  await f.request('conversation', { action: 'relay', sessionId: 's', revision: 0, toPersonaId: 'Claude小姐' });
  fail = true; for (let seq = 10; seq < 40; seq++) f.report('s', seq); await flush();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.state()).rows.length, 20);
  assert.equal((await f.conversation()).relay.status, 'pending');
  await f.dispose(); assert.equal(f.tables.get('sessions').get('s').length, 20);
});

test('a failed first relay after restart still bounds the restored result history', async (t) => {
  const f = fixture(t, { config: { maxRowsPerSession: 20 } }); await f.ready();
  for (let seq = 10; seq < 30; seq++) f.report('s', seq); await flush();
  await f.request('conversation', { action: 'relay', sessionId: 's', revision: 0, toPersonaId: 'Claude小姐' });
  await f.dispose();
  const next = fixture(t, { tables: f.tables, config: { maxRowsPerSession: 20 }, failWrite: (key) => key === 'conversations' });
  await next.ready(); next.report('s', 30); await flush();
  assert.equal(next.calls.length, 0);
  assert.equal((await next.state()).rows.length, 20);
  await next.dispose(); assert.equal(next.tables.get('sessions').get('s').length, 20);
});

test('historical memory references never claim an edited preference was used in the original rewrite', async (t) => {
  const f = fixture(t); await f.ready();
  await f.request('memory', { action: 'add', entry: { kind: 'preference', scope: 'shared', content: '称呼我为小晴' } });
  f.report(); await flush(); const before = (await f.state()).rows[0];
  const entry = (await f.request('memory')).value.entries[0];
  await f.request('memory', { action: 'update', id: entry.id, version: entry.version, content: '称呼我为小黎', pinned: false });
  const after = (await f.state()).rows[0];
  assert.equal(after.text, before.text); assert.equal(f.calls.length, 1);
  assert.deepEqual(after.memories, [], 'a changed version is omitted rather than attributed to the old report');
  await f.dispose(); const next = fixture(t, { tables: f.tables }); await next.ready();
  assert.deepEqual((await next.state()).rows[0].memories, []);
});

test('conversation metadata advances for global changes even when the session choice revision is unchanged', async (t) => {
  const f = fixture(t); await f.ready();
  const before = await f.conversation();
  await f.request('presets', { action: 'apply', id: 'Claude小姐' });
  const after = await f.conversation();
  assert.equal(after.revision, before.revision);
  assert.equal(after.instanceId, before.instanceId);
  assert.ok(after.stateRev > before.stateRev);
  const state = await f.state();
  assert.equal(state.conversation.stateRev, state.rev);
});

test('legacy unversioned memory references cannot be attributed after restart', async (t) => {
  const f = fixture(t); await f.ready();
  await f.request('memory', { action: 'add', entry: { kind: 'preference', scope: 'shared', content: '称呼我为小晴' } });
  f.report(); await flush(); const before = (await f.state()).rows[0];
  await f.dispose();
  const cached = f.tables.get('sessions').get('s')[0];
  cached.memoryIds = before.memories.map((m) => m.id); delete cached.memoryRefs;
  const next = fixture(t, { tables: f.tables }); await next.ready();
  const restored = (await next.state()).rows[0];
  assert.equal(restored.text, before.text); assert.equal(restored.canRetry, true);
  assert.deepEqual(restored.memories, []);
});
