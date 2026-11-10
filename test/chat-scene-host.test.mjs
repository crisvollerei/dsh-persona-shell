import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,reply,domain,newRoom,roomSend,roomState,settledRoom,flush,preference,whale,dragon,claude,readChatInput} from './helpers/persona-chat-host.mjs';

const wire=text=>(async function*(){yield{type:'text-delta',text};yield{type:'finish',reason:{kind:'stop'}};})();
const said=body=>body.events.filter(event=>event.author.role==='assistant');
const catalog=body=>body.sceneCatalog;
function sceneKey(body,relation,topicText){
  const options=catalog(body)?.options;
  assert.ok(Array.isArray(options),'the actual director receives a bounded public scene catalogue');
  const reuse=options.find(option=>option.key==='K');
  const target=topicText?catalog(body).topics.find(topic=>topic.text===topicText)?.id:undefined;
  const selected=reuse??options.find(option=>option.relation===relation&&(!topicText||option.target===target));
  assert.ok(selected,`the current public snapshot offers ${relation}`);
  return selected.key;
}
function direct(body,id,relation,work='N',topicText){
  if(!id)return wire('WAIT');
  const choice=body.choices.find(option=>option.id===id&&option.to==='user'&&option.kind==='normal');
  assert.ok(choice,'the fixture selects only a legal current user target');
  return wire(`${choice.choiceId} ${work} ${sceneKey(body,relation,topicText)}`);
}
async function targets(f,room,ids){
  const state=await roomState(f,room);
  assert.equal((await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:ids,configRevision:state.room.configRevision,epoch:state.epoch})).status,200);
}
const anchorFor=(state,message)=>state.room.turns.find(turn=>turn.phase==='anchor'&&turn.user===message);
const repliesFor=(state,anchor)=>state.room.turns.filter(turn=>turn.phase!=='anchor'&&turn.messageId===anchor.messageId);
const savedRoom=(f,room)=>f.storage.tables.get('profile').get('personaChats').rooms.find(value=>value.id===room.roomId);
function pointerText(request,pointer){
  if(!pointer)return undefined;
  const control=readChatInput(request),event=control.timeline.find(value=>value.eventId===pointer.eventId);
  if(!event)return undefined;
  const packet=JSON.parse(request.messages[event.messageIndex].content[0].text),position=event.bubbles.findIndex(bubble=>bubble.index===pointer.index);
  return typeof packet.messages[position]==='string'?packet.messages[position]:packet.messages.find(value=>value.index===pointer.index)?.text;
}
function sourceServices(){
  return [['sessions',{get:id=>({header:{id,title:'示例项目',cwd:'D:/synthetic/project'}})}],
    ['sessionQuery',{observeSession:async()=>({events:[
      {seq:1,type:'turn/start',data:{turn:1}},
      {seq:2,type:'user/message',data:{content:[{type:'text',text:'调整设置页，发布前先验收。'}]}},
      {seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:'SOURCE_REPORT_RISK：12项离线测试通过，真实客户端尚未验证，发布尚未获批准。'}]}}},
      {seq:4,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
    ]})}]];
}
const story={
  summary:'帮我总结这个任务',
  opinion:'其他人的看法呢',
  pause:'算了先不管了，和我贴贴',
  resume:'再看看刚才发布前没验的风险',
};

async function preparePause(t,{storage=domain(),pauseOrder=[whale,dragon],pauseScript,directorPause}={}){
  const f=fixture(t,{storage,extraServices:sourceServices(),directorScript:options=>{
    const body=readChatInput(options);
    if(body.message===story.summary)return direct(body,said(body).length?undefined:whale,'fresh','s1');
    if(directorPause)return directorPause(body);
    const id=pauseOrder.find(id=>body.choices.some(choice=>choice.id===id&&choice.to==='user'&&choice.kind==='normal'));
    return direct(body,id,'pause','N');
  },script:options=>readChatInput(options).message===story.summary?reply(['已完成的公开摘要。']):pauseScript?.(options)??reply(['自然承接这次互动。'])});
  await f.ready();const room=await newRoom(f,[whale,dragon],'转场边界','pause-boundary');
  await targets(f,room,[whale]);await roomSend(f,room,whale,story.summary,'boundary-summary');
  const seeded=await settledRoom(f,room);assert.equal(seeded.directorFailure,null);
  await targets(f,room,pauseOrder.length===1?[whale]:[whale,dragon]);
  return{f,room,seeded};
}

