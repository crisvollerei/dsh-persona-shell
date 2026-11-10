import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaChat, CHAT_LIMITS, primaryChatTurn } from '../lib/persona-chat.js';
import { resolveChatQuote } from '../lib/chat-quote.js';

const members=[{id:'a',name:'甲'},{id:'b',name:'乙'},{id:'c',name:'丙'}];
const setup=async(options={})=>{const chat=createPersonaChat(options),room=await chat.create({requestId:'room',name:'线性讨论',memberIds:members.map(p=>p.id),targetPersonaIds:[]});
  const sent=await chat.send({directed:true,roomId:room.id,personaId:'a',name:'甲',recipients:[],requestId:'message',content:'大家一起聊聊',revision:room.revision,scopeKey:'scope',contextKey:'context'});
  return{chat,room:sent.room,anchor:sent.turn};};
const append=(chat,room,planId,actor=members[0],responsePlan={kind:'normal',to:'user'},extra={})=>chat.appendDirectedReply({roomId:room.id,messageId:'message',planId,actor,responsePlan,members,epoch:chat.epoch(),scopeKey:'scope',contextKey:'context',...extra});
const finish=(chat,result,status='ready',messages=['这是一句原话。'])=>chat.finish({roomId:result.room.id,id:result.turn.id,attemptId:result.turn.attemptId,status,messages,failure:status==='failed'?'network':null});

test('room addressees permit zero through eight ordered selections without inventing a default',async()=>{
  const chat=createPersonaChat(),ids=Array.from({length:8},(_,i)=>'person-'+i),room=await chat.create({requestId:'room',name:'房间',memberIds:ids,targetPersonaIds:[]});
  assert.equal(room.targetPersonaId,null);assert.deepEqual(room.targetPersonaIds,[]);
  const selected=await chat.update({roomId:room.id,configRevision:0,epoch:0,targetPersonaIds:ids.toReversed()});
  assert.deepEqual(selected.targetPersonaIds,ids.toReversed());assert.equal(selected.targetPersonaId,ids.at(-1));
  const cleared=await chat.update({roomId:room.id,configRevision:1,epoch:0,targetPersonaIds:[]});assert.equal(cleared.targetPersonaId,null);
  const restored=createPersonaChat();restored.restore(chat.snapshot());assert.deepEqual(restored.read(room.id),cleared);
});

test('a directed send stores a user-only anchor and exact parts without a fictional assistant or contact',async()=>{
  const {chat,room,anchor}=await setup();assert.equal(anchor.phase,'anchor');assert.equal(anchor.status,'ready');assert.equal(anchor.recipientId,'user');
  assert.deepEqual(anchor.assistant,[]);assert.deepEqual(anchor.recipients,[]);assert.equal(primaryChatTurn(anchor),false);assert.deepEqual(chat.contacts(),[]);
  assert.equal(resolveChatQuote(room,{roomId:room.id,generation:0,kind:'user',messageId:'message'},'scope').text,'大家一起聊聊');
  assert.equal(resolveChatQuote(room,{roomId:room.id,generation:0,kind:'assistant',turnId:anchor.id,attemptId:anchor.attemptId,index:0},'scope'),null);
  const repeated=await chat.send({directed:true,roomId:room.id,recipients:[],requestId:'message',content:'大家一起聊聊',revision:0,scopeKey:'scope',contextKey:'context'});
  assert.equal(repeated.created,false);assert.equal(chat.read(room.id).turns.length,1);
  const restored=createPersonaChat();restored.restore(chat.snapshot());assert.deepEqual(restored.read(room.id),chat.read(room.id));
});

