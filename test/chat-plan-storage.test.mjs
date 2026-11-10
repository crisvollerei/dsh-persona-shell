import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaChat, CHAT_LIMITS } from '../lib/persona-chat.js';

const members=Array.from('abcdefgh',id=>({id,name:'角色'+id.toUpperCase()}));
const dialogue={version:1,addressed:Array.from('cdef',id=>({id,evidence:'大家都说说'})),voluntary:[{id:'g',to:'a'},{id:'h',to:'g'}]};
const attempts=group=>group.map(t=>({id:t.id,attemptId:t.attemptId}));
const groupOf=(chat,roomId)=>chat.read(roomId).turns;
async function fixture(options={},sendExtra={}){
  const chat=createPersonaChat(options),room=await chat.create({requestId:'room',name:'讨论',memberIds:members.map(p=>p.id),targetPersonaIds:['a','b']});
  const start=await chat.send({roomId:room.id,personaId:'a',name:'角色A',recipients:members.slice(0,2),requestId:'message',content:'大家都说说',revision:room.revision,...sendExtra});
  const planBody={roomId:room.id,messageId:'message',planId:'initial-plan',attempts:attempts(start.turns),dialogue,members,contextKey:start.turn.contextKey,scopeKey:start.turn.scopeKey};
  return{chat,room,start,planBody};
}
const finish=(chat,room,turn,status='ready',messages=[turn.recipientId+'的完整原话'])=>chat.finish({roomId:room.id,id:turn.id,attemptId:turn.attemptId,status,messages,failure:status==='ready'?null:'model'});
async function finishAll(chat,room,turns,failedId){for(const turn of turns)await finish(chat,room,turn,turn.recipientId===failedId?'failed':'ready');}
const continuationBody=(f,planId,responses)=>({roomId:f.room.id,messageId:'message',planId,attempts:attempts(groupOf(f.chat,f.room.id)),responses,members});
const replies=(evidence='b的完整原话')=>[{id:'a',to:'b',evidence},{id:'b',to:'a',evidence:'a的完整原话'}];
async function planned(options={},sendExtra={}){const f=await fixture(options,sendExtra);await f.chat.planRound(f.planBody);return f;}
async function completeInitial(options={}){const f=await planned(options);await finishAll(f.chat,f.room,groupOf(f.chat,f.room.id));return f;}
async function twelve(options={},finishLast=true){
  const f=await completeInitial(options);
  const first=await f.chat.appendContinuations(continuationBody(f,'continuation-1',replies()));await finishAll(f.chat,f.room,first.turns);
  const second=await f.chat.appendContinuations(continuationBody(f,'continuation-2',replies()));if(finishLast)await finishAll(f.chat,f.room,second.turns);
  return{...f,first,second};
}

test('a durable initial plan adds invited and voluntary seats without changing the original mentions',async()=>{
  const f=await fixture(),result=await f.chat.planRound(f.planBody),group=groupOf(f.chat,f.room.id);
  assert.equal(result.created,true);assert.deepEqual(group.map(t=>t.recipientId),members.map(p=>p.id));
  for(const turn of group)assert.deepEqual(turn.recipients,members.slice(0,2));
  assert.deepEqual(group[0].dialoguePlan,dialogue);assert.deepEqual(group[2].responsePlan,{kind:'invited',to:'user',evidence:'大家都说说'});
  assert.deepEqual(group[6].responsePlan,{kind:'contribute',to:'a'});assert.equal(group[6].speakerName,'角色G');
  const repeated=await f.chat.planRound(f.planBody);assert.equal(repeated.created,false);assert.equal(groupOf(f.chat,f.room.id).length,8);
  const forged=structuredClone(f.planBody);forged.planId='second-plan';forged.dialogue={version:1,addressed:[],voluntary:[]};
  assert.equal((await f.chat.planRound(forged)).created,false);assert.deepEqual(groupOf(f.chat,f.room.id)[0].dialoguePlan,dialogue);
});

