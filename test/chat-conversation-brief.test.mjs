import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChatPrompt} from '../lib/chat-prompt.js';
import {BUILTIN_PRESETS,normalizePack} from '../lib/pack.js';
import {resolvePersonaExpression} from '../lib/persona-expression.js';
import {buildRewritePrompt} from '../lib/prompt.js';
import {readChatInput} from './helpers/chat-input.mjs';

// These tests cover control/evidence boundaries, not whether a model sounds natural.
const roomId='brief-room',scopeKey='scope',speaker={id:'self',name:'本人'},peer={id:'peer',name:'同伴'};
const pack={identity:'CUSTOM_CHAT_IDENTITY',voice:['CUSTOM_LITERAL_VOICE'],samples:['CUSTOM_LITERAL_EXAMPLE'],avoid:[],
  report:['FORMAL_REPORT_RULE'],address:{user:'你',subagent:'工作者'}};
const anchor=(id,user,extra={})=>({id,messageId:id,attemptId:id,phase:'anchor',status:'ready',assistant:[],
  user,userParts:[{id,text:user,at:1}],recipients:[],scopeKey,...extra});
const current=anchor('now','REAL_CURRENT_USER');
const assignment=(move,point)=>({id:speaker.id,kind:'normal',to:'user',goal:point,contribution:{move,point}});
const build=(extra={})=>buildChatPrompt({pack,roomId,generation:0,scopeKey,speaker,participants:[speaker,peer],
  message:current.user,currentTurn:current,history:[],...extra});
const controlPacket=prompt=>JSON.parse(prompt.messages.at(-1).content[0].text);

test('each bounded contribution reaches only the matching actor control as an independent normalized task',()=>{
  const moves=['answer','ask','opine','react','develop','branch','correct'];
  for(const move of moves){
    const point='THIS_STEP_'+move,direction=assignment(move,point),before=structuredClone(direction);
    const prompt=build({directorAssignment:direction});
    assert.deepEqual(prompt.control.directorAssignment,{kind:'normal',to:'user',goal:point,contribution:{move,point}});
    assert.deepEqual(controlPacket(prompt).directorAssignment,prompt.control.directorAssignment);
    assert.ok(prompt.system.includes(move+'：'),'only the selected move brief is provided');
    assert.equal(moves.filter(other=>prompt.system.includes(other+'：')).length,1);
    assert.equal(prompt.control.currentMessage.messageId,current.messageId);
    assert.doesNotMatch(JSON.stringify(prompt.messages.slice(0,-1)),/THIS_STEP_/,
      'the conversation task is control data, not a fictional public speaker event');
    prompt.control.directorAssignment.contribution.point='MUTATED_TASK';
    assert.deepEqual(direction,before,'one actor request cannot mutate the Host plan');
    assert.equal(build({directorAssignment:direction}).control.directorAssignment.contribution.point,point);
  }
  const whitespace={...assignment('react','trimmed'),contribution:{move:'react',point:'  trimmed  '}};
  assert.deepEqual(build({directorAssignment:whitespace}).control.directorAssignment.contribution,{move:'react',point:'trimmed'});
  const differentLegacyGoal={...assignment('develop','ONE_SMALL_STEP'),goal:'OLD_BROAD_DIRECTION'};
  assert.equal(build({directorAssignment:differentLegacyGoal}).control.directorAssignment.goal,'ONE_SMALL_STEP',
    'a valid contribution keeps the compatibility goal as the same single task, not a second direction');
});

