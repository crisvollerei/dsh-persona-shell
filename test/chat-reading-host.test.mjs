import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,reply,preference,newRoom,roomSend,roomState,settledRoom,whale,dragon,claude,readChatInput} from './helpers/persona-chat-host.mjs';

// Synthetic replies isolate the real Host's request construction. They are not
// evidence that a model's conversation or persona expression has improved.
const little='鲸鲸（实验性）',cat='Gemini';
const wire=text=>(async function*(){yield{type:'text-delta',text};yield{type:'finish',reason:{kind:'stop'}};})();
const packet=message=>JSON.parse(message.content[0].text);
const said=body=>body.events.filter(event=>event.author.role==='assistant');
async function targets(f,room,ids){
  const state=await roomState(f,room);
  assert.equal((await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:ids,
    configRevision:state.room.configRevision,epoch:state.epoch})).status,200);
}
function choose(body,id,{kind='normal',to='user',eventId,index,work='N',point='接选中的这条真实原话。'}={}){
  const choice=body.choices.find(value=>value.id===id&&value.kind===kind&&value.to===to
    &&(eventId===undefined||value.eventId===eventId)&&(index===undefined||value.index===index));
  if(!choice)return wire('WAIT');
  const scene=body.sceneCatalog.options.find(value=>value.key==='K')??body.sceneCatalog.options.find(value=>value.key==='F');
  assert.ok(scene);
  return wire(`${choice.choiceId} ${work} ${scene.key} react | ${point}`);
}
function sourceServices(){
  return [['sessions',{get:id=>({header:{id,title:'阅读顺序合成项目',cwd:'D:/synthetic/reading-order'}})}],
    ['sessionQuery',{observeSession:async()=>({events:[
      {seq:1,type:'turn/start',data:{turn:1}},
      {seq:2,type:'user/message',data:{content:[{type:'text',text:'READING_SOURCE_GOAL：只读核对，不发布。'}]}},
      {seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:'READING_SOURCE_REPORT：原作者离线检查通过，设备尚未验证；建议不是批准。'}]}}},
      {seq:4,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
    ]})}]];
}
function assertOriginalTimeline(request,state){
  const body=readChatInput(request),control=body.__control,keys=[];
  for(const event of control.timeline){
    assert.ok(Number.isInteger(event.messageIndex)&&event.messageIndex>=0&&event.messageIndex<request.messages.length-1);
    const raw=request.messages[event.messageIndex],decoded=packet(raw),semantic=body.__events.get(event.eventId);
    assert.equal(semantic.messages.length,event.bubbles.length);
    if(event.author.role==='user'){
      assert.equal(raw.role,'user');assert.deepEqual(decoded.author,event.author);
      assert.equal(event.bubbles.length,1);
      const ref=event.bubbles[0].ref;
      assert.equal(ref.roomId,state.room.id);assert.equal(ref.generation,state.room.generation??0);
      const original=state.room.turns.filter(value=>value.phase==='anchor').flatMap(value=>value.userParts).find(value=>value.id===ref.messageId);
      assert.ok(original,'every admitted user original resolves to a real persisted part');
      assert.deepEqual(semantic.messages,[original.text]);keys.push('u:'+ref.messageId);
    }else{
      const original=state.room.turns.find(value=>value.id===event.turnId&&value.attemptId===event.attemptId);
      assert.ok(original&&original.status==='ready');assert.equal(event.author.id,original.recipientId);
      assert.equal(event.author.name,original.speakerName);assert.deepEqual(semantic.messages,original.assistant);
      const own=event.author.id===body.speaker.id;
      assert.equal(raw.role,own?'assistant':'user');
      if(!own)assert.deepEqual(decoded.author,event.author);
      assert.deepEqual(raw.source,{kind:'model',provider:'persona-chat-history',model:'unknown'});
      keys.push('a:'+event.turnId+':'+event.attemptId);
    }
  }
  const admitted=new Set(keys),expected=[];
  for(const messageId of [...new Set(state.room.turns.map(value=>value.messageId))]){
    const group=state.room.turns.filter(value=>value.messageId===messageId),head=group.find(value=>value.phase==='anchor');
    for(const part of head?.userParts??[])expected.push('u:'+part.id);
    for(const turn of group.filter(value=>value.phase!=='anchor'&&value.status==='ready').sort((a,b)=>a.emittedOrder-b.emittedOrder))expected.push('a:'+turn.id+':'+turn.attemptId);
  }
  assert.deepEqual(keys,expected.filter(key=>admitted.has(key)),'timeline stays chronological even when SDK message reading order changes');
  assert.equal(new Set(control.timeline.map(value=>value.messageIndex)).size,control.timeline.length);
  assert.equal(packet(request.messages.at(-1)).task,'chat-control');
  return body;
}

