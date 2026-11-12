import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,domain,newRoom,roomSend,roomState,settledRoom,readChatInput,reply,dragon,whale} from './helpers/persona-chat-host.mjs';

const wire=text=>(async function*(){yield {type:'text-delta',text};yield {type:'finish',reason:{kind:'stop'}};})();

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
