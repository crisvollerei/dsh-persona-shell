import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveConfig} from '../lib/config.js';
import {fixture,domain,reply,jsonReply,newRoom,roomSend,settledRoom,roomState,whale,flush,readChatInput} from './helpers/persona-chat-host.mjs';

const info=()=>({reasoning:{efforts:[{id:'off',name:'关闭'},{id:'low',name:'轻度'},{id:'high',name:'深度'}],defaultEffort:'high'}});
const actorCalls=f=>f.calls.filter(call=>{try{return readChatInput(call).task==='chat-control';}catch{return false;}});

test('new chat defaults enable thinking and model-default effort without changing report defaults',()=>{
  const value=resolveConfig({});assert.equal(value.chatThinking,true);assert.equal(value.chatReasoningEffort,'');assert.equal(value.reasoningEffort,'');
  assert.equal(resolveConfig({chatThinking:false}).chatThinking,false);
  assert.equal(resolveConfig({chatReasoningEffort:' high '}).chatReasoningEffort,'high');
  for(const chatReasoningEffort of [null,5,'x'.repeat(129)])assert.equal(resolveConfig({chatReasoningEffort}).chatReasoningEffort,'');
});

test('Host settings remain lazy and default chat dispatch uses the advertised default, while its director stays off',async t=>{
  let lookups=0;const f=fixture(t,{modelInfo:async()=>{lookups++;return info();}});await f.ready();
  const settings=(await f.request('settings')).value.settings;assert.equal(settings.chatThinking,true);assert.equal(settings.chatReasoningEffort,'');
  assert.equal(lookups,0);assert.equal(f.requests.length,0);
  const room=await newRoom(f,[whale]);assert.equal(lookups,0);assert.equal(f.requests.length,0);
  await roomSend(f,room);await settledRoom(f,room);
  assert.equal(actorCalls(f)[0].reasoningEffort,'high');assert.equal(actorCalls(f)[0].maxTokens,8192);
  assert.ok(f.directors.length>0);assert.ok(f.directors.every(call=>call.reasoningEffort==='off'));
});

test('custom chat effort and disabled thinking are isolated from report preference and persist across restart',async t=>{
  const storage=domain(),f=fixture(t,{storage,modelInfo:async()=>info(),config:{reasoningEffort:'high'}});await f.ready();
  await f.request('settings',{chatReasoningEffort:' low '});const room=await newRoom(f,[whale]);await roomSend(f,room);await settledRoom(f,room);
  assert.equal(actorCalls(f).at(-1).reasoningEffort,'low');
  await f.request('settings',{chatThinking:false});await roomSend(f,room,whale,'下一句','off-turn');await settledRoom(f,room);
  assert.equal(actorCalls(f).at(-1).reasoningEffort,'off');
  let settings=(await f.request('settings')).value.settings;assert.equal(settings.chatReasoningEffort,'low');assert.equal(settings.reasoningEffort,'high');
  await f.dispose();const reopened=fixture(t,{storage,modelInfo:async()=>info()});await reopened.ready();
  settings=(await reopened.request('settings')).value.settings;assert.equal(settings.chatThinking,false);assert.equal(settings.chatReasoningEffort,'low');
});

test('startup changes to thinking and its grade survive storage restore without replacing unrelated settings',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const storage=domain(gate);storage.tables.set('profile',new Map([['settings',{chatThinking:true,chatReasoningEffort:'low',reasoningEffort:'retained-report-choice'}]]));
  const f=fixture(t,{storage});
  await f.request('settings',{chatThinking:false,chatReasoningEffort:'high'});release();await f.ready();
  const settings=(await f.request('settings')).value.settings;assert.equal(settings.chatThinking,false);assert.equal(settings.chatReasoningEffort,'high');assert.equal(settings.reasoningEffort,'retained-report-choice');
  await f.dispose();const again=fixture(t,{storage});await again.ready();
  assert.equal((await again.request('settings')).value.settings.chatReasoningEffort,'high');
});

test('chat metadata is authenticated, read only, sanitized and queried only on demand',async t=>{
  const queried=[],f=fixture(t,{modelInfo:async(...args)=>{queried.push(args);return{...info(),apiKey:'SECRET',reasoning:{...info().reasoning,credentials:'SECRET'}};}});await f.ready();
  assert.equal((await f.request('chat-model-options',undefined,false)).status,403);assert.equal(queried.length,0);
  assert.equal((await f.request('chat-model-options',{})).status,405);assert.equal(queried.length,0);
  const result=await f.request('chat-model-options');assert.equal(result.status,200);
  assert.deepEqual(result.value,{provider:'p',model:'m',source:'rewrite',status:'available',efforts:info().reasoning.efforts,defaultEffort:'high'});
  assert.equal(queried.length,1);assert.equal(queried[0][0],'p');assert.equal(queried[0][1],'m');assert.ok(queried[0][2] instanceof AbortSignal);
  assert.equal(f.requests.length,0);assert.doesNotMatch(JSON.stringify(result.value),/SECRET|apiKey|credentials/);
  assert.equal((await f.request('chat-model-options?room=absent')).status,409);assert.equal(queried.length,1);
  await newRoom(f,[whale]);assert.equal((await f.request('chat-model-options?room=absent')).status,404);assert.equal(queried.length,1);
});

test('metadata follows the actual chat override and exact model, without changing either saved selection',async t=>{
  const queried=[],f=fixture(t,{modelInfo:async(provider,model)=>{queried.push([provider,model]);return info();}});await f.ready();
  await f.request('settings',{chatProvider:'chat-provider',chatModel:'exact-chat-model',chatReasoningEffort:'missing'});
  const room=await newRoom(f,[whale]),response=await f.request('chat-model-options?room='+encodeURIComponent(room.roomId));
  assert.deepEqual(queried,[['chat-provider','exact-chat-model']]);assert.equal(response.value.source,'chat');
  assert.equal((await f.request('settings')).value.settings.chatReasoningEffort,'missing');assert.equal(f.requests.length,0);
});

