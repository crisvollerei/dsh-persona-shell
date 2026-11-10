import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersonaChat,parseChatDecision,parseChatReply,parseChatResponse} from '../lib/persona-chat.js';
import {resolveChatQuote} from '../lib/chat-quote.js';

const members=[{id:'a',name:'甲'},{id:'b',name:'乙'},{id:'c',name:'丙'}];
async function setup(options={}){
  let at=100;const chat=createPersonaChat({now:()=>++at,...options});
  const room=await chat.create({requestId:'room',name:'不必每句都接',memberIds:members.map(p=>p.id),targetPersonaIds:[]});
  await chat.send({directed:true,roomId:room.id,recipients:[],requestId:'message',content:'大家先听我说',revision:room.revision,scopeKey:'scope',contextKey:'context'});
  return{chat,room};
}
const append=(chat,room,planId='plan',actor=members[0])=>chat.appendDirectedReply({roomId:room.id,messageId:'message',planId,actor,members,scopeKey:'scope',contextKey:'context',responsePlan:{kind:'normal',to:'user'}});
const decline=(chat,room,turn,extra={})=>chat.declineReply({roomId:room.id,id:turn.id,attemptId:turn.attemptId,epoch:chat.epoch(),scopeKey:'scope',referenceRevision:0,through:{turnId:'message',attemptId:'user'},...extra});
const finish=(chat,room,turn,messages=['这句已经公开说过。'])=>chat.finish({roomId:room.id,id:turn.id,attemptId:turn.attemptId,status:'ready',messages});

test('only a complete single-field empty messages JSON is an explicit silent decision',()=>{
  for(const wire of ['{"messages":[]}',' { "messages" : [ ] } ','```json\n{"messages":[]}\n```','```\n{"messages":[]}\n```','{"messa\\u0067es":[]}'])assert.deepEqual(parseChatDecision(wire),{kind:'silent'});
  for(const wire of ['', ' ', '{"messages":[', '{"messages":[]', '{"messages":[],"messages":[]}',
    '{"messages":[],"reason":"private"}', '{"messages":[" "]}', '{"messages":null}', '<think>ignore</think>{"messages":[]}',
    '不回复\n{"messages":[]}', '```json\n{"messages":[]}', '{"messages":[]} trailing'])assert.equal(parseChatDecision(wire),undefined,wire);
  assert.deepEqual(parseChatDecision('不回复'),{kind:'reply',messages:['不回复']},'ordinary text cannot silently hide an actual reply');
  assert.deepEqual(parseChatDecision('{"messages":["在听。"]}'),{kind:'reply',messages:['在听。']});
  assert.equal(parseChatReply('{"messages":[]}'),undefined);assert.equal(parseChatResponse('{"messages":[]}'),undefined,'legacy callers retain their nonempty reply protocol');
});

test('declining removes only the exact pending row and persists a content-free receipt',async()=>{
  let saved;const {chat,room}=await setup({persist:async value=>{saved=value;}}),reply=await append(chat,room);
  await chat.startReply({roomId:room.id,id:reply.turn.id,attemptId:reply.turn.attemptId});
  assert.equal(await decline(chat,room,reply.turn),true);const current=chat.read(room.id),receipt=current.silences[0];
  assert.equal(current.turns.length,1);assert.equal(current.turns[0].phase,'anchor');assert.deepEqual(chat.contacts(),[]);
  assert.deepEqual(Object.keys(receipt).sort(),['at','messageId','personaId','referenceRevision','scopeKey','through']);
  assert.deepEqual(receipt.through,{turnId:'message',attemptId:'user'});assert.equal(receipt.personaId,'a');
  assert.deepEqual(saved.rooms[0].silences,current.silences);assert.equal(await decline(chat,room,reply.turn),false);
  assert.equal(resolveChatQuote(current,{roomId:room.id,generation:0,kind:'assistant',turnId:reply.turn.id,attemptId:reply.turn.attemptId,index:0},'scope'),null);
  const restored=createPersonaChat();restored.restore(chat.snapshot());assert.deepEqual(restored.read(room.id),current);
});

