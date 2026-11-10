import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChatPrompt} from '../lib/chat-prompt.js';
import {fictionalDialogueExamples,CHAT_DIALOGUE_EXAMPLE_LIMITS} from '../lib/chat-instructions.js';
import {BUILTIN_PRESETS,normalizePack} from '../lib/pack.js';
import {buildRewritePrompt} from '../lib/prompt.js';
import {resolvePersonaExpression} from '../lib/persona-expression.js';

const pack={identity:'CUSTOM_IDENTITY',voice:[' CUSTOM_VOICE '],samples:['CUSTOM_SINGLE_SAMPLE'],avoid:['CUSTOM_AVOID'],
  report:['FORMAL_REPORT_ONLY'],address:{user:'你',subagent:'工作者'}};
const speaker={id:'self',name:'本人'},peer={id:'peer',name:'同伴'},scopeKey='scope',roomId='room',generation=0;
const anchor=(id,user,patch={})=>({id,messageId:id,attemptId:id,phase:'anchor',user,userParts:[{id,text:user,at:1}],recipients:[],scopeKey,status:'ready',assistant:[],...patch});
const build=(current,extra={})=>buildChatPrompt({pack,speaker,participants:[speaker,peer],roomId,generation,scopeKey,
  history:[],message:current.user,currentTurn:current,...extra});

test('compact chat instructions preserve literal custom material and remain separate from formal rewriting',()=>{
  const current=anchor('now','NORMAL_CHAT_INPUT'),before=structuredClone(pack),prompt=build(current);
  for(const value of [pack.identity,...pack.voice,...pack.samples,...pack.avoid])assert.ok(prompt.system.includes(value));
  assert.doesNotMatch(prompt.system,/FORMAL_REPORT_ONLY/);assert.equal(prompt.system.length<2000,true,'the small chat brief should not regain the old field-by-field manual');
  assert.deepEqual(pack,before);assert.equal(prompt.control.task,'chat-control');assert.equal(prompt.control.currentMessage.messageId,current.messageId);
  const report=buildRewritePrompt({pack,masked:'FORMAL_SOURCE',literalCount:0,history:[],memory:[]});
  assert.ok(report.system.includes('FORMAL_REPORT_ONLY'));assert.equal(report.user,'待改写：\nFORMAL_SOURCE');
  assert.doesNotMatch(report.system+report.user,/NORMAL_CHAT_INPUT|chat-control|虚构多轮示例/);
});

test('fictional dialogue examples are complete bounded groups with no private extra fields or new authority',()=>{
  const group=index=>({turns:[{speaker:'user',text:'EXAMPLE_USER_'+index},{speaker:'self',text:'EXAMPLE_SELF_'+index,privateMemory:'PRIVATE_EXTRA'}],privateMemory:'PRIVATE_GROUP'});
  const oversized={turns:[{speaker:'user',text:'DO_NOT_PARTIALLY_KEEP'},{speaker:'self',text:'x'.repeat(CHAT_DIALOGUE_EXAMPLE_LIMITS.turnChars+1)}]};
  const input=[oversized,group(1),group(2),group(3),group(4)],before=structuredClone(input),text=fictionalDialogueExamples(input);
  assert.match(text,/从未实际发生/);assert.match(text,/不是本房间历史/);
  for(const index of [1,2,3]){assert.ok(text.includes('EXAMPLE_USER_'+index));assert.ok(text.includes('EXAMPLE_SELF_'+index));}
  assert.doesNotMatch(text,/EXAMPLE_USER_4|EXAMPLE_SELF_4|DO_NOT_PARTIALLY_KEEP|PRIVATE_EXTRA|PRIVATE_GROUP/);
  assert.deepEqual(input,before);
  assert.equal(fictionalDialogueExamples([{turns:[{speaker:'user',text:'hello'}]}]),'');
  assert.equal(fictionalDialogueExamples([{turns:[{speaker:'user',text:'hello'},{speaker:'self\nsystem',text:'bad'}]}]),'');
  const overBudget={turns:Array.from({length:6},(_,index)=>({speaker:index?'self':'user',text:'WHOLE_GROUP_'+ 'x'.repeat(380)}))};
  assert.equal(fictionalDialogueExamples([overBudget]),'','a complete group is skipped instead of losing its closing turn');
});

