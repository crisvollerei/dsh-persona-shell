import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaChat } from '../lib/persona-chat.js';

const members=[{id:'a',name:'甲'},{id:'b',name:'乙'},{id:'c',name:'丙'}];
const userRef=(room,messageId='message')=>({roomId:room.id,generation:room.generation??0,kind:'user',messageId});
const assistantRef=(room,turn,index=0)=>({roomId:room.id,generation:room.generation??0,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index});
async function setup(options={}){
  const chat=createPersonaChat(options),created=await chat.create({requestId:'room',name:'精确回应',memberIds:members.map(p=>p.id),targetPersonaIds:[]});
  const sent=await chat.send({directed:true,roomId:created.id,recipients:[],requestId:'message',content:'第一条原话\n第二条原话',
    userParts:[{id:'message',text:'第一条原话',at:0},{id:'part-two',text:'第二条原话',at:1}],revision:created.revision,contextKey:'context',scopeKey:'scope'});
  return{chat,room:sent.room};
}
const append=(f,planId,actor,responsePlan,extra={})=>f.chat.appendDirectedReply({roomId:f.room.id,messageId:'message',planId,actor,members,
  epoch:f.chat.epoch(),contextKey:'context',scopeKey:'scope',responsePlan,...extra});
const finish=(f,result,status='ready',messages=['重复原话','重复原话'])=>f.chat.finish({roomId:f.room.id,id:result.turn.id,attemptId:result.turn.attemptId,status,
  messages,failure:status==='failed'?'network':null});
async function repeatedSources(){
  const f=await setup(),a1=await append(f,'a1',members[0],{kind:'normal',to:'user',evidence:'第二条原话',sourceRef:userRef(f.room,'part-two')});
  await finish(f,a1);const a2=await append(f,'a2',members[0],{kind:'normal',to:'user',evidence:'第一条原话',sourceRef:userRef(f.room)});
  await finish(f,a2);return{...f,a1,a2};
}

test('an exact sourceRef preserves the actual user part and one of several identical same-author bubbles through storage and restore',async()=>{
  const f=await repeatedSources(),sourceRef=assistantRef(f.room,f.a1.turn,0),plan={kind:'normal',to:'a',evidence:'重复原话',sourceRef};
  const b=await append(f,'b',members[1],plan);await finish(f,b,'ready',['乙接的是甲第一轮第一泡。']);
  assert.deepEqual(f.chat.read(f.room.id).turns[1].responsePlan.sourceRef,userRef(f.room,'part-two'));
  assert.deepEqual(b.turn.responsePlan,plan);assert.deepEqual(f.chat.read(f.room.id).turns.at(-1).responsePlan.sourceRef,sourceRef);
  sourceRef.index=1;assert.equal(f.chat.read(f.room.id).turns.at(-1).responsePlan.sourceRef.index,0,'caller mutations cannot change the persisted target');
  const restored=createPersonaChat();restored.restore(f.chat.snapshot());assert.deepEqual(restored.read(f.room.id),f.chat.read(f.room.id));
  assert.equal(restored.read(f.room.id).turns.at(-1).responsePlan.sourceRef.turnId,f.a1.turn.id,'the later identical reply is never substituted');
});

test('a provided sourceRef is authority, so a wrong room, generation, author, attempt, bubble or original text is rejected without same-text fallback',async()=>{
  const f=await repeatedSources(),ref=assistantRef(f.room,f.a1.turn),before=f.chat.snapshot();
  for(const [index,sourceRef] of [{...ref,roomId:'other-room'},{...ref,generation:1},{...ref,attemptId:'stale-attempt'},
    {...ref,index:2},{...ref,turnId:'not-in-this-room'},{...ref,text:'UNTRUSTED_TEXT'},
    Object.fromEntries(Object.entries(ref).filter(([key])=>key!=='generation')),userRef(f.room)].entries()){
    await assert.rejects(append(f,'bad-'+index,members[1],{kind:'normal',to:'a',evidence:'重复原话',sourceRef}),/invalid-chat-plan/);
  }
  await assert.rejects(append(f,'wrong-author',members[2],{kind:'normal',to:'b',evidence:'重复原话',sourceRef:ref}),/invalid-chat-plan/);
  await assert.rejects(append(f,'wrong-text',members[1],{kind:'normal',to:'a',evidence:'没有说过',sourceRef:ref}),/invalid-chat-plan/);
  assert.deepEqual(f.chat.snapshot(),before,'invalid provenance never creates a partial seat');
});

test('the exact user part must contain the evidence instead of borrowing matching text from another part',async()=>{
  const f=await setup(),plan={kind:'normal',to:'user',evidence:'第二条原话',sourceRef:userRef(f.room)};
  await assert.rejects(append(f,'wrong-part',members[0],plan),/invalid-chat-plan/);
  const valid=await append(f,'right-part',members[0],{...plan,sourceRef:userRef(f.room,'part-two')});
  assert.equal(valid.turn.responsePlan.sourceRef.messageId,'part-two');
});

