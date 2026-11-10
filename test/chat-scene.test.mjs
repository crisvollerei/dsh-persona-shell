import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersonaChat} from '../lib/persona-chat.js';
import {buildChatSceneCatalog,selectChatScene,projectChatScene,publicChatSceneCatalog,CHAT_SCENE_LIMITS} from '../lib/chat-scene.js';

const members=[{id:'a',name:'甲'},{id:'b',name:'乙'},{id:'c',name:'丙'}];
const scope=room=>room.id+':sources:'+(room.sourceVersion??0);
const params=(room,messageId)=>({messageId,scopeKey:scope(room),referenceRevision:room.referenceRevision??0});
async function setup(options={}){const chat=createPersonaChat(options),room=await chat.create({requestId:'room',name:'公开话题',memberIds:members.map(p=>p.id),targetPersonaIds:[]});return{chat,room};}
async function send(chat,room,id,content='公开用户原话',userParts){const current=chat.read(room.id);return chat.send({roomId:room.id,directed:true,personaId:'a',name:'甲',recipients:[],requestId:id,content,userParts,
  revision:current.revision,epoch:chat.epoch(),scopeKey:scope(current),contextKey:'context'});}
async function select(chat,room,messageId,key){const current=chat.read(room.id),frame=selectChatScene(current,{...params(current,messageId),key});assert.ok(frame,key);
  assert.equal(await chat.setScene({roomId:room.id,scene:frame,...params(current,messageId),epoch:chat.epoch()}),true);return frame;}
async function append(chat,room,messageId,planId,actor=members[0]){return chat.appendDirectedReply({roomId:room.id,messageId,planId,actor,members,responsePlan:{kind:'normal',to:'user'},
  epoch:chat.epoch(),scopeKey:scope(chat.read(room.id)),contextKey:'context'});}
const finish=(chat,result,extra={})=>chat.finish({roomId:result.room.id,id:result.turn.id,attemptId:result.turn.attemptId,status:'ready',messages:['完整公开回复。'],...extra});
const projected=(chat,room,id)=>{const current=chat.read(room.id);return projectChatScene(current,params(current,id));};

test('fresh, continuation, pause and resume preserve public topic refs and one shared transition',async()=>{
  const {chat,room}=await setup();await send(chat,room,'m1','看看这份报告');await select(chat,room,'m1','F');const first=await append(chat,room,'m1','p1');await finish(chat,first);
  await send(chat,room,'m2','其他人的看法呢');await select(chat,room,'m2','C1');
  let scene=projected(chat,room,'m2');assert.equal(scene.focus.messageId,'m1');assert.equal(scene.relatedReplies[0].turnId,first.turn.id);
  const second=await append(chat,room,'m2','p2',members[1]);await finish(chat,second);
  await send(chat,room,'m3','先不管了，来贴贴');await select(chat,room,'m3','P1');scene=projected(chat,room,'m3');
  assert.equal(scene.focus.messageId,'m3');assert.equal(scene.parked.messageId,'m1');assert.equal(scene.transition.reply,null);
  const acknowledged=await append(chat,room,'m3','p3');await finish(chat,acknowledged);scene=projected(chat,room,'m3');
  assert.equal(scene.transition.reply.turnId,acknowledged.turn.id);assert.deepEqual(buildChatSceneCatalog(chat.read(room.id),params(chat.read(room.id),'m3')).options.map(option=>option.key),['K']);
  const later=await append(chat,room,'m3','p4',members[1]);await finish(chat,later);assert.equal(projected(chat,room,'m3').transition.reply.turnId,acknowledged.turn.id);
  await send(chat,room,'m4','再靠近一点');await select(chat,room,'m4','C1');scene=projected(chat,room,'m4');
  assert.equal(scene.transition.reply.turnId,acknowledged.turn.id);assert.equal(scene.parked.messageId,'m1');
  assert.ok(scene.relatedReplies.some(ref=>ref.turnId===acknowledged.turn.id));assert.ok(!scene.relatedReplies.some(ref=>ref.turnId===first.turn.id),'a paused work topic is not the active casual focus');
  await send(chat,room,'m5','回来看刚才的报告');const state=chat.read(room.id),catalog=buildChatSceneCatalog(state,params(state,'m5'));
  const resume=catalog.options.find(option=>option.relation==='resume'&&option.frame.focus.messageId==='m1');assert.ok(resume);
  await select(chat,room,'m5',resume.key);scene=projected(chat,room,'m5');
  assert.equal(scene.focus.messageId,'m1');assert.equal(scene.parked.messageId,'m3');assert.equal(scene.transition.trigger.messageId,'m5');
  assert.deepEqual(new Set(scene.relatedReplies.map(ref=>ref.turnId)),new Set([first.turn.id,second.turn.id]));
});