test('directed appends are durable, plan-idempotent and cannot overlap a pending seat',async()=>{
  const {chat,room}=await setup(),first=await append(chat,room,'plan-a');assert.equal(first.created,true);assert.equal(first.turn.phase,'reaction');assert.equal(first.turn.emittedOrder,undefined);
  assert.equal((await append(chat,room,'plan-a')).created,false);
  await assert.rejects(append(chat,room,'plan-a',members[1]),/conflict/);
  await assert.rejects(append(chat,room,'renamed',{id:'b',name:'冒名'}),/conflict/);
  await assert.rejects(append(chat,room,'plan-b',members[1]),/conflict/);
  await chat.startReply({roomId:room.id,id:first.turn.id,attemptId:first.turn.attemptId});await finish(chat,first);
  await assert.rejects(append(chat,room,'bad-attempt',members[1],undefined,{attempts:[]}),/conflict/);
  await assert.rejects(append(chat,room,'bad-scope',members[1],undefined,{scopeKey:'other'}),/conflict/);
  const second=await append(chat,room,'plan-b',members[1],undefined,{attempts:chat.liveGroup(room.id,'message')});assert.equal(second.created,true);
});

test('peer appends require another ready speaker and literal evidence within the current reference scope',async()=>{
  const {chat,room}=await setup(),first=await append(chat,room,'plan-a');await finish(chat,first,'ready',['先保留原话，再讨论布局。']);
  const peer={kind:'peer',to:'a',evidence:'保留原话'};
  await assert.rejects(append(chat,room,'self',members[0],peer),/invalid-chat-plan/);
  await assert.rejects(append(chat,room,'invented',members[1],{...peer,evidence:'没有说过的话'}),/invalid-chat-plan/);
  await assert.rejects(append(chat,room,'not-ready',members[1],{...peer,to:'c'}),/invalid-chat-plan/);
  const reply=await append(chat,room,'peer-b',members[1],peer);assert.equal(reply.turn.phase,'followup');await finish(chat,reply);
  const normalPeer=await append(chat,room,'normal-c-peer',members[2],{...peer,kind:'normal'});assert.equal(normalPeer.turn.phase,'reaction');
  assert.deepEqual(normalPeer.turn.responsePlan,{kind:'normal',to:'a',evidence:'保留原话'});await finish(chat,normalPeer);
  const again=await append(chat,room,'normal-a-again');assert.equal(again.created,true);await finish(chat,again);
  const restored=createPersonaChat();restored.restore(chat.snapshot());assert.deepEqual(restored.read(room.id),chat.read(room.id));
});

test('directed actors belong to both the frozen send roster and current room membership',async()=>{
  const {chat,room}=await setup();await chat.update({roomId:room.id,configRevision:0,epoch:0,memberIds:['a','b','new']});
  await assert.rejects(append(chat,room,'removed',members[2]),/conflict/);
  await assert.rejects(append(chat,room,'new',{id:'new',name:'新成员'},undefined,{members:[...members,{id:'new',name:'新成员'}]}),/conflict/);
  const current=await append(chat,room,'stays',members[1]);assert.equal(current.turn.recipientId,'b');
});

test('a directed cycle retains thirty-two actual reply seats plus its separate user anchor',async()=>{
  const {chat,room}=await setup();assert.equal(CHAT_LIMITS.roundReplies,32);
  for(let i=0;i<32;i++){const result=await append(chat,room,'plan-'+i,members[i%members.length]);assert.equal(await chat.startReply({roomId:room.id,id:result.turn.id,attemptId:result.turn.attemptId}),true);await finish(chat,result);}
  const turns=chat.read(room.id).turns;assert.equal(turns.length,33);assert.deepEqual(turns.slice(1).map(turn=>turn.emittedOrder),Array.from({length:32},(_,i)=>i));
  await assert.rejects(append(chat,room,'overflow'),/conflict/);
  const restored=createPersonaChat();restored.restore(chat.snapshot());assert.deepEqual(restored.read(room.id),chat.read(room.id));
});

