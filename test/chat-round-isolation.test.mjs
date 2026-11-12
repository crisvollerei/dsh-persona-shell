import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, domain, flush, reply, directorReply, preference, newRoom, roomSend, roomState, settledRoom,
  whale, dragon, claude } from './helpers/persona-chat-host.mjs';

function gate(t) {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  t.after(open);
  return { promise, open };
}
const bodyOf = options => readChatInput(options);
const actors = state => state.room.turns.filter(turn=>turn.phase!=='anchor');
function directed(options,ids) {
  const value=bodyOf(options),answered=new Set(value.events.filter(event=>event.author.role==='assistant').map(event=>event.author.id));
  const person=(ids??value.recipients.map(person=>person.id)).find(id=>!answered.has(id)&&value.states.some(state=>state.id===id&&state.normalReady));
  const event=value.events.findLast(event=>event.author.role==='user');
  return directorReply({work:'not-needed',sourceIds:[],request:'open',evidence:value.message},person?{id:person,kind:'normal',to:'user',
    evidence:{eventId:event.id,index:0,text:event.messages[0]},goal:'回应本房间的这条原话。'}:null);
}
const memoryEntry = async (f, content) => (await f.request('memory')).value.entries.find(e => e.content === content);
const updatePreference = (f, entry, change) => f.request('memory', { action:'update', id:entry.id,
  version:entry.version, pinned:entry.pinned, ...change });

test('a confirmed cross-source retry retains every original addressee but only the in-scope response', async t => {
  let fishAttempts=0;
  const f=fixture(t,{script:options=>{
    const speaker=bodyOf(options).speaker.id;
    return speaker===whale ? reply(['新范围里的回答'],++fishAttempts===1?'max-tokens':'stop') : reply(['OLD_SCOPE_ONLY']);
  }});
  await f.ready();const room=await newRoom(f);
  const select=await f.request('chat-rooms',{...room,action:'update',configRevision:0,epoch:0,targetPersonaIds:[dragon,whale]});
  assert.equal(select.status,200);
  await roomSend(f,room,dragon,'你们俩怎么看','both');
  const prior=await settledRoom(f,room);const failed=actors(prior).find(turn=>turn.status==='failed');
  assert.deepEqual(actors(prior).map(t=>t.status),['ready','failed']);
  const opened=await f.request('chat-context?room='+encodeURIComponent(room.roomId)+'&viewer=viewer-room-create&sequence=2');
  const current=await f.request('chat-context',{action:'detach',roomId:room.roomId,sessionId:'work',revision:opened.value.revision});
  assert.equal(current.status,200);
  const binding={roomId:room.roomId,contextKey:current.value.id+':'+current.value.revision};
  const state=await roomState(f,binding);
  const retry={action:'retry',...binding,id:failed.id,attemptId:'retry-in-new-scope',personaId:whale,revision:state.room.revision,epoch:state.epoch};
  assert.equal((await f.request('chat',retry)).status,409);
  const beforeRetryJudgements=f.directors.length;
  assert.equal((await f.request('chat',{...retry,previousContextKey:room.contextKey})).status,200);const retryDone=await settledRoom(f,binding);
  assert.equal(f.directors.length,beforeRetryJudgements,'confirmation retries this seat without reopening the old scope cycle');
  assert.equal(retryDone.directorFailure,null);
  assert.deepEqual(f.calls.slice(2).map(call=>bodyOf(call).speaker.id),[whale],'a confirmed retry replaces only the failed seat, never the already successful speaker');
  assert.deepEqual((await roomState(f,binding)).room.turns.find(turn=>turn.recipientId===dragon).assistant,['OLD_SCOPE_ONLY']);
  assert.equal((await roomSend(f,binding,dragon,'刚才点名了谁？','next')).status,200);await settledRoom(f,binding);
  const question=f.calls.map(bodyOf).find(p=>p.message==='刚才点名了谁？');const [previous]=question.history;
  assert.deepEqual(previous.recipients.map(p=>p.id),[dragon,whale]);
  assert.equal(previous.recipient.id,whale);assert.deepEqual(previous.assistant,['新范围里的回答']);
  assert.doesNotMatch(JSON.stringify(question.history),/OLD_SCOPE_ONLY/);
});

test('out-of-order viewer requests do not initialize a hidden room, renew it, or replace another window’s source',async t=>{
  const reads=[], f=fixture(t,{extraServices:[['sessionQuery',{observeSession:async id=>{reads.push(id);return {events:[]};}}]]});
  await f.ready();const made=await f.request('chat-rooms',{action:'create',requestId:'lease-race',name:'两扇窗',memberIds:[whale],targetPersonaId:whale,epoch:0});
  const roomId=made.value.room.id, context=body=>f.request('chat-context',{roomId,...body});
  assert.equal((await context({action:'presence',viewer:'first',sequence:3,visible:false})).status,200);
  const stale=await context({action:'open',viewer:'first',sequence:1,visible:true,sessionId:'old'});
  assert.equal(stale.value.initialized,false);assert.deepEqual(reads,[]);
  const actual=await context({action:'open',viewer:'second',sequence:1,sessionId:'current'});
  assert.equal(actual.value.primarySessionId,'current');assert.deepEqual(reads,['current']);
  const late=await f.request('chat-context?room='+encodeURIComponent(roomId)+'&viewer=first&sequence=2');
  assert.equal(late.status,200);assert.equal(late.value.primarySessionId,'current');
  const closed=await context({action:'presence',viewer:'second',sequence:2,visible:false});
  assert.equal(closed.value.active,false,'the late poll did not give the closed viewer another lease');
  assert.deepEqual(reads,['current']);assert.equal(f.calls.length,0);
});