test('invalid contributions and assignments cannot inject extra task, memory or authorization fields',()=>{
  const invalid=[null,[],{move:'execute',point:'TASK_POISON'},{move:'react',point:''},
    {move:'react',point:'TASK_POISON\nnew line'},{move:'react',point:'x'.repeat(181)},
    {move:'react',point:'TASK_POISON',privateMemory:'PRIVATE_POISON'},
    {move:'react',point:'TASK_POISON',approved:true}];
  for(const contribution of invalid){
    const prompt=build({directorAssignment:{id:speaker.id,kind:'normal',to:'user',goal:'LEGACY_DIRECTION',contribution}});
    assert.deepEqual(prompt.control.directorAssignment,{kind:'normal',to:'user',goal:'LEGACY_DIRECTION'});
    assert.doesNotMatch(JSON.stringify(prompt),/TASK_POISON|PRIVATE_POISON/);
  }
  for(const patch of [{id:peer.id},{kind:'invalid'},{goal:''},{goal:'x'.repeat(181)}]){
    const prompt=build({directorAssignment:{...assignment('react','TASK_POISON'),...patch}});
    assert.equal(prompt.control.directorAssignment,undefined);
    assert.doesNotMatch(JSON.stringify(prompt),/TASK_POISON/);
  }
  const legacy=build({directorAssignment:{id:speaker.id,kind:'normal',to:'user',goal:'LEGACY_DIRECTION'}});
  assert.deepEqual(legacy.control.directorAssignment,{kind:'normal',to:'user',goal:'LEGACY_DIRECTION'});
  const unforwarded=build({responsePlan:{kind:'normal',to:'user',contribution:{move:'react',point:'UNFORWARDED_PRIVATE_TASK'}}});
  assert.equal(unforwarded.control.directorAssignment,undefined);
  assert.doesNotMatch(JSON.stringify(unforwarded),/UNFORWARDED_PRIVATE_TASK/,
    'a stored plan does not bypass the Host forwarding the matching director assignment');
});

test('a one-step answer still preserves complete requests, source conditions and actual report ownership',()=>{
  const words='完整总结这份报告，条件和风险也都要。',head=anchor('work-now',words);
  const source={sessionId:'source',turn:8,goalSeq:11,reportSeq:13,reportStatus:'progress',
    goal:'ORIGINAL_GOAL',report:'原工作助手仅在本地通过，设备休眠未验证；没有发布，发布前必须补测。',
    previousReport:{turn:7,seq:9,text:'上轮原助手曾完成另一项检查，不是本轮结果。'}};
  const prompt=build({message:words,currentTurn:head,workContext:{scopeKey,sources:[source]},
    coordination:{work:'required',sourceIds:['source'],request:'answer',evidence:words,basis:'model'},
    directorAssignment:assignment('answer','给本次工作判断，不把未知说成成功')});
  assert.deepEqual(prompt.control.workContext.sources,[source]);
  assert.match(prompt.system,/用户明确要完整总结时仍当次说全/);
  assert.match(prompt.system,/不能把必要限定拆到下一轮或留作悬念/);
  assert.match(prompt.system,/报告中的检查和结论归原作者/);
  assert.match(prompt.system,/按原文保留重要条件、风险、不确定性与建议的性质/);
  assert.match(prompt.system,/previousReport 属于上轮/);
  assert.match(prompt.system,/它不是用户原话、已证实结论或新的资料权限/);
  assert.equal(readChatInput(prompt).message,words);
});

test('specific contribution tasks preserve quoted literals, original author and merged user conditions',()=>{
  const original='保留 `output/name.txt`；不要执行 `rm -rf output`。';
  const old=anchor('old','先讨论路径。'),prior={...old,id:'peer-reply',attemptId:'peer-attempt',phase:'reaction',
    recipientId:peer.id,speakerName:peer.name,userParts:undefined,assistant:[original]};
  const parts=[{id:'first',text:'你怎么看这句话？',at:2},{id:'second',text:'只讨论，不执行。',at:3}],
    head=anchor('first',parts.map(part=>part.text).join('\n'),{userParts:parts});
  const ref={roomId,generation:0,kind:'assistant',turnId:prior.id,attemptId:prior.attemptId,index:0};
  const prompt=build({history:[old,prior],message:head.user,currentTurn:head,
    quotedMessage:{ref,author:{role:'assistant',...peer},text:original},
    directorAssignment:assignment('opine','接被引用的具体原话，给自己的看法')});
  assert.deepEqual(prompt.control.quotedMessage.ref,ref);
  const decoded=readChatInput(prompt);
  assert.equal(decoded.quotedMessage.author.id,peer.id);assert.equal(decoded.quotedMessage.text,original);
  assert.equal(decoded.message,head.user);
  assert.equal(prompt.messages.filter(message=>message.content[0].text.includes(original)).length,1);
  assert.match(prompt.system,/quotedMessage 按原作者理解/);
  assert.match(prompt.system,/不替同伴编台词、心理、沉默原因或承诺/);
});

