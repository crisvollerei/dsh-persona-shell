import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILTIN_PRESETS} from '../lib/pack.js';
import {buildChatPrompt} from '../lib/chat-prompt.js';
import {parseChatDecision} from '../lib/persona-chat.js';
import {resolvePersonaExpression} from '../lib/persona-expression.js';

const roomId='actions-room',scopeKey='scope';
const current={id:'now',messageId:'now',attemptId:'now',phase:'anchor',user:'REAL_CURRENT_WORDS',
  userParts:[{id:'now',text:'REAL_CURRENT_WORDS',at:1}],recipients:[],scopeKey,status:'ready',assistant:[]};
const build=(preset,extra={})=>buildChatPrompt({pack:preset.pack,persona:{id:preset.id,builtin:true},
  speaker:{id:preset.id,name:preset.name},participants:[{id:preset.id,name:preset.name}],
  roomId,generation:0,scopeKey,message:current.user,currentTurn:current,history:[],...extra});

test('all chat speakers and phases get optional own-view action guidance without a forced gesture',()=>{
  for(const preset of BUILTIN_PRESETS)for(const phase of ['primary','reaction','followup']){
    const prompt=build(preset,{phase});
    assert.match(prompt.system,/括号动作可选.*从本人视角写，通常省略主语/);
    assert.match(prompt.system,/需要主语时沿用本人自称/);
    assert.match(resolvePersonaExpression(preset.pack,{channel:'chat',persona:{id:preset.id,builtin:true}}).identity,/女性/);
    assert.doesNotMatch(resolvePersonaExpression(preset.pack,{channel:'chat',persona:{id:preset.id,builtin:true}}).identity,/第三人称用/);
    assert.match(prompt.system,/角色卡或用户明确要第三人称叙事时按要求表达/);
    assert.match(prompt.system,/只写本人动作与念头，不替他人表演/);
    assert.equal(prompt.control.speaker.id,preset.id);
    assert.equal(prompt.control.currentMessage.messageId,current.messageId);
  }
});

test('personal reactions may stand alone while requested explanations and source conditions remain available',()=>{
  const source={sessionId:'work',turn:9,goal:'REAL_WORK_GOAL',reportStatus:'final',
    report:'REAL_REPORT: transport retry passed; device sleep remains unverified; no production release.'};
  const prompt=build(BUILTIN_PRESETS[2],{workContext:{scopeKey,sources:[source]},memory:['ONLY_THIS_OWNER_STYLE'],
    coordination:{work:'required',sourceIds:['work'],request:'answer',evidence:current.user,basis:'model'},
    participants:[{id:'peer',name:'同伴',privateMemory:'PEER_PRIVATE_STYLE'}]});
  assert.match(prompt.system,/个人邀请、应声、赞同也有价值/);
  assert.match(prompt.system,/说完不用再解释自己为何这样说/);
  assert.match(prompt.system,/需要理由时自然讲清，不为缩短而省掉依据/);
  assert.match(prompt.system,/工作判断所需的重要条件、风险、未知与来源一起保留/);
  assert.match(prompt.system,/用户已明确邀请抱抱时可以直接应邀/);
  assert.match(prompt.system,/把用户的后续反应留给用户；不必逐动作索要确认/);
  assert.match(prompt.system,/按原文保留重要条件、风险、不确定性与建议的性质/);
  assert.match(prompt.system,/报告中的检查和结论归原作者/);
  assert.deepEqual(prompt.control.workContext.sources,[source]);
  assert.ok(prompt.system.includes('ONLY_THIS_OWNER_STYLE'));
  assert.doesNotMatch(JSON.stringify(prompt),/PEER_PRIVATE_STYLE/);
});

test('custom self-address and an explicit narration choice remain card data rather than being replaced',()=>{
  for(const voice of ['自称「俺」，动作也可以省略主语。','明确采用第三人称叙事，括号中以「她」描述自己的动作。']){
    const pack={...BUILTIN_PRESETS[0].pack,identity:'自定义旅人',voice:[voice]};
    const prompt=build(BUILTIN_PRESETS[0],{pack,persona:{id:'custom-traveller',builtin:false},
      speaker:{id:'custom-traveller',name:'旅人'}});
    assert.ok(prompt.system.includes(voice));
    assert.match(prompt.system,/需要主语时沿用本人自称/);
    assert.match(prompt.system,/角色卡或用户明确要第三人称叙事时按要求表达/);
    assert.doesNotMatch(prompt.system,/需要主语时用「我」/);
    assert.doesNotMatch(prompt.system,/虚构多轮示例/);
    assert.equal(prompt.control.speaker.id,'custom-traveller');
  }
});

test('style guidance never rewrites received bubbles, including quoted third-person prose or literal brackets',()=>{
  const messages=['（坐下了）好。','她刚才说的是「（她坐下了）」这段引文。','`（她坐下了）` 是代码里的原始字符串。'];
  const before=structuredClone(messages);
  const parsed=parseChatDecision(JSON.stringify({messages}));
  assert.deepEqual(parsed,{kind:'reply',messages:before});
  assert.deepEqual(messages,before);
  assert.deepEqual(parseChatDecision('{"messages":[]}'),{kind:'silent'});
});

test('the subjectless fictional action stays in the prompt example rather than actual history or report material',()=>{
  const preset=BUILTIN_PRESETS.find(value=>value.id==='Claude小姐'),persona={id:preset.id,builtin:true};
  const expression=resolvePersonaExpression(preset.pack,{channel:'chat',persona});
  const action=expression.dialogueExamples.flatMap(group=>group.turns).find(turn=>turn.speaker==='self'&&turn.text.startsWith('（'));
  assert.ok(action);assert.doesNotMatch(action.text,/^（(?:她|Claude小姐|小克)/);
  const prompt=build(preset),actual=JSON.stringify({messages:prompt.messages,control:prompt.control});
  assert.ok(prompt.system.includes(action.text));assert.equal(actual.includes(action.text),false);
  const report=resolvePersonaExpression(preset.pack,{channel:'report',persona});
  assert.equal(JSON.stringify(report).includes(action.text),false);
  assert.match(prompt.system,/不返回.*内部推理/);
  assert.match(prompt.system,/没有必要再说时返回 \{"messages":\[\]\}/);
});
