import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILTIN_PRESETS} from '../lib/pack.js';
import {buildChatPrompt} from '../lib/chat-prompt.js';
import {resolvePersonaExpression} from '../lib/persona-expression.js';

const preset=BUILTIN_PRESETS[0],persona={id:preset.id,builtin:true};
const build=extra=>buildChatPrompt({pack:preset.pack,persona,speaker:{id:preset.id,name:preset.name},message:'说说你的看法',...extra});

test('daily and work exchanges are fixed character material selected without becoming source evidence',()=>{
  const expression=resolvePersonaExpression(preset.pack,{channel:'chat',persona});
  const sample=expression.dialogueExamples[0].turns[0].text;
  const workSample=expression.workDialogueExamples[0].turns[0].text;
  assert.ok(build().system.includes(sample));
  assert.ok(!build().system.includes(workSample));
  const selected=build({coordination:{work:'required',sourceIds:['source'],request:'answer'},
    workContext:{sources:[{sessionId:'source',report:'原报告保留 Windows 权限尚未验证；没有执行。'}]}});
  assert.ok(!selected.system.includes(sample));assert.ok(selected.system.includes(workSample));
  assert.match(selected.system,/虚构多轮示例 · 工作讨论/);
  assert.ok(JSON.stringify(selected.messages).includes('Windows 权限尚未验证'));
  assert.ok(!JSON.stringify({messages:selected.messages,control:selected.control}).includes(workSample));
  assert.match(selected.system,/工作者称呼按来源理解/);
  const unavailable=build({coordination:{work:'required',sourceIds:['source'],request:'answer'},
    workContext:{sources:[],omitted:[{name:'工作来源',reason:'read-failed'}]}});
  assert.ok(!unavailable.system.includes(sample));assert.ok(unavailable.system.includes(workSample));
  assert.match(unavailable.system,/参考暂不可用/);
  const casual=build({coordination:{work:'not-needed',sourceIds:[],request:'open'},
    workContext:{sources:[{sessionId:'source',report:'NOT_FOR_THIS_CASUAL_TURN'}]}});
  assert.ok(casual.system.includes(sample));assert.doesNotMatch(JSON.stringify(casual),/NOT_FOR_THIS_CASUAL_TURN/);
  assert.ok(!casual.system.includes(workSample));
});

test('custom literal examples stay intact while natural text and complete messages JSON retain separate output rules',()=>{
  const custom={identity:'用户自己的角色',voice:[],samples:['CUSTOM_LITERAL_EXAMPLE'],avoid:[],address:{user:'你'}};
  const result=buildChatPrompt({pack:custom,persona:{id:preset.id,builtin:false},message:'看看这份报告',
    workContext:{sources:[{sessionId:'source',report:'SOURCE_ORIGINAL'}]}});
  assert.ok(result.system.includes(custom.samples[0]));assert.doesNotMatch(result.system,/虚构多轮示例/);
  assert.match(result.system,/可以直接输出自然正文，空行分气泡；也可以输出 messages JSON/);
  const last=result.system.split('\n').at(-1);assert.match(last,/JSON方式唯一输出/);assert.match(last,/只允许 messages 这一个键/);
  assert.match(last,/JSON须完整/);assert.match(last,/空输出不代表沉默/);
  assert.match(result.system,/用 messages JSON 包住原文/);
  assert.doesNotMatch(JSON.stringify(result.messages),/CUSTOM_LITERAL_EXAMPLE/);
});

test('each builtin work set stays outside actual evidence and preserves the selected report and private owner',()=>{
  for(const preset of BUILTIN_PRESETS){
    const persona={id:preset.id,builtin:true},expression=resolvePersonaExpression(preset.pack,{channel:'chat',persona});
    const source={sessionId:'selected',turn:7,goalSeq:9,reportSeq:10,reportStatus:'progress',
      goal:'ACTUAL_SELECTED_GOAL',report:'ACTUAL_SELECTED_REPORT_WITH_CONDITION',
      previousReport:{turn:6,text:'ACTUAL_PREVIOUS_REPORT_NOT_THIS_TURN'}};
    const current={id:'now',messageId:'now',attemptId:'now',phase:'anchor',user:'ACTUAL_CURRENT_USER',
      userParts:[{id:'now',text:'ACTUAL_CURRENT_USER',at:1}],recipients:[],scopeKey:'scope',status:'ready',assistant:[]};
    const result=buildChatPrompt({pack:preset.pack,persona,speaker:{id:preset.id,name:preset.name},
      roomId:'room',generation:0,scopeKey:'scope',currentTurn:current,message:current.user,history:[],
      participants:[{id:preset.id,name:preset.name},{id:'peer',name:'同伴',privateMemory:'PEER_PRIVATE_MUST_NOT_APPEAR'}],
      memory:['ONLY_OWNER_PRIVATE_STYLE'],workContext:{scopeKey:'scope',primarySessionId:'selected',sources:[source,
        {sessionId:'other',report:'UNSELECTED_REPORT_MUST_NOT_APPEAR'}]},
      coordination:{work:'required',sourceIds:['selected'],request:'answer',evidence:current.user,basis:'model'}});
    const evidence=JSON.stringify({messages:result.messages,control:result.control});
    assert.equal(result.control.currentMessage.messageId,current.messageId);
    assert.deepEqual(result.control.workContext.sources,[source]);
    assert.ok(result.system.includes('ONLY_OWNER_PRIVATE_STYLE'));
    for(const group of expression.workDialogueExamples){
      const fictional=group.turns[0].text;
      assert.ok(result.system.includes(fictional));assert.equal(evidence.includes(fictional),false);
    }
    assert.doesNotMatch(evidence,/ONLY_OWNER_PRIVATE_STYLE/);
    assert.doesNotMatch(JSON.stringify(result),/PEER_PRIVATE_MUST_NOT_APPEAR|UNSELECTED_REPORT_MUST_NOT_APPEAR/);
    assert.match(result.system,/示例里的报告、数字和检查者也是虚构材料/);
    assert.match(result.system,/没有必要再说时返回 \{"messages":\[\]\}/);
  }
});