test('actual five-person user-facing requests put current originals after peer background while retaining history, source and private-memory boundaries',async t=>{
  const seed='先留一句本人原话。',current='大家各说一句自己的看法，仍只讨论，不执行。';
  const order=[whale,dragon,cat,little,claude],seedReply=['READING_SELF_HISTORY：这是我先前真实提交的原话。'];
  const responses=new Map(order.map((id,index)=>[id,[`READING_PEER_${index}_FIRST`,`READING_PEER_${index}_SECOND`]]));
  const f=fixture(t,{extraServices:sourceServices(),directorScript:options=>{
    const body=readChatInput(options),id=body.message===seed?(said(body).length?undefined:claude):order[said(body).length];
    return choose(body,id,{work:body.message===current?'s1':'N'});
  },script:options=>{
    const body=readChatInput(options);return reply(body.message===seed?seedReply:responses.get(body.speaker.id));
  }});
  await f.ready();await preference(f,'READING_CLAUDE_PRIVATE',claude);await preference(f,'READING_WHALE_PRIVATE',whale);
  const room=await newRoom(f,order,'真实Host阅读顺序','reading-five');await targets(f,room,[claude]);
  assert.equal((await roomSend(f,room,claude,seed,'reading-seed')).status,200);await settledRoom(f,room);
  assert.equal(readChatInput(f.calls[0]).readingFocus,undefined,'a first solo reply has no peer context and keeps the old organization');
  await targets(f,room,[]);
  assert.equal((await roomSend(f,room,whale,current,'reading-current')).status,200);
  const done=await settledRoom(f,room);assert.equal(done.directorFailure,null);
  const calls=f.calls.filter(options=>readChatInput(options).message===current);
  assert.deepEqual(calls.map(options=>readChatInput(options).speaker.id),order);
  const request=calls.at(-1),body=assertOriginalTimeline(request,done),control=body.__control;
  assert.ok(control.readingFocus);assert.equal(body.speaker.id,claude);
  const currentEvent=control.timeline.find(value=>control.currentMessage.eventIds.includes(value.eventId));
  const peers=control.timeline.filter(value=>value.messageId==='reading-current'&&value.author.role==='assistant');
  assert.equal(peers.length,4);assert.ok(peers.every(value=>value.contextRole==='peer-background'&&value.messageIndex<currentEvent.messageIndex));
  assert.equal(currentEvent.messageIndex,request.messages.length-2);
  assert.equal(control.timeline.filter(value=>value.messageId==='reading-current')[0].eventId,currentEvent.eventId);
  assert.deepEqual(body.exchange.map(value=>value.messages),order.slice(0,-1).map(id=>responses.get(id)));
  const own=request.messages.filter(value=>value.role==='assistant');assert.equal(own.length,1);assert.deepEqual(packet(own[0]),{messages:seedReply});
  assert.ok(control.timeline.some(value=>value.contextRole==='self-history'));
  assert.equal(body.workContext.sources.length,1);assert.equal(body.workContext.sources[0].goal,'READING_SOURCE_GOAL：只读核对，不发布。');
  assert.equal(body.workContext.sources[0].report,'READING_SOURCE_REPORT：原作者离线检查通过，设备尚未验证；建议不是批准。');
  assert.match(request.system,/READING_CLAUDE_PRIVATE/);assert.doesNotMatch(request.system,/READING_WHALE_PRIVATE/);
  assert.doesNotMatch(JSON.stringify(f.directors),/READING_CLAUDE_PRIVATE|READING_WHALE_PRIVATE/);
  assert.doesNotMatch(JSON.stringify(request.messages.slice(0,-1)),/READING_SOURCE_REPORT|READING_CLAUDE_PRIVATE/);
});