test('retry after a roster edit or restart hears only original listeners still in the room', async t => {
  for (const original of [[whale], [whale, dragon, claude]]) {
    const storage = domain(), first = fixture(t, { storage, script:() => reply([], 'max-tokens') });
    await first.ready();
    const room = await newRoom(first, original), sent = await roomSend(first, room);
    assert.equal(sent.status, 200);
    const failed = await settledRoom(first, room);
    assert.equal(actors(failed)[0].status, 'failed');
    const retained = original.includes(claude) ? [claude] : [];
    assert.equal((await first.request('chat-rooms', { ...room, action:'update', configRevision:failed.room.configRevision,
      epoch:failed.epoch, memberIds:[whale, ...retained, 'Gemini'] })).status, 200);
    // An acknowledgment replay is still the original send after members change.
    assert.deepEqual((await roomSend(first, room)).value.room.turns[0].memberIdsAtSend, original);
    assert.equal(first.calls.length, 1);
    await first.dispose();
    const f = fixture(t, { storage, directorScript:options=>directed(options,[whale,...retained]) });
    await f.ready();
    const opened = (await f.request('chat-context', { action:'open', roomId:room.roomId, viewer:'retry-viewer', sequence:1, sessionId:'work' })).value;
    const state = await roomState(f, room);
    assert.equal((await f.request('chat', { action:'retry', ...room, contextKey:opened.id+':'+opened.revision, id:actors(failed)[0].id,
      attemptId:'second-attempt', personaId:whale, revision:state.room.revision, epoch:state.epoch })).status, 200);
    const result = await settledRoom(f, room);
    for(const call of f.directors)assert.deepEqual(bodyOf(call).members.map(p=>p.id),[whale,...retained]);
    assert.equal(f.plans.length+f.continuations.length,0);
    assert.deepEqual(actors(result).map(t=>[t.recipientId,t.status]), [whale,...retained].map(id=>[id,'ready']));
    for (const turn of result.room.turns) {
      assert.deepEqual(turn.memberIdsAtSend, original);
      assert.deepEqual(turn.recipients.map(p=>p.id), [whale]);
    }
    await f.dispose();
  }
});

test('clearing and deleting a different room preserves listener decisions, quick replies and valid room actions', async t => {
  const listeners = gate(t), suggestions = gate(t);
  const f = fixture(t, {
    directorScript: options => (async function* () { await listeners.promise; yield* directed(options,[whale,dragon]); })(),
    script: options => (async function* () {
      if (bodyOf(options).instruction !== undefined) {
        await suggestions.promise;
        yield { type:'text-delta', text:'{"suggestions":["你怎么看？"]}' };
        yield { type:'finish', reason:{kind:'stop'} };
      } else yield* reply();
    })(),
  });
  await f.ready();
  const a = await newRoom(f, [whale, dragon], '正在判断', 'a');
  const b = await newRoom(f, [whale], '准备删除', 'b');
  const c = await newRoom(f, [claude], '正在准备快捷参考', 'c');
  await roomSend(f, a); await flush();
  assert.equal((await roomState(f,a)).roundPhase,'preparing');
  const before = await roomState(f,c);
  const pendingSuggestions = f.request('chat/suggestions', { ...c, personaId:claude, revision:before.room.revision,
    epoch:before.epoch, instruction:'给我一句追问' });
  await flush();
  let other = await roomState(f,b);
  assert.equal((await f.request('chat',{ ...b, action:'clear', personaId:whale, revision:other.room.revision, epoch:other.epoch })).status,200);
  other = await roomState(f,b);
  assert.equal((await f.request('chat-rooms',{ action:'delete', roomId:b.roomId, revision:other.room.revision, epoch:other.epoch })).status,200);
  suggestions.open(); listeners.open();
  assert.equal((await pendingSuggestions).status,200);
  const state = await settledRoom(f,a);
  assert.deepEqual(actors(state).map(t => [t.recipientId,t.status]),[[whale,'ready'],[dragon,'ready']]);
  const decisions=f.directors.map(bodyOf);
  assert.deepEqual(decisions.map(input=>input.events.filter(event=>event.author.role==='assistant').map(event=>event.author.id)),[[],[whale]],
    'both scheduled actors delivered, without a third terminal judgement');
  assert.ok(decisions.every(input=>input.choices.every(choice=>choice.kind==='normal'&&choice.to==='user')),
    'neither reply addressed a companion');
  assert.equal((await f.request('chat',{ ...c, action:'send', personaId:claude, content:'目录变了，但我的房间没有变',
    revision:before.room.revision, epoch:before.epoch, requestId:'still-current' })).status,200);
});

