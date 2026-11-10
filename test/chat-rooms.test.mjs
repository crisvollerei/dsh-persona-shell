import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaChat, CHAT_LIMITS } from '../lib/persona-chat.js';
import { recentChatHistory } from '../lib/chat-prompt.js';

const create = (chat, requestId='room-one', memberIds=['whale','dragon']) => chat.create({ requestId, name:'讨论室',memberIds,targetPersonaId:memberIds[0],interaction:'independent' });
const send = (chat,room,requestId='message-one') => chat.send({roomId:room.id,personaId:room.targetPersonaId,name:room.targetPersonaId,
  requestId,content:'用户消息',revision:chat.read(room.id).revision,epoch:chat.epoch()});
const finish = (chat,start,extra={}) => chat.finish({roomId:start.room.id,personaId:start.turn.recipientId,id:start.turn.id,
  attemptId:start.turn.attemptId,status:'ready',messages:['角色回复'],...extra});

test('independent rooms can share members without sharing history; create is durable and idempotent',async()=>{
  let fail=false;const chat=createPersonaChat({persist:async()=>{if(fail)throw Error('disk');}});
  const a=await create(chat),b=await create(chat,'room-two');assert.notEqual(a.id,b.id);
  assert.equal((await create(chat)).id,a.id);assert.equal(chat.list().length,2);
  const start=await send(chat,a);await finish(chat,start);assert.equal(chat.read(b.id).turns.length,0);
  fail=true;await assert.rejects(create(chat,'room-three'),/disk/);assert.equal(chat.list().length,2);
});

test('first-room requests from independent viewers share one durable room; manual creation stays independent', async()=>{
  const started=Promise.withResolvers(),release=Promise.withResolvers();let writes=0;
  const chat=createPersonaChat({persist:async()=>{if(++writes===1){started.resolve();await release.promise;}}});
  const first=(id,member)=>chat.create({requestId:id,memberIds:[member],targetPersonaId:member,name:'与'+member+'的聊天',epoch:0},{onlyIfEmpty:true});
  const a=first('window-a','whale');await started.promise;
  const b=first('window-b','dragon');assert.equal(chat.list().length,0);
  release.resolve();const [left,right]=await Promise.all([a,b]);
  assert.equal(left.id,right.id);assert.deepEqual(right.memberIds,['whale']);assert.equal(writes,1);
  const manual=await create(chat,'manual');assert.notEqual(manual.id,left.id);
  assert.equal((await first('late-window','cat')).id,manual.id,'keep the current active room');
  assert.equal(writes,2);assert.equal(chat.list().length,2);
});

test('recipient changes retain one shared timeline and cannot relabel pending or historical replies',async()=>{
  const chat=createPersonaChat(),room=await create(chat),first=await send(chat,room);
  const selected=await chat.update({roomId:room.id,revision:1,epoch:0,targetPersonaId:'dragon'});
  assert.equal(selected.turns[0].recipientId,'whale');assert.equal(selected.targetPersonaId,'dragon');
  await assert.rejects(send(chat,selected,'while-running'),/chat-busy/);
  await finish(chat,first);const second=await send(chat,selected,'to-dragon');await finish(chat,second);
  assert.deepEqual(chat.read(room.id).turns.map(t=>t.recipientId),['whale','dragon']);
  await assert.rejects(chat.send({roomId:room.id,personaId:'stranger',name:'外人',content:'不应调用',requestId:'bad',revision:4}),/not-member/);
});

test('room edits retain historical speakers, reject stale saves and validate the member limit',async()=>{
  const chat=createPersonaChat(),room=await create(chat),first=await send(chat,room);await finish(chat,first);
  const changed=await chat.update({roomId:room.id,revision:2,epoch:0,name:'新标题',memberIds:['dragon']});
  assert.equal(changed.targetPersonaId,null);assert.deepEqual(changed.targetPersonaIds,[]);assert.equal(changed.turns[0].recipientId,'whale');
  await assert.rejects(chat.update({roomId:room.id,revision:2,name:'迟到的标题'}),/conflict/);
  await assert.rejects(chat.update({roomId:room.id,revision:3,memberIds:[]}),/invalid-chat-members/);
  await assert.rejects(chat.update({roomId:room.id,revision:3,targetPersonaId:'whale'}),/not-member/);
  await assert.rejects(create(chat,'huge',Array.from({length:CHAT_LIMITS.members+1},(_,n)=>'p'+n)),/invalid-chat-room/);
});