test('two bounded continuation batches retain peer evidence, host names and twelve seats',async()=>{
  const f=await twelve(),group=groupOf(f.chat,f.room.id);
  assert.equal(group.length,12);assert.deepEqual(group[0].continuationPlanIds,['continuation-1','continuation-2']);
  assert.deepEqual(group.slice(-4).map(t=>t.phase),Array(4).fill('followup'));
  assert.deepEqual(group[8].responsePlan,{kind:'peer',to:'b',evidence:'b的完整原话'});assert.equal(group[8].speakerName,'角色A');
  assert.equal(group.filter(t=>t.recipientId==='a').length,3);assert.equal(group.filter(t=>t.recipientId==='b').length,3);
  const before=f.chat.snapshot();await assert.rejects(f.chat.appendContinuations(continuationBody(f,'continuation-3',replies())),/chat-conflict/);
  assert.deepEqual(f.chat.snapshot(),before);
});

test('lost continuation acknowledgements are idempotent, while altered or stale deliveries cannot append',async()=>{
  const f=await completeInitial(),body=continuationBody(f,'continuation-1',replies());
  const added=await f.chat.appendContinuations(body),before=f.chat.snapshot();
  assert.equal((await f.chat.appendContinuations(body)).created,false);assert.deepEqual(f.chat.snapshot(),before);
  await assert.rejects(f.chat.appendContinuations({...body,responses:[{...body.responses[0],evidence:'别的话'},body.responses[1]]}),/chat-conflict/);
  await finishAll(f.chat,f.room,added.turns);
  await assert.rejects(f.chat.appendContinuations({...body,planId:'late-new-plan'}),/chat-conflict/);
  const other=await f.chat.create({requestId:'other-room',name:'另一个房间',memberIds:['a','b'],targetPersonaIds:['a','b']});
  const otherStart=await f.chat.send({roomId:other.id,personaId:'a',name:'角色A',recipients:members.slice(0,2),requestId:'message',content:'大家都说说',revision:other.revision});
  await finishAll(f.chat,other,otherStart.turns);
  await assert.rejects(f.chat.appendContinuations({...body,roomId:other.id}),/chat-conflict/);assert.equal(f.chat.read(other.id).turns.length,2);
});

test('continuations require settled current attempts and another actual complete speaker bubble',async()=>{
  const f=await planned();await finish(f.chat,f.room,groupOf(f.chat,f.room.id)[0]);
  await assert.rejects(f.chat.appendContinuations(continuationBody(f,'pending',replies())),/chat-conflict/);
  await finishAll(f.chat,f.room,groupOf(f.chat,f.room.id).filter(t=>t.status==='pending'));
  for(const responses of [[{id:'a',to:'a',evidence:'a的完整原话'}],[{id:'a',to:'b',evidence:'其他房间的话'}],
    [{id:'outside',to:'b',evidence:'b的完整原话'}],[{id:'a',to:'b',evidence:'b的完整原话',name:'模型伪造名字'}],
    [replies()[0],replies()[0]],[...replies(),{id:'c',to:'b',evidence:'b的完整原话'}]]){
    await assert.rejects(f.chat.appendContinuations(continuationBody(f,'invalid',responses)),/invalid-chat-plan/);
  }
  const current=f.chat.read(f.room.id);await f.chat.update({roomId:f.room.id,revision:current.revision,memberIds:current.memberIds.filter(id=>id!=='h')});
  await assert.rejects(f.chat.appendContinuations(continuationBody(f,'removed',[{id:'h',to:'b',evidence:'b的完整原话'}])),/invalid-chat-plan/);
});

test('initial plans and continuation appends are invisible after failed or invalidated persistence',async()=>{
  let fail=false,retire=false,current=true,saved;
  const f=await fixture({persist:async value=>{if(fail)throw Error('disk');saved=value;if(retire){retire=false;current=false;}}});
  const initial=f.chat.snapshot();fail=true;await assert.rejects(f.chat.planRound(f.planBody),/disk/);assert.deepEqual(f.chat.snapshot(),initial);
  fail=false;await f.chat.planRound(f.planBody);await finishAll(f.chat,f.room,groupOf(f.chat,f.room.id));
  const before=f.chat.snapshot(),body=continuationBody(f,'save',replies());fail=true;await assert.rejects(f.chat.appendContinuations(body),/disk/);assert.deepEqual(f.chat.snapshot(),before);
  fail=false;retire=true;const result=await f.chat.appendContinuations({...body,valid:()=>current});
  assert.equal(result.created,false);assert.deepEqual(f.chat.snapshot(),before);assert.deepEqual(saved,before,'a validity change during save repairs the persisted snapshot');
});

