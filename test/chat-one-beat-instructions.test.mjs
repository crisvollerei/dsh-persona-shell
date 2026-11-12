import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChatPrompt} from '../lib/chat-prompt.js';

// These checks verify the speaking brief and evidence boundary, not model naturalness.

const roomId='one-beat-room',scopeKey='source-scope',speaker={id:'self',name:'本人'},peer={id:'peer',name:'同伴'};
const pack={identity:'CHAT_IDENTITY',voice:['CHAT_VOICE'],samples:[],avoid:[],report:['REPORT_ONLY_RULE'],address:{user:'你',subagent:'工作者'}};
const anchor=(id,user)=>({id,messageId:id,attemptId:id,phase:'anchor',user,userParts:[{id,text:user,at:1}],recipients:[],scopeKey,status:'ready',assistant:[]});
const build=(current,extra={})=>buildChatPrompt({pack,roomId,generation:0,scopeKey,speaker,participants:[speaker,peer],history:[],
  message:current.user,currentTurn:current,...extra});
const allowance=(normal,independent=1)=>({kind:'normal',normalRemainingAfterThis:normal,peerRemainingAfterThis:independent});

test('a speaking opportunity is one conversational beat rather than a compulsory complete mini-report',()=>{
  const current=anchor('now','这一句是本轮真实原话。'),before=structuredClone(current),opportunity=allowance(2),prompt=build(current,{opportunity});
  assert.match(prompt.system,/这一拍先接一个眼下的话头/);
  assert.match(prompt.system,/长短随内容/);
  assert.match(prompt.system,/不必硬找新事实、不同风险或漂亮结论/);
  assert.match(prompt.system,/需要理由时自然讲清，不为缩短而省掉依据/);
  assert.match(prompt.system,/允许话题暂不收束/);
  assert.match(prompt.system,/不把每次发言都组织成背景、理由、建议、追问和结尾/);
  assert.doesNotMatch(prompt.system,/一个完整意思一个气泡/);
  assert.deepEqual(prompt.control.opportunity,opportunity);assert.deepEqual(current,before);
  assert.equal(prompt.control.currentMessage.messageId,current.messageId);
  assert.ok(prompt.messages.some(message=>message.content[0].text.includes(current.user)));
});

test('actual remaining opportunities permit taking time without promising more turns or requiring a closing summary',()=>{
  for(const [normal,independent] of [[3,1],[2,0],[0,1],[0,0]]){
    const prompt=build(anchor('now','继续聊。'),{opportunity:allowance(normal,independent)});
    assert.deepEqual(prompt.control.opportunity,allowance(normal,independent));
    assert.match(prompt.system,/余量只是上限，不要求用满，也不保证再轮到你/);
    assert.match(prompt.system,/最后一次也不用总结/);
    assert.match(prompt.system,/正文不报额度，不为续聊刻意互相点名/);
  }
  const invalid=build(anchor('now','继续聊。'),{opportunity:allowance(99)});
  assert.equal(invalid.control.opportunity,undefined);assert.doesNotMatch(invalid.system,/普通机会最多还剩|undefined 轮/);
});

test('a complete requested work answer still carries its material conditions, unknowns and original author attribution now',()=>{
  const current=anchor('now','请完整总结这份报告，改动、条件和风险都说清。');
  const workContext={key:'context',scopeKey,sources:[{sessionId:'work',name:'原始任务',turn:8,goalSeq:6,reportSeq:9,
    reportStatus:'progress',goal:'目标原话',report:'ORIGINAL_CURRENT：只在本地通过；没有验收，不得发布。',
    previousReport:{turn:7,seq:3,text:'ORIGINAL_PREVIOUS：上轮曾通过，但不代表本轮。'}}]};
  const prior={...current,id:'earlier-reply',attemptId:'earlier-attempt',phase:'reaction',recipientId:peer.id,speakerName:peer.name,
    assistant:['前位已概括一部分，但用户这次明确要完整总结。'],status:'ready',userParts:undefined};
  const prompt=build(current,{workContext,exchange:[prior],coordination:{work:'required',sourceIds:['work'],request:'answer',evidence:current.user,basis:'model'},opportunity:allowance(2)});
  assert.equal(prompt.control.sharedResponse.workRole,'optional-addition','an explicit complete request remains an exception even with prior shared answers');
  assert.match(prompt.system,/用户明确要重述、完整总结或集中答复时当次给齐/);
  assert.match(prompt.system,/工作判断所需的重要条件、风险、未知与来源一起保留/);
  assert.match(prompt.system,/按原文保留重要条件、风险、不确定性与建议的性质/);
  assert.match(prompt.system,/不代表你检查了文件、跑过测试或核验了云端/);
  assert.match(prompt.system,/previousReport 属于上轮/);assert.match(prompt.system,/没有提供的部分保持未知/);
  const supplied=prompt.control.workContext.sources[0];
  for(const key of ['turn','goalSeq','reportSeq','reportStatus','goal','report','previousReport'])assert.deepEqual(supplied[key],workContext.sources[0][key]);
  assert.doesNotMatch(prompt.system,/REPORT_ONLY_RULE/);
});

test('a personal invitation and a short agreement remain valid even when shared work material already has an answer',()=>{
  const current=anchor('now','你自己也这样觉得吗？'),earlier={...current,id:'peer-reply',attemptId:'peer-attempt',phase:'reaction',
    recipientId:peer.id,speakerName:peer.name,assistant:['前位已经说清这份报告。'],status:'ready',userParts:undefined};
  const prompt=build(current,{exchange:[earlier],workContext:{scopeKey,sources:[{sessionId:'work',report:'已知材料，尚未正式验收。'}]},
    coordination:{work:'required',sourceIds:['work'],request:'answer',evidence:current.user,basis:'model'}});
  assert.equal(prompt.control.sharedResponse.workRole,'optional-addition');
  assert.match(prompt.system,/共同摘要说过就接着聊/);
  assert.match(prompt.system,/个人邀请、应声、赞同也有价值/);
  assert.match(prompt.system,/不必硬找新事实/);assert.match(prompt.system,/不是要求再找一项遗漏/);
  assert.doesNotMatch(prompt.system,/没有真实差异就沉默/,'source de-duplication is not a blanket ban on personal replies');
});

test('a short beat supports both body entrances and retains complete JSON, memory and attribution boundaries',()=>{
  const prompt=build(anchor('now','原话仍在当前房间。'),{memory:['OWN_PERSONA_PREFERENCE'],participants:[speaker,{...peer,privateMemory:'OTHER_PERSONA_PRIVATE'}]});
  assert.match(prompt.system,/只使用本房间当前参考范围的公开原话/);
  assert.match(prompt.system,/不共享其他人格的私有记忆，不从别的房间补经历/);
  assert.match(prompt.system,/不替同伴编台词、心理、沉默原因或承诺/);
  assert.match(prompt.system,/可以直接输出自然正文/);assert.match(prompt.system,/JSON须完整/);assert.match(prompt.system,/不用半句话索取下一轮/);
  assert.match(prompt.system,/唯一输出 \{"messages":\["你的话"\]\}/);assert.match(prompt.system,/没有必要再说时返回 \{"messages":\[\]\}/);
  assert.match(prompt.system,/只允许 messages 这一个键/);assert.match(prompt.system,/OWN_PERSONA_PREFERENCE/);
  assert.doesNotMatch(JSON.stringify(prompt),/OTHER_PERSONA_PRIVATE|REPORT_ONLY_RULE/);
});