test('metadata failure and missing capabilities are honest unknowns and never start a generation',async t=>{
  const f=fixture(t,{modelInfo:async()=>{throw Error('PRIVATE_PROVIDER_ERROR');}});await f.ready();
  const failed=await f.request('chat-model-options');assert.equal(failed.value.status,'unknown');assert.equal(failed.value.error,'metadata-unavailable');
  assert.doesNotMatch(JSON.stringify(failed.value),/PRIVATE_PROVIDER_ERROR/);assert.equal(f.requests.length,0);
  const unknown=fixture(t,{modelInfo:async()=>({})});await unknown.ready();assert.equal((await unknown.request('chat-model-options')).value.status,'unknown');
  const off=fixture(t,{modelInfo:async()=>({reasoning:{efforts:[{id:'off'}],defaultEffort:'off'}})});await off.ready();
  assert.equal((await off.request('chat-model-options')).value.status,'unavailable');assert.equal(off.requests.length,0);
});

test('unload cancels a pending metadata lookup and late resolution cannot dispatch',async t=>{
  let release,signal;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release(info()));
  const f=fixture(t,{modelInfo:async(_p,_m,next)=>{signal=next;return gate;}});await f.ready();
  const request=f.request('chat-model-options');await flush();assert.equal(signal.aborted,false);
  await f.dispose();assert.equal(signal.aborted,true);assert.equal((await request).status,503);release(info());await flush();assert.equal(f.requests.length,0);
});

test('a metadata timeout ends inspection even when an adapter ignores cancellation',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  let release,signal;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release(info()));
  const f=fixture(t,{modelInfo:async(_p,_m,next)=>{signal=next;return gate;}});await f.ready();
  const pending=f.request('chat-model-options');await flush();t.mock.timers.tick(8000);await flush();
  const result=await pending;assert.equal(result.value.status,'unknown');assert.equal(result.value.error,'metadata-unavailable');assert.equal(signal.aborted,true);
  release(info());await flush();assert.equal(f.requests.length,0);
});

test('invalid setting types and oversized effort IDs cannot replace a saved chat preference',async t=>{
  const f=fixture(t);await f.ready();await f.request('settings',{chatThinking:false,chatReasoningEffort:'low'});
  for(const patch of [{chatThinking:'true'},{chatReasoningEffort:null},{chatReasoningEffort:5},{chatReasoningEffort:'x'.repeat(129)}])await f.request('settings',patch);
  const settings=(await f.request('settings')).value.settings;assert.equal(settings.chatThinking,false);assert.equal(settings.chatReasoningEffort,'low');
});

test('unsupported saved grades use the new model default without rewriting the saved value',async t=>{
  const f=fixture(t,{modelInfo:async()=>info()});await f.ready();await f.request('settings',{chatReasoningEffort:'not-in-this-model'});
  const room=await newRoom(f,[whale]);await roomSend(f,room);await settledRoom(f,room);
  assert.equal(actorCalls(f)[0].reasoningEffort,'high');assert.equal((await f.request('settings')).value.settings.chatReasoningEffort,'not-in-this-model');
});

test('quick reply references inherit chat effort but never the report effort',async t=>{
  const f=fixture(t,{modelInfo:async()=>info(),config:{reasoningEffort:'high'},script:call=>call.system.startsWith('你为用户准备消息区')?jsonReply({suggestions:['聊聊这个。','我想想。']}):reply(['在呢。'])});
  await f.ready();await f.request('settings',{chatReasoningEffort:'low'});const binding=await newRoom(f,[whale]);await roomSend(f,binding);await settledRoom(f,binding);
  const {room,epoch}=await roomState(f,binding);
  const result=await f.request('chat/suggestions',{personaId:whale,roomId:room.id,revision:room.revision,epoch,contextKey:binding.contextKey,instruction:'给我两个短句参考'});
  assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(f.calls.at(-1).reasoningEffort,'low');
});

test('conclusion request identity freezes thinking grade, and a new request can use a new grade',async t=>{
  const f=fixture(t,{modelInfo:async()=>info(),script:call=>readChatInput(call).task==='work-instruction-draft'?jsonReply({draft:'先核对原文，再画草图；未确认的部分单列。'}):reply(['先画草图。'])});await f.ready();
  const room=await newRoom(f,[whale]);await roomSend(f,room);await settledRoom(f,room);
  const catalog=(await f.request('chat-work-draft?room='+encodeURIComponent(room.roomId))).value;
  const body={action:'generate',requestId:'grade-request',roomId:room.roomId,epoch:catalog.epoch,scopeKey:catalog.scopeKey,discussionRevision:catalog.discussionRevision,
    refs:[catalog.choices.find(choice=>choice.ref.kind==='user').ref],instruction:'整理结论'};
  await f.request('settings',{chatReasoningEffort:'low'});assert.equal((await f.request('chat-work-draft',body)).status,200);assert.equal(f.calls.at(-1).reasoningEffort,'low');
  const count=f.calls.length;await f.request('settings',{chatReasoningEffort:'high'});assert.equal((await f.request('chat-work-draft',body)).status,409);assert.equal(f.calls.length,count);
  assert.equal((await f.request('chat-work-draft',{...body,requestId:'fresh-grade-request'})).status,200);assert.equal(f.calls.at(-1).reasoningEffort,'high');
});