test('a primary retry rebuilds every frozen extra after the failed position and retires old continuation seats',async()=>{
  const f=await planned();await finishAll(f.chat,f.room,groupOf(f.chat,f.room.id),'b');
  const previous=groupOf(f.chat,f.room.id),oldExtras=previous.slice(2),headBefore=structuredClone(previous[0]);
  const next=await f.chat.appendContinuations(continuationBody(f,'old-continuation',[{id:'a',to:'c',evidence:'c的完整原话'}]));await finishAll(f.chat,f.room,next.turns);
  const failed=previous[1],result=await f.chat.retry({roomId:f.room.id,personaId:'b',name:'角色B',id:failed.id,attemptId:'retry-b',
    revision:f.chat.read(f.room.id).revision,members:members.map(p=>p.id==='c'?{...p,name:'角色C新名称'}:p)});
  assert.deepEqual(result.turns.map(t=>t.recipientId),Array.from('bcdefgh'));
  assert.deepEqual(result.room.turns[0],headBefore,'the earlier ready primary and its original relationship stay intact');
  assert.deepEqual(result.room.turns[0].dialoguePlan,dialogue);assert.equal(result.room.turns[2].speakerName,'角色C新名称');
  assert.equal(result.room.turns.some(t=>t.phase==='followup'),false);assert.equal(result.room.turns[0].continuationPlanIds,undefined);
  assert.ok(result.turns.every(t=>t.status==='pending'));assert.ok(oldExtras.every(old=>!result.room.turns.some(t=>t.id===old.id)));
  assert.equal(await finish(f.chat,f.room,oldExtras[0]),false,'late replies from retired initial extras cannot settle the retry');
  assert.equal((await f.chat.planRound({...f.planBody,planId:'retry-replan',attempts:attempts(result.room.turns)})).created,false);
  assert.equal(groupOf(f.chat,f.room.id).length,8,'a Host plan replay cannot add the extras twice');
});

test('retry preserves independent invited replies that actually spoke before a delayed failed primary',async()=>{
  const f=await planned(),initial=groupOf(f.chat,f.room.id);
  for(const id of Array.from('cdefghab')){
    const turn=initial.find(t=>t.recipientId===id);assert.equal(await f.chat.startReply({roomId:f.room.id,id:turn.id,attemptId:turn.attemptId}),true);
    await finish(f.chat,f.room,turn,id==='b'?'failed':'ready');
  }
  const before=groupOf(f.chat,f.room.id),failed=before[1];assert.equal(before[0].emittedOrder,6);
  const result=await f.chat.retry({roomId:f.room.id,personaId:'b',name:'角色B',id:failed.id,attemptId:'delayed-b-retry',revision:f.chat.read(f.room.id).revision,members});
  assert.deepEqual(result.turns.map(t=>t.recipientId),['b'],'already completed independent extras are not charged or generated again');
  for(const previous of before.filter(t=>t.recipientId!=='b'))assert.deepEqual(result.room.turns.find(t=>t.id===previous.id),previous);
  const repeated=await f.chat.planRound({...f.planBody,planId:'replayed-plan',attempts:attempts(result.room.turns)});
  assert.equal(repeated.created,false);assert.deepEqual(repeated.turns.map(t=>t.recipientId),['b']);assert.equal(repeated.room.turns.length,8);
  assert.equal(await f.chat.startReply({roomId:f.room.id,id:failed.id,attemptId:'delayed-b-retry'}),true);await finish(f.chat,f.room,result.turns[0]);
  const added=await f.chat.appendContinuations(continuationBody(f,'after-delayed-retry',replies()));
  for(const turn of added.turns){assert.equal(await f.chat.startReply({roomId:f.room.id,id:turn.id,attemptId:turn.attemptId}),true);await finish(f.chat,f.room,turn);}
  const last=await f.chat.appendContinuations(continuationBody(f,'after-delayed-retry-2',replies()));
  for(const turn of last.turns){assert.equal(await f.chat.startReply({roomId:f.room.id,id:turn.id,attemptId:turn.attemptId}),true);await finish(f.chat,f.room,turn);}
  assert.deepEqual(groupOf(f.chat,f.room.id).map(t=>t.emittedOrder).sort((a,b)=>a-b),Array.from({length:12},(_,n)=>n));
});

