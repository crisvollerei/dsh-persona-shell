import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, reply, flush, newRoom, roomSend, roomState, settledRoom, whale, dragon, readChatInput } from './helpers/persona-chat-host.mjs';
import { buildDirectorRequest, parseDirectorResponse } from '../lib/chat-director-wire.js';
import { buildChatPrompt } from '../lib/chat-prompt.js';

const eventsFor=id=>[
  {seq:1,type:'turn/start',data:{turn:1}},
  {seq:2,type:'user/message',data:{content:[{type:'text',text:id+'_ORIGINAL_GOAL'}]}},
  {seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:id+'_ORIGINAL_REPORT'}]}}},
  {seq:4,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
];
const wire=line=>(async function*(){yield{type:'text-delta',text:line};yield{type:'finish',reason:{kind:'stop'}};})();
const choiceFor=(body,id)=>body.choices.find(choice=>choice.id===id&&choice.to==='user');
const workWire=(body,choice)=>`D1 ${body.protocol.ticket} ${choice.choiceId} s1 answer q0`;

function sourceHost(t,directorScript){
  const reads=[],events=new Map(['work','other'].map(id=>[id,eventsFor(id)]));let fail=false;
  const f=fixture(t,{directorScript,script:()=>reply(['围绕本次真实资料回应。']),extraServices:[
    ['sessions',{get:id=>({header:{id,title:id+' 的工作会话',cwd:'D:/fixture/'+id}})}],
    ['sessionQuery',{observeSession:async id=>{reads.push(id);if(fail)throw Error('PRIVATE_SOURCE_READ_FAILURE');return{events:events.get(id)??[]};}}],
  ]});
  return{f,reads,failSource(){fail=true;const event={seq:5,type:'user/message',data:{content:[{type:'text',text:'work_UPDATED_GOAL'}]}};
    events.get('work').push(event);f.bus.emit('session/event',{id:'work',header:{},append(){assert.fail('chat cannot modify a work session');}},event);}};
}

test('a short action plus source key grounds the first actual reply in the fixed primary source without guessing a request type',async t=>{
  const {f}=sourceHost(t,options=>{const body=readChatInput(options),choice=choiceFor(body,whale);return wire(choice?choice.choiceId+' s1':'WAIT');});
  await f.ready();const room=await newRoom(f,[whale]);
  await roomSend(f,room,whale,'这个任务呀','short-source');await settledRoom(f,room);
  assert.equal(f.directors.length,1);assert.equal(f.calls.length,1);
  const answer=readChatInput(f.calls[0]);assert.deepEqual(answer.workContext.sources.map(source=>source.sessionId),['work']);
  assert.match(JSON.stringify(answer.workContext),/work_ORIGINAL_GOAL/);assert.match(JSON.stringify(answer.workContext),/work_ORIGINAL_REPORT/);
  assert.equal(answer.coordination.work,'required');assert.equal(answer.coordination.request,'unclear','selecting material does not silently turn an ambiguous request into a request for advice');
  const body=readChatInput(f.directors[0]);assert.equal(body.sources[0].primary,true);
  assert.doesNotMatch(JSON.stringify(f.directors),/ORIGINAL_GOAL|ORIGINAL_REPORT/);
});

test('a required source selected for one reply remains grounded for the next bare-choice reply in the same user round',async t=>{
  const {f,reads}=sourceHost(t,(options,count)=>{
    const body=readChatInput(options),choice=choiceFor(body,count===1?whale:dragon);
    return wire(choice?count===1?workWire(body,choice):choice.choiceId:'WAIT');
  });
  await f.ready();const room=await newRoom(f,[whale,dragon]),state=await roomState(f,room);
  assert.equal((await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[whale,dragon],configRevision:state.room.configRevision,epoch:state.epoch})).status,200);
  const baseline=reads.length;await roomSend(f,room,whale,'你们看看这个任务','same-round');await settledRoom(f,room);
  assert.equal(f.calls.length,2);assert.equal(f.directors.length,2);
  const answers=f.calls.map(readChatInput);
  assert.deepEqual(answers[0].workContext.sources.map(source=>source.sessionId),['work']);
  assert.deepEqual(answers[1].workContext.sources.map(source=>source.sessionId),['work'],'omitted auxiliary context must not erase this round\'s already verified work selection');
  assert.match(JSON.stringify(answers[1].workContext),/work_ORIGINAL_GOAL/);
  assert.deepEqual(reads.slice(baseline),[],'one fresh source snapshot can serve both actual replies without another model or source read');
  assert.doesNotMatch(JSON.stringify(f.directors),/ORIGINAL_GOAL|ORIGINAL_REPORT/,'the shared selector only sees attached source metadata');
});