test('directed retry replaces only the failed seat and preserves every later successful reply and ordering',async()=>{
  const {chat,room}=await setup(),first=await append(chat,room,'a');await chat.startReply({roomId:room.id,id:first.turn.id,attemptId:first.turn.attemptId});await finish(chat,first,'failed');
  const second=await append(chat,room,'b',members[1]);await chat.startReply({roomId:room.id,id:second.turn.id,attemptId:second.turn.attemptId});await finish(chat,second);
  const before=chat.read(room.id),retried=await chat.retry({roomId:room.id,personaId:'a',name:'甲',id:first.turn.id,attemptId:'retry-a',revision:before.revision,epoch:0,scopeKey:'scope',contextKey:'context'});
  assert.equal(retried.turns.length,1);assert.equal(retried.turn.emittedOrder,0);assert.deepEqual(retried.room.turns.find(turn=>turn.id===second.turn.id),before.turns.find(turn=>turn.id===second.turn.id));
  assert.equal(await finish(chat,first),false);assert.equal(await chat.startReply({roomId:room.id,id:first.turn.id,attemptId:'retry-a'}),true);await finish(chat,retried);
  assert.equal((await chat.retry({roomId:room.id,personaId:'a',name:'甲',id:first.turn.id,attemptId:'retry-a',revision:0,epoch:0,scopeKey:'scope',contextKey:'context'})).created,false);
});

test('invalidated saves roll back a directed append and old clears retire late completion',async()=>{
  let block=false,valid=true,lastSaved;const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const {chat,room}=await setup({persist:async value=>{if(block){block=false;entered.resolve();await release.promise;}lastSaved=structuredClone(value);}});
  block=true;const saving=append(chat,room,'slow',members[0],undefined,{valid:()=>valid});await entered.promise;valid=false;release.resolve();
  assert.equal((await saving).created,false);assert.equal(chat.read(room.id).turns.length,1);assert.equal(lastSaved.rooms[0].turns.length,1);
  const pending=await append(chat,room,'next');await chat.clear({roomId:room.id,revision:chat.read(room.id).revision,epoch:0});assert.equal(await finish(chat,pending),false);
  await assert.rejects(append(chat,room,'stale',members[0],undefined,{epoch:0}),/conflict/);
});

test('current local legacy history remains intact beside a new directed user anchor after restore',async()=>{
  const chat=createPersonaChat(),room=await chat.create({requestId:'room',name:'混合历史',memberIds:['a','b'],targetPersonaIds:['a']});
  const legacy=await chat.send({roomId:room.id,personaId:'a',name:'甲',requestId:'old',content:'旧原话',revision:0});await finish(chat,legacy);
  const directed=await chat.send({directed:true,roomId:room.id,recipients:[members[0]],requestId:'new',content:'新原话',revision:chat.read(room.id).revision});
  assert.equal(directed.turn.phase,'anchor');const restored=createPersonaChat();restored.restore(chat.snapshot());assert.deepEqual(restored.read(room.id),chat.read(room.id));
});

test('restoration never turns a damaged user anchor or invented peer plan into usable conversation evidence',async()=>{
  const {chat,room}=await setup(),first=await append(chat,room,'a');await finish(chat,first);
  const valid=chat.snapshot(),missingParts=structuredClone(valid);delete missingParts.rooms[0].turns[0].userParts;
  const restored=createPersonaChat();restored.restore(missingParts);assert.equal(restored.read(room.id).turns.length,0);
  const invented=structuredClone(valid);invented.rooms[0].turns[1].responsePlan={kind:'peer',to:'b',evidence:'虚构的原话'};
  restored.restore(invented);assert.equal(restored.read(room.id).turns.length,1);assert.equal(restored.read(room.id).turns[0].phase,'anchor');
  const duplicate=structuredClone(valid);duplicate.rooms[0].turns.push({...duplicate.rooms[0].turns[1],id:'duplicate',attemptId:'duplicate'});
  restored.restore(duplicate);assert.equal(restored.read(room.id).turns.length,2,'the same directed plan cannot be restored twice');
});