test('retry keeps a failed canonical head and compacts sparse real order before appending new speech',async()=>{
  const userParts=[{id:'message',text:'大家都说说',at:1}],f=await planned({}, {userParts}),initial=groupOf(f.chat,f.room.id);
  for(const id of Array.from('cdefghba')){
    const turn=initial.find(t=>t.recipientId===id);await f.chat.startReply({roomId:f.room.id,id:turn.id,attemptId:turn.attemptId});await finish(f.chat,f.room,turn,id==='a'?'failed':'ready');
  }
  const raw=f.chat.snapshot();for(const turn of raw.rooms[0].turns)turn.emittedOrder+=2;
  const restored=createPersonaChat();restored.restore(raw);f.chat=restored;
  const old=groupOf(restored,f.room.id),head=old[0];assert.equal(head.emittedOrder,9);
  const retried=await restored.retry({roomId:f.room.id,personaId:'a',name:'角色A',id:head.id,attemptId:'retry-canonical-head',revision:restored.read(f.room.id).revision,members});
  assert.equal(retried.room.turns[0].id,'message');assert.deepEqual(retried.room.turns[0].userParts,userParts);assert.deepEqual(retried.room.turns[0].dialoguePlan,dialogue);
  assert.deepEqual(retried.turns.map(t=>t.recipientId),['a']);assert.equal(retried.turns[0].emittedOrder,undefined);
  const retained=retried.room.turns.filter(t=>t.status==='ready').sort((a,b)=>a.emittedOrder-b.emittedOrder);
  assert.deepEqual(retained.map(t=>t.recipientId),Array.from('cdefghb'));assert.deepEqual(retained.map(t=>t.emittedOrder),[0,1,2,3,4,5,6]);
  for(const turn of retained){const prior=old.find(t=>t.id===turn.id);assert.deepEqual(turn.assistant,prior.assistant);assert.equal(turn.speakerName,prior.speakerName);}
  assert.equal(await restored.startReply({roomId:f.room.id,id:head.id,attemptId:'retry-canonical-head'}),true);
  assert.equal(restored.read(f.room.id).turns[0].emittedOrder,7,'a stale high ordinal cannot exhaust the twelve-seat bound');
});

test('a confirmed scope retry keeps old public replies but plans and grounds new peers only in the current scope',async()=>{
  const f=await planned({}, {contextKey:'context-old',scopeKey:'scope-old'}),initial=groupOf(f.chat,f.room.id);
  for(const turn of initial){await f.chat.startReply({roomId:f.room.id,id:turn.id,attemptId:turn.attemptId});await finish(f.chat,f.room,turn,turn.recipientId==='b'?'failed':'ready');}
  const before=groupOf(f.chat,f.room.id),failed=before[1],result=await f.chat.retry({roomId:f.room.id,personaId:'b',name:'角色B',id:failed.id,attemptId:'new-scope-attempt',
    revision:f.chat.read(f.room.id).revision,contextKey:'context-new',scopeKey:'scope-new',previousContextKey:'context-old',members});
  assert.equal(result.room.turns[0].scopeKey,'scope-old');assert.equal(result.turns[0].scopeKey,'scope-new');
  const replanned=await f.chat.planRound({...f.planBody,attempts:attempts(result.room.turns),planId:'new-scope-plan',contextKey:'context-new',scopeKey:'scope-new'});
  assert.deepEqual(replanned.turns.map(t=>t.recipientId),Array.from('bcdefgh'));
  for(const turn of replanned.turns)await finish(f.chat,f.room,turn,'ready',[turn.recipientId+'的新范围原话']);
  const body=continuationBody(f,'new-scope-peer',[{id:'b',to:'a',evidence:'a的完整原话'}]);
  await assert.rejects(f.chat.appendContinuations({...body,contextKey:'context-new',scopeKey:'scope-new'}),/invalid-chat-plan/);
  const peer=await f.chat.appendContinuations({...body,responses:[{id:'a',to:'c',evidence:'c的新范围原话'}],contextKey:'context-new',scopeKey:'scope-new'});
  assert.equal(peer.created,true);assert.equal(peer.turns[0].scopeKey,'scope-new');assert.equal(f.chat.read(f.room.id).turns[0].scopeKey,'scope-old');
});