test('the actual Host carries one public task across opinion, one room transition and source-backed resumption',async t=>{
  const plans=new Map([[story.summary,{relation:'fresh',work:'s1',order:[whale]}],
    [story.opinion,{relation:'continue',work:'s1',order:[dragon,claude]}],
    [story.pause,{relation:'pause',work:'N',order:[whale,dragon]}],
    [story.resume,{relation:'resume',work:'s1',order:[claude],topic:story.summary}]]);
  const f=fixture(t,{extraServices:sourceServices(),directorScript:options=>{
    const body=readChatInput(options),plan=plans.get(body.message);assert.ok(plan);
    return direct(body,plan.order[said(body).length],plan.relation,plan.work,plan.topic);
  },script:options=>{
    const body=readChatInput(options);
    return reply(body.message===story.summary?['SUMMARY_PUBLIC：设置页已改，离线测试通过，但真实客户端还没验。']:
      body.message===story.opinion?['这是各自的判断理由，不再重列整份摘要。']:
        body.message===story.pause?['（挪近了一点。）过来。']:['来源报告仍注明真实客户端尚未验证。']);
  }});
  await f.ready();await preference(f,'WHALE_PRIVATE_SCENE_STYLE',whale);await preference(f,'DRAGON_PRIVATE_SCENE_STYLE',dragon);
  const room=await newRoom(f,[whale,dragon,claude],'连续讨论','scene-story');
  assert.equal(f.requests.length,0,'opening a room cannot generate a scene-planning request');
  await targets(f,room,[whale]);assert.equal((await roomSend(f,room,whale,story.summary,'scene-summary')).status,200);
  let state=await settledRoom(f,room);assert.equal(state.directorFailure,null);
  const first=anchorFor(state,story.summary);assert.equal(first.scene?.relation,'fresh');
  assert.equal(first.scene.focus.messageId,first.userParts[0].id);
  await targets(f,room,[dragon,claude]);assert.equal((await roomSend(f,room,dragon,story.opinion,'scene-opinion')).status,200);
  state=await settledRoom(f,room);assert.equal(state.directorFailure,null);
  const opinion=anchorFor(state,story.opinion);assert.equal(opinion.scene.relation,'continue');
  assert.deepEqual(opinion.scene.focus,first.scene.focus);
  for(const request of f.calls.filter(request=>readChatInput(request).message===story.opinion)){
    const control=readChatInput(request);
    assert.deepEqual(control.recipients.map(person=>person.id),[dragon,claude]);
    assert.ok(control.conversationScene.relatedReplies.some(pointer=>pointerText(request,pointer)?.includes('SUMMARY_PUBLIC')),
      'a new user message must not reset the public shared task to an unaddressed request');
    assert.ok(control.sharedResponse.priorReplyEvents.length>0);
    assert.equal(control.sharedResponse.workRole,'optional-addition');
  }
  assert.doesNotMatch(f.calls.find(request=>readChatInput(request).speaker.id===dragon).system,/WHALE_PRIVATE_SCENE_STYLE/);
  await targets(f,room,[whale,dragon]);assert.equal((await roomSend(f,room,whale,story.pause,'scene-pause')).status,200);
  state=await settledRoom(f,room);assert.equal(state.directorFailure,null);
  const paused=anchorFor(state,story.pause),pauseReplies=repliesFor(state,paused);
  assert.equal(paused.scene.relation,'pause');assert.deepEqual(paused.scene.parked,first.scene.focus);
  assert.equal(paused.scene.focus.messageId,paused.userParts[0].id);
  assert.equal(paused.scene.transition.reply.turnId,pauseReplies[0].id);
  const pauseCalls=f.calls.filter(request=>readChatInput(request).message===story.pause);
  assert.equal(pauseCalls.length,2);
  assert.equal(readChatInput(pauseCalls[0]).conversationScene.transition.reply,null);
  assert.ok(readChatInput(pauseCalls[1]).conversationScene.transition.reply,'only the first committed response consumes the shared transition');
  for(const request of pauseCalls){assert.deepEqual(readChatInput(request).workContext.sources,[]);assert.doesNotMatch(JSON.stringify(readChatInput(request).workContext),/SOURCE_REPORT_RISK/);
    assert.doesNotMatch(JSON.stringify(request.messages),/SUMMARY_PUBLIC/,
      'a parked work summary must not return through broad history or a member\'s old unread inbox');}
  await targets(f,room,[claude]);assert.equal((await roomSend(f,room,claude,story.resume,'scene-resume')).status,200);
  state=await settledRoom(f,room);assert.equal(state.directorFailure,null);
  const resumed=anchorFor(state,story.resume);assert.equal(resumed.scene.relation,'resume');assert.deepEqual(resumed.scene.focus,first.scene.focus);
  const final=readChatInput(f.calls.at(-1));assert.equal(final.conversationScene.relation,'resume');
  assert.match(JSON.stringify(final.workContext.sources),/SOURCE_REPORT_RISK/,'resuming reselects original evidence rather than inventing a task result from prior social talk');
  assert.doesNotMatch(JSON.stringify(f.directors),/SOURCE_REPORT_RISK|WHALE_PRIVATE_SCENE_STYLE|DRAGON_PRIVATE_SCENE_STYLE/);
  assert.doesNotMatch(JSON.stringify(savedRoom(f,room).turns.map(turn=>turn.scene).filter(Boolean)),/SUMMARY_PUBLIC|SOURCE_REPORT_RISK|挪近|PRIVATE_SCENE_STYLE/,
    'scene persistence contains references and relations, not copied dialogue or private preferences');
  const before=f.requests.length;await flush();assert.equal(f.requests.length,before,'a settled sequence creates no new scene model or background poll');
});

