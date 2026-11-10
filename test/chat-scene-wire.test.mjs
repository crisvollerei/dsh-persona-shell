import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDirectorRequest,parseDirectorResponse} from '../lib/chat-director-wire.js';

const ref=id=>({roomId:'room',generation:0,kind:'user',messageId:id});
function options(topic='old-user'){
  return{message:'其他人的看法呢',members:[{id:'a',name:'甲'}],events:[{id:'current',author:{role:'user',name:'我'},messages:['其他人的看法呢']}],
    states:[{id:'a',level:0,normalRemaining:3,peerRemaining:1,normalReady:true,peerReady:false,pendingEventIds:['current'],normalPendingEventIds:['current']}],
    sources:[{id:'work',name:'已接入的工作会话'}],sourceIds:['work'],sceneCatalog:{
      options:[{key:'F',relation:'fresh',frame:{privateMemory:'DO_NOT_COPY'}},{key:'C1',relation:'continue',target:'t1'},{key:'P1',relation:'pause',target:'t1'},{key:'R1',relation:'resume',target:'t1'}],
      topics:[{id:'t1',ref:ref(topic),text:'先前的共同任务',parts:[{ref:ref(topic),text:'先前的共同任务'}],responses:[],omittedResponses:0}],current:null,omittedTopics:0,
    }};
}
const body=o=>JSON.parse(buildDirectorRequest(o).user);

test('a compact scene choice binds the original actor and independent source selection without copying a frame',()=>{
  const o=options(),value=body(o),choice=value.choices[0].choiceId;
  const continued=parseDirectorResponse(`${choice} s1 C1`,o);
  assert.equal(continued.basis,'model');assert.equal(continued.next.id,'a');assert.equal(continued.sceneKey,'C1');
  assert.equal(continued.context.work,'required');assert.deepEqual(continued.context.sourceIds,['work']);
  const paused=parseDirectorResponse(`${choice} N P1`,o);
  assert.equal(paused.sceneKey,'P1');assert.equal(paused.context.work,'not-needed');assert.deepEqual(paused.context.sourceIds,[]);
  assert.doesNotMatch(JSON.stringify(value.sceneCatalog),/DO_NOT_COPY|"frame"/);
  assert.equal(parseDirectorResponse(`${choice} N`,o).sceneKey,undefined,'an old source-only answer does not invent a scene');
});

test('scene state cannot be forged, extended or replayed over a different public topic catalogue',()=>{
  const o=options(),choice=body(o).choices[0].choiceId;
  for(const wire of [`${choice} N C99`,`${choice} s2 C1`,`${choice} N C1 extra`,`${choice} N {"focus":"foreign"}`]){
    const result=parseDirectorResponse(wire,o);assert.equal(result.basis,'invalid',wire);assert.equal(result.next,null);
  }
  assert.equal(parseDirectorResponse(`${choice} N C1`,options('another-topic')).basis,'invalid','the action stamp also binds the projected scene evidence');
});

test('a scene-aware stop may retain a grounded transition while a bare stop grants no relation',()=>{
  const o=options(),stopped=parseDirectorResponse('WAIT N P1',o);
  assert.equal(stopped.basis,'model');assert.equal(stopped.next,null);assert.equal(stopped.waitForUser,true);assert.equal(stopped.sceneKey,'P1');
  assert.equal(parseDirectorResponse('IDLE N F',o).waitForUser,false);
  assert.equal(parseDirectorResponse('WAIT',o).sceneKey,undefined);
  assert.equal(parseDirectorResponse('WAIT N P99',o).basis,'invalid');
});