test('pending, failed and silent responses do not acknowledge a transition; acknowledgement shares the successful durable commit',async()=>{
  let reject=false;const {chat,room}=await setup({persist:async()=>{if(reject)throw Error('disk');}});
  await send(chat,room,'m1');await select(chat,room,'m1','F');await send(chat,room,'m2','换个话题');await select(chat,room,'m2','P1');
  const failed=await append(chat,room,'m2','p1');await chat.startReply({roomId:room.id,id:failed.turn.id,attemptId:failed.turn.attemptId});
  assert.equal(projected(chat,room,'m2').transition.reply,null);await finish(chat,failed,{status:'failed',messages:[],failure:'network'});assert.equal(projected(chat,room,'m2').transition.reply,null);
  const silent=await append(chat,room,'m2','p2',members[1]);
  assert.equal(await chat.declineReply({roomId:room.id,id:silent.turn.id,attemptId:silent.turn.attemptId,epoch:chat.epoch(),scopeKey:scope(chat.read(room.id)),referenceRevision:0,through:{turnId:'m2',attemptId:'user'}}),true);
  assert.equal(projected(chat,room,'m2').transition.reply,null);
  const ready=await append(chat,room,'m2','p3',members[2]);reject=true;await assert.rejects(finish(chat,ready),/disk/);
  assert.equal(chat.read(room.id).turns.find(turn=>turn.id===ready.turn.id).status,'pending');assert.equal(projected(chat,room,'m2').transition.reply,null);
  reject=false;await finish(chat,ready);assert.equal(projected(chat,room,'m2').transition.reply.turnId,ready.turn.id);
});

test('a pending transition can be acknowledged by a later continuation and survives a revalidated restart',async()=>{
  const {chat,room}=await setup();await send(chat,room,'work','先说工作');await select(chat,room,'work','F');
  await send(chat,room,'pause','先歇会');await select(chat,room,'pause','P1');
  await send(chat,room,'later','其他人也来');await select(chat,room,'later','C1');
  const first=await append(chat,room,'later','ack-later');await finish(chat,first);
  const scene=projected(chat,room,'later');assert.equal(scene.transition.trigger.messageId,'pause');
  assert.equal(scene.transition.reply.turnId,first.turn.id);
  await send(chat,room,'continue','一起坐坐');await select(chat,room,'continue','C1');
  const restored=createPersonaChat();restored.restore(chat.snapshot());
  assert.deepEqual(projected(restored,room,'continue'),projected(chat,room,'continue'));
  assert.equal(projected(restored,room,'continue').transition.reply.turnId,first.turn.id);
});

test('scene selection is durable, rejects forged and stale frames and cannot be changed after it is selected',async()=>{
  let reject=false;const {chat,room}=await setup({persist:async()=>{if(reject)throw Error('disk');}});await send(chat,room,'m1');
  const state=chat.read(room.id),fresh=selectChatScene(state,{...params(state,'m1'),key:'F'});reject=true;
  await assert.rejects(chat.setScene({roomId:room.id,scene:fresh,...params(state,'m1'),epoch:0}),/disk/);assert.equal(projected(chat,room,'m1'),null);
  reject=false;await select(chat,room,'m1','F');
  await assert.rejects(chat.setScene({roomId:room.id,scene:{...fresh,privateMemory:'DO_NOT_STORE'},...params(chat.read(room.id),'m1'),epoch:0}),/invalid-chat-scene/);
  const other={...fresh,focus:{...fresh.focus,roomId:'other'}};await assert.rejects(chat.setScene({roomId:room.id,scene:other,...params(chat.read(room.id),'m1'),epoch:0}),/invalid-chat-scene/);
  assert.equal(await chat.setScene({roomId:room.id,scene:fresh,...params(chat.read(room.id),'m1'),referenceRevision:1,epoch:0}),false);
  await send(chat,room,'m2');assert.equal(await chat.setScene({roomId:room.id,scene:fresh,...params(chat.read(room.id),'m1'),epoch:0}),false);
});