test('streamed text cannot acknowledge a room transition before the complete reply is committed',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const {f,room}=await preparePause(t,{pauseScript:options=>readChatInput(options).speaker.id===whale?(async function*(){
    yield{type:'text-delta',text:JSON.stringify({messages:['（把资料合上。）来。']})};await gate;yield{type:'finish',reason:{kind:'stop'}};
  })():reply(['这里也留着位置。'])});
  await roomSend(f,room,whale,story.pause,'streamed-transition');await flush();
  const pending=await roomState(f,room),anchor=anchorFor(pending,story.pause);
  assert.ok(anchor.scene?.transition);assert.equal(anchor.scene.transition.reply,null);
  assert.equal(f.calls.filter(request=>readChatInput(request).message===story.pause).length,1);
  assert.equal(savedRoom(f,room).turns.find(turn=>turn.id===anchor.id).scene.transition.reply,null,
    'provisional display does not consume a durable shared transition');
  release();const done=await settledRoom(f,room),committed=anchorFor(done,story.pause),completed=repliesFor(done,committed).filter(turn=>turn.status==='ready');
  assert.equal(committed.scene.transition.reply.turnId,completed[0].id);
  const second=f.calls.filter(request=>readChatInput(request).message===story.pause)[1];
  assert.ok(readChatInput(second).conversationScene.transition.reply);
  assert.equal(pointerText(second,readChatInput(second).conversationScene.transition.reply),'（把资料合上。）来。');
});

test('old unread work messages cannot bypass an active scene through the actual actor inbox',async t=>{
  const {f,room}=await preparePause(t,{pauseOrder:[dragon]});
  await roomSend(f,room,dragon,story.pause,'old-unread-paused');
  const state=await settledRoom(f,room);assert.equal(state.directorFailure,null);
  const request=f.calls.find(options=>readChatInput(options).message===story.pause);assert.ok(request);
  assert.equal(readChatInput(request).speaker.id,dragon);
  assert.doesNotMatch(JSON.stringify(request.messages),/已完成的公开摘要|SOURCE_REPORT_RISK/,
    'an unread earlier work cycle is background, not an explicit request to restore parked report text');
  const original=anchorFor(state,story.summary);
  assert.ok(repliesFor(state,original).some(turn=>turn.assistant.includes('已完成的公开摘要。')),
    'retrieval selection must preserve original room records');
});