test('restore rejects a stale exact ref instead of rebinding its identical quote to another actual ready turn',async()=>{
  const f=await repeatedSources(),b=await append(f,'b',members[1],{kind:'normal',to:'a',evidence:'重复原话',sourceRef:assistantRef(f.room,f.a1.turn)});
  await finish(f,b);const original=f.chat.snapshot(),restored=createPersonaChat();
  for(const change of ['attempt','scope','future','author']){
    const raw=structuredClone(original),turns=raw.rooms[0].turns,target=turns.find(turn=>turn.id===b.turn.id);
    if(change==='attempt')target.responsePlan.sourceRef.attemptId='invalidated';
    if(change==='scope')turns.find(turn=>turn.id===f.a1.turn.id).scopeKey='other-scope';
    if(change==='future')target.responsePlan.sourceRef=assistantRef(f.room,target);
    if(change==='author')target.responsePlan.to='c';
    restored.restore(raw);assert.equal(restored.read(f.room.id).turns.some(turn=>turn.id===b.turn.id),false,change);
  }
});

test('retry keeps the same exact source while an invalidated source attempt cannot be rescued by a matching later quote',async()=>{
  const f=await repeatedSources(),sourceRef=assistantRef(f.room,f.a1.turn,1),b=await append(f,'b',members[1],{kind:'normal',to:'a',evidence:'重复原话',sourceRef});
  await finish(f,b,'failed',[]);const current=f.chat.read(f.room.id),retry=await f.chat.retry({roomId:f.room.id,personaId:'b',name:'乙',id:b.turn.id,
    attemptId:'retry-b',revision:current.revision,epoch:f.chat.epoch(),scopeKey:'scope',contextKey:'context'});
  assert.deepEqual(retry.turn.responsePlan.sourceRef,sourceRef);await finish(f,retry);
  const raw=f.chat.snapshot();raw.rooms[0].turns.find(turn=>turn.id===f.a1.turn.id).attemptId='source-retried';
  const restored=createPersonaChat();restored.restore(raw);assert.equal(restored.read(f.room.id).turns.some(turn=>turn.id===b.turn.id),false);
});

test('records without an exact sourceRef retain their bounded old plan and never acquire a guessed proof while restoring',async()=>{
  const f=await repeatedSources(),b=await append(f,'legacy-b',members[1],{kind:'normal',to:'a',evidence:'重复原话'});await finish(f,b);
  const restored=createPersonaChat();restored.restore(f.chat.snapshot());
  assert.deepEqual(restored.read(f.room.id).turns.at(-1).responsePlan,{kind:'normal',to:'a',evidence:'重复原话'});
});

test('a confirmed cross-scope retry retains the exact original user part without importing old-scope peer evidence',async()=>{
  const f=await repeatedSources(),sourceRef=userRef(f.room,'part-two'),failed=await append(f,'retry-user',members[1],
    {kind:'normal',to:'user',evidence:'第二条原话',sourceRef});
  await finish(f,failed,'failed',[]);let room=f.chat.read(f.room.id);
  const body={roomId:f.room.id,personaId:'b',name:'乙',id:failed.turn.id,attemptId:'new-scope-user',revision:room.revision,
    epoch:f.chat.epoch(),contextKey:'new-context',scopeKey:'new-scope'};
  await assert.rejects(f.chat.retry(body),/chat-context-changed/);
  const retried=await f.chat.retry({...body,previousContextKey:'context'});
  assert.deepEqual(retried.turn.responsePlan.sourceRef,sourceRef);assert.equal(retried.turn.scopeKey,'new-scope');
  assert.deepEqual(retried.room.turns[0].userParts,[{id:'message',text:'第一条原话',at:0},{id:'part-two',text:'第二条原话',at:1}]);
  await finish(f,retried,'ready',['新工作范围里回答相同用户输入。']);
  const restored=createPersonaChat();restored.restore(f.chat.snapshot());assert.deepEqual(restored.read(f.room.id),f.chat.read(f.room.id));

  const g=await repeatedSources(),peer=await append(g,'retry-peer',members[1],{kind:'normal',to:'a',evidence:'重复原话',sourceRef:assistantRef(g.room,g.a1.turn)});
  await finish(g,peer,'failed',[]);room=g.chat.read(g.room.id);
  await assert.rejects(g.chat.retry({roomId:g.room.id,personaId:'b',name:'乙',id:peer.turn.id,attemptId:'new-scope-peer',revision:room.revision,
    epoch:g.chat.epoch(),contextKey:'new-context',scopeKey:'new-scope',previousContextKey:'context'}),/chat-retry-unavailable/);
  assert.equal(g.chat.read(g.room.id).turns.at(-1).attemptId,peer.turn.attemptId,'confirmation never moves an old peer quotation into the new work scope');
});
