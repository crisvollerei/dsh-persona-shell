import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectorPrompt, parseDirector } from '../lib/chat-director.js';

function setup(){
  const events=[{id:'actual-user',author:{role:'user',name:'我'},messages:['我想再考虑一下，先聊到这里。']},
    {id:'actual-peer',author:{role:'assistant',id:'b',name:'乙'},messages:['甲，你还想补充什么吗？']}];
  return{message:events[0].messages[0],members:[{id:'a',name:'甲'},{id:'b',name:'乙'}],events,sourceIds:[],
    states:[{id:'a',level:1,normalRemaining:2,peerRemaining:1,normalReady:true,peerReady:true,pendingEventIds:events.map(event=>event.id),normalPendingEventIds:events.map(event=>event.id),spokenCount:1}]};
}
const view=options=>JSON.parse(buildDirectorPrompt(options).user);
const context=options=>({work:'not-needed',sourceIds:[],request:'open',evidence:options.message});

test('waiting for the user is explicit and distinct from a null decision that merely waits for later eligibility',()=>{
  const options=setup(),before=structuredClone(options);
  const wait=parseDirector('{"choiceId":null,"waitForUser":true}',options);
  assert.equal(wait.basis,'model');assert.equal(wait.next,null);assert.equal(wait.waitForUser,true);
  assert.deepEqual(wait.context.sourceIds,[]);assert.equal(wait.context.work,'unclear');
  for(const value of [{choiceId:null},{choiceId:null,waitForUser:false}]){
    const result=parseDirector(JSON.stringify(value),options);assert.equal(result.basis,'model');assert.equal(result.waitForUser,false);
  }
  assert.deepEqual(options,before,'a semantic waiting result changes neither source evidence nor budget authority');
});

test('a wait marker cannot discard an actual selected action or weaken legacy evidence authority',()=>{
  const options=setup(),choice=view(options).choices.find(option=>option.kind==='normal');
  const selected=parseDirector(JSON.stringify({choiceId:choice.choiceId,waitForUser:true}),options);
  assert.equal(selected.next.id,'a');assert.equal(selected.waitForUser,false);
  const next={id:'a',kind:'normal',to:'user',goal:'接住原话。',evidence:{eventId:'actual-user',index:0,text:options.message}};
  assert.equal(parseDirector(JSON.stringify({context:context(options),next,waitForUser:true}),options).waitForUser,false);
  const legacyWait=parseDirector(JSON.stringify({context:context(options),next:null,waitForUser:true}),options);
  assert.equal(legacyWait.waitForUser,true);assert.equal(legacyWait.next,null);
  const invalid=parseDirector(JSON.stringify({context:context(options),next,waitForUser:true}),{...options,states:[{...options.states[0],pendingEventIds:undefined}]});
  assert.equal(invalid.reason,'stale-event');assert.equal(invalid.waitForUser,false);
});

test('wrong waiting types, unknown routes and duplicate waiting authority remain invalid instead of becoming a stop signal',()=>{
  const options=setup();
  for(const waitForUser of ['true',1,null,[],{}]){
    const result=parseDirector(JSON.stringify({choiceId:null,waitForUser}),options);
    assert.equal(result.reason,'shape');assert.equal(result.waitForUser,false);assert.equal(result.next,null);
  }
  assert.equal(parseDirector('{"choiceId":null,"waitForUser":true,"resetBudget":true}',options).reason,'shape');
  const duplicate=parseDirector('{"choiceId":null,"waitForUser":false,"waitForUser":true}',options);
  assert.equal(duplicate.reason,'duplicate-key');assert.equal(duplicate.waitForUser,false);
});

test('spoken count describes completed participation without resetting or mechanically excluding remaining opportunities',()=>{
  const options=setup();
  for(const count of [0,1,4]){
    const current={...options,states:[{...options.states[0],spokenCount:count}]},body=view(current);
    assert.equal(body.states[0].spokenCount,count);assert.equal(body.states[0].normalRemaining,2);assert.equal(body.states[0].peerRemaining,1);
    const choice=body.choices.find(option=>option.kind==='normal');assert.ok(choice);
    assert.equal(parseDirector(JSON.stringify({choiceId:choice.choiceId}),current).next.id,'a');
  }
  for(const spokenCount of [-1,5,'1',1.5,null])assert.equal(view({...options,states:[{...options.states[0],spokenCount}]}).states[0].spokenCount,undefined);
  const exhausted={...options,states:[{...options.states[0],spokenCount:3,level:3,normalRemaining:0,normalReady:false}]};
  assert.ok(view(exhausted).choices.every(choice=>choice.kind==='peer'));
  assert.equal(parseDirector('{"choiceId":null,"waitForUser":true}',exhausted).waitForUser,true);
});