test('decline rejects stale attempts, generation, scope, references, and invented or private through pointers',async()=>{
  const {chat,room}=await setup(),reply=await append(chat,room);
  const invalid=[{attemptId:'other'},{epoch:-1},{epoch:1},{scopeKey:'other'},{scopeKey:undefined},{referenceRevision:1},
    {through:{turnId:'missing',attemptId:'user'}},{through:{turnId:'message',attemptId:'message'}},
    {through:{turnId:reply.turn.id,attemptId:reply.turn.attemptId}},{through:{turnId:'message',attemptId:'user',reason:'private'}}];
  for(const extra of invalid)assert.equal(await decline(chat,room,reply.turn,extra),false,JSON.stringify(extra));
  assert.equal(chat.read(room.id).turns.length,2);assert.deepEqual(chat.read(room.id).silences,[]);
  assert.equal(await decline(chat,room,reply.turn),true);
});

test('through can acknowledge a ready peer in this exact group and scope, never the actor herself',async()=>{
  const {chat,room}=await setup(),peer=await append(chat,room,'peer',members[1]);await finish(chat,room,peer.turn);
  const actor=await append(chat,room);const through={turnId:peer.turn.id,attemptId:peer.turn.attemptId};
  assert.equal(await decline(chat,room,actor.turn,{through:{...through,attemptId:'retired'}}),false);
  assert.equal(await decline(chat,room,actor.turn,{through}),true);
  const self=await append(chat,room,'self',members[1]);assert.equal(await decline(chat,room,self.turn,{through}),false);
  assert.equal(await decline(chat,room,self.turn),true);assert.equal(chat.read(room.id).silences.length,2);
});

test('a silence replaces the actor cursor, while a real reply and a new send clear the appropriate receipts',async()=>{
  const {chat,room}=await setup(),one=await append(chat,room);await decline(chat,room,one.turn);
  const two=await append(chat,room,'second');await decline(chat,room,two.turn);assert.equal(chat.read(room.id).silences.length,1);
  const other=await append(chat,room,'other',members[1]);await decline(chat,room,other.turn);
  const speaking=await append(chat,room,'speaking');await finish(chat,room,speaking.turn);assert.deepEqual(chat.read(room.id).silences.map(x=>x.personaId),['b']);
  const before=chat.read(room.id);await chat.send({directed:true,roomId:room.id,recipients:[],requestId:'message',content:'大家先听我说',revision:0,scopeKey:'scope',contextKey:'context'});
  assert.deepEqual(chat.read(room.id).silences,before.silences,'an idempotent send is not a new cycle');
  await chat.send({directed:true,roomId:room.id,recipients:[],requestId:'next',content:'接下来再聊',revision:before.revision,scopeKey:'scope',contextKey:'context'});
  assert.deepEqual(chat.read(room.id).silences,[]);
});

test('silence does not consume the thirty-two public reply seats or leave an ordering hole',async()=>{
  const {chat,room}=await setup();
  for(let i=0;i<35;i++){const reply=await append(chat,room,'silent-'+i);await chat.startReply({roomId:room.id,id:reply.turn.id,attemptId:reply.turn.attemptId});assert.equal(await decline(chat,room,reply.turn),true);}
  for(let i=0;i<32;i++){const reply=await append(chat,room,'public-'+i,members[i%3]);assert.equal(await chat.startReply({roomId:room.id,id:reply.turn.id,attemptId:reply.turn.attemptId}),true);await finish(chat,room,reply.turn);}
  assert.deepEqual(chat.read(room.id).turns.slice(1).map(t=>t.emittedOrder),Array.from({length:32},(_,i)=>i));
  await assert.rejects(append(chat,room,'overflow'),/conflict/);
});

