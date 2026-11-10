import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,domain,jsonReply,reply,preference,newRoom,roomSend,roomState,settledRoom,flush,whale,dragon,claude } from './helpers/persona-chat-host.mjs';

const body=options=>readChatInput(options);
const quiet=()=>jsonReply({messages:[]});
const wait=()=>jsonReply({choiceId:null,waitForUser:true});
const choose=(value,predicate)=>{const selected=value.choices.find(predicate);assert.ok(selected,'a legal current choice exists');
  return jsonReply({context:{work:'not-needed',sourceIds:[],request:'open',evidence:value.message},choiceId:selected.choiceId,goal:'看过当前语境后自行决定是否有必要发言。'});};
const broadcast=async(f,room)=>{const state=await roomState(f,room);assert.equal((await f.request('chat-rooms',{...room,action:'update',
  targetPersonaIds:[],configRevision:state.room.configRevision,epoch:state.epoch})).status,200);};
const speakerCalls=(f,id)=>f.calls.filter(options=>body(options).speaker.id===id);

test('a persona can stay silent without a public empty reply, a failure, quota loss or repeated calls for the same scene',async t=>{
  const f=fixture(t,{directorScript:options=>choose(body(options),option=>option.id===whale&&option.kind==='normal'),script:quiet});
  await f.ready();const room=await newRoom(f,[whale],'安静也可以','solo-silence');
  await roomSend(f,room,whale,'先陪我坐一会儿。','quiet-user');const done=await settledRoom(f,room);
  assert.equal(f.calls.length,1);assert.equal(f.directors.length,1);assert.equal(done.directorFailure,null);
  assert.deepEqual(done.room.turns.map(turn=>turn.phase),['anchor']);
  assert.equal(done.room.silences.length,1);assert.equal(done.room.silences[0].personaId,whale);
  assert.deepEqual(done.room.silences[0].through,{turnId:'quiet-user',attemptId:'user'});
  const state=await roomState(f,room);
  assert.equal((await f.request('chat',{...room,personaId:whale,action:'retry-director',messageId:'quiet-user',epoch:state.epoch})).status,200);
  await settledRoom(f,room);assert.equal(f.calls.length,1);assert.equal(f.directors.length,1);
  const usage=(await f.request('model-usage?days=1')).value;assert.equal(usage.totals.calls,2);assert.equal(usage.totals.failedCalls,0);
  const references=(await f.request('chat-references?room='+encodeURIComponent(room.roomId))).value;
  assert.match(JSON.stringify(references),/"outcome":"silent"/);
  const memory=(await f.request('memory')).value;
  assert.ok(memory.usage.records.some(record=>record.channel==='chat'&&record.outcome==='silent'));
});

test('a new peer statement can invite a previously silent persona back with her full remaining quota and isolated preferences',async t=>{
  const f=fixture(t,{directorScript:options=>{const value=body(options),events=value.events.filter(event=>event.author.role==='assistant');
    if(events.some(event=>event.author.id===whale))return wait();
    if(events.some(event=>event.author.id===dragon))return choose(value,option=>option.id===whale&&option.kind==='peer'&&option.to===dragon);
    return choose(value,option=>option.id===whale&&option.kind==='normal'||option.id===dragon&&option.kind==='normal');
  },script:options=>{const value=body(options);return value.speaker.id===whale&&speakerCalls(f,whale).length===1?quiet():reply([
    value.speaker.id===dragon?'鲸鲸，等会儿想一起聊哪本书？':'这次有新话头了，我想聊你刚才提的那本。']);}});
  await f.ready();await preference(f,'ONLY_WHALE_PRIVATE',whale);await preference(f,'ONLY_DRAGON_PRIVATE',dragon);
  const room=await newRoom(f,[whale,dragon],'先听再聊','quiet-then-peer');await broadcast(f,room);
  await roomSend(f,room,whale,'你们先随意聊。','quiet-peer-user');const done=await settledRoom(f,room);
  assert.deepEqual(f.calls.map(options=>body(options).speaker.id),[whale,dragon,whale]);
  assert.equal(body(speakerCalls(f,whale)[1]).opportunity.normalRemainingAfterThis,3,'neither silence nor the independent peer response spends a normal opportunity');
  assert.deepEqual(done.room.turns.filter(turn=>turn.phase!=='anchor').map(turn=>[turn.recipientId,turn.emittedOrder]),[[dragon,0],[whale,1]]);
  assert.ok(!done.room.silences.some(value=>value.personaId===whale),'a committed real reply supersedes that actor’s quiet frontier');
  assert.doesNotMatch(JSON.stringify(f.directors),/ONLY_WHALE_PRIVATE|ONLY_DRAGON_PRIVATE/);
  assert.doesNotMatch(f.calls[1].system,/ONLY_WHALE_PRIVATE/);assert.doesNotMatch(f.calls[2].system,/ONLY_DRAGON_PRIVATE/);
});