test('a silent participant neither consumes the shared transition nor spends an ordinary opportunity',async t=>{
  const {f,room}=await preparePause(t,{pauseScript:options=>reply(readChatInput(options).speaker.id===whale?[]:['另一位完整接住了转场。'])});
  await roomSend(f,room,whale,story.pause,'silent-transition');const done=await settledRoom(f,room),anchor=anchorFor(done,story.pause);
  const turns=repliesFor(done,anchor);assert.deepEqual(turns.map(turn=>turn.recipientId),[dragon]);
  assert.equal(anchor.scene.transition.reply.turnId,turns[0].id);
  const pauseCalls=f.calls.filter(request=>readChatInput(request).message===story.pause);assert.equal(pauseCalls.length,2);
  assert.equal(readChatInput(pauseCalls[1]).conversationScene.transition.reply,null,'silence is not a public scene movement');
  const afterSilence=f.directors.map(readChatInput).find(body=>body.message===story.pause&&body.states.find(state=>state.id===whale)?.normalReady===false);
  assert.ok(afterSilence);assert.equal(afterSilence.states.find(state=>state.id===whale).normalRemaining,3);
  assert.equal(afterSilence.states.find(state=>state.id===whale).level,0);
});

test('an incomplete first actor leaves the transition pending and its exact retry can acknowledge it once',async t=>{
  let succeed=false;
  const {f,room}=await preparePause(t,{pauseOrder:[whale],pauseScript:()=>reply(['尚未完整提交的动作。'],succeed?'stop':'max-tokens')});
  await roomSend(f,room,whale,story.pause,'failed-transition');let state=await settledRoom(f,room),anchor=anchorFor(state,story.pause);
  const failed=repliesFor(state,anchor)[0];assert.equal(failed.status,'failed');assert.equal(anchor.scene.transition.reply,null);
  assert.deepEqual(failed.assistant,[]);succeed=true;
  assert.equal((await f.request('chat',{...room,action:'retry',personaId:whale,id:failed.id,attemptId:'exact-scene-retry',revision:state.room.revision,epoch:state.epoch})).status,200);
  state=await settledRoom(f,room);anchor=anchorFor(state,story.pause);
  const retried=repliesFor(state,anchor)[0];assert.equal(retried.status,'ready');assert.equal(anchor.scene.transition.reply.turnId,retried.id);
  assert.equal(anchor.scene.transition.reply.attemptId,'exact-scene-retry');
  assert.equal(repliesFor(state,anchor).length,1,'retrying a failed seat does not append a replacement user cycle or reply');
});

test('a failed scene save dispatches no actor and an explicit retry can persist the same user scene',async t=>{
  let failNextScene=true,rejectCurrent=false;
  const storage=domain(Promise.resolve(),{fail:id=>rejectCurrent&&id==='personaChats',beforePut(id,value){
    rejectCurrent=id==='personaChats'&&failNextScene&&value.rooms?.some(room=>room.turns?.some(turn=>turn.phase==='anchor'&&turn.user===story.pause&&turn.scene?.relation==='pause'));
    if(rejectCurrent)failNextScene=false;
  }});
  const {f,room}=await preparePause(t,{storage,pauseOrder:[whale]});
  await roomSend(f,room,whale,story.pause,'save-failed-transition');let state=await settledRoom(f,room),anchor=anchorFor(state,story.pause);
  assert.equal(f.calls.filter(request=>readChatInput(request).message===story.pause).length,0,'no LLM dispatch may use an uncommitted scene choice');
  assert.ok(state.directorFailure);assert.equal(anchor.scene,undefined);
  assert.equal((await f.request('chat',{...room,action:'retry-director',personaId:whale,messageId:anchor.messageId,epoch:state.epoch})).status,200);
  state=await settledRoom(f,room);anchor=anchorFor(state,story.pause);
  assert.equal(state.directorFailure,null);assert.equal(anchor.scene.relation,'pause');assert.ok(anchor.scene.transition.reply);
  assert.equal(f.calls.filter(request=>readChatInput(request).message===story.pause).length,1);
  assert.equal(state.room.turns.filter(turn=>turn.phase==='anchor'&&turn.user===story.pause).length,1);
});

