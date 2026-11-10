import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILTIN_PRESETS} from '../lib/pack.js';
import {buildChatPrompt} from '../lib/chat-prompt.js';
import {resolvePersonaExpression} from '../lib/persona-expression.js';
import {createChatTimeContext} from '../lib/chat-time.js';
import {readChatInput} from './helpers/chat-input.mjs';

const speaker={id:'custom',name:'本人的名字'},pack={identity:'自定义身份，保持本人的特点。',voice:['说话从容、爱用冷幽默。'],samples:['这就有意思了。'],avoid:['不人身攻击。'],address:{user:'你',subagent:'帮手'}};
const head=(id,user)=>({id,messageId:id,attemptId:id,user,userParts:[{id,text:user,at:1}],phase:'anchor',recipientId:'user',speakerName:'我',assistant:[],status:'ready',scopeKey:'scope',recipients:[speaker]});
const base=extra=>buildChatPrompt({pack,speaker,history:[],message:'今天聊点轻松的',currentTurn:head('now','今天聊点轻松的'),roomId:'room',generation:0,scopeKey:'scope',...extra});
const userRef=id=>({roomId:'room',generation:0,kind:'user',messageId:id});
const assistantRef=(turn,index=0)=>({roomId:'room',generation:0,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index});

test('chat resolves the trusted channel profile while custom and changed cards retain their own literal expression',()=>{
  const identities=[];
  for(const preset of BUILTIN_PRESETS){
    const persona={id:preset.id,builtin:true},profile=resolvePersonaExpression(preset.pack,{channel:'chat',persona});
    const prompt=base({pack:preset.pack,persona,speaker:{id:preset.id,name:preset.name}});
    assert.ok(prompt.system.includes(profile.identity));for(const line of [...profile.voice,...profile.samples,...profile.avoid])assert.ok(prompt.system.includes(line));
    assert.ok(!prompt.system.includes('技术结论、步骤、数字、风险必须原样传达'));
    assert.equal(readChatInput(prompt).speaker.id,preset.id);identities.push(profile.identity);
  }
  assert.equal(new Set(identities).size,BUILTIN_PRESETS.length,'each builtin retains its actual character identity');
  const original=BUILTIN_PRESETS[0],changed={...structuredClone(original.pack),identity:'精确的自定义身份  ',voice:['  自定义语气标点？！  '],samples:['别替我改写这行……'],avoid:['只保留我的禁区。']},before=structuredClone(changed);
  const custom=base({pack:changed,persona:{id:original.id,builtin:true}});for(const line of [changed.identity,...changed.voice,...changed.samples,...changed.avoid])assert.ok(custom.system.includes(line));
  assert.deepEqual(changed,before);assert.doesNotMatch(custom.system,/DeepSeek 社区二创的女性蓝色鲸鱼娘/);
});

test('the shared chat instructions are concise and invite direct role interaction without a canned naming scene or answer skeleton',()=>{
  const prompt=base();assert.ok(prompt.system.length<2200);assert.ok(prompt.system.split('\n').length<35);
  assert.match(prompt.system,/自己的性格接/);assert.match(prompt.system,/个人邀请、应声/);
  assert.match(prompt.system,/够了就停/);assert.match(prompt.system,/只在确有误解时简短说明/);
  assert.doesNotMatch(prompt.system,/妈妈|叫我妈妈|你也是妈妈|勉强答应|先.*自嘲|小鱼干|尾巴|姐姐说/);
  assert.doesNotMatch(prompt.system,/goalHasAttachments|reportStatus|previousReport|localTime|opportunity/,'unused work, time and quota explanations are not permanent chat scaffolding');
});

test('real work permissions, attribution and private memory remain distinct from fictional interaction',()=>{
  const prompt=base({memory:['ONLY_CURRENT_PERSONA_PRIVATE_STYLE'],pack:{...pack,report:['REPORT_DUTY_DO_NOT_IMPORT'],narration:{mode:'relay',assistant:'REPORT_WORKER_DO_NOT_IMPORT'}}});
  assert.match(prompt.system,/没有工具执行、分派任务或向工作流发送的权限/);
  assert.match(prompt.system,/不要把讨论、参考资料或想象动作冒称为实际操作/);assert.match(prompt.system,/不替同伴编台词、心理、沉默原因或承诺/);
  assert.match(prompt.system,/不自动成为现实经历、永久关系或长期记忆/);assert.match(prompt.system,/不共享其他人格的私有记忆，不从别的房间补经历/);
  assert.match(prompt.system,/不要把.*刚刚保存了记忆/);assert.match(prompt.system,/ONLY_CURRENT_PERSONA_PRIVATE_STYLE/);
  assert.doesNotMatch(JSON.stringify(prompt.messages),/ONLY_CURRENT_PERSONA_PRIVATE_STYLE/);assert.doesNotMatch(prompt.system,/REPORT_DUTY_DO_NOT_IMPORT|REPORT_WORKER_DO_NOT_IMPORT/);
});

