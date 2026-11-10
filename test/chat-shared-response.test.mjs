import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDirectorPrompt} from '../lib/chat-director.js';
import {buildChatPrompt} from '../lib/chat-prompt.js';
import {DEFAULT_PACK} from '../lib/pack.js';
import {chatSchedulerEventKey} from '../lib/chat-scheduler.js';
import {fixture,reply,newRoom,roomSend,roomState,settledRoom,flush,whale,dragon,readChatInput} from './helpers/persona-chat-host.mjs';

test('the shared director groups only validated earlier responses to the exact public target',()=>{
  const key=(turnId,roomId='room')=>chatSchedulerEventKey({roomId,generation:0,sourceScope:'scope',turnId,attemptId:turnId});
  const events=[{id:key('user'),author:{role:'user',name:'我'},messages:['先看布局。','还要留意窄屏。']},
    {id:key('a'),author:{role:'assistant',id:'a',name:'甲'},messages:['窄屏先单列。'],replyTo:{to:'user',eventId:key('user'),index:1},privateMemory:'PRIVATE_MEMORY'},
    {id:key('b'),author:{role:'assistant',id:'b',name:'乙'},messages:['另一个真实回复。'],replyTo:{to:'user',eventId:key('user'),index:0}},
    {id:key('bad'),author:{role:'assistant',id:'b',name:'乙'},messages:['不能绑定不存在的气泡。'],replyTo:{to:'user',eventId:key('user'),index:2}},
    {id:key('foreign','other'),author:{role:'assistant',id:'b',name:'乙'},messages:['不能跨房间绑定。'],replyTo:{to:'user',eventId:key('user'),index:1}}];
  const p=buildDirectorPrompt({message:'先看布局。\n还要留意窄屏。',members:[{id:'a',name:'甲'},{id:'b',name:'乙'}],events});
  const body=JSON.parse(p.user);
  assert.deepEqual(body.priorResponses,[{eventId:'e1',index:1,responseEventIds:['e2']},{eventId:'e1',index:0,responseEventIds:['e3']}]);
  assert.ok(body.priorResponses.every(group=>!('complete'in group)&&!('resolved'in group)), 'a response pointer cannot declare a task solved');
  assert.doesNotMatch(p.user,/PRIVATE_MEMORY/);
});

test('actor shared-response pointers include only visible completed peers in the current room and reference scope',()=>{
  const anchor={id:'anchor',messageId:'user',attemptId:'anchor',phase:'anchor',user:'帮我总结',userParts:[{id:'user',text:'帮我总结',at:1}],recipients:[],scopeKey:'scope'};
  const turn=(id,patch={})=>({...anchor,id,attemptId:id,phase:'reaction',recipientId:'peer',speakerName:'同伴',status:'ready',assistant:['公开原话-'+id],...patch});
  const p=buildChatPrompt({pack:DEFAULT_PACK,speaker:{id:'self',name:'我'},roomId:'room',scopeKey:'scope',currentTurn:anchor,
    message:anchor.user,history:[turn('old',{messageId:'older-user'})],exchange:[turn('good'),turn('own',{recipientId:'self'}),turn('failed',{status:'failed'}),
      turn('pending',{status:'pending'}),turn('foreign-room',{roomId:'other'}),turn('foreign-scope',{scopeKey:'other'})]});
  const body=readChatInput(p),refs=body.sharedResponse.priorReplyEvents;
  assert.equal(refs.length,1);assert.equal(body.timeline.find(event=>event.eventId===refs[0]).turnId,'good');
  assert.equal(JSON.stringify(p.messages).split('公开原话-good').length-1,1,'pointers must not repeat dialogue bodies');
  assert.doesNotMatch(JSON.stringify(body.sharedResponse),/公开原话|resolved|complete/);
  assert.doesNotMatch(JSON.stringify(p.messages),/公开原话-(failed|pending|foreign-room|foreign-scope)/);
});

test('source discussion duties depend on the current supplied material and committed public peers',()=>{
  const anchor={id:'anchor',attemptId:'anchor',messageId:'user',user:'帮我总结',userParts:[{id:'user',text:'帮我总结',at:1}],phase:'anchor',scopeKey:'scope'};
  const peer={...anchor,id:'peer',attemptId:'peer',recipientId:'peer',speakerName:'同伴',phase:'reaction',status:'ready',assistant:['已经公开的总结。']};
  const base={pack:DEFAULT_PACK,speaker:{id:'self',name:'我'},roomId:'room',scopeKey:'scope',currentTurn:anchor,message:anchor.user,
    coordination:{work:'required',sourceIds:['work'],request:'unclear'},workContext:{sources:[{sessionId:'work',report:'只读报告'}]}};
  assert.equal(readChatInput(buildChatPrompt(base)).sharedResponse.workRole,'source-answer');
  assert.equal(readChatInput(buildChatPrompt({...base,exchange:[peer]})).sharedResponse.workRole,'optional-addition');
  assert.equal(readChatInput(buildChatPrompt({...base,exchange:[peer],coordination:{work:'not-needed',sourceIds:[],request:'open'}})).sharedResponse.workRole,undefined,
    'a personal invitation without selected work material must not inherit the source-review role');
  const addressed=readChatInput(buildChatPrompt({...base,exchange:[peer],responsePlan:{kind:'peer',to:'peer'},
    replyTarget:{ref:{roomId:'room',generation:0,kind:'assistant',turnId:'peer',attemptId:'peer',index:0},author:{role:'assistant',id:'peer',name:'同伴'},text:peer.assistant[0]}}));
  assert.equal(addressed.sharedResponse.workRole,'peer-response','a validated peer invitation keeps its directed response even while work material is available');
  assert.equal(addressed.responsePlan.to,'peer');assert.equal(addressed.replyTarget.author.id,'peer');
});

test('a later actor receives fresh shared-response pointers only after the preceding stream is committed',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const f=fixture(t,{directorScript:options=>{
    const body=readChatInput(options),said=body.events.filter(event=>event.author.role==='assistant'),id=[whale,dragon][said.length];
    return(async function*(){yield{type:'text-delta',text:body.choices.find(choice=>choice.id===id&&choice.to==='user')?.choiceId+' N'};yield{type:'finish',reason:{kind:'stop'}};})();
  },script:options=>readChatInput(options).speaker.id===whale?(async function*(){
    yield{type:'text-delta',text:JSON.stringify({messages:['只有完成后才成为公开依据。']})};await gate;yield{type:'finish',reason:{kind:'stop'}};
  })():reply(['一个不同的补充。'])});
  await f.ready();const room=await newRoom(f,[whale,dragon]),before=await roomState(f,room);
  assert.equal((await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[whale,dragon],configRevision:before.room.configRevision,epoch:before.epoch})).status,200);
  await roomSend(f,room,whale,'请一起看一下。','shared-stream');await flush();
  assert.equal(f.calls.length,1);assert.deepEqual(readChatInput(f.calls[0]).sharedResponse.priorReplyEvents,[]);
  release();await settledRoom(f,room);assert.equal(f.calls.length,2);
  const next=readChatInput(f.calls[1]);assert.equal(next.sharedResponse.priorReplyEvents.length,1);
  assert.equal(next.timeline.find(event=>event.eventId===next.sharedResponse.priorReplyEvents[0]).author.id,whale);
  const decision=readChatInput(f.directors[1]);assert.equal(decision.priorResponses.length,1);
  assert.equal(decision.events.find(event=>event.id===decision.priorResponses[0].responseEventIds[0]).author.id,whale);
});