test('room source selections persist separately while clear keeps members and retires late replies',async()=>{
  const chat=createPersonaChat(),room=await create(chat);await chat.sources({roomId:room.id,sessionIds:['work'],primarySessionId:'work'});
  const first=await send(chat,room);await chat.clear({roomId:room.id,revision:1,epoch:0});
  assert.equal(await finish(chat,first),false);const empty=chat.read(room.id);
  assert.deepEqual(empty.memberIds,['whale','dragon']);assert.deepEqual(empty.sources,['work']);assert.equal(empty.turns.length,0);
  const restored=createPersonaChat();restored.restore(chat.snapshot());assert.deepEqual(restored.read(room.id),empty);
  await chat.remove({roomId:room.id,revision:2,epoch:1});assert.equal(chat.read(room.id),null);
  await assert.rejects(chat.send({roomId:room.id,personaId:'whale',name:'鲸',requestId:'late',content:'旧页面迟到的发送',revision:2,epoch:1}),/not-found/);
});

test('only the current room schema is restored and unfinished replies are never resumed automatically',async()=>{
  const chat=createPersonaChat();chat.restore({version:1,rooms:[{id:'old'}]});assert.deepEqual(chat.list(),[]);
  chat.restore({version:2,rooms:[{id:'old'}]});assert.deepEqual(chat.list(),[]);
  const room=await create(chat),start=await send(chat,room);const saved=chat.snapshot();
  chat.restore(saved);assert.equal(chat.read(room.id).turns[0].status,'interrupted');
  assert.equal(chat.read(room.id).turns[0].recipientId,'whale');assert.equal(chat.active(),room.id);
  assert.equal(await finish(chat,start),false);
});

test('multi-recipient sends are atomic, idempotent and retain one immutable user-message identity',async()=>{
  let fail=false;const chat=createPersonaChat({persist:async()=>{if(fail)throw Error('disk');}}),initial=await create(chat);
  const room=await chat.update({roomId:initial.id,configRevision:0,epoch:0,targetPersonaIds:['whale','dragon']});
  const body={roomId:room.id,personaId:'whale',name:'鲸',recipients:[{id:'whale',name:'鲸'},{id:'dragon',name:'龙'}],requestId:'group-one',content:'你们怎么看',revision:room.revision};
  fail=true;await assert.rejects(chat.send(body),/disk/);assert.equal(chat.read(room.id).turns.length,0);
  fail=false;const first=await chat.send(body);assert.equal(first.turns.length,2);assert.equal(chat.list()[0].turnCount,1);
  assert.deepEqual(first.turns.map(t=>t.messageId),['group-one','group-one']);assert.notEqual(first.turns[0].id,first.turns[1].id);
  await chat.update({roomId:room.id,configRevision:1,epoch:0,targetPersonaIds:['dragon']});
  assert.equal((await chat.send(body)).created,false,'a lost acknowledgement cannot repeat either call after the selection changes');
  await assert.rejects(chat.send({...body,recipients:[{id:'whale',name:'鲸'}]}),/id-conflict/);
  const broadcast=await chat.update({roomId:room.id,configRevision:2,epoch:0,targetPersonaIds:[]});
  assert.equal(broadcast.targetPersonaId,null);assert.deepEqual(broadcast.targetPersonaIds,[]);
  await assert.rejects(chat.update({roomId:room.id,configRevision:3,epoch:0,targetPersonaIds:['dragon','dragon']}),/not-member/);
});