test('reaction retries preserve the original downstream sequence and restoration keeps interrupted seats',async()=>{
  const f=await planned();await finishAll(f.chat,f.room,groupOf(f.chat,f.room.id),'c');
  const first=await f.chat.appendContinuations(continuationBody(f,'continuation-1',[{id:'a',to:'d',evidence:'d的完整原话'},{id:'b',to:'d',evidence:'d的完整原话'}]));await finishAll(f.chat,f.room,first.turns);
  const second=await f.chat.appendContinuations(continuationBody(f,'continuation-2',replies()));await finishAll(f.chat,f.room,second.turns);
  const before=groupOf(f.chat,f.room.id),failed=before[2],result=await f.chat.retry({roomId:f.room.id,personaId:'c',name:'角色C',id:failed.id,attemptId:'retry-c',revision:f.chat.read(f.room.id).revision});
  assert.deepEqual(result.turns.map(t=>t.id),before.slice(2).map(t=>t.id));assert.deepEqual(result.room.turns.slice(0,2),before.slice(0,2));
  assert.deepEqual(result.room.turns[0].continuationPlanIds,['continuation-1','continuation-2']);assert.ok(result.turns.every(t=>t.status==='pending'));
  const restored=createPersonaChat();restored.restore(f.chat.snapshot());const restoredGroup=groupOf(restored,f.room.id);
  assert.equal(restoredGroup.length,12);assert.ok(restoredGroup.slice(2).every(t=>t.status==='interrupted'));
  assert.deepEqual(restoredGroup[8].responsePlan,{kind:'peer',to:'d',evidence:'d的完整原话'});
  assert.equal(await finish(f.chat,f.room,before[8]),false,'the retired continuation attempt cannot overwrite its pending retry');
});

test('a continuation retry keeps completed earlier replies and requeues only its existing tail',async()=>{
  const f=await twelve({},false),before=groupOf(f.chat,f.room.id),[failed,later]=f.second.turns;
  await finish(f.chat,f.room,failed,'failed');await finish(f.chat,f.room,later);
  const settled=groupOf(f.chat,f.room.id),result=await f.chat.retry({roomId:f.room.id,personaId:failed.recipientId,name:failed.speakerName,
    id:failed.id,attemptId:'retry-continuation',revision:f.chat.read(f.room.id).revision});
  assert.deepEqual(result.room.turns.slice(0,10),settled.slice(0,10));assert.deepEqual(result.turns.map(t=>t.id),before.slice(10).map(t=>t.id));
  assert.ok(result.turns.every(t=>t.status==='pending'));assert.deepEqual(result.turns.map(t=>t.responsePlan),before.slice(10).map(t=>t.responsePlan));
  assert.equal(await finish(f.chat,f.room,later),false);assert.deepEqual(result.room.turns[0].continuationPlanIds,['continuation-1','continuation-2']);
});

test('a failed retry save leaves the old queue, attempts and frozen plan intact',async()=>{
  let fail=false;const f=await planned({persist:async()=>{if(fail)throw Error('disk');}});await finishAll(f.chat,f.room,groupOf(f.chat,f.room.id),'b');
  const previous=f.chat.snapshot(),failed=groupOf(f.chat,f.room.id)[1];fail=true;
  await assert.rejects(f.chat.retry({roomId:f.room.id,personaId:'b',name:'角色B',id:failed.id,attemptId:'not-saved',revision:f.chat.read(f.room.id).revision}),/disk/);
  assert.deepEqual(f.chat.snapshot(),previous);
});

