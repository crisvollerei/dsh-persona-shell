import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDirectorPrompt} from '../lib/chat-director.js';
import {buildDirectorRequest,parseDirectorResponse} from '../lib/chat-director-wire.js';
import {chatSchedulerEventKey} from '../lib/chat-scheduler.js';

const userId=chatSchedulerEventKey({roomId:'room',generation:0,sourceScope:null,turnId:'user',attemptId:'user'});
const options={message:'先说说你的倾向，别急着定。',recipients:[],members:[{id:'a',name:'甲'}],
  events:[{id:userId,author:{role:'user',name:'我'},messages:['先说说你的倾向，别急着定。']}],
  states:[{id:'a',level:0,normalRemaining:3,peerRemaining:1,normalReady:true,peerReady:false,pendingEventIds:[userId],normalPendingEventIds:[userId]}]};

test('native and production director briefs allow an unfinished discussion without requiring an unfinished transport response',()=>{
  for(const prompt of [buildDirectorPrompt(options),buildDirectorRequest(options)]){
    assert.match(prompt.system,/一小步|这一拍/);assert.match(prompt.system,/简短赞同/);
    assert.match(prompt.system,/慢慢聊/);assert.match(prompt.system,/最后一次也不|接近上限也不/);
    assert.doesNotMatch(prompt.system,/一位先完成主要回答|后位只在有具体的新事实|只是礼貌收尾时/);
    assert.match(prompt.system,/完整总结|集中答复/);assert.match(prompt.system,/重要条件/);
  }
});

test('pauses and local speaking choices keep the existing authority, effort budget and exact source pointer',()=>{
  const request=buildDirectorRequest(options),body=JSON.parse(request.user);
  assert.deepEqual(body.states.map(s=>[s.level,s.normalRemaining,s.peerRemaining]),[[0,3,1]]);
  const selected=parseDirectorResponse(body.choices[0].choiceId+' N',options);
  assert.equal(selected.basis,'model');assert.equal(selected.next.id,'a');assert.equal(selected.next.evidence.eventId,userId);
  assert.equal(selected.context.work,'not-needed');assert.equal(parseDirectorResponse('WAIT',options).waitForUser,true);
  assert.equal(parseDirectorResponse('IDLE',options).waitForUser,false);
  assert.equal(parseDirectorResponse(body.choices[0].choiceId+' N',{...options,events:[]}).basis,'invalid');
  assert.doesNotMatch(request.user,/resolved|readyToPublish|privateMemory/);
});

test('handing the turn to another person is judged from public invitations, not an order to replay every joke',()=>{
  const system=buildDirectorRequest(options).system;
  assert.match(system,/哪些个人邀请还没被接住/);assert.match(system,/优先考虑尚未回应/);
  assert.match(system,/不必硬找新事实/);assert.match(system,/不用替整场聊天收尾/);
  assert.match(system,/沉默、改题或角色自称已解决不代表用户回答/);
  assert.match(system,/用户可回应、拒绝、改题或暂停，不需要被催问/);
});