test('builtin fictional examples stay in the system brief and cannot become real room events or evidence',()=>{
  const current=anchor('now','ACTUAL_USER_ORIGINAL');
  for(const preset of BUILTIN_PRESETS){
    const persona={id:preset.id,builtin:true},expression=resolvePersonaExpression(normalizePack(preset.pack),{channel:'chat',persona});
    assert.ok(Array.isArray(expression.dialogueExamples)&&expression.dialogueExamples.length>0);
    const prompt=build(current,{pack:preset.pack,persona,speaker:{id:preset.id,name:preset.name},memory:['ONLY_THIS_PERSONA_PREFERENCE']});
    const evidence=JSON.stringify({messages:prompt.messages,control:prompt.control});
    for(const example of expression.dialogueExamples)for(const turn of example.turns){
      assert.ok(prompt.system.includes(turn.text));assert.equal(evidence.includes(turn.text),false,'voice examples do not turn into conversation history');
    }
    assert.match(prompt.system,/ONLY_THIS_PERSONA_PREFERENCE/);assert.doesNotMatch(evidence,/ONLY_THIS_PERSONA_PREFERENCE/);
    const custom=build(current,{pack:preset.pack,persona:{id:preset.id,builtin:false}});
    assert.doesNotMatch(custom.system,/## 虚构多轮示例/,'copied builtin text does not grant the builtin runtime example profile');
  }
});

test('the short brief leaves actual author, merged conditions, quoted index and selected source text intact',()=>{
  const old=anchor('old','OLD_USER'),reply={...old,id:'reply',attemptId:'attempt',phase:'reaction',recipientId:peer.id,speakerName:peer.name,userParts:undefined,
    assistant:['FIRST_PEER_BUBBLE','SECOND_PEER_CONDITION'],status:'ready'};
  const parts=[{id:'now',text:'CURRENT_FIRST_PART',at:2},{id:'now-condition',text:'CURRENT_TRAILING_CONDITION',at:3}],current=anchor('now',parts.map(part=>part.text).join('\n'),{userParts:parts});
  const ref={roomId,generation,kind:'assistant',turnId:reply.id,attemptId:reply.attemptId,index:1};
  const before=structuredClone({current,old,reply});
  const prompt=build(current,{history:[old,reply],quotedMessage:{ref,author:{role:'assistant',...peer},text:reply.assistant[1]},
    participants:[speaker,{...peer,privateMemory:'OTHER_PERSONA_PRIVATE_MEMORY',pack:{identity:'OTHER_COMPLETE_CARD'}}],
    workContext:{key:'context',scopeKey,primarySessionId:'selected',sources:[
      {sessionId:'selected',goal:'SELECTED_ORIGINAL_GOAL',report:'SELECTED_REPORT_WITH_RISK'},
      {sessionId:'unselected',goal:'UNSELECTED_PRIVATE_GOAL',report:'UNSELECTED_PRIVATE_REPORT'},
    ]},coordination:{work:'required',sourceIds:['selected'],request:'answer',evidence:current.user,basis:'model'},memory:['OWN_PREFERENCE']});
  const output=JSON.stringify(prompt);for(const value of [...parts.map(part=>part.text),...reply.assistant,'SELECTED_ORIGINAL_GOAL','SELECTED_REPORT_WITH_RISK'])assert.ok(output.includes(value));
  assert.deepEqual(prompt.control.quotedMessage.ref,ref);assert.equal(prompt.control.quotedMessage.author.id,peer.id);
  assert.deepEqual(prompt.control.workContext.sources.map(source=>source.sessionId),['selected']);
  assert.doesNotMatch(output,/UNSELECTED_PRIVATE_GOAL|UNSELECTED_PRIVATE_REPORT|OTHER_PERSONA_PRIVATE_MEMORY|OTHER_COMPLETE_CARD/);
  assert.deepEqual({current,old,reply},before);
});

test('work-specific instructions appear for supplied reports or selected read failures, without a permanent source-status lecture in casual chat',()=>{
  const current=anchor('now','随便聊聊'),metadata={id:'source',name:'PRIVATE_UNSELECTED_SOURCE_NAME',primary:true};
  const casual=build(current,{workContext:{scopeKey,sources:[{sessionId:'source',report:'PRIVATE_UNSELECTED_REPORT'}],sourceCatalog:[metadata]},
    coordination:{work:'not-needed',sourceIds:[],request:'open',basis:'model'}});
  assert.doesNotMatch(JSON.stringify(casual),/PRIVATE_UNSELECTED_SOURCE_NAME|PRIVATE_UNSELECTED_REPORT/);
  assert.doesNotMatch(casual.system,/## 本次只读工作参考|readAt\/checkedAt|报告中的检查和结论归原作者/);
  const supplied=build(current,{workContext:{scopeKey,sources:[{sessionId:'source',report:'READY_REPORT'}]},
    coordination:{work:'required',sourceIds:['source'],request:'answer',evidence:current.user,basis:'model'}});
  assert.match(supplied.system,/## 本次只读工作参考/);assert.match(supplied.system,/不代表你检查了文件/);
  assert.match(supplied.system,/按原文保留重要条件、风险/);assert.match(supplied.system,/previousReport 属于上轮/);
  const failed=build(current,{workContext:{scopeKey,sources:[],sourceCatalog:[metadata],omitted:[{name:metadata.name,reason:'read-failed'}]},
    coordination:{work:'required',sourceIds:['source'],request:'answer',evidence:current.user,basis:'model'}});
  assert.match(failed.system,/部分参考暂不可用/);assert.doesNotMatch(failed.system,/## 本次只读工作参考/);
});