test('a selected source read failure reaches the actor as unavailable evidence rather than an unexplained empty envelope',async t=>{
  const {f,failSource}=sourceHost(t,options=>{const body=readChatInput(options),choice=choiceFor(body,whale);return wire(choice?workWire(body,choice):'WAIT');});
  await f.ready();const room=await newRoom(f,[whale]);failSource();
  await roomSend(f,room,whale,'看一下这个任务现在的目标','read-failure');await settledRoom(f,room);
  assert.equal(f.calls.length,1);const answer=readChatInput(f.calls[0]);
  assert.deepEqual(answer.workContext.sources,[]);
  assert.ok(answer.workContext.omitted.some(source=>source.reason==='read-failed'),'selected but unreadable material must retain its specific absence reason');
  assert.doesNotMatch(JSON.stringify(f.calls),/PRIVATE_SOURCE_READ_FAILURE|work_ORIGINAL_GOAL|work_ORIGINAL_REPORT|work_UPDATED_GOAL/);
});

test('an explicit no-work token clears a prior selected source in the same round',async t=>{
  const {f}=sourceHost(t,(options,count)=>{const body=readChatInput(options),choice=choiceFor(body,count===1?whale:dragon);
    return wire(choice?choice.choiceId+(count===1?' s1':' N'):'WAIT');});
  await f.ready();const room=await newRoom(f,[whale,dragon]),state=await roomState(f,room);
  assert.equal((await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[whale,dragon],configRevision:state.room.configRevision,epoch:state.epoch})).status,200);
  await roomSend(f,room,whale,'先看这个任务，再顺着话题聊两句','explicit-no-work');await settledRoom(f,room);
  assert.equal(f.calls.length,2);const [first,second]=f.calls.map(readChatInput);
  assert.equal(first.workContext.sources.length,1);assert.deepEqual(second.workContext.sources,[]);assert.equal(second.coordination.work,'not-needed');
  assert.doesNotMatch(JSON.stringify(second.workContext),/ORIGINAL_GOAL|ORIGINAL_REPORT/);
});

test('a new user round never inherits the prior round work body through a bare action',async t=>{
  const {f,reads}=sourceHost(t,(options,count)=>{const body=readChatInput(options),choice=choiceFor(body,whale);return wire(choice?choice.choiceId+(count===1?' s1':''):'WAIT');});
  await f.ready();const room=await newRoom(f,[whale]);
  await roomSend(f,room,whale,'这个任务现在是什么情况','work-round');await settledRoom(f,room);
  assert.equal(readChatInput(f.calls[0]).workContext.sources.length,1);const baseline=reads.length;
  await roomSend(f,room,whale,'今天那只猫又把自己尾巴吓到了','new-casual-round');await settledRoom(f,room);
  assert.equal(f.calls.length,2);const answer=readChatInput(f.calls[1]);assert.deepEqual(answer.workContext.sources,[]);
  assert.doesNotMatch(JSON.stringify(answer.workContext),/ORIGINAL_GOAL|ORIGINAL_REPORT/);assert.deepEqual(reads.slice(baseline),[]);
});

test('a bare casual choice does not inject attached work bodies or refresh the source merely because the room has one',async t=>{
  const {f,reads}=sourceHost(t,options=>{const body=readChatInput(options),choice=choiceFor(body,whale);return wire(choice?.choiceId??'WAIT');});
  await f.ready();const room=await newRoom(f,[whale]),baseline=reads.length;
  await roomSend(f,room,whale,'今天那只猫又把自己尾巴吓到了','casual');await settledRoom(f,room);
  assert.equal(f.calls.length,1);assert.deepEqual(readChatInput(f.calls[0]).workContext.sources,[]);
  assert.doesNotMatch(JSON.stringify(f.calls),/ORIGINAL_GOAL|ORIGINAL_REPORT/);assert.deepEqual(reads.slice(baseline),[]);
});

test('a foreground event in another work session does not retarget the room or disclose its unattached body',async t=>{
  const {f,reads}=sourceHost(t,options=>{const body=readChatInput(options),choice=choiceFor(body,whale);return wire(choice?workWire(body,choice):'WAIT');});
  await f.ready();const room=await newRoom(f,[whale]);
  f.bus.emit('session/event',{id:'other',header:{cwd:'D:/fixture/other'},append(){assert.fail('chat cannot write to another workflow');}},
    {seq:8,type:'user/message',data:{content:[{type:'text',text:'OTHER_FOREGROUND_PRIVATE_INPUT'}]}});
  await roomSend(f,room,whale,'看看接入的任务','fixed-source');await settledRoom(f,room);
  assert.deepEqual(readChatInput(f.directors[0]).sources.map(source=>source.id),['work']);
  assert.deepEqual(readChatInput(f.calls[0]).workContext.sources.map(source=>source.sessionId),['work']);
  assert.ok(!reads.includes('other'));assert.doesNotMatch(JSON.stringify(f.requests),/OTHER_FOREGROUND_PRIVATE_INPUT|other_ORIGINAL_GOAL|other_ORIGINAL_REPORT/);
});