test('late scene saves roll back when their validity changes during persistence',async()=>{
  let block=false,valid=true,last;const began=Promise.withResolvers(),gate=Promise.withResolvers();
  const {chat,room}=await setup({persist:async next=>{if(block){block=false;began.resolve();await gate.promise;}last=next;}});await send(chat,room,'m1');
  const state=chat.read(room.id),scene=selectChatScene(state,{...params(state,'m1'),key:'F'});block=true;
  const saving=chat.setScene({roomId:room.id,scene,...params(state,'m1'),epoch:0,valid:()=>valid});await began.promise;valid=false;gate.resolve();
  assert.equal(await saving,false);assert.equal(projected(chat,room,'m1'),null);assert.equal(last.rooms[0].turns[0].scene,undefined);
});

test('scope changes, reference revisions and clears retire scenes while raw public messages remain independent',async()=>{
  const {chat,room}=await setup();await send(chat,room,'m1');await select(chat,room,'m1','F');const a=await append(chat,room,'m1','p1');await finish(chat,a);
  await send(chat,room,'m2');await select(chat,room,'m2','C1');const before=chat.read(room.id);
  assert.deepEqual(buildChatSceneCatalog(before,{...params(before,'m2'),scopeKey:'other'}).options,[]);
  assert.equal(projectChatScene(before,{...params(before,'m2'),referenceRevision:1}),null);
  await chat.referencePolicy({roomId:room.id,referenceRevision:0,scopeKey:scope(before),epoch:0,ref:{roomId:room.id,generation:0,kind:'user',messageId:'m1'},excluded:true});
  assert.equal(projected(chat,room,'m2'),null);assert.ok(chat.read(room.id).turns.some(turn=>turn.id===a.turn.id));
  await select(chat,room,'m2','F');await chat.sources({roomId:room.id,sessionIds:['work'],primarySessionId:'work'});
  assert.equal(projectChatScene(chat.read(room.id),params(before,'m2')),null);
  const latest=chat.read(room.id);await chat.clear({roomId:room.id,revision:latest.revision,epoch:chat.epoch()});assert.equal(projectChatScene(chat.read(room.id),params(latest,'m2')),null);
});

test('restore rechecks every scene reference and keeps only refs, not generated descriptions',async()=>{
  const {chat,room}=await setup();await send(chat,room,'m1','PRIVATE_BODY_NOT_IN_FRAME');await select(chat,room,'m1','F');const a=await append(chat,room,'m1','p1');await finish(chat,a);
  await send(chat,room,'m2','新话题');await select(chat,room,'m2','P1');const b=await append(chat,room,'m2','p2');await finish(chat,b);
  const snapshot=chat.snapshot(),restored=createPersonaChat();restored.restore(snapshot);assert.deepEqual(projected(restored,room,'m2'),projected(chat,room,'m2'));
  assert.doesNotMatch(JSON.stringify(snapshot.rooms[0].turns.filter(turn=>turn.scene).map(turn=>turn.scene)),/PRIVATE_BODY_NOT_IN_FRAME|完整公开回复/);
  for(const mutate of [raw=>raw.rooms[0].turns.find(turn=>turn.id==='m2').scene.focus.roomId='foreign',raw=>raw.rooms[0].turns.find(turn=>turn.id===b.turn.id).status='failed',
    raw=>raw.rooms[0].sourceVersion++,raw=>raw.rooms[0].turns.find(turn=>turn.id==='m2').scene.summary='FORGED_SUMMARY']){
    const raw=structuredClone(snapshot);mutate(raw);const c=createPersonaChat();c.restore(raw);assert.equal(projected(c,room,'m2'),null);
  }
});

test('merged user originals remain separate refs and unresponded past inputs remain selectable without fabricated answers',async()=>{
  const {chat,room}=await setup();await send(chat,room,'m1','先聊报告\n不过先陪我坐一会儿',[{id:'m1',text:'先聊报告',at:1},{id:'part2',text:'不过先陪我坐一会儿',at:2}]);await select(chat,room,'m1','F');
  await send(chat,room,'m2','接着刚才');const state=chat.read(room.id),catalog=buildChatSceneCatalog(state,params(state,'m2'));
  assert.equal(catalog.topics.length,1);assert.deepEqual(catalog.topics[0].responses,[]);assert.deepEqual(catalog.topics[0].parts.map(part=>part.ref.messageId),['m1','part2']);
  await select(chat,room,'m2','C1');const scene=projected(chat,room,'m2');assert.deepEqual(scene.focusParts.map(ref=>ref.messageId),['m1','part2']);assert.deepEqual(scene.relatedReplies,[]);
});