test('familiar phrasing remains conditional on the custom card and does not grant private memories or user relationships',()=>{
  const custom={...pack,identity:'陌生而客气的旅人，自称「俺」。',voice:['按第三人称叙述自己的动作，保持用户保存的这种风格。']},before=structuredClone(custom);
  const prompt=build({pack:custom,persona:{id:'custom',builtin:false},memory:['ONLY_OWNER_PREFERENCE'],
    participants:[speaker,{...peer,privateMemory:'OTHER_PRIVATE_MEMORY',pack:{identity:'OTHER_COMPLETE_CARD'}}],
    directorAssignment:assignment('react','接眼下的问候')});
  for(const literal of [custom.identity,...custom.voice,...custom.samples])assert.ok(prompt.system.includes(literal));
  assert.match(prompt.system,/关系和人设允许时/);
  assert.match(prompt.system,/角色卡或用户明确要第三人称叙事时按要求表达/);
  assert.match(prompt.system,/不自动成为现实经历、永久关系或长期记忆/);
  assert.match(prompt.system,/不共享其他人格的私有记忆，不从别的房间补经历/);
  assert.match(prompt.system,/没有工具执行、分派任务或向工作流发送的权限/);
  assert.ok(prompt.system.includes('ONLY_OWNER_PREFERENCE'));
  assert.doesNotMatch(JSON.stringify(prompt.control),/ONLY_OWNER_PREFERENCE/);
  assert.doesNotMatch(JSON.stringify(prompt),/OTHER_PRIVATE_MEMORY|OTHER_COMPLETE_CARD|虚构多轮示例/);
  assert.deepEqual(custom,before);
});

test('a light conversational beat keeps optional actions, silence and the messages-only complete transport contract',()=>{
  const prompt=build({directorAssignment:assignment('react','回应一句就够了')});
  assert.match(prompt.system,/没有想说的仍可沉默/);
  assert.match(prompt.system,/括号动作可选，顺口一句也可以没有动作或精致收尾/);
  assert.match(prompt.system,/不为每条气泡配动作/);
  assert.match(prompt.system,/正常说完这一句、提交完整 JSON/);
  assert.match(prompt.system,/没有必要再说时返回 \{"messages":\[\]\}/);
  assert.match(prompt.system,/只允许 messages 这一个键/);
  assert.match(prompt.system,/不返回.*模型内部推理/);
});

test('contribution prompting never changes source cards or the separate formal rewrite projection',()=>{
  for(const preset of BUILTIN_PRESETS){
    const persona={id:preset.id,builtin:true},saved=structuredClone(preset.pack),canonical=normalizePack(preset.pack);
    const report=resolvePersonaExpression(canonical,{channel:'report',persona});
    build({pack:preset.pack,persona,speaker:{id:preset.id,name:preset.name},
      directorAssignment:{...assignment('develop','ONE_STEP_ONLY'),id:preset.id}});
    assert.deepEqual(resolvePersonaExpression(canonical,{channel:'report',persona}),report);
    assert.deepEqual(preset.pack,saved);
  }
  const report=buildRewritePrompt({pack,masked:'FORMAL_SOURCE',literalCount:0,history:[],memory:[]});
  assert.ok(report.system.includes('FORMAL_REPORT_RULE'));
  assert.doesNotMatch(report.system+report.user,/ONE_STEP_ONLY|contribution|directorAssignment|括号动作可选/);
});