test('two-token source selection rejects unknown, duplicate and replayed routing authority',()=>{
  const eventId='room-a-current-user',options={message:'看看这个任务',members:[{id:'a',name:'甲'}],recipients:[{id:'a',name:'甲'}],
    events:[{id:eventId,author:{role:'user',name:'我'},messages:['看看这个任务']}],
    states:[{id:'a',level:0,normalReady:true,normalRemaining:3,peerReady:false,peerRemaining:1,pendingEventIds:[eventId],normalPendingEventIds:[eventId]}],
    sources:[{id:'work-a',name:'已接入任务',primary:true,available:true}],sourceIds:['work-a']};
  const body=JSON.parse(buildDirectorRequest(options).user),choice=body.choices[0].choiceId;
  const accepted=parseDirectorResponse(choice+' s1',options);assert.equal(accepted.basis,'model');assert.deepEqual(accepted.context.sourceIds,['work-a']);
  for(const source of ['s0','s7','s2','s1+s1','s1+s2','work-a','https://example.invalid/source']){
    const result=parseDirectorResponse(choice+' '+source,options);assert.equal(result.basis,'invalid',source);assert.equal(result.next,null);assert.deepEqual(result.context.sourceIds,[]);
  }
  const consumed=structuredClone(options);consumed.states[0].pendingEventIds=[];consumed.states[0].normalPendingEventIds=[];
  const anotherRoom=structuredClone(options);anotherRoom.events[0].id='room-b-current-user';
  anotherRoom.states[0].pendingEventIds=['room-b-current-user'];anotherRoom.states[0].normalPendingEventIds=['room-b-current-user'];
  for(const snapshot of [consumed,anotherRoom]){
    const result=parseDirectorResponse(choice+' s1',snapshot);assert.equal(result.basis,'invalid');assert.equal(result.next,null);assert.deepEqual(result.context.sourceIds,[]);
  }
});

test('the actor sees only attached counts for unselected material and a whitelisted absence reason for failed material',()=>{
  const workContext={key:'context',scopeKey:'scope',primarySessionId:'work',
    sourceCatalog:[{id:'work',name:'PRIVATE_SOURCE_NAME',primary:true,state:'read-failed',error:'PRIVATE_ERROR_DETAIL'}],
    sources:[{sessionId:'work',name:'PRIVATE_SOURCE_NAME',goal:'PRIVATE_ORIGINAL_GOAL',report:'PRIVATE_ORIGINAL_REPORT'}],
    omitted:[{name:'PRIVATE_SOURCE_NAME',reason:'read-failed',error:'PRIVATE_ERROR_DETAIL',stack:'PRIVATE_STACK'}]};
  const pack={identity:'当前人格',voice:['自然聊天'],samples:[],avoid:[],address:{user:'你'}};
  for(const work of ['not-needed','unclear']){
    const prompt=buildChatPrompt({pack,history:[],message:'随便聊两句',roomId:'room',workContext,
      coordination:{work,sourceIds:[],request:'open',basis:'model'}}),result=readChatInput(prompt);
    assert.deepEqual(result.workContext.referenceAccess,{attachedCount:1,status:'not-selected'});
    assert.deepEqual(result.workContext.sourceCatalog,[]);assert.deepEqual(result.workContext.sources,[]);assert.deepEqual(result.workContext.omitted,[]);
    assert.doesNotMatch(JSON.stringify(prompt),/PRIVATE_SOURCE_NAME|PRIVATE_ORIGINAL_|PRIVATE_ERROR_DETAIL|PRIVATE_STACK/);
  }
  const prompt=buildChatPrompt({pack,history:[],message:'看看这个任务',roomId:'room',workContext:{...workContext,sources:[]},
    coordination:{work:'required',sourceIds:['work'],request:'unclear',basis:'model'}}),result=readChatInput(prompt);
  assert.deepEqual(result.workContext.referenceAccess,{attachedCount:1,status:'unavailable'});
  assert.deepEqual(result.workContext.omitted,[{name:'PRIVATE_SOURCE_NAME',reason:'read-failed'}]);
  assert.equal(result.workContext.sourceCatalog[0].state,'read-failed');
  assert.doesNotMatch(JSON.stringify(prompt),/PRIVATE_ORIGINAL_|PRIVATE_ERROR_DETAIL|PRIVATE_STACK/);
});

test('a delayed two-token choice cannot read or reply after the room replaces its source mapping',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const {f}=sourceHost(t,options=>(async function*(){const body=readChatInput(options),choice=choiceFor(body,whale);await gate;yield*wire(choice.choiceId+' s1');})());
  await f.ready();const room=await newRoom(f,[whale]);await roomSend(f,room,whale,'看看这个任务','old-source');await flush();
  assert.equal(f.directors.length,1);
  const detached=await f.request('chat-context',{action:'detach',...room,sessionId:'work',revision:Number(room.contextKey.split(':').at(-1))});
  assert.equal(detached.status,200);
  const attached=await f.request('chat-context',{action:'attach',roomId:room.roomId,sessionId:'other',primary:true,revision:detached.value.revision});
  assert.equal(attached.status,200);release();await flush();
  const binding={roomId:room.roomId,contextKey:attached.value.id+':'+attached.value.revision},settled=await settledRoom(f,binding);
  assert.equal(f.calls.length,0);assert.ok(settled.room.turns.every(turn=>turn.phase==='anchor'||turn.status!=='ready'));
  assert.doesNotMatch(JSON.stringify(f.requests),/other_ORIGINAL_GOAL|other_ORIGINAL_REPORT/);
});
