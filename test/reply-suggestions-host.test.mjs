import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,newRoom,roomSend,roomState,settledRoom,flush,reply,jsonReply,preference,readChatInput,whale,dragon,claude} from './helpers/persona-chat-host.mjs';
const candidates=()=>jsonReply({suggestions:['接着说说？','我想听听大家的看法。']});
const isSuggestion=options=>options.system.startsWith('你为用户准备消息区');
async function targets(f,room,ids){const s=await roomState(f,room);return f.request('chat-rooms',{action:'update',roomId:room.roomId,epoch:s.epoch,configRevision:s.room.configRevision,targetPersonaIds:ids});}
async function request(f,binding,personaId,instruction='',extra={}){
 const s=await roomState(f,binding);
 return f.request('chat/suggestions',{...binding,personaId,revision:s.room.revision,epoch:s.epoch,instruction,...extra});
}

test('broadcast suggestions accept a room member without a primary target and use only this room public history',async t=>{
 const f=fixture(t,{script:options=>isSuggestion(options)?candidates():reply(['这是本房间的回答。'])});await f.ready();
 await preference(f,'PRIVATE_PERSONA_STYLE',dragon);f.work('WORK_REPORT_SECRET');
 const other=await newRoom(f,[whale],'别的房间','suggest-other');await roomSend(f,other,whale,'OTHER_ROOM_SECRET');await settledRoom(f,other);
 const room=await newRoom(f,[dragon,claude],'向房间说话','suggest-broadcast');await targets(f,room,[]);
 await roomSend(f,room,dragon,'公开聊聊衣服。','public-outfit');const before=await settledRoom(f,room);
 assert.equal(before.room.targetPersonaId,null);assert.equal(before.room.memberIds.includes(before.personaId),false,'the global fallback persona need not be in this room');
 const result=await request(f,room,dragon);assert.equal(result.status,200);assert.equal(result.value.suggestions.length,2);
 const call=f.calls.at(-1),input=readChatInput(call);
 assert.equal(input.recipient,before.room.memberIds.map(id=>before.contacts.find(p=>p.id===id).name).join('、'));
 assert.match(JSON.stringify(input.history),/公开聊聊衣服/);assert.doesNotMatch(JSON.stringify(call),/PRIVATE_PERSONA_STYLE|WORK_REPORT_SECRET|OTHER_ROOM_SECRET/);
 assert.deepEqual((await roomState(f,room)).room,before.room);
 const count=f.calls.length;assert.equal((await request(f,room,whale,'不属于房间')).status,409);assert.equal(f.calls.length,count);
});

test('ordered selected recipients still bind suggestions to the real primary and reject stale room or foreign source snapshots',async t=>{
 const f=fixture(t,{script:options=>isSuggestion(options)?candidates():reply()});await f.ready();
 const room=await newRoom(f,[whale,dragon]);await targets(f,room,[dragon,whale]);
 const before=f.calls.length;
 assert.equal((await request(f,room,whale,'错误的主要对象')).status,409);assert.equal(f.calls.length,before);
 assert.equal((await request(f,room,dragon,'给两个候选')).status,200);
 assert.equal(readChatInput(f.calls.at(-1)).recipient,'大肥龙、大肥鱼（默认）');
 const state=await roomState(f,room),other=await newRoom(f,[claude],'另一来源','suggest-source');
 assert.equal((await request(f,room,dragon,'旧版本',{revision:state.room.revision-1})).status,409);
 assert.equal((await request(f,room,dragon,'其他房间的来源',{contextKey:other.contextKey})).status,409);
 assert.equal(f.calls.length,before+1);
});

test('changing broadcast recipients during generation discards the old candidates and never sends a user message',async t=>{
 let release,signal;t.after(()=>release?.());
 const f=fixture(t,{script:options=>(async function*(){signal=options.signal;await new Promise(resolve=>release=resolve);yield*candidates();})()});await f.ready();
 const room=await newRoom(f,[whale,dragon]);await targets(f,room,[]);
 const pending=request(f,room,whale,'帮我接一句');await flush();assert.equal(f.calls.length,1);
 await targets(f,room,[dragon]);assert.equal(signal.aborted,true);
 release();assert.equal((await pending).status,409);assert.equal((await roomState(f,room)).room.turns.length,0);
});