test('a rejected, undurable or duplicate send cannot preempt an accepted listener decision', async t => {
  const waiting = gate(t); let fail = false;
  const f = fixture(t, { storage:domain(Promise.resolve(),{fail:key=>key==='chatInputQueue'&&fail}),
    directorScript:options=>(async function*(){await waiting.promise;yield* directed(options,[whale,dragon]);})() });
  await f.ready(); const room = await newRoom(f);
  assert.equal((await roomSend(f,room)).status,200); await flush();
  const state = await roomState(f,room); assert.equal(state.roundPhase,'preparing');
  const post = { ...room, action:'send', personaId:whale, requestId:'new-question', content:'下一题',
    epoch:state.epoch, revision:state.room.revision };
  assert.equal((await f.request('chat',{ ...post, epoch:state.epoch+1 })).status,409);
  fail=true; assert.equal((await f.request('chat',post)).status,503); fail=false;
  assert.equal((await roomSend(f,room)).status,200);
  assert.equal(f.directors[0].signal.aborted,false); waiting.open();
  const result = await settledRoom(f,room);
  assert.deepEqual(result.room.turns.map(t => [t.messageId,t.phase]),[['room-message','anchor'],['room-message','reaction'],['room-message','reaction']]);
});

test('a delayed create replay queued behind deletion cannot recreate the deleted room', async t => {
  const entered=gate(t), resume=gate(t); let deleting=false;
  const f=fixture(t,{storage:domain(Promise.resolve(), {async beforePut(key){
    if(key==='personaChats'&&deleting){deleting=false;entered.open();await resume.promise;}
  }})});
  await f.ready();const binding=await newRoom(f,[whale],'旧房间','create-once');
  const before=await roomState(f,binding);deleting=true;
  const deletion=f.request('chat-rooms',{action:'delete', ...binding, revision:before.room.revision, epoch:before.epoch});
  await entered.promise;
  const late=f.request('chat-rooms',{action:'create',requestId:'create-once', name:'旧房间', memberIds:[whale],
    targetPersonaId:whale,epoch:before.epoch});
  await flush(); resume.open();assert.equal((await deletion).status,200);assert.equal((await late).status,409);
  assert.equal((await f.state()).rooms.length,0);
});

test('editing queued and unrelated private preferences leaves the current speaker running; the next speaker reads the edit', async t => {
  const waiting = gate(t);
  const f = fixture(t, { script:options=>(async function*(){
    if(bodyOf(options).speaker.id===whale)await waiting.promise;
    yield* reply();
  })() });
  await f.ready();
  await preference(f,'龙的旧偏好',dragon); await preference(f,'克的旧偏好',claude);
  const room = await newRoom(f);
  await f.request('chat-rooms',{...room,action:'update',epoch:0,configRevision:0,targetPersonaIds:[whale,dragon]});
  await roomSend(f,room);await flush();
  assert.equal(f.calls.length,1);
  assert.equal((await updatePreference(f,await memoryEntry(f,'克的旧偏好'),{content:'克的私有新偏好'})).status,200);
  assert.equal((await updatePreference(f,await memoryEntry(f,'龙的旧偏好'),{content:'龙的私有新偏好'})).status,200);
  assert.equal(f.calls[0].signal.aborted,false);
  waiting.open(); const final=await settledRoom(f,room);
  assert.deepEqual(actors(final).map(t => t.status),['ready','ready']);
  assert.match(f.calls[1].system,/龙的私有新偏好/);
  assert.doesNotMatch(f.calls[1].system,/龙的旧偏好|克的私有新偏好/);
});

test('moving a private preference retires requests with changed inputs at either end, not an unrelated third speaker', async t => {
  const waiting=gate(t), f=fixture(t,{script:()=>(async function*(){await waiting.promise;yield*reply();})()});
  await f.ready();await preference(f,'旧鱼偏好',whale);
  const rooms=[];
  for(const [i,id] of [whale,dragon,claude].entries()){
    rooms.push(await newRoom(f,[id],id,'p'+i));
    assert.equal((await roomSend(f,rooms[i],id)).status,200);
  }
  await flush(); assert.equal(f.calls.length,3);
  const saved=await updatePreference(f,await memoryEntry(f,'旧鱼偏好'),{content:'改给龙的偏好',scope:'persona',personaId:dragon});
  assert.equal(saved.status,200);
  assert.deepEqual(f.calls.map(call=>call.signal.aborted),[true,true,false]);
  waiting.open();const states=await Promise.all(rooms.map(r=>settledRoom(f,r)));
  assert.deepEqual(states.map(s=>actors(s)[0].status),['cancelled','cancelled','ready']);
});