test('restore rejects ungrounded or duplicate peer seats rather than promoting malformed saved plans',async()=>{
  const f=await twelve(),raw=f.chat.snapshot();
  raw.rooms[0].turns[8].responsePlan.evidence='原话中不存在的内容';
  raw.rooms[0].turns[9].responsePlan.to='b';
  const restored=createPersonaChat();restored.restore(raw);
  assert.equal(groupOf(restored,f.room.id).some(t=>t.id===raw.rooms[0].turns[8].id),false);
  assert.equal(groupOf(restored,f.room.id).some(t=>t.id===raw.rooms[0].turns[9].id),false);
  const duplicate=f.chat.snapshot();duplicate.rooms[0].turns[9].recipientId='a';duplicate.rooms[0].turns[9].responsePlan={kind:'peer',to:'b',evidence:'b的完整原话'};
  const next=createPersonaChat();next.restore(duplicate);
  assert.equal(groupOf(next,f.room.id).filter(t=>t.continuationPlanId==='continuation-1'&&t.recipientId==='a').length,1);
  assert.ok(groupOf(next,f.room.id).length<=12);
});

test('restore retains forty complete twelve-seat groups and bounded continuation metadata',async()=>{
  const f=await twelve(),raw=f.chat.snapshot(),template=raw.rooms[0].turns;
  raw.rooms[0].turns=Array.from({length:41},(_,n)=>template.map(turn=>({...structuredClone(turn),id:n+':'+turn.id,attemptId:n+':'+turn.attemptId,messageId:'message-'+n}))).flat();
  const restored=createPersonaChat();restored.restore(raw);const group=groupOf(restored,f.room.id);
  assert.equal(new Set(group.map(t=>t.messageId)).size,40);assert.equal(group.length,480);assert.equal(group[0].messageId,'message-1');
  assert.deepEqual(group[0].dialoguePlan,dialogue);assert.deepEqual(group.at(-4).responsePlan,{kind:'peer',to:'b',evidence:'b的完整原话'});
  const again=createPersonaChat();again.restore(restored.snapshot());assert.deepEqual(again.snapshot(),restored.snapshot());
});

test('a twelve-attempt stop cancels only pending seats of that room and retires late results',async()=>{
  const f=await twelve({},false),group=groupOf(f.chat,f.room.id),other=await f.chat.create({requestId:'other',name:'另一个',memberIds:['a'],targetPersonaIds:['a']});
  const otherStart=await f.chat.send({roomId:other.id,personaId:'a',name:'角色A',requestId:'separate',content:'另一条',revision:other.revision});
  assert.equal(await f.chat.cancel({roomId:f.room.id,id:group[0].id,attemptId:group[0].attemptId,messageId:'message',attempts:attempts(group)}),true);
  assert.ok(groupOf(f.chat,f.room.id).slice(-2).every(t=>t.status==='cancelled'));assert.equal(f.chat.read(other.id).turns[0].status,'pending');
  assert.equal(await finish(f.chat,f.room,f.second.turns[0]),false);assert.equal(await finish(f.chat,other,otherStart.turn),true);
});