test('new reference scopes and other rooms cannot reuse the former task as a scene target',async t=>{
  const fresh='换个范围后说一件新事';
  const {f,room,seeded}=await preparePause(t,{directorPause:body=>direct(body,said(body).length?undefined:whale,'fresh','N')});
  const first=anchorFor(seeded,story.summary),before=f.requests.length;
  const changed=await f.request('chat-context',{...room,action:'detach',sessionId:'work',revision:Number(room.contextKey.split(':').at(-1))});
  assert.equal(changed.status,200);const binding={roomId:room.roomId,contextKey:changed.value.id+':'+changed.value.revision};
  await roomSend(f,binding,whale,fresh,'new-scope-scene');let state=await settledRoom(f,binding);
  assert.equal(state.directorFailure,null);
  const scopeRequest=f.directors.map(readChatInput).find(body=>body.message===fresh);
  assert.doesNotMatch(JSON.stringify(scopeRequest.sceneCatalog),/已完成的公开摘要|帮我总结这个任务/);
  assert.ok(!JSON.stringify(scopeRequest.sceneCatalog).includes(first.scene.focus.messageId));
  assert.equal(anchorFor(state,fresh).scene.parked,null);
  const b=await newRoom(f,[whale],'另一个房间','scene-isolated-room');
  await roomSend(f,b,whale,'另一个房间的独立消息','foreign-room-scene');state=await settledRoom(f,b);
  assert.equal(state.directorFailure,null);
  const other=f.directors.map(readChatInput).find(body=>body.message==='另一个房间的独立消息');
  assert.ok(!JSON.stringify(other.sceneCatalog).includes(first.scene.focus.messageId));
  assert.doesNotMatch(JSON.stringify(f.requests.slice(before)),/已完成的公开摘要/,'a changed scope cannot leak the former scene through ordinary model context');
});

test('excluding the basis while a scene selection is in flight prevents a late transition from being committed',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const {f,room,seeded}=await preparePause(t,{pauseOrder:[whale],directorPause:body=>(async function*(){
    const choice=body.choices.find(option=>option.id===whale&&option.to==='user'),key=sceneKey(body,'pause');
    await gate;yield*wire(`${choice.choiceId} N ${key}`);
  })()});
  const basis=anchorFor(seeded,story.summary).scene.focus;
  await roomSend(f,room,whale,story.pause,'exclude-in-flight-scene');await flush();
  const view=(await f.request('chat-references?room='+encodeURIComponent(room.roomId))).value;
  assert.equal((await f.request('chat-references',{roomId:room.roomId,ref:basis,excluded:true,referenceRevision:view.referenceRevision,epoch:view.epoch})).status,200);
  release();const done=await settledRoom(f,room),anchor=anchorFor(done,story.pause);
  assert.equal(f.calls.filter(request=>readChatInput(request).message===story.pause).length,0);
  assert.equal(anchor.scene,undefined,'late model output cannot resurrect a revoked source pointer');
  assert.ok(!savedRoom(f,room).turns.find(turn=>turn.id===anchor.id).scene);
});

test('a committed transition survives reopen and restart without new calls, while continued conversation retains its public receipt',async t=>{
  const storage=domain(),{f,room}=await preparePause(t,{storage});
  await roomSend(f,room,whale,story.pause,'restart-transition');const settled=await settledRoom(f,room),anchor=anchorFor(settled,story.pause);
  assert.ok(anchor.scene.transition.reply);const previous=structuredClone(anchor.scene);
  const before=f.requests.length;
  assert.equal((await f.request('chat-context',{action:'presence',...room,viewer:'viewer-pause-boundary',sequence:2,visible:false})).status,200);
  await flush();assert.equal(f.requests.length,before,'closing the view cannot create scene updates or character messages');await f.dispose();
  const followup='大家接着靠一会儿';
  const g=fixture(t,{storage,extraServices:sourceServices(),directorScript:options=>{
    const body=readChatInput(options);return direct(body,said(body).length?undefined:whale,'continue','N');
  },script:()=>reply(['仍然接着刚才的互动。'])});
  await g.ready();assert.equal(g.requests.length,0);
  const opened=(await g.request('chat-context',{action:'open',roomId:room.roomId,viewer:'restart-view',sequence:1,sessionId:'work'})).value;
  const binding={roomId:room.roomId,contextKey:opened.id+':'+opened.revision};
  let restored=await roomState(g,binding);assert.equal(g.requests.length,0);assert.deepEqual(anchorFor(restored,story.pause).scene,previous);
  await targets(g,binding,[whale]);await roomSend(g,binding,whale,followup,'continued-after-restart');restored=await settledRoom(g,binding);
  assert.equal(restored.directorFailure,null);assert.equal(g.calls.length,1);
  const control=readChatInput(g.calls[0]);assert.equal(control.conversationScene.relation,'continue');
  assert.ok(control.conversationScene.transition.reply,'an existing transition remains acknowledged across a new user cycle');
  assert.equal(control.opportunity.normalRemainingAfterThis,2,'only the new user message resets the ordinary opportunity, not restoring the scene');
  assert.deepEqual(control.workContext.sources,[]);
});