test('a declined write is rolled back when its owner changes and persistence errors do not erase a pending reply',async()=>{
  let block=false,valid=true,saved;const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const {chat,room}=await setup({persist:async value=>{if(block){block=false;entered.resolve();await release.promise;}saved=value;}}),reply=await append(chat,room);
  block=true;const work=decline(chat,room,reply.turn,{valid:()=>valid});await entered.promise;valid=false;release.resolve();
  assert.equal(await work,false);assert.equal(chat.read(room.id).turns.length,2);assert.deepEqual(chat.read(room.id).silences,[]);assert.equal(saved.rooms[0].turns.length,2);
  let rejected=false;const throwing=await setup({persist:async()=>{if(rejected)throw Error('disk');}}),pending=await append(throwing.chat,throwing.room);rejected=true;
  await assert.rejects(decline(throwing.chat,throwing.room,pending.turn),/disk/);assert.equal(throwing.chat.read(throwing.room.id).turns.length,2);
});

test('restore discards invalid, cross-cycle, self-authored and private silence receipts',async()=>{
  const {chat,room}=await setup(),peer=await append(chat,room,'peer',members[1]);await finish(chat,room,peer.turn);
  const actor=await append(chat,room);await decline(chat,room,actor.turn,{through:{turnId:peer.turn.id,attemptId:peer.turn.attemptId}});
  const base=chat.snapshot(),receipt=base.rooms[0].silences[0];
  const invalid=[{...receipt,reason:'private'},{...receipt,messageId:'previous'},{...receipt,referenceRevision:1},{...receipt,at:-1},
    {...receipt,personaId:'outside'},{...receipt,personaId:'b'},{...receipt,scopeKey:'other'},
    {...receipt,through:{...receipt.through,attemptId:'retired'}},{...receipt,through:{...receipt.through,text:'private'}}];
  for(const entry of invalid){const raw=structuredClone(base);raw.rooms[0].silences=[entry];const restored=createPersonaChat();restored.restore(raw);assert.deepEqual(restored.read(room.id).silences,[],JSON.stringify(entry));}
  const eight=structuredClone(base);eight.rooms[0].silences=Array.from({length:20},(_,i)=>({...receipt,at:receipt.at+i}));
  const bounded=createPersonaChat();bounded.restore(eight);assert.equal(bounded.read(room.id).silences.length,1,'only the actor latest receipt survives');
  const active=createPersonaChat();active.restore(base);assert.equal(active.read(room.id).silences.length,1);
});

test('clearing or removing membership retires receipts; another room cannot acknowledge this room through a turn',async()=>{
  const {chat,room}=await setup(),reply=await append(chat,room);await decline(chat,room,reply.turn);
  await chat.update({roomId:room.id,configRevision:0,epoch:0,memberIds:['b','c']});assert.deepEqual(chat.read(room.id).silences,[]);
  const other=await chat.create({requestId:'other-room',name:'另一个房间',memberIds:['b'],targetPersonaIds:[]});
  await chat.send({directed:true,roomId:other.id,recipients:[],requestId:'other-message',content:'另一个房间原话',revision:other.revision,scopeKey:'scope'});
  const slot=await chat.appendDirectedReply({roomId:other.id,messageId:'other-message',planId:'other-plan',actor:members[1],members:[members[1]],scopeKey:'scope',responsePlan:{kind:'normal',to:'user'}});
  assert.equal(await chat.declineReply({roomId:other.id,id:slot.turn.id,attemptId:slot.turn.attemptId,epoch:chat.epoch(),scopeKey:'scope',referenceRevision:0,through:{turnId:'message',attemptId:'user'}}),false);
  await chat.clear({roomId:other.id,revision:chat.read(other.id).revision,epoch:chat.epoch()});assert.equal(await chat.declineReply({roomId:other.id,id:slot.turn.id,attemptId:slot.turn.attemptId,epoch:0,scopeKey:'scope',referenceRevision:0,through:{turnId:'other-message',attemptId:'user'}}),false);
});
