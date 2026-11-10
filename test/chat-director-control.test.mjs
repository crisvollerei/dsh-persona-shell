import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectorRequest,parseDirectorResponse } from '../lib/chat-director-wire.js';
import { chatSchedulerEventKey } from '../lib/chat-scheduler.js';

function setup(roomId='room') {
  const id=chatSchedulerEventKey({roomId,generation:0,sourceScope:null,turnId:'user',attemptId:'user'});
  return {message:'帮我看看项目甲。先别执行。',recipients:[],members:[{id:'fish',name:'鲸鲸'}],
    events:[{id,author:{role:'user',name:'我'},messages:['帮我看看项目甲。先别执行。']}],
    states:[{id:'fish',level:0,normalRemaining:3,peerRemaining:1,normalReady:true,peerReady:false,pendingEventIds:[id],normalPendingEventIds:[id]}],
    sources:[{id:'source-a',name:'项目甲'},{id:'source-b',name:'项目乙'}],sourceIds:['source-a','source-b']};
}
const body=options=>JSON.parse(buildDirectorRequest(options).user);
const response=(options,{action,work='N',request='open',evidence='-'}={})=>{
  const view=body(options);return `D1 ${view.protocol.ticket} ${action??view.choices[0].choiceId} ${work} ${request} ${evidence}`;
};

test('finite control chooses locally-bound actor/evidence and reads only selected attached work sources',()=>{
  const options=setup(),view=body(options),result=parseDirectorResponse(response(options,{work:'s2+s1',request:'answer',evidence:'q1'}),options);
  assert.equal(result.basis,'model');assert.equal(result.next.id,'fish');
  assert.equal(result.next.to,'user');assert.equal(result.next.evidence.eventId,options.events[0].id);
  assert.deepEqual(result.context.sourceIds,['source-b','source-a']);assert.equal(result.context.evidence,'帮我看看项目甲。');
  assert.deepEqual(view.sourceKeys,[{key:'s1',id:'source-a'},{key:'s2',id:'source-b'}]);
  assert.ok(view.userEvidence.every(item=>Object.keys(item).length===3),'evidence menu stores offsets rather than repeated quotations');
});

test('WAIT and IDLE are distinct complete decisions with no invented next speaker',()=>{
  const options=setup();for(const action of ['WAIT','IDLE']) {
    const value=parseDirectorResponse(response(options,{action}),options);
    assert.equal(value.basis,'model');assert.equal(value.next,null);assert.equal(value.waitForUser,action==='WAIT');
    assert.equal(value.context.work,'not-needed');assert.deepEqual(value.context.sourceIds,[]);
  }
});

test('explicit compact stops and a bound single action do not need auxiliary context or grant work access',()=>{
  const options=setup(),view=body(options);
  for(const wire of ['WAIT','wait','```text\nWAIT\n```',`D1 ${view.protocol.ticket} WAIT`]){
    const value=parseDirectorResponse(wire,options);assert.equal(value.basis,'model');assert.equal(value.next,null);assert.equal(value.waitForUser,true);assert.deepEqual(value.context.sourceIds,[]);
  }
  const idle=parseDirectorResponse('IDLE',options);assert.equal(idle.basis,'model');assert.equal(idle.waitForUser,false);
  const action=parseDirectorResponse(view.choices[0].choiceId,options);assert.equal(action.basis,'model');assert.equal(action.next.id,'fish');assert.deepEqual(action.context.sourceIds,[]);
  assert.equal(action.context.request,'unclear');assert.equal(action.context.work,'unclear');
  assert.equal(parseDirectorResponse(view.choices[0].choiceId,setup('other-room')).basis,'invalid');
  for(const broken of ['WAIT extra','这次就 WAIT',`D1 ${view.protocol.ticket} WAIT s7`,'IDLE advice'])assert.equal(parseDirectorResponse(broken,options).basis,'invalid');
  assert.doesNotMatch(buildDirectorRequest(options).system,/choiceId=null|waitForUser/,'output instructions use one coherent compact/extended contract');
});

test('presentation-only whitespace and a single enclosing fence do not invalidate a complete finite selection',()=>{
  const options=setup(),wire=response(options);
  for(const value of ['  '+wire+'\n',wire.split(' ').join('\n'),'```text\n'+wire+'\n```','```\n'+wire+'\n```'])
    assert.equal(parseDirectorResponse(value,options).basis,'model');
});

test('finite control cannot be replayed across room, source revision, current input or actor readiness',()=>{
  const options=setup(),wire=response(options);
  for(const changed of [setup('other-room'),{...options,message:'当前用户原话变了。'},
    {...options,sources:[{id:'another',name:'项目甲'}]},
    {...options,states:options.states.map(state=>({...state,normalReady:false}))}]) {
    const value=parseDirectorResponse(wire,changed);assert.equal(value.basis,'invalid');assert.equal(value.next,null);
  }
});

test('malformed, fabricated or partial control never causes guessed routing, work access or a successful silent result',()=>{
  const options=setup(),wire=response(options);
  for(const broken of [wire+' extra',wire+'\nWAIT',wire.replace('D1','D2'),wire.replace(' N ',' s7 '),
    wire.replace(' N ',' s1+s1 '),wire.replace(' open ',' advice '),wire.replace(' -',' q999'),
    'private-response-text',wire.replace(body(options).choices[0].choiceId,'c99-forged')]) {
    const value=parseDirectorResponse(broken,options);assert.equal(value.basis,'invalid',broken);
    assert.equal(value.next,null);assert.equal(value.waitForUser,false);assert.deepEqual(value.context.sourceIds,[]);
  }
});

test('source-required and explicit request classifications always resolve actual current-user evidence',()=>{
  const options=setup();for(const request of ['answer','advice','listen'])
    assert.equal(parseDirectorResponse(response(options,{request}),options).reason,'evidence');
  assert.equal(parseDirectorResponse(response(options,{work:'s1'}),options).reason,'evidence');
  assert.equal(parseDirectorResponse(response(options,{work:'s1',evidence:'q0'}),options).context.evidence,options.message);
  assert.equal(parseDirectorResponse(response(options,{evidence:'q2'}),options).context.evidence,'先别执行。');
});

test('legacy strict JSON stays validated without substring extraction or duplicate-field repair',()=>{
  const options=setup(),choice=body(options).choices[0].choiceId;
  assert.equal(parseDirectorResponse(JSON.stringify({choiceId:choice}),options).basis,'model');
  for(const value of ['{"choiceId":','{"choiceId":null,"choiceId":"'+choice+'"}','prefix {"choiceId":null}'])
    assert.equal(parseDirectorResponse(value,options).basis,'invalid');
});
