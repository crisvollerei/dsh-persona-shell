import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,jsonReply,reply,newRoom,roomSend,roomState,settledRoom,flush,whale,dragon } from './helpers/persona-chat-host.mjs';

const input=options=>readChatInput(options);
const context=body=>({work:'not-needed',sourceIds:[],request:'open',evidence:body.message});
const wire=(text,finish='stop')=>(async function*(){yield{type:'text-delta',text};yield{type:'finish',reason:{kind:finish}};})();
const choose=(body,id=whale)=>{const option=body.choices.find(choice=>choice.id===id&&choice.kind==='normal'&&choice.to==='user');
  assert.ok(option,'the native model receives a legal program-bound choice');
  return{context:context(body),choiceId:option.choiceId,goal:'自然接住选中原话。'};};

test('a no-mention native short choice creates the real speaker without requiring any copied routing or quotation fields',async t=>{
  const f=fixture(t,{directorScript:options=>{const body=input(options);return jsonReply(body.events.some(event=>event.author.id===whale)
    ?{context:context(body),choiceId:null}:choose(body));}});
  await f.ready();const room=await newRoom(f,[whale,dragon],'广播短选择','choice-broadcast');
  const state=await roomState(f,room);await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[],configRevision:state.room.configRevision,epoch:state.epoch});
  await roomSend(f,room,whale,'大家晚上好。','short-choice-user');const done=await settledRoom(f,room);
  assert.deepEqual(input(f.directors[0]).recipients,[]);assert.equal(f.calls.length,1);assert.equal(done.directorFailure,null);
  assert.deepEqual(input(f.calls[0]).replyTarget,{author:{role:'user',name:'我'},text:'大家晚上好。'});
  assert.equal(done.room.turns.at(-1).responsePlan.evidence,'大家晚上好。');
});

for(const [name,response,reason,finish]of[
  ['malformed text',()=>wire('PRIVATE_PROVIDER_WIRE-not-json'),'control','stop'],
  ['unknown choice',body=>jsonReply({context:context(body),choiceId:'foreign-or-expired-choice',goal:'不要执行。'}),'choice','stop'],
  ['truncated result',body=>wire(JSON.stringify(choose(body)),'max-tokens'),'non-stop','max-tokens'],
])test(`director diagnostics classify ${name} without exposing provider output or silently retrying`,async t=>{
  const f=fixture(t,{directorScript:options=>response(input(options))});await f.ready();const room=await newRoom(f,[whale],'具体原因','diagnostic-'+name);
  await roomSend(f,room,whale,'这是需要保留的用户原话。','original-user');const done=await settledRoom(f,room);
  assert.equal(f.calls.length,0);assert.equal(done.directorFailure.code,'invalid');assert.equal(done.directorFailure.reason,reason);
  assert.equal(done.directorFailure.finish,finish);assert.equal(done.room.turns[0].user,'这是需要保留的用户原话。');
  const diagnostic=(await f.request('diagnostics')).value.chatDirector;
  assert.equal(diagnostic.status,'failed');assert.equal(diagnostic.reason,reason);assert.equal(diagnostic.finish,finish);
  assert.doesNotMatch(JSON.stringify({done,diagnostic}),/PRIVATE_PROVIDER_WIRE-not-json|foreign-or-expired-choice|不要执行/);
  const before=f.requests.length;await flush();assert.equal(f.requests.length,before,'an invalid judge result never causes hidden repair calls');
});

test('a later unknown choice preserves the successful earlier answer and identifies only the paused continuation',async t=>{
  const f=fixture(t,{directorScript:(options,count)=>{const body=input(options);return jsonReply(count===1?choose(body):
    {context:context(body),choiceId:'unlisted-continuation',goal:'不采用这条。'});},script:()=>reply(['前面的完整回复仍然保留。'])});
  await f.ready();const room=await newRoom(f,[whale,dragon],'保留成功回复','partial-choice-failure');
  const before=await roomState(f,room);await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[],configRevision:before.room.configRevision,epoch:before.epoch});
  await roomSend(f,room,whale,'接着聊聊。','continued-user');const done=await settledRoom(f,room);
  assert.equal(f.calls.length,1);assert.equal(done.directorFailure.reason,'choice');
  assert.deepEqual(done.room.turns.filter(turn=>turn.phase!=='anchor').map(turn=>[turn.status,turn.assistant]),[['ready',['前面的完整回复仍然保留。']]]);
});
