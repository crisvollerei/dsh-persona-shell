import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,reply,newRoom,roomSend,roomState,settledRoom,whale,dragon,claude,domain,readChatInput } from './helpers/persona-chat-host.mjs';

const body=options=>JSON.parse(options.messages.at(-1).content[0].text);
const control=(value,action='WAIT',work='N',request='open',evidence='-')=>(async function*(){
  yield{type:'text-delta',text:`D1 ${value.protocol.ticket} ${action} ${work} ${request} ${evidence}`};
  yield{type:'finish',reason:{kind:'stop'}};
})();
const compact=text=>(async function*(){yield{type:'text-delta',text};yield{type:'finish',reason:{kind:'stop'}};})();
async function broadcast(f,room){const state=await roomState(f,room);assert.equal((await f.request('chat-rooms',{
  ...room,action:'update',targetPersonaIds:[],configRevision:state.room.configRevision,epoch:state.epoch})).status,200);}

test('actual Host accepts finite no-mention decisions, preserves each actor own model history, and ends without quota-filling calls',async t=>{
  const f=fixture(t,{directorScript:options=>{const value=body(options),said=value.events.filter(event=>event.author.role==='assistant');
    const option=value.choices.find(choice=>choice.id===whale&&choice.to==='user');
    return control(value,said.length?'WAIT':option.choiceId);},script:()=>reply(['上一轮确实说过的完整原话。'])});
  await f.ready();const room=await newRoom(f,[whale,dragon],'真实角色历史','native-history');await broadcast(f,room);
  await roomSend(f,room,whale,'第一句原话。','first-user');let done=await settledRoom(f,room);
  assert.equal(done.directorFailure,null);assert.equal(f.calls.length,1);
  await roomSend(f,room,whale,'下一句，接着刚才聊。','second-user');done=await settledRoom(f,room);
  assert.equal(done.directorFailure,null);assert.equal(f.calls.length,2);
  const request=f.calls[1],own=request.messages.filter(message=>message.role==='assistant');
  assert.equal(own.length,1);assert.deepEqual(JSON.parse(own[0].content[0].text),{messages:['上一轮确实说过的完整原话。']});
  assert.ok(own[0].id);assert.deepEqual(own[0].source,{kind:'model',provider:'persona-chat-history',model:'unknown'});
  assert.equal(body(request).task,'chat-control');
  assert.doesNotMatch(JSON.stringify(body(request)),/上一轮确实说过的完整原话|下一句，接着刚才聊/,'control holds pointers, not duplicate dialogue bodies');
});

test('a public peer message is heard without reopening a person who already answered, while untouched initial recipients keep their entry',async t=>{
  const snapshots=[];const f=fixture(t,{directorScript:options=>{const value=body(options);snapshots.push(value);
    const spoken=value.events.filter(event=>event.author.role==='assistant');
    const id=[whale,dragon][spoken.length],option=value.choices.find(choice=>choice.id===id&&choice.to==='user');
    return control(value,option?.choiceId??'WAIT');},script:options=>reply([body(options).speaker.id===whale?'我先说自己的话。':'我也直接接用户这句话。'])});
  await f.ready();const room=await newRoom(f,[whale,dragon],'听见与接话分开','peer-hearing');await broadcast(f,room);
  await roomSend(f,room,whale,'各位随意。','user');const done=await settledRoom(f,room);
  assert.equal(done.directorFailure,null);assert.equal(f.calls.length,2);
  assert.ok(snapshots[1].choices.some(choice=>choice.id===dragon&&choice.to==='user'));
  const final=snapshots.at(-1);if(final.events.filter(event=>event.author.role==='assistant').length===2)
    assert.ok(final.choices.every(choice=>choice.id!==whale),'a peer answer to the human does not reopen whale');
  const second=f.calls[1];assert.ok(second.messages.some(message=>message.role==='user'&&message.content[0].text.includes('我先说自己的话。')));
  assert.ok(!second.messages.some(message=>message.role==='assistant'),'another actor’s words never become this actor’s own assistant history');
});

test('a forged finite ticket never dispatches a persona or reads working bodies and keeps the user original for retry',async t=>{
  const f=fixture(t,{directorScript:options=>control({...body(options),protocol:{ticket:'0000000000000000'}},'WAIT')});
  await f.ready();const room=await newRoom(f,[whale],'不可伪造选择','bad-ticket');
  await roomSend(f,room,whale,'保留下来的原话。','user');const state=await settledRoom(f,room);
  assert.equal(f.calls.length,0);assert.equal(state.directorFailure.reason,'choice');assert.equal(state.room.turns[0].user,'保留下来的原话。');
});

test('a successful reply followed by a compact WAIT ends normally without a warning, hidden repair or work access',async t=>{
  const f=fixture(t,{directorScript:options=>{const value=body(options);return compact(value.events.some(event=>event.author.role==='assistant')?'WAIT':value.choices.find(choice=>choice.id===whale).choiceId);}});
  await f.ready();const room=await newRoom(f,[whale,dragon],'自然收尾','compact-stop');await broadcast(f,room);
  await roomSend(f,room,whale,'这句话轻松聊聊。','compact-user');const done=await settledRoom(f,room);
  assert.equal(f.calls.length,1);assert.equal(f.directors.length,2);assert.equal(done.directorFailure,null);assert.equal(done.running,false);
  assert.deepEqual(body(f.calls[0]).workContext.sources,[]);assert.equal(f.requests.length,3);
});