test('retrying an earlier member refreshes its dependent tail and cancelling a batch retires pending results',async()=>{
  const chat=createPersonaChat(),initial=await create(chat),room=await chat.update({roomId:initial.id,configRevision:0,epoch:0,targetPersonaIds:['whale','dragon']});
  const result=await chat.send({roomId:room.id,personaId:'whale',name:'鲸',recipients:[{id:'whale',name:'鲸'},{id:'dragon',name:'龙'}],requestId:'multi',content:'一起聊',revision:1});
  const [whale,dragon]=result.turns;
  await chat.finish({roomId:room.id,id:whale.id,attemptId:whale.attemptId,status:'failed',failure:'length'});
  await chat.finish({roomId:room.id,id:dragon.id,attemptId:dragon.attemptId,status:'ready',messages:['龙的原回复']});
  const retried=await chat.retry({roomId:room.id,personaId:'whale',name:'鲸',id:whale.id,attemptId:'whale-retry',revision:chat.read(room.id).revision});
  assert.deepEqual(retried.room.turns[1].assistant,[]);assert.equal(retried.room.turns[1].status,'pending');assert.equal(chat.list()[0].turnCount,1);
  await chat.cancel({roomId:room.id,id:whale.id,attemptId:'whale-retry',messageId:'multi'});
  assert.equal(await chat.finish({roomId:room.id,id:whale.id,attemptId:'whale-retry',status:'ready',messages:['迟到']}),false);
  assert.equal(chat.read(room.id).turns[1].status,'cancelled');
  const next=await chat.send({roomId:room.id,personaId:'whale',name:'鲸',recipients:whale.recipients,requestId:'next',content:'再聊',revision:chat.read(room.id).revision});
  await chat.cancel({roomId:room.id,id:next.turn.id,attemptId:next.turn.attemptId,messageId:'next'});
  assert.deepEqual(chat.read(room.id).turns.slice(-2).map(t=>t.status),['cancelled','cancelled']);
});

test('history and retention count shared user messages, keeping complete multi-speaker groups',async()=>{
  const chat=createPersonaChat(),initial=await create(chat),room=await chat.update({roomId:initial.id,configRevision:0,epoch:0,targetPersonaIds:['whale','dragon']});
  for(let i=0;i<CHAT_LIMITS.turns+1;i++){
    const value=await chat.send({roomId:room.id,personaId:'whale',name:'鲸',recipients:[{id:'whale',name:'鲸'},{id:'dragon',name:'龙'}],
      requestId:'group-'+i,content:'讨论 '+i,revision:chat.read(room.id).revision});
    for(const turn of value.turns)await chat.finish({roomId:room.id,id:turn.id,attemptId:turn.attemptId,status:'ready',messages:[turn.speakerName+' 的回复']});
  }
  const saved=chat.read(room.id);assert.equal(saved.turns.length,80);assert.equal(chat.list()[0].turnCount,40);
  assert.equal(saved.turns[0].messageId,'group-1');const history=recentChatHistory(saved.turns);assert.equal(history.length,8);
  assert.equal(history.at(-1).responses.length,2);assert.deepEqual(history.at(-1).responses.map(t=>t.speaker.id),['whale','dragon']);
  const restored=createPersonaChat();restored.restore(chat.snapshot());assert.deepEqual(restored.read(room.id),saved);
});

test('batch stop tolerates an already-finished first speaker without cancelling a later retry',async()=>{
  const chat=createPersonaChat(),initial=await create(chat),room=await chat.update({roomId:initial.id,configRevision:0,epoch:0,targetPersonaIds:['whale','dragon']});
  const result=await chat.send({roomId:room.id,personaId:'whale',name:'鲸',recipients:[{id:'whale',name:'鲸'},{id:'dragon',name:'龙'}],requestId:'both',content:'一起聊',revision:1});
  const [first,second]=result.turns,stop={roomId:room.id,id:first.id,attemptId:first.attemptId,messageId:'both',attempts:result.turns.map(t=>({id:t.id,attemptId:t.attemptId}))};
  await chat.finish({roomId:room.id,id:first.id,attemptId:first.attemptId,status:'ready',messages:['先完成']});
  assert.equal(await chat.cancel(stop),true);assert.equal(chat.read(room.id).turns[1].status,'cancelled');
  await chat.retry({roomId:room.id,personaId:'dragon',name:'龙',id:second.id,attemptId:'new-attempt',revision:chat.read(room.id).revision});
  assert.equal(await chat.cancel(stop),false);assert.equal(chat.read(room.id).turns[1].status,'pending');
});