test('buffered user parts remain exact, head-owned and idempotent through planning, retry and restore',async()=>{
  const chat=createPersonaChat(),room=await chat.create({requestId:'parts-room',name:'分段',memberIds:members.map(p=>p.id),targetPersonaIds:['a','b']});
  const parts=[{id:'part-one',text:'大家都说说',at:10},{id:'part-two',text:'这只是补充，暂不执行。',at:12}];
  const body={roomId:room.id,personaId:'a',name:'角色A',recipients:members.slice(0,2),requestId:parts[0].id,userParts:parts,content:parts.map(p=>p.text).join('\n'),revision:room.revision};
  const start=await chat.send(body);assert.deepEqual(start.turn.userParts,parts);assert.equal(start.turns[1].userParts,undefined);
  assert.equal((await chat.send(body)).created,false);await assert.rejects(chat.send({...body,userParts:[{id:parts[0].id,text:body.content,at:10}]}),/chat-id-conflict/);
  const plan=await chat.planRound({roomId:room.id,messageId:parts[0].id,planId:'parts-plan',attempts:attempts(start.turns),dialogue,members});
  assert.ok(plan.turns.slice(1).every(t=>t.userParts===undefined));await finishAll(chat,room,groupOf(chat,room.id),'b');
  const failed=groupOf(chat,room.id)[1];const retried=await chat.retry({roomId:room.id,personaId:'b',name:'角色B',id:failed.id,attemptId:'parts-retry',revision:chat.read(room.id).revision});
  assert.deepEqual(retried.room.turns[0].userParts,parts);assert.equal(retried.room.turns[0].user,body.content);
  const restored=createPersonaChat();restored.restore(chat.snapshot());assert.deepEqual(restored.read(room.id).turns[0].userParts,parts);
});

test('invalid parts and reused part ids cannot create a different quoted source',async()=>{
  const chat=createPersonaChat(),room=await chat.create({requestId:'invalid-parts-room',name:'分段',memberIds:['a'],targetPersonaIds:['a']});
  const body={roomId:room.id,personaId:'a',name:'角色A',requestId:'first',content:'第一段\n第二段',revision:room.revision};
  const good=[{id:'first',text:'第一段',at:1},{id:'second',text:'第二段',at:2}];
  for(const userParts of [[],good.slice(1),[good[0],{...good[1],id:'first'}],[good[0],{...good[1],at:-1}],
    [good[0],{...good[1],at:1.5}],[good[0],{...good[1],text:'被改过的正文'}],[good[0],{...good[1],text:' '}],
    Array.from({length:9},(_,n)=>({id:n?'p'+n:'first',text:'段',at:n}))]){
    await assert.rejects(chat.send({...body,userParts}),/invalid-chat-message/);assert.equal(chat.read(room.id).turns.length,0);
  }
  const start=await chat.send({...body,userParts:good});await finish(chat,room,start.turn);
  await assert.rejects(chat.send({...body,requestId:'second',content:'不能复用旧分段id',revision:chat.read(room.id).revision}),/chat-id-conflict/);
  const raw=chat.snapshot();raw.rooms[0].turns[0].userParts[1].text='伪造分段正文';
  const restored=createPersonaChat();restored.restore(raw);assert.equal(restored.read(room.id).turns[0].userParts,undefined);
  assert.equal(restored.read(room.id).turns[0].user,body.content,'invalid segmented metadata never replaces the original merged words');
});

test('a buffered round keeps its recipients and roster even after next-message controls change',async()=>{
  const chat=createPersonaChat(),room=await chat.create({requestId:'frozen-room',name:'冻结选择',memberIds:['a','b','c'],targetPersonaIds:['a']});
  const updated=await chat.update({roomId:room.id,revision:room.revision,targetPersonaIds:['b'],memberIds:['a','b','d']});
  const body={roomId:room.id,personaId:'a',name:'角色A',recipients:[members[0]],requestId:'frozen-message',content:'大家都说说',revision:updated.revision,frozenMemberIds:['a','b','c']};
  await assert.rejects(chat.send(body),/chat-conflict/);
  const start=await chat.send({...body,frozenRecipients:true});assert.deepEqual(start.turn.recipients,[members[0]]);assert.deepEqual(start.turn.memberIdsAtSend,['a','b','c']);
  const plan=await chat.planRound({roomId:room.id,messageId:body.requestId,planId:'frozen-plan',attempts:attempts(start.turns),members,
    dialogue:{version:1,addressed:[{id:'c',evidence:'大家都说说'}],voluntary:[]}});
  assert.equal(plan.room.turns.length,1,'a removed frozen member is skipped and a new member cannot enter an old round');
  assert.deepEqual(plan.room.turns[0].dialoguePlan.addressed,[{id:'c',evidence:'大家都说说'}],'removal does not rewrite the frozen invitation');
});
