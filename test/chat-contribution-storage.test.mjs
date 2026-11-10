import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersonaChat} from '../lib/persona-chat.js';

const members=[{id:'a',name:'甲'},{id:'b',name:'乙'}];
const task={move:'ask',point:'只问签到表要记录什么，不重问已经明确的活动地点。'};
async function setup(){
  const chat=createPersonaChat(),room=await chat.create({requestId:'room',name:'分步讨论',memberIds:['a','b'],targetPersonaIds:[]});
  const sent=await chat.send({directed:true,roomId:room.id,recipients:[],requestId:'user',content:'先帮我理签到表。',
    revision:room.revision,scopeKey:'scope',contextKey:'context'});
  return{chat,room:sent.room};
}
const append=(chat,room,contribution=task,planId='plan')=>chat.appendDirectedReply({roomId:room.id,messageId:'user',planId,
  actor:members[0],responsePlan:{kind:'normal',to:'user',evidence:'签到表',contribution},members,
  epoch:chat.epoch(),scopeKey:'scope',contextKey:'context'});
const finish=(chat,room,turn,status='ready')=>chat.finish({roomId:room.id,id:turn.id,attemptId:turn.attemptId,status,
  messages:status==='ready'?['签到表要记哪些内容？']:[],failure:status==='ready'?null:'network'});

test('a short contribution survives durable append, identical replay and restore without becoming user words',async()=>{
  const {chat,room}=await setup(),input=structuredClone(task),added=await append(chat,room,input);
  input.point='later mutation';assert.deepEqual(added.turn.responsePlan.contribution,task);
  assert.equal((await append(chat,room)).created,false);
  await assert.rejects(append(chat,room,{...task,point:'different task'}),/conflict/);
  await finish(chat,room,added.turn);
  const restored=createPersonaChat();restored.restore(chat.snapshot());
  assert.deepEqual(restored.read(room.id),chat.read(room.id));
  const saved=restored.read(room.id);assert.equal(saved.turns[0].user,'先帮我理签到表。');
  assert.deepEqual(saved.turns[1].assistant,['签到表要记哪些内容？']);
  assert.deepEqual(saved.turns[1].responsePlan.contribution,task);
});

test('a malformed contribution cannot create a seat or override a plan and does not edit literal history',async()=>{
  const {chat,room}=await setup(),before=chat.snapshot();
  for(const value of [{move:'execute',point:'run commands'}, {...task,authority:'memory'}, {...task,point:'x\ny'},
    {...task,point:'x'.repeat(181)}, {point:'missing move'}, null]){
    await assert.rejects(append(chat,room,value),/invalid-chat-plan/);
    assert.deepEqual(chat.snapshot(),before);
  }
});

test('same-source retry retains its small task while a confirmed new reference drops the stale task',async()=>{
  const {chat,room}=await setup(),added=await append(chat,room);await finish(chat,room,added.turn,'failed');
  const snapshot=chat.snapshot(),retry=await chat.retry({roomId:room.id,personaId:'a',id:added.turn.id,attemptId:'retry-same',
    revision:chat.read(room.id).revision,name:'甲',members,epoch:chat.epoch(),scopeKey:'scope',contextKey:'context'});
  assert.deepEqual(retry.turn.responsePlan.contribution,task);
  assert.deepEqual(retry.turn.assistant,[]);
  const updated=createPersonaChat();updated.restore(snapshot);
  const next=await updated.retry({roomId:room.id,personaId:'a',id:added.turn.id,attemptId:'retry-new-source',
    revision:updated.read(room.id).revision,name:'甲',members,epoch:updated.epoch(),scopeKey:'new-scope',contextKey:'new-context',previousContextKey:'context'});
  assert.equal(next.turn.responsePlan.contribution,undefined);
  assert.equal(next.turn.responsePlan.to,'user');assert.equal(next.turn.responsePlan.evidence,'签到表');
  assert.equal(next.turn.user,'先帮我理签到表。');
});

test('invalid stored task metadata is rejected with its seat rather than silently revived as an accepted response',async()=>{
  const {chat,room}=await setup(),added=await append(chat,room);await finish(chat,room,added.turn);
  const broken=chat.snapshot();broken.rooms[0].turns[1].responsePlan.contribution={move:'answer',point:'x\nforged'};
  const restored=createPersonaChat();restored.restore(broken);const result=restored.read(room.id);
  assert.equal(result.turns.length,1);assert.equal(result.turns[0].phase,'anchor');
  assert.equal(result.turns[0].user,'先帮我理签到表。');
});