test('a real older peer target keeps its full event after current user originals; same-text quotes and a failed exact retry retain their sources',async t=>{
  const initial='顺着杯子的设想随意聊聊。',quoted='引用较早那一轮的第二泡，只接这句限制。';
  const duplicate=['GPT、小肥鱼，你们觉得杯子会自己续杯吗？','READING_EXACT_CONDITION：只聊这个设想，不替用户安排动作。'];
  let failQuote=true;
  const f=fixture(t,{directorScript:options=>{
    const body=readChatInput(options),spoken=said(body);
    if(body.message===quoted)return spoken.length?wire('WAIT'):choose(body,little,{point:'对照用户这次引用的原话回应。'});
    if(!spoken.length)return choose(body,whale);
    if(spoken.length===1)return choose(body,dragon,{kind:'peer',to:whale,eventId:spoken[0].id});
    if(spoken.length===2)return choose(body,whale,{kind:'peer',to:dragon,eventId:spoken[1].id});
    if(spoken.length===3)return choose(body,little,{kind:'peer',to:whale,eventId:spoken[0].id});
    return wire('WAIT');
  },script:options=>{
    const body=readChatInput(options);
    if(body.message===quoted)return reply([failQuote?'UNCOMMITTED_READING_PREVIEW':'只回应这句已引用的限制。'],failQuote?'max-tokens':'stop');
    return reply(body.speaker.id===whale?duplicate:body.speaker.id===dragon?['鲸鲸，我请你把杯子那句再接一下。']:['先接你原来问我的那一句。']);
  }});
  await f.ready();const room=await newRoom(f,[whale,dragon,little],'精确同伴阅读目标','reading-peer');await targets(f,room,[]);
  assert.equal((await roomSend(f,room,whale,initial,'reading-peer-user')).status,200);
  let done=await settledRoom(f,room);assert.equal(done.directorFailure,null);
  assert.deepEqual(f.calls.map(options=>readChatInput(options).speaker.id),[whale,dragon,whale,little]);
  const request=f.calls[3],body=assertOriginalTimeline(request,done),control=body.__control;
  const target=control.timeline.find(value=>value.eventId===control.replyTarget.eventId);
  const whales=control.timeline.filter(value=>value.author.id===whale);
  assert.equal(whales.length,2);assert.equal(target.turnId,whales[0].turnId);assert.notEqual(target.turnId,whales[1].turnId);
  assert.equal(target.contextRole,'reply-target');assert.equal(target.messageIndex,request.messages.length-2);
  assert.deepEqual(packet(request.messages[target.messageIndex]).messages.map(value=>value.text),duplicate);
  const user=control.timeline.find(value=>control.currentMessage.eventIds.includes(value.eventId));
  assert.equal(user.messageIndex,target.messageIndex-1);assert.ok(whales[1].messageIndex<user.messageIndex);
  assert.deepEqual(control.timeline.map(value=>value.author.id??'user'),['user',whale,dragon,whale]);
  const first=done.room.turns.find(value=>value.id===whales[0].turnId);
  const quote={roomId:room.roomId,generation:done.room.generation??0,kind:'assistant',turnId:first.id,attemptId:first.attemptId,index:1};
  await targets(f,room,[little]);let state=await roomState(f,room);
  assert.equal((await f.request('chat',{...room,action:'send',personaId:little,content:quoted,requestId:'reading-quote-user',quote,
    revision:state.room.revision,epoch:state.epoch})).status,200);
  done=await settledRoom(f,room);const failed=done.room.turns.find(value=>value.messageId==='reading-quote-user'&&value.phase!=='anchor');
  assert.equal(failed.status,'failed');assert.deepEqual(failed.assistant,[]);
  const failedRequest=f.calls.at(-1),failedBody=readChatInput(failedRequest);
  assert.deepEqual(failedBody.quotedMessage.ref,quote);assert.equal(failedBody.quotedMessage.text,duplicate[1]);
  failQuote=false;
  assert.equal((await f.request('chat',{...room,action:'retry',personaId:little,id:failed.id,attemptId:'reading-exact-retry',
    revision:done.room.revision,epoch:done.epoch})).status,200);
  done=await settledRoom(f,room);assert.equal(done.directorFailure,null);
  const retriedRequest=f.calls.at(-1),retried=assertOriginalTimeline(retriedRequest,done);
  assert.deepEqual(retried.quotedMessage,failedBody.quotedMessage);assert.deepEqual(retried.replyTarget,failedBody.replyTarget);
  assert.deepEqual(retried.directorAssignment,failedBody.directorAssignment);
  assert.equal(retried.__control.timeline.find(value=>value.eventId===retried.quotedMessage.pointer.eventId).turnId,first.id);
  assert.doesNotMatch(JSON.stringify(retriedRequest),/UNCOMMITTED_READING_PREVIEW/);
  assert.equal(done.room.turns.filter(value=>value.messageId==='reading-quote-user'&&value.phase!=='anchor').length,1);
  assert.equal(done.room.turns.find(value=>value.id===failed.id).attemptId,'reading-exact-retry');
});