test('active-focus original groups retain intermediate conditions with no reply, failed reply or silence, including after restore',async()=>{
  const {chat,room}=await setup();await send(chat,room,'m1','整理这份方案');await select(chat,room,'m1','F');const first=await append(chat,room,'m1','p1');await finish(chat,first);
  await send(chat,room,'m2','先保留原文\n但不要发布',[{id:'m2',text:'先保留原文',at:1},{id:'condition',text:'但不要发布',at:2}]);await select(chat,room,'m2','C1');
  // No selected actor in m2 is a normal WAIT, not permission to forget it.
  await send(chat,room,'m3','验收前不要删备份');await select(chat,room,'m3','C1');const failed=await append(chat,room,'m3','p3');await finish(chat,failed,{status:'failed',messages:[],failure:'network'});
  await send(chat,room,'m4','预算也还没确认');await select(chat,room,'m4','C1');const silent=await append(chat,room,'m4','p4');
  assert.equal(await chat.declineReply({roomId:room.id,id:silent.turn.id,attemptId:silent.turn.attemptId,epoch:0,scopeKey:scope(chat.read(room.id)),referenceRevision:0,through:{turnId:'m4',attemptId:'user'}}),true);
  await send(chat,room,'parked','先聊晚饭');await select(chat,room,'parked','F');
  await send(chat,room,'m5','回来继续原方案');let state=chat.read(room.id),catalog=buildChatSceneCatalog(state,params(state,'m5'));
  const resumed=catalog.options.find(option=>option.relation==='resume'&&option.frame.focus.messageId==='m1');await select(chat,room,'m5',resumed.key);
  await send(chat,room,'m6','按刚才的条件继续');await select(chat,room,'m6','C1');
  const scene=projected(chat,room,'m6');assert.deepEqual(scene.activeUserGroups.map(group=>group.map(ref=>ref.messageId)),[['m1'],['m2','condition'],['m3'],['m4'],['m5'],['m6']]);
  assert.equal(scene.omittedActiveUserGroups,0);assert.equal(scene.relatedReplies.length,1);assert.equal(scene.relatedReplies[0].turnId,first.turn.id);
  assert.doesNotMatch(JSON.stringify(scene.activeUserGroups),/整理这份方案|但不要发布|验收前|预算/);
  const restored=createPersonaChat();restored.restore(chat.snapshot());assert.deepEqual(projected(restored,room,'m6').activeUserGroups,scene.activeUserGroups);
});

test('public catalogue is a bounded idempotent whitelist with whole replies and no host frame payloads',async()=>{
  const {chat,room}=await setup();
  for(let n=0;n<7;n++){await send(chat,room,'m'+n,'原话'+n);await select(chat,room,'m'+n,'F');const a=await append(chat,room,'m'+n,'p'+n);await finish(chat,a,{messages:['甲'.repeat(1800),'乙'.repeat(1800)]});}
  await send(chat,room,'current');const state=chat.read(room.id),raw=buildChatSceneCatalog(state,params(state,'current'));
  assert.ok(raw.topics.length<=CHAT_SCENE_LIMITS.topics);assert.ok(raw.topics.some(topic=>topic.omittedResponses>0));
  raw.options[0].frame.privateMemory='DO_NOT_COPY';raw.privateMemory='DO_NOT_COPY';raw.topics[0].memory='DO_NOT_COPY';
  const pub=publicChatSceneCatalog(raw);assert.deepEqual(publicChatSceneCatalog(pub),pub);assert.doesNotMatch(JSON.stringify(pub),/DO_NOT_COPY|"frame"/);
  assert.ok(pub.topics.flatMap(topic=>topic.responses).every(reply=>reply.messages.length===2&&reply.messages[0].length===1800));
  const length=pub.topics.reduce((sum,topic)=>sum+topic.parts.reduce((n,part)=>n+part.text.length,0)+topic.responses.reduce((n,response)=>n+response.messages.join('').length,0),0);
  assert.ok(length<=CHAT_SCENE_LIMITS.chars);assert.ok(pub.omittedTopics>0);
});