test('silence survives restart without charging a turn or restarting the same scene, and new user input opens a fresh cycle',async t=>{
  const storage=domain(),f=fixture(t,{storage,script:quiet});await f.ready();const room=await newRoom(f,[whale],'恢复安静进度','quiet-restore');
  await roomSend(f,room,whale,'这句先听着就好。','before-restart');const prior=await settledRoom(f,room);await f.dispose();
  const restored=fixture(t,{storage});await restored.ready();
  const opened=(await restored.request('chat-context',{action:'open',roomId:room.roomId,viewer:'quiet-restored-viewer',sequence:1,sessionId:'work'})).value;
  const binding={roomId:room.roomId,contextKey:opened.id+':'+opened.revision},state=await roomState(restored,binding);
  assert.deepEqual(state.room.silences,prior.room.silences);assert.equal(restored.requests.length,0);
  assert.equal((await restored.request('chat',{...binding,personaId:whale,action:'retry-director',messageId:'before-restart',epoch:state.epoch})).status,200);
  await settledRoom(restored,binding);assert.equal(restored.requests.length,0);
  await roomSend(restored,binding,whale,'现在我有新问题了。','after-restart');const done=await settledRoom(restored,binding);
  assert.equal(restored.calls.length,1);assert.equal(body(restored.calls[0]).opportunity.normalRemainingAfterThis,2);
  assert.deepEqual(done.room.silences,[]);assert.equal(done.room.turns.at(-1).status,'ready');
});

test('declining a peer opportunity preserves it for a genuinely new direct peer call',async t=>{
  const f=fixture(t,{directorScript:options=>{const value=body(options),events=value.events.filter(event=>event.author.role==='assistant');
    if(events.some(event=>event.author.id===whale))return wait();
    if(events.some(event=>event.author.id===claude))return choose(value,option=>option.id===whale&&option.kind==='peer'&&option.to===claude);
    if(value.choices.some(option=>option.id===whale&&option.kind==='peer'))return choose(value,option=>option.id===whale&&option.kind==='peer');
    if(events.some(event=>event.author.id===dragon))return choose(value,option=>option.id===claude&&option.kind==='normal'&&option.to==='user');
    return choose(value,option=>option.id===dragon&&option.kind==='normal'&&option.to==='user');
  },script:options=>{const value=body(options);if(value.speaker.id===whale)return speakerCalls(f,whale).length===1?quiet():reply(['这次我来回答小克的新问题。']);
    return reply([value.speaker.id===dragon?'鲸鲸，你想不想接这句话？':'鲸鲸，我还有一个新问题想听你说。']);}});
  await f.ready();const room=await newRoom(f,[whale,dragon,claude],'独立机会先保留','quiet-peer-budget');await broadcast(f,room);
  await roomSend(f,room,whale,'你们聊聊吧。','quiet-peer-cycle');const done=await settledRoom(f,room);
  assert.deepEqual(f.calls.map(options=>body(options).speaker.id),[dragon,whale,claude,whale]);
  const a=speakerCalls(f,whale);assert.ok(a.every(options=>body(options).opportunity.kind==='peer'));
  assert.ok(a.every(options=>body(options).opportunity.normalRemainingAfterThis===3));
  const afterSilence=f.directors.map(body).find(value=>value.events.some(event=>event.author.id===claude));
  assert.equal(afterSilence.states.find(state=>state.id===whale).peerRemaining,1);
  assert.equal(done.room.turns.filter(turn=>turn.recipientId===whale).length,1);
});

test('waiting for the user stops the current cycle while preserving remaining opportunities and opens no idle model loop',async t=>{
  const f=fixture(t,{directorScript:options=>{const value=body(options);return value.events.some(event=>event.author.role==='assistant')?wait():choose(value,option=>option.id===whale&&option.kind==='normal');},
    script:()=>reply(['我在，今天想聊点什么？'])});
  await f.ready();const room=await newRoom(f,[whale,dragon,claude],'把话留给用户','wait-user-room');await broadcast(f,room);
  await roomSend(f,room,whale,'晚上好。','wait-user-cycle');const done=await settledRoom(f,room);
  assert.equal(f.calls.length,1);assert.equal(f.directors.length,2);assert.equal(done.running,false);assert.equal(done.directorFailure,null);
  assert.ok(body(f.directors[1]).states.some(state=>state.id===dragon&&state.normalRemaining===3&&state.normalReady));
  const before=f.requests.length;await flush();assert.equal(f.requests.length,before);
});

