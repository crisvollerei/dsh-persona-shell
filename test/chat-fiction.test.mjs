import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSceneDirection,projectSceneDirection} from '../lib/chat-fiction.js';
import {buildChatPrompt} from '../lib/chat-prompt.js';

const roomId='fiction-room',scopeKey='fiction-scope',generation=2,speaker={id:'claude',name:'小克'};
const pack={identity:'本人的身份',voice:['本人语气'],samples:[],avoid:[],address:{user:'你',subagent:'原助手'}};
const current={id:'now',messageId:'now',attemptId:'now',phase:'anchor',status:'ready',user:'小克，你的长裙好长。',
  userParts:[{id:'now',text:'小克，你的长裙好长。',at:2}],assistant:[],recipients:[speaker],scopeKey};
const ref={roomId,generation,kind:'user',messageId:'now'};
const envelope={text:'SCENE_PROPOSAL_ONLY：接住这幕裙长比较，后续随用户改题。',roomId,generation,scopeKey,messageId:'now',actorId:speaker.id,sourceRef:ref};
const assignment={id:speaker.id,kind:'normal',to:'user',goal:'说自己对长裙的想法。',contribution:{move:'develop',point:'说自己对长裙的想法。'}};
const args={pack,roomId,generation,scopeKey,speaker,currentTurn:current,message:current.user,history:[],participants:[speaker],recipients:[speaker],
  directorAssignment:assignment,replyTarget:{ref,author:{role:'user',name:'我'},text:current.user},coordination:{work:'not-needed',sourceIds:[],request:'open'}};
const build=extra=>buildChatPrompt({...args,...extra});

test('scene directions are bounded proposals, without accepting control lines or empty strings',()=>{
  assert.equal(normalizeSceneDirection('  衣着闲聊，顺着本人的性格接。  '),'衣着闲聊，顺着本人的性格接。');
  assert.equal(normalizeSceneDirection('景'.repeat(240)),'景'.repeat(240));
  for(const value of [undefined,null,{},[],false,'','  ','景'.repeat(241),'提议\n执行','提议\r','提议\t','提议\u0000','提议\u0085','提议\u2028'])
    assert.equal(normalizeSceneDirection(value),null);
});

test('a valid direction is projected onto the included real target without changing canonical conversation or persona',()=>{
  const original=structuredClone({args,envelope}),without=build(),withDirection=build({sceneDirection:envelope});
  assert.equal(withDirection.control.sceneDirection.text,envelope.text);
  const source=withDirection.control.sceneDirection.source,event=withDirection.control.timeline.find(event=>event.eventId===source.eventId);
  assert.equal(event.author.role,'user');assert.equal(source.index,0);assert.equal(event.messageId,'now');
  assert.deepEqual(withDirection.messages.slice(0,-1),without.messages.slice(0,-1));
  const projected=structuredClone(withDirection.control);delete projected.sceneDirection;assert.deepEqual(projected,without.control);
  assert.deepEqual({args,envelope},original);
  assert.equal(JSON.stringify(withDirection.messages.slice(0,-1)).includes('SCENE_PROPOSAL_ONLY'),false);
  assert.match(withDirection.system,/只是提议/);assert.match(withDirection.system,/用户改题便让开/);
  assert.match(withDirection.system,/用户动作\/感受或工具许可/);
});

test('room, clear generation, scope, user cycle, actor and exact public position each gate the ephemeral proposal',()=>{
  for(const patch of [{roomId:'other-room'},{generation:3},{scopeKey:'other-source'},{scopeKey:null},{messageId:'old'},{actorId:'other-actor'},
    {sourceRef:{...ref,messageId:'missing'}},{sourceRef:{...ref,roomId:'other-room'}},{sourceRef:{...ref,generation:0}},
    {sourceRef:{roomId,generation,kind:'assistant',turnId:'invented',attemptId:'invented',index:0}}]){
    const result=build({sceneDirection:{...envelope,...patch}});assert.equal(result.control.sceneDirection,undefined,JSON.stringify(patch));
    assert.doesNotMatch(result.system,/SCENE_PROPOSAL_ONLY/);
  }
  assert.equal(build({sceneDirection:envelope,directorAssignment:{...assignment,id:'other-actor'}}).control.sceneDirection,undefined);
  assert.equal(build({sceneDirection:envelope,replyTarget:undefined}).control.sceneDirection,undefined);
  assert.equal(build({sceneDirection:envelope,currentTurn:{...current,messageId:'later'}}).control.sceneDirection,undefined);
});

test('equal text at another public position and excluded history do not certify a scene direction',()=>{
  const old={...current,id:'old',messageId:'old',attemptId:'old',userParts:[{id:'old',text:current.user,at:1}]};
  const misplaced=build({history:[old],sceneDirection:{...envelope,sourceRef:{...ref,messageId:'old'}}});
  assert.equal(misplaced.control.sceneDirection,undefined,'literal equality is not a target binding');
  assert.equal(build({sceneDirection:envelope,excluded:[ref]}).control.sceneDirection,undefined);
});

test('work or unknown selection and absent proof degrade to ordinary chat rather than granting fiction authority',()=>{
  for(const extra of [{coordination:undefined},{coordination:{work:'unclear',sourceIds:[],request:'unclear'}},
    {coordination:{work:'required',sourceIds:['work'],request:'answer'},workContext:{scopeKey,sources:[{sessionId:'work',name:'工作原文',report:'原报告有一项尚未验证。'}]}}]){
    assert.equal(build({...extra,sceneDirection:envelope}).control.sceneDirection,undefined);
  }
  assert.equal(projectSceneDirection(envelope),undefined);
  const result=build({sceneDirection:{...envelope,text:'提议\n私有控制'}});assert.equal(result.control.sceneDirection,undefined);
  assert.deepEqual(result.control.directorAssignment,build().control.directorAssignment);
});