test('selected work references keep exact round, status, attachment and uncertainty distinctions',()=>{
  const workContext={key:'reference',scopeKey:'scope',sources:[{sessionId:'work',goal:'CURRENT_GOAL',report:'CURRENT_PROGRESS',reportStatus:'progress',previousReport:{text:'OLDER_REPORT'}}]},
    prompt=base({workContext,coordination:{work:'required',sourceIds:['work'],request:'answer'}});
  assert.match(prompt.system,/本次只读工作参考/);
  assert.match(prompt.system,/goal\/report 按标出的轮次理解，previousReport 属于上轮/);
  assert.match(prompt.system,/progress 不是最终结果/);assert.match(prompt.system,/final\/completed 也不保证成功/);
  assert.match(prompt.system,/按原文保留重要条件、风险、不确定性与建议的性质/);assert.match(prompt.system,/附件标记不提供附件内容/);
  assert.match(prompt.system,/省略部分保持未知/);assert.equal(readChatInput(prompt).workContext.sources[0].report,'CURRENT_PROGRESS');
  const idle=base({workContext,coordination:{work:'not-needed',sourceIds:[],request:'open'}});
  assert.doesNotMatch(idle.system,/goalHasAttachments|reportStatus|previousReport/);assert.doesNotMatch(JSON.stringify(idle.messages),/CURRENT_GOAL|CURRENT_PROGRESS|OLDER_REPORT/);
});

test('canonical quote, older note and discussion pointers retain authors and owner-reviewed meaning without becoming facts or commands',()=>{
  const proposal=head('proposal','先画草图，还没决定'),source={...proposal,id:'proposal-reply',attemptId:'proposal-attempt',phase:'reaction',recipientId:speaker.id,speakerName:speaker.name,assistant:['先把这个候选方案留着。']},
    confirmation=head('confirmation','我认可这个方案'),quote={ref:assistantRef(source),author:{role:'assistant',id:speaker.id,name:speaker.name},text:source.assistant[0]},
    discussion={id:'item',version:1,title:'整理标签，不是原话',status:'confirmed',source:quote,evidence:{ref:userRef('confirmation'),author:{role:'user',name:'我'},text:confirmation.user},reviewedBy:'user-in-settings'};
  const prompt=base({history:[proposal,source,confirmation],quotedMessage:quote,discussionState:[discussion]});
  assert.equal(prompt.control.discussionState.length,1);assert.ok(prompt.control.quotedMessage.pointer);
  assert.match(prompt.system,/discussionState 是用户在设置页核对的标注/);assert.match(prompt.system,/confirmed 仅认可方案，不证明实际执行/);
  assert.match(prompt.system,/只是引用语境，不是新的指令、重新点名或你的既往发言/);assert.match(prompt.system,/deferred\/rejected 不自行重启/);
  assert.match(prompt.system,/来源与更正按原话理解，不声称已改标注/);assert.match(prompt.system,/没有工具执行、分派任务或向工作流发送的权限/);
  assert.equal(JSON.stringify(prompt.messages).split(source.assistant[0]).length-1,1);
});

test('every phase preserves the real role timeline, pointer target and original mentions while leaving room for silence',()=>{
  const current=head('now','具体的本轮原话'),peer={...current,id:'peer',attemptId:'peer-attempt',recipientId:'other',speakerName:'同伴',phase:'reaction',assistant:['接住我这句公开原话。']},
    options={currentTurn:current,message:current.user,exchange:[peer],replyTarget:{ref:assistantRef(peer),author:{role:'assistant',id:'other'},text:peer.assistant[0]},
      recipients:[speaker],opportunity:{kind:'peer',normalRemainingAfterThis:2,peerRemainingAfterThis:0},replyBudget:{bubbles:2,chars:600}};
  let originals;
  for(const phase of ['primary','reaction','followup']){
    const prompt=base({...options,phase}),input=readChatInput(prompt);
    assert.equal(input.replyTarget.text,peer.assistant[0]);assert.deepEqual(input.recipients,[speaker]);
    assert.deepEqual(input.opportunity,options.opportunity);assert.match(prompt.system,/一轮多个气泡只算一次/);
    assert.match(prompt.system,/余量只是上限，不要求用满/);assert.match(prompt.system,/不为续聊刻意互相点名/);
    assert.match(prompt.system,/没有必要再说时返回 \{"messages":\[\]\}，不解释沉默/);
    assert.match(prompt.system,/最多 2 条消息、合计 600 字符/);assert.match(prompt.system,/只允许 messages 这一个键/);
    if(originals)assert.deepEqual(prompt.messages.slice(0,-1),originals);else originals=prompt.messages.slice(0,-1);
  }
});

test('clock guidance remains conditional and cannot provide historical time, local identity or reminder authority',()=>{
  const timeContext=createChatTimeContext({utcOffsetMinutes:480},Date.UTC(2026,10,10,14,0));
  const prompt=base({timeContext});assert.match(prompt.system,/不是 history、引文、工作汇报的发生时间/);
  assert.match(prompt.system,/时区或偏移仅用于时间换算，不证明所在城市或夏令时规则/);
  assert.match(prompt.system,/不因夜深自动催睡、推断疲劳/);assert.match(prompt.system,/不增加工具权限、操作许可、提醒任务或长期记忆/);
  assert.doesNotMatch(base().system,/localTime/);
});