test('a legacy no-work choice stays compatible without inventing a casual scene transition',async t=>{
  const {f,room}=await preparePause(t,{pauseOrder:[whale],directorPause:body=>{
    if(said(body).length)return wire('WAIT');
    const choice=body.choices.find(option=>option.id===whale&&option.to==='user'&&option.kind==='normal');
    return wire(`${choice.choiceId} N`);
  }});
  await roomSend(f,room,whale,story.pause,'legacy-no-scene');const done=await settledRoom(f,room),anchor=anchorFor(done,story.pause);
  assert.equal(done.directorFailure,null);assert.equal(anchor.scene,undefined);
  const request=f.calls.find(request=>readChatInput(request).message===story.pause);assert.ok(request);
  assert.ok(readChatInput(request).conversationScene==null,'a work-selection token carries no conversational scene authority');
  assert.deepEqual(readChatInput(request).workContext.sources,[]);
});

test('a scene-bound wait freezes a public transition without dispatching a character or consuming its receipt',async t=>{
  const {f,room}=await preparePause(t,{pauseOrder:[whale],directorPause:body=>wire(`WAIT N ${sceneKey(body,'pause')}`)});
  const calls=f.requests.length;
  await roomSend(f,room,whale,story.pause,'wait-with-scene');const done=await settledRoom(f,room),anchor=anchorFor(done,story.pause);
  assert.equal(done.directorFailure,null);assert.equal(anchor.scene.relation,'pause');assert.equal(anchor.scene.transition.reply,null);
  assert.equal(f.calls.filter(request=>readChatInput(request).message===story.pause).length,0);
  assert.equal(f.requests.length,calls+1,'a no-speaker decision does not start an actor or a second scene thread');
  assert.equal(savedRoom(f,room).turns.find(turn=>turn.id===anchor.id).scene.transition.reply,null);
});

test('a rejected completed-reply save cannot leave a transition acknowledged before its exact retry commits',async t=>{
  let rejectReplyOnce=true;
  const storage=domain(Promise.resolve(),{beforePut(id,value){
    if(id==='personaChats'&&rejectReplyOnce&&value.rooms?.some(room=>room.turns?.some(turn=>turn.phase==='anchor'&&turn.user===story.pause&&turn.scene?.transition?.reply))){
      rejectReplyOnce=false;throw Error('simulated reply persistence failure');
    }
  }});
  const {f,room}=await preparePause(t,{storage,pauseOrder:[whale]});
  await roomSend(f,room,whale,story.pause,'atomic-reply-scene');let state=await settledRoom(f,room),anchor=anchorFor(state,story.pause);
  const failed=repliesFor(state,anchor)[0];assert.equal(failed.status,'failed');assert.equal(anchor.scene.transition.reply,null);
  assert.equal(savedRoom(f,room).turns.find(turn=>turn.id===anchor.id).scene.transition.reply,null);
  assert.equal((await f.request('chat',{...room,action:'retry',personaId:whale,id:failed.id,attemptId:'durable-scene-retry',revision:state.room.revision,epoch:state.epoch})).status,200);
  state=await settledRoom(f,room);anchor=anchorFor(state,story.pause);
  const complete=repliesFor(state,anchor)[0];assert.equal(complete.status,'ready');
  assert.equal(anchor.scene.transition.reply.turnId,complete.id);assert.equal(anchor.scene.transition.reply.attemptId,'durable-scene-retry');
  assert.deepEqual(savedRoom(f,room).turns.find(turn=>turn.id===anchor.id).scene,anchor.scene);
});