test('a truncated empty response is a failed response, not a successful silent decision',async t=>{
  const f=fixture(t,{script:()=>jsonReply({messages:[]},'max-tokens')});await f.ready();const room=await newRoom(f,[whale],'完整结果才可沉默','quiet-truncated');
  await roomSend(f,room,whale,'这句需要一个完整结果。','truncated-empty');const done=await settledRoom(f,room);
  assert.equal(done.room.turns.at(-1).status,'failed');assert.equal(done.room.turns.at(-1).failure,'length');assert.deepEqual(done.room.silences,[]);
});

test('a declined-response save failure keeps a retryable failed seat instead of silently dropping the user’s message',async t=>{
  let failQuietOnce=true;
  const storage=domain(Promise.resolve(),{beforePut(key,value){if(key==='personaChats'&&failQuietOnce&&value.rooms.some(room=>room.silences?.length)){
    failQuietOnce=false;throw Error('private disk failure');}}});
  const f=fixture(t,{storage,script:quiet});await f.ready();const room=await newRoom(f,[whale],'沉默也需可靠保存','quiet-save');
  await roomSend(f,room,whale,'不要丢掉这条原话。','quiet-save-user');const failed=await settledRoom(f,room),seat=failed.room.turns.at(-1);
  assert.equal(seat.status,'failed');assert.equal(seat.failure,'save');assert.deepEqual(failed.room.silences,[]);
  assert.equal(failed.room.turns[0].user,'不要丢掉这条原话。');
  assert.equal((await f.request('chat',{...room,action:'retry',personaId:whale,id:seat.id,attemptId:'retry-quiet-save',revision:failed.room.revision,epoch:failed.epoch})).status,200);
  const retried=await settledRoom(f,room);assert.equal(retried.room.turns.length,1);assert.equal(retried.room.silences.length,1);
  assert.ok(speakerCalls(f,whale).every(options=>body(options).opportunity.normalRemainingAfterThis===2));
});

test('one room’s silent cursor cannot suppress the same persona in another room or leak either room’s conversation',async t=>{
  const f=fixture(t,{script:options=>body(options).message==='ROOM_A_PRIVATE_CONTEXT'?quiet():reply(['只回应乙房间。'])});
  await f.ready();const a=await newRoom(f,[whale],'甲房间','quiet-room-a'),b=await newRoom(f,[whale],'乙房间','quiet-room-b');
  await roomSend(f,a,whale,'ROOM_A_PRIVATE_CONTEXT','a-user');const stateA=await settledRoom(f,a);
  await roomSend(f,b,whale,'ROOM_B_PRIVATE_CONTEXT','b-user');const stateB=await settledRoom(f,b);
  assert.equal(stateA.room.silences.length,1);assert.deepEqual(stateB.room.silences,[]);
  assert.equal(stateB.room.turns.at(-1).status,'ready');assert.equal(body(f.calls[1]).opportunity.normalRemainingAfterThis,2);
  assert.doesNotMatch(JSON.stringify(f.calls[1].messages),/ROOM_A_PRIVATE_CONTEXT/);
  assert.doesNotMatch(JSON.stringify(f.calls[0].messages),/ROOM_B_PRIVATE_CONTEXT/);
});

test('clearing a room retires an in-flight silent decision and its late result cannot suppress a new generation',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(release);
  const f=fixture(t,{script:(_,count)=>(async function*(){if(count===1)await gate;yield*quiet();})()});
  await f.ready();const room=await newRoom(f,[whale],'清空后的新现场','quiet-clear');
  await roomSend(f,room,whale,'即将被清空的旧现场。','old-quiet-user');await flush();const active=await roomState(f,room);
  assert.equal(active.room.turns.at(-1).status,'pending');
  assert.equal((await f.request('chat',{...room,personaId:whale,action:'clear',revision:active.room.revision,epoch:active.epoch})).status,200);
  release();await flush();const cleared=await roomState(f,room);assert.deepEqual(cleared.room.turns,[]);assert.deepEqual(cleared.room.silences,[]);
  await roomSend(f,room,whale,'这是清空后新说的话。','new-quiet-user');const done=await settledRoom(f,room);
  assert.equal(f.calls.length,2);assert.equal(done.room.silences.length,1);assert.equal(done.room.silences[0].messageId,'new-quiet-user');
  assert.deepEqual(done.room.turns.map(turn=>turn.user),['这是清空后新说的话。']);
});