test('two real queued user parts stay together in original order behind peer background, including the exact trailing target',async t=>{
  const parts=['先听我把这两句说完。','READING_TRAILING_CONDITION：只讨论，不执行。'];
  const f=fixture(t,{directorScript:options=>{
    const body=readChatInput(options),id=[whale,dragon][said(body).length];
    assert.equal(body.message,parts.join('\n'));
    return choose(body,id,{index:1});
  },script:()=>reply(['一份已经完整提交的合成同伴回复。'])});
  await f.ready();const room=await newRoom(f,[whale,dragon],'用户分段完整阅读','reading-parts');await targets(f,room,[]);
  // The two sends happen before the Host's zero-delay drain timer: this uses
  // the real durable queue, not a hand-built actor prompt or patched helper.
  assert.equal((await roomSend(f,room,whale,parts[0],'reading-part-one')).status,200);
  assert.equal((await roomSend(f,room,whale,parts[1],'reading-part-two')).status,200);
  const done=await settledRoom(f,room);assert.equal(done.directorFailure,null);
  const head=done.room.turns.find(value=>value.phase==='anchor');
  assert.deepEqual(head.userParts.map(value=>[value.id,value.text]),[['reading-part-one',parts[0]],['reading-part-two',parts[1]]]);
  assert.equal(f.calls.length,2);
  const request=f.calls[1],body=assertOriginalTimeline(request,done),control=body.__control;
  assert.equal(body.message,parts.join('\n'));assert.equal(body.replyTarget.text,parts[1]);
  assert.deepEqual(control.readingFocus.currentUserEventIds,control.currentMessage.eventIds);
  const users=control.currentMessage.eventIds.map(id=>control.timeline.find(value=>value.eventId===id));
  assert.deepEqual(users.map(value=>value.bubbles[0].ref.messageId),['reading-part-one','reading-part-two']);
  assert.deepEqual(users.map(value=>value.messageIndex),[request.messages.length-3,request.messages.length-2]);
  assert.deepEqual(request.messages.slice(-3,-1).map(value=>packet(value).messages[0].text),parts);
  assert.deepEqual(control.timeline.map(value=>value.author.id??'user'),['user','user',whale]);
  assert.equal(control.timeline.find(value=>value.eventId===control.replyTarget.eventId).bubbles[0].ref.messageId,'reading-part-two');
});
