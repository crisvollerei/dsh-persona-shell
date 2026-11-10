import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,domain,directorReply,reply,newRoom,roomSend,roomState,settledRoom,flush,whale } from './helpers/persona-chat-host.mjs';

const input=options=>readChatInput(options);
const context=body=>({work:'not-needed',sourceIds:[],request:'open',evidence:body.message});
const choose=(body,index=0)=>{const event=body.events.findLast(e=>e.author.role==='user');return{
  id:whale,kind:'normal',to:'user',evidence:{eventId:event.id,index,text:event.messages[index]},goal:'回应本次指定的用户原话。'};};
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return{promise,open};};

test('a valid director result after eight seconds uses the configured deadline rather than an independent short cutoff',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=gate();let signal;t.after(pending.open);
  const f=fixture(t,{config:{timeoutMs:15000},directorScript:options=>(async function*(){
    signal=options.signal;await pending.promise;const body=input(options);yield*directorReply(context(body),choose(body));
  })()});
  await f.ready();const room=await newRoom(f,[whale],'等待有效调度','director-latency');
  await roomSend(f,room,whale,'这次模型响应慢一点。','latency-user');t.mock.timers.tick(0);await flush();
  assert.ok(signal);t.mock.timers.tick(8001);await flush();
  assert.equal(signal.aborted,false,'the configured fifteen-second deadline still has time left');
  pending.open();await flush();const done=await settledRoom(f,room);
  assert.equal(f.calls.length,1);assert.equal(done.directorFailure,null);assert.equal(done.room.turns.at(-1).status,'ready');
});

test('restarting a successful single-member cycle cannot re-admit its already-consumed original user event',async t=>{
  const storage=domain(),f=fixture(t,{storage,directorScript:options=>{const body=input(options);return directorReply(context(body),choose(body));}});
  await f.ready();const room=await newRoom(f,[whale],'恢复消费进度','restore-consumed');
  await roomSend(f,room,whale,'这句已经回答过了。','handled-user');const done=await settledRoom(f,room);
  assert.equal(f.calls.length,1);const saved=structuredClone(done.room.turns);
  assert.equal(saved.at(-1).responsePlan.evidence,'这句已经回答过了。');await f.dispose();
  const restored=fixture(t,{storage});await restored.ready();
  const opened=(await restored.request('chat-context',{action:'open',roomId:room.roomId,viewer:'restored-viewer',sequence:1,sessionId:'work'})).value;
  const binding={roomId:room.roomId,contextKey:opened.id+':'+opened.revision},state=await roomState(restored,binding);
  assert.deepEqual(state.room.turns,saved,'literal response evidence and completed replies survive restore');
  assert.equal((await restored.request('chat',{...binding,action:'retry-director',personaId:whale,messageId:'handled-user',epoch:state.epoch})).status,200);
  await settledRoom(restored,binding);assert.equal(restored.requests.length,0,'remaining quota alone cannot trigger a duplicate judgement or reply');
});

test('a selected second user fragment stays the precise reply target after a failed actor call, persistence and explicit retry',async t=>{
  const storage=domain(),busy=gate();t.after(busy.open);
  const f=fixture(t,{storage,directorScript:options=>{const body=input(options);return directorReply(context(body),choose(body,body.message.includes('第二段')?1:0));},
    script:options=>(async function*(){const body=input(options);if(body.message==='先占住这一轮')await busy.promise;
      yield*reply(['针对当前这一句回应。'],body.message.includes('第二段')?'max-tokens':'stop');})()});
  await f.ready();const room=await newRoom(f,[whale],'分段依据恢复','fragment-evidence');
  await roomSend(f,room,whale,'先占住这一轮','busy-user');await flush();
  await roomSend(f,room,whale,'第一段是背景。','first-fragment');
  await roomSend(f,room,whale,'第二段才是问题。','second-fragment');busy.open();
  const failed=await settledRoom(f,room),actor=failed.room.turns.find(turn=>turn.messageId==='first-fragment'&&turn.phase!=='anchor');
  assert.equal(actor.status,'failed');assert.equal(actor.responsePlan.evidence,'第二段才是问题。');
  assert.deepEqual(input(f.calls.at(-1)).replyTarget,{author:{role:'user',name:'我'},text:'第二段才是问题。'});
  await f.dispose();const restored=fixture(t,{storage});await restored.ready();
  const opened=(await restored.request('chat-context',{action:'open',roomId:room.roomId,viewer:'retry-viewer',sequence:1,sessionId:'work'})).value;
  const binding={roomId:room.roomId,contextKey:opened.id+':'+opened.revision},state=await roomState(restored,binding);
  assert.equal((await restored.request('chat',{...binding,action:'retry',personaId:whale,id:actor.id,attemptId:'retry-fragment',epoch:state.epoch,revision:state.room.revision})).status,200);
  await settledRoom(restored,binding);assert.equal(restored.calls.length,1);
  assert.deepEqual(input(restored.calls[0]).replyTarget,{author:{role:'user',name:'我'},text:'第二段才是问题。'});
});
