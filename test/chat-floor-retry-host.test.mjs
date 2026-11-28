import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,domain,newRoom,roomSend,roomState,settledRoom,readChatInput,reply,dragon,whale} from './helpers/persona-chat-host.mjs';

const wire=text=>(async function*(){yield {type:'text-delta',text};yield {type:'finish',reason:{kind:'stop'}};})();

test('a rejoined member cannot poll indefinitely or acquire a second chance in a retired cycle',async t=>{
  const f=fixture(t,{directorScript:options=>wire(readChatInput(options).choices.find(c=>c.kind==='normal'&&c.id===whale)?.choiceId??'WAIT'),
    script:()=>reply(['incomplete'],'max-tokens')});
  await f.ready();const room=await newRoom(f,[dragon,whale]);
  await roomSend(f,room,dragon,'说一声','before-rejoin');
  const first=await settledRoom(f,room),seat=first.room.turns.find(turn=>turn.status==='failed');assert.equal(seat.recipientId,whale);
  for(const memberIds of [[dragon],[dragon,whale]]){
    const state=await roomState(f,room);
    assert.equal((await f.request('chat-rooms',{action:'update',roomId:room.roomId,configRevision:state.room.configRevision,
      epoch:state.epoch,memberIds})).status,200);
  }
  const before=await roomState(f,room),calls=f.calls.length;
  assert.equal((await f.request('chat',{action:'retry',...room,personaId:whale,id:seat.id,attemptId:'after-rejoin',
    revision:before.room.revision,epoch:before.epoch})).status,200);
  const done=await settledRoom(f,room),retried=done.room.turns.find(turn=>turn.id===seat.id);
  assert.equal(retried.status,'cancelled');assert.equal(f.calls.length,calls);
});

test('a restored legacy peer seat cannot use an invitation from a different bubble and does not stick pending',async t=>{
  const storage=domain(),aside='鲸鲸那边也有一本，你可以自己选。';
  const f=fixture(t,{storage,directorScript:request=>{
    const b=readChatInput(request),hasSource=b.events.some(e=>e.author.id===dragon);
    return wire(b.choices.find(c=>hasSource?c.kind==='peer'&&c.id===whale:c.kind==='normal'&&c.id===dragon)?.choiceId??'WAIT');
  },script:r=>readChatInput(r).speaker.id===dragon?reply([aside,'鲸鲸，借我另一册。']):reply(['未交付'],'max-tokens')});
  await f.ready();
  const room=await newRoom(f,[dragon,whale],'指向不同气泡的历史重试','legacy-floor-retry');
  await roomSend(f,room,dragon,'那我能先借一本看看吗？','floor-borrow');
  const before=await settledRoom(f,room);
  const failed=before.room.turns.find(turn=>turn.responsePlan?.kind==='peer'&&turn.status==='failed');
  assert.equal(failed.responsePlan.sourceRef.index,1);
  await f.dispose();
  // Only the isolated fixture is seeded with a valid pre-upgrade plan: the
  // substring used to match the name in the first bubble, addressed to the user.
  const saved=storage.tables.get('profile').get('personaChats').rooms.find(r=>r.id===room.roomId).turns.find(t=>t.id===failed.id);
  saved.responsePlan.sourceRef.index=0;saved.responsePlan.evidence=aside;
  const g=fixture(t,{storage});await g.ready();
  const opened=(await g.request('chat-context',{action:'open',roomId:room.roomId,viewer:'legacy-floor-reopen',sequence:1,sessionId:'work'})).value;
  const binding={roomId:room.roomId,contextKey:opened.id+':'+opened.revision};
  const state=await roomState(g,binding);
  const retried=await g.request('chat',{...binding,action:'retry',personaId:whale,id:failed.id,attemptId:'floor-retry',
    revision:state.room.revision,epoch:state.epoch,previousContextKey:room.contextKey});
  assert.equal(retried.status,200);
  const done=await settledRoom(g,binding),seat=done.room.turns.find(t=>t.id===failed.id);
  assert.equal(g.requests.length,0);assert.equal(seat.status,'failed');assert.equal(seat.failure,'source-changed');
  assert.equal(seat.responsePlan.sourceRef.index,0);assert.equal(done.running,false);
});

test('restart after a wall-clock rollback restores the completed turn before retrying its invited peer',async t=>{
  const storage=domain();
  const f=fixture(t,{storage,directorScript:request=>{
    const b=readChatInput(request),said=b.events.some(e=>e.author.id===dragon);
    return wire(b.choices.find(c=>said?c.kind==='peer'&&c.id===whale:c.kind==='normal'&&c.id===dragon)?.choiceId??'WAIT');
  },script:req=>readChatInput(req).speaker.id===dragon?reply(['鲸鲸，来帮我一下。']):reply(['未交付'],'max-tokens')});
  await f.ready();const room=await newRoom(f,[dragon,whale]);await roomSend(f,room,dragon,'要试试吗？','rollback');
  const state=await settledRoom(f,room),seat=state.room.turns.find(t=>t.status==='failed');
  assert.equal(seat.recipientId,whale);await f.dispose();
  const saved=storage.tables.get('profile').get('personaChats').rooms.find(r=>r.id===room.roomId).turns;
  const previous=saved.find(t=>t.recipientId===dragon&&t.phase!=='anchor');
  previous.at=saved[0].at-2000;previous.completedAt=saved[0].at-1000;
  const gate=Promise.withResolvers(),started=Promise.withResolvers();t.after(gate.resolve);
  const g=fixture(t,{storage,directorScript:()=>wire('WAIT'),script:()=>(async function*(){started.resolve(); await gate.promise; yield* reply();})()});await g.ready();
  const reopened=(await g.request('chat-context',{action:'open',roomId:room.roomId,viewer:'clock-reopen',sequence:1,sessionId:'work'})).value;
  const binding={roomId:room.roomId,contextKey:reopened.id+':'+reopened.revision};
  const before=await roomState(g,binding);
  const stream=receive=>g.handler({url:'/persona-shell/chat/live?batch=1&room='+encodeURIComponent(room.roomId),
    method:'GET',headers:{authorization:'owner'}},{writeHead(){},end(){},write(line){receive(JSON.parse(line.slice(5)));return true;}});
  const history=[];await stream(frame=>history.push(frame));assert.deepEqual(history.map(f=>[f.status,f.frames]),[['settled',[]]]);
  assert.equal((await g.request('chat',{action:'retry',...binding,personaId:whale,id:seat.id,attemptId:'after-clock-change',
    revision:before.room.revision,epoch:before.epoch,previousContextKey:room.contextKey})).status,200);
  await started.promise; const seen=[];
  const listening=stream(frame=>{seen.push(frame);gate.resolve();});
  const done=await settledRoom(g,binding);await listening;
  assert.equal(seen[0].status,'streaming');assert.equal(seen.at(-1).status,'settled');
  assert.deepEqual(seen.at(-1).frames.map(f=>f.attemptId),['after-clock-change']);
  assert.equal(done.room.turns.find(t=>t.id===seat.id).status,'ready');assert.equal(g.calls.length,1);
  assert.deepEqual(done.room.turns.find(t=>t.id===previous.id),before.room.turns.find(t=>t.id===previous.id));
});