test('a completed no-mention send can be acknowledged again without an error, a second anchor or another model call',async t=>{
  const f=fixture(t,{directorScript:options=>{const value=body(options);return control(value,value.choices[0]?.choiceId??'WAIT');}});
  await f.ready();const room=await newRoom(f,[whale,dragon],'广播回执','broadcast-ack');await broadcast(f,room);
  assert.equal((await roomSend(f,room,whale,'这句话只保存一次。','same-request')).status,200);
  const first=await settledRoom(f,room),calls=f.requests.length;
  assert.equal((await roomSend(f,room,whale,'这句话只保存一次。','same-request')).status,200);
  const second=await settledRoom(f,room);assert.equal(f.requests.length,calls);assert.deepEqual(second.room.turns,first.room.turns);
});

test('restart retries a real older peer target beyond the director reading budget using its exact persisted source',async t=>{
  const storage=domain(),bigFish=['鲸鲸，'+'乙'.repeat(997),...Array(5).fill('乙'.repeat(1000))],bigClaude=Array(6).fill('丙'.repeat(1000));
  const f=fixture(t,{storage,directorScript:options=>{const value=body(options),spoken=value.events.filter(event=>event.author.role==='assistant');
    const failed=spoken.some(event=>event.author.id===dragon),hasClaude=spoken.some(event=>event.author.id===claude);
    const id=!failed?dragon:!f.calls.some(call=>body(call).speaker.id===whale)?whale:!hasClaude?claude:null;
    const choice=value.choices.find(choice=>choice.id===id&&choice.kind===(id===whale?'peer':'normal'));
    return control(value,choice?.choiceId??'WAIT');},script:options=>body(options).speaker.id===dragon?reply(bigFish):body(options).speaker.id===claude?reply(bigClaude):reply(['中断后重试'],'max-tokens')});
  await f.ready();const room=await newRoom(f,[whale,dragon,claude],'长消息精确重试','long-peer-retry');await broadcast(f,room);
  await roomSend(f,room,whale,'当前用户原话。'.repeat(600).slice(0,4000),'long-user');const prior=await settledRoom(f,room);
  const failed=prior.room.turns.find(turn=>turn.recipientId===whale);assert.equal(failed.status,'failed');assert.ok(failed.responsePlan.sourceRef);
  assert.ok(prior.room.turns.some(turn=>turn.recipientId===claude&&turn.status==='ready'));await f.dispose();
  const restored=fixture(t,{storage,directorScript:options=>control(body(options)),script:()=>reply(['我接的是指定的那一句较早原话。'])});await restored.ready();
  const opened=(await restored.request('chat-context',{action:'open',roomId:room.roomId,viewer:'long-peer-restored',sequence:1,sessionId:'work'})).value;
  const binding={roomId:room.roomId,contextKey:opened.id+':'+opened.revision},state=await roomState(restored,binding);
  assert.equal((await restored.request('chat',{...binding,action:'retry',personaId:whale,id:failed.id,attemptId:'restored-peer-retry',
    revision:state.room.revision,epoch:state.epoch,previousContextKey:room.contextKey})).status,200);
  const done=await settledRoom(restored,binding);assert.equal(restored.calls.length,1);assert.equal(done.directorFailure,null);
  const actual=readChatInput(restored.calls[0]);assert.equal(actual.replyTarget.author.id,dragon);assert.equal(actual.replyTarget.text,bigFish[0]);
  assert.deepEqual(done.room.turns.find(turn=>turn.id===failed.id).responsePlan.sourceRef,failed.responsePlan.sourceRef);
});

test('an excluded original target cannot silently turn a precise retry into a different persona response',async t=>{
  const f=fixture(t,{script:()=>reply(['不应提交的中断内容'],'max-tokens')});await f.ready();
  const room=await newRoom(f,[whale],'排除依据后不替换目标','excluded-directed-target');
  await roomSend(f,room,whale,'这份原话先保留。','excluded-original');let state=await settledRoom(f,room);
  const failed=state.room.turns.find(turn=>turn.recipientId===whale);assert.equal(failed.status,'failed');
  const references=(await f.request('chat-references?room='+encodeURIComponent(room.roomId))).value;
  assert.equal((await f.request('chat-references',{roomId:room.roomId,ref:failed.responsePlan.sourceRef,excluded:true,
    referenceRevision:references.referenceRevision,epoch:references.epoch})).status,200);
  state=await roomState(f,room);const before=f.calls.length;
  assert.equal((await f.request('chat',{...room,action:'retry',personaId:whale,id:failed.id,attemptId:'excluded-retry',
    revision:state.room.revision,epoch:state.epoch})).status,200);
  const done=await settledRoom(f,room);assert.equal(f.calls.length,before,'no model call is dispatched without its exact allowed target');
  assert.equal(done.room.turns.find(turn=>turn.id===failed.id).status,'failed');
});
