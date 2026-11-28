import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChatPrompt} from '../lib/chat-prompt.js';
import {buildRewritePrompt} from '../lib/prompt.js';
import {buildProgressPrompt} from '../lib/progress.js';
import {parseChatDecision,chatResponseBody} from '../lib/persona-chat.js';
import {partialChatReply} from '../lib/chat-live.js';
import {buildExtractPrompt,parseGeneratedPreset,GENERATION_RECORDS_EXAMPLE} from '../lib/preset.js';
import {fixture,whale,newRoom,roomSend,roomState,settledRoom,reply,flush,readChatInput} from './helpers/persona-chat-host.mjs';

const pack={identity:'独立角色，自称我。',narration:{mode:'voice',assistant:'原助手'},report:['保留报告事实。'],voice:[],samples:[],avoid:[],address:{user:'你',subagent:'子代理'}};
const speaker={id:'self',name:'本人'},peer={id:'peer',name:'同伴'},scopeKey='scope';
const anchor=(id,user)=>({id,messageId:id,attemptId:id,recipientId:'user',speakerName:'我',phase:'anchor',status:'ready',assistant:[],user,
  userParts:[{id,text:user,at:1}],recipients:[speaker],memberIdsAtSend:['self','peer'],scopeKey});
const said=(head,id,person,assistant)=>({...head,id,attemptId:id,recipientId:person.id,speakerName:person.name,phase:'reaction',status:'ready',assistant,userParts:undefined});
const ref=(turn,index=0)=>({roomId:'room',generation:2,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index});
const build=(current,extra={})=>buildChatPrompt({pack,speaker,participants:[speaker,peer],recipients:[speaker],roomId:'room',generation:2,scopeKey,
  message:current.user,currentTurn:current,history:[],...extra});
import {readChatPacket as packet} from './helpers/chat-input.mjs';
const task=call=>{try{return readChatInput(call).task;}catch{return null;}};
const actorCalls=f=>f.calls.filter(call=>task(call)==='chat-control');
const output=body=>(async function*(){yield{type:'text-delta',index:0,text:body};yield{type:'finish',reason:{kind:'stop'}};})();

test('both output routes keep the final control separate from original history and quoted bubble locations',()=>{
  const old=anchor('old','上轮用户原句：先留候选。'),own=said(old,'own',speaker,['本人历史第一泡。','本人历史第二泡。']),
    other=said(old,'other',peer,['同伴第一泡。','同伴被引用的第二泡。']),current=anchor('now','现在只接被引用的那一句。');
  const input={history:[old,own,other],quotedMessage:{ref:ref(other,1),author:{role:'assistant',...peer},text:other.assistant[1]}};
  const before=structuredClone(input),result=build(current,input),control=packet(result.messages.at(-1));
  assert.equal(control.task,'chat-control');assert.equal(control.timeline,undefined);assert.deepEqual(result.control.quotedMessage,control.quotedMessage);
  assert.ok(result.messages.every(message=>!Object.hasOwn(packet(message),'replyFormat')));
  const decoded=readChatInput(result);assert.equal(decoded.message,current.user);assert.equal(decoded.quotedMessage.text,other.assistant[1]);
  assert.deepEqual(result.messages.filter(message=>message.role==='assistant').map(message=>packet(message).messages),[own.assistant]);
  const quoteEvent=result.control.timeline.find(event=>event.eventId===control.quotedMessage.pointer.eventId);
  assert.equal(quoteEvent.author.id,peer.id);assert.equal(control.quotedMessage.pointer.index,1);
  const quotePacket=packet(result.messages[quoteEvent.messageIndex]);
  assert.equal(quotePacket.messages.find(message=>message.index===1).text,other.assistant[1]);
  for(const literal of [old.user,current.user,...own.assistant,...other.assistant])assert.equal(JSON.stringify(result.messages).split(literal).length-1,1);
  assert.ok(result.control.timeline.every(event=>event.messageIndex<result.messages.length-1),'the control never gets a public event or quote location');
  assert.doesNotMatch(JSON.stringify(control),/replyFormat|本次气泡正文/);assert.deepEqual(input,before);
  assert.doesNotMatch(result.system,/replyFormat|本次气泡正文/);
});

test('natural text and complete messages JSON are two normal inputs while malformed protocol is never downgraded to prose',()=>{
  assert.deepEqual(parseChatDecision('{"messages":[]}'),{kind:'silent'});
  const bubbles=['第一泡带引号："你好"。','第二泡😀\n仍是同一泡。'];
  assert.deepEqual(parseChatDecision(JSON.stringify({messages:bubbles})),{kind:'reply',messages:bubbles});
  for(const raw of ['{"messages":["没闭合"','{"messages":[],"replyFormat":{"messages":[]}}','{"messages":["正文"],"tool":"run"}',
    '{"replyFormat":{"messages":["正文"]}}','先解释格式：{"messages":["正文"]}','{"messages":["正文"]}\n额外文字'])assert.equal(parseChatDecision(raw),undefined,raw);
  const natural='自然第一段。\n\n自然第二段。';
  assert.equal(chatResponseBody(natural).kind,'text');assert.deepEqual(parseChatDecision(natural),{kind:'reply',messages:['自然第一段。','自然第二段。']});
  assert.deepEqual(parseChatDecision('```json\n{"messages":[]}\n```'),{kind:'silent'});
  for(const raw of ['', '  \n\t','{"messages":[', '```js\nconst x = 1;\n```', '```\nplain code\n```', '["raw array"]', '"raw quoted string"', '<div>raw HTML</div>', '`raw inline code`'])assert.equal(parseChatDecision(raw),undefined,raw);
});

test('reserved-prefix code is valid content inside messages and streams without losing newlines or JSON-like source text',()=>{
  for(const code of ['```js\nconst value = { messages: ["源代码"] };\n\nconsole.log(value);\n```','["原样数组"]','{"original":"原样JSON正文"}','<div>原样HTML</div>','"原样引号"']){
    const messages=[code,'后续说明保持独立气泡。'],wire=JSON.stringify({messages});
    assert.equal(parseChatDecision(code),undefined);
    assert.deepEqual(parseChatDecision(wire),{kind:'reply',messages});
    for(let i=0;i<=wire.length;i++)for(const [index,part] of partialChatReply(wire.slice(0,i)).entries())assert.equal(part.text,messages[index].slice(0,part.text.length));
    assert.deepEqual(partialChatReply(wire).map(part=>part.text),messages);
  }
});

test('actual Host text and JSON replies commit the same canonical bubbles and code streams safely before explicit silence',async t=>{
  const first='本轮原句😀，保持原样。',second='第二泡保留原样。',wire=JSON.stringify({messages:[first,second]}),cut=wire.indexOf('😀')+1,
    plain='自然第一段。\n\n自然第二段。',code='```js\nconst value = { messages: ["源代码"] };\n\nconsole.log(value);\n```',codeWire=JSON.stringify({messages:[code]}),
    gate=Promise.withResolvers();t.after(()=>gate.resolve());let count=0;
  const f=fixture(t,{script(call){assert.equal(task(call),'chat-control');assert.equal(packet(call.messages.at(-1)).replyFormat,undefined);
    if(++count===1)return(async function*(){yield{type:'text-delta',index:0,text:wire.slice(0,cut)};await gate.promise;
      yield{type:'text-delta',index:0,text:wire.slice(cut)};yield{type:'finish',reason:{kind:'stop'}};})();
    if(count===2)return output(plain);
    if(count===3)return(async function*(){const split=codeWire.indexOf('\\n')+1;yield{type:'text-delta',index:0,text:codeWire.slice(0,split)};
      yield{type:'text-delta',index:0,text:codeWire.slice(split)};yield{type:'finish',reason:{kind:'stop'}};})();
    return reply([]);
  }});await f.ready();const room=await newRoom(f,[whale],'格式与交付','reply-format-room');
  await roomSend(f,room,whale,'先接这一句。','reply-format-first');await flush();
  const pending=(await roomState(f,room)).room.turns.find(turn=>turn.phase!=='anchor');
  assert.equal(pending.status,'pending');assert.deepEqual(pending.assistant,[],'partial text is not committed as a reply');
  assert.deepEqual(partialChatReply(wire.slice(0,cut)),[{text:'本轮原句',complete:false}]);
  for(let i=0;i<=wire.length;i++)for(const bubble of partialChatReply(wire.slice(0,i)))assert.doesNotMatch(bubble.text,/replyFormat|本次气泡正文|"messages"/);
  gate.resolve();let state=await settledRoom(f,room);
  assert.deepEqual(state.room.turns.find(turn=>turn.phase!=='anchor').assistant,[first,second]);
  assert.deepEqual(partialChatReply(wire).map(value=>value.text),[first,second]);
  await roomSend(f,room,whale,'直接说两段就行。','reply-format-text');state=await settledRoom(f,room);
  assert.deepEqual(state.room.turns.filter(turn=>turn.phase!=='anchor').at(-1).assistant,['自然第一段。','自然第二段。']);
  await roomSend(f,room,whale,'保留这段代码。','reply-format-code');state=await settledRoom(f,room);
  assert.deepEqual(state.room.turns.filter(turn=>turn.phase!=='anchor').at(-1).assistant,[code]);
  await roomSend(f,room,whale,'这轮可以先停。','reply-format-silence');state=await settledRoom(f,room);
  assert.equal(actorCalls(f).length,4);assert.equal(state.room.turns.filter(turn=>turn.phase!=='anchor').length,3);
  assert.ok(state.room.silences.some(receipt=>receipt.personaId===whale));
  const after=f.directors.map(readChatInput).findLast(input=>input.message==='这轮可以先停。');
  assert.equal(after.states.find(value=>value.id===whale).normalRemaining,3,'silence is not a spent ordinary reply');
  assert.doesNotMatch(JSON.stringify(state.room),/replyFormat|本次气泡正文/);
  for(const call of f.directors)assert.doesNotMatch(JSON.stringify(call),/replyFormat|本次气泡正文/);
});

test('the Host rejects empty, malformed and incomplete outputs instead of recording successful silence or automatically repairing them',async t=>{
  const cases=[['empty','', 'stop','format'],['broken','{"messages":["没闭合"','stop','format'],
    ['unknown-key','{"messages":["正文"],"extra":"not allowed"}','stop','format'],['incomplete','{"messages":["未完成"','max-tokens','length']];
  for(const [id,body,finish,failure] of cases){
    const f=fixture(t,{script:()=>(async function*(){if(body)yield{type:'text-delta',index:0,text:body};yield{type:'finish',reason:{kind:finish}};})()});await f.ready();
    const room=await newRoom(f,[whale],id,'invalid-output-'+id);await roomSend(f,room,whale,'先回应当前原话。','invalid-message-'+id);
    const state=await settledRoom(f,room),turn=state.room.turns.find(value=>value.phase!=='anchor');
    assert.equal(turn.status,'failed',id);assert.equal(turn.failure,failure,id);assert.deepEqual(turn.assistant,[],id);
    assert.equal(state.room.silences?.length??0,0,id);assert.equal(actorCalls(f).length,1,'a failed format does not start a repair model call');
  }
});

test('report and progress keep their own protocols outside both actor output routes',async t=>{
  const reports=[],f=fixture(t,{script(call){reports.push(call);return output(call.messages[0].content[0].text.split('待改写：\n').at(-1));}});await f.ready();
  const session={id:'reply-contract-report',header:{},append(){assert.fail('expression cannot write work history');}};
  f.bus.emit('session/event',session,{type:'turn/start',seq:1,data:{turn:1}});
  f.bus.emit('session/event',session,{type:'assistant/message',seq:2,data:{turn:1,message:{role:'assistant',content:[{type:'text',text:'本地检查通过，设备尚未验证。'}]}}});
  f.bus.emit('session/event',session,{type:'turn/end',seq:3,data:{turn:1,reason:{kind:'completed'}}});await flush();
  assert.equal(reports.length,1);assert.doesNotMatch(JSON.stringify(reports[0]),/replyFormat|本次气泡正文/);
  const formal=buildRewritePrompt({pack,masked:'本地检查通过，设备尚未验证。',literalCount:0,history:[]});
  const progress=buildProgressPrompt(pack,'当前仍在运行，尚无新报告。');
  for(const value of [formal,progress])assert.doesNotMatch(JSON.stringify(value),/replyFormat|本次气泡正文/);
});

test('the actor action brief distinguishes an offered posture from contact without adding a confirmation workflow',()=>{
  const old=anchor('invite','我想要抱抱。'),offered=said(old,'offered',speaker,['（张开手）来。']),paused=anchor('pause','好了，先别抱了，就聊聊天。');
  const result=build(paused,{history:[old,offered]});
  assert.equal(readChatInput(result).message,paused.user);assert.deepEqual(result.messages.filter(message=>message.role==='assistant').map(message=>packet(message).messages),[offered.assistant]);
  assert.match(result.system,/张开手、留位置是本人的姿态，不等于双方已经接触/);
  assert.match(result.system,/不因这句话补写此前已抱住、现在松开/);
  const invitation=build(old).system;
  assert.match(invitation,/用户确实写了靠近或接触时也可自然承接/);assert.match(invitation,/不必逐动作索要确认/);
  assert.match(invitation,/用户已明确邀请抱抱时可以直接应邀/);assert.doesNotMatch(result.system,/用户已明确邀请抱抱时可以直接应邀/);
  assert.doesNotMatch(result.system,/replyFormat/);
});

test('an unqualified pause can follow a visible offer, without reviving an unrelated or excluded encounter',()=>{
  const before=anchor('invite','好呀。'),offered=said(before,'offer',speaker,['（张开手）来。']),paused=anchor('pause','好了，先聊聊天吧。');
  const guidance=/不因这句话补写此前已抱住、现在松开/;
  assert.match(build(paused,{history:[before,offered]}).system,guidance);
  assert.match(build(paused,{history:[before,{...offered,recipientId:peer.id,speakerName:peer.name}]}).system,guidance);
  assert.doesNotMatch(build(anchor('new','聊聊新的电影。'),{history:[before,offered]}).system,guidance);
  const unrelated=anchor('other','上次电影里都演了什么？');
  assert.doesNotMatch(build(paused,{history:[before,offered,unrelated,said(unrelated,'review',peer,['只说电影吧。'])]}).system,guidance);
  assert.doesNotMatch(build(paused,{history:[before,offered],excluded:[ref(offered)]}).system,guidance);
  assert.doesNotMatch(build(paused,{history:[before,{...offered,scopeKey:'other'}]}).system,guidance);
  assert.doesNotMatch(build(paused,{history:[before,{...offered,status:'pending'}]}).system,guidance);
});

test('an explicit pause after an offered hug works with the original present or cropped out during a scene change',()=>{
  const old=anchor('old','抱抱'),offer=said(old,'offer',speaker,['（张开手）过来吧']),pause=anchor('now','先暂停一下，我们聊点别的');
  assert.match(build(pause,{history:[old,offer]}).system,/不因这句话补写此前已抱住、现在松开/);
  const refUser=id=>({roomId:'room',generation:2,kind:'user',messageId:id});
  const cropped=build(pause,{history:[old,offer],scene:{version:1,relation:'pause',trigger:refUser('now'),focus:refUser('now'),parked:refUser('old'),
    transition:{trigger:refUser('now'),reply:null},relatedReplies:[]}});
  assert.equal(cropped.control.conversationScene.historySelection,'active-focus');
  assert.ok(!cropped.messages.some(m=>m.role==='assistant'));
  assert.match(cropped.system,/只凭这句话不能补写已经发生的动作或双方接触/);
  assert.doesNotMatch(cropped.system,/此前已抱住、现在松开/);
  for(const words of ['暂停按钮怎么用？','别暂停，继续说。']){
    assert.doesNotMatch(build(anchor('other',words),{history:[old,offer]}).system,/不能补写已经发生的动作或双方接触|此前已抱住、现在松开/);
  }
});

test('actor memory projects only bounded content, approved kinds and coarse time labels',()=>{
  const current=anchor('memory','还记得吗？');
  const result=build(current,{personalContext:[null,{kind:'other',content:'PRIVATE_KIND'},
    {kind:'episode',content:'a'.repeat(241)},
    {kind:'agreement',content:'请使用保存的称呼',when:'昨天',timeBasis:'记录时间',evidence:'PRIVATE_QUOTE'},
    {kind:'episode',content:'一起看过雪',when:'PRIVATE_TIME',timeBasis:'PRIVATE_BASIS'},{kind:'context',content:'PRIVATE_THIRD'}]});
  assert.deepEqual(result.control.personalContext,[{kind:'agreement',content:'请使用保存的称呼',when:'昨天',timeBasis:'记录时间'},
    {kind:'episode',content:'一起看过雪'}]); assert.doesNotMatch(JSON.stringify(result.messages),/PRIVATE_/);
});

test('physical cues include an earlier visible speaker in this exchange and an explicitly resumed focus',()=>{
  const old=anchor('offer','好呀。'),offer=said(old,'hands',peer,['（张开手）来。']),aside=said(old,'aside',speaker,['窗外放晴了。']);
  const current=build(old,{history:[old,offer,aside]});
  assert.equal(current.control.exchange.length,2); assert.match(current.system,/张开手、留位置/);
  const other=anchor('movie','我们聊聊电影吧。'),paused=anchor('hold','先暂停一下。');
  const refUser=messageId=>({roomId:'room',generation:2,kind:'user',messageId});
  const result=build(paused,{history:[old,offer,other,said(other,'film',peer,['我昨天看了电影。'])],scene:{version:1,
    relation:'resume',trigger:refUser('hold'),focus:refUser('offer'),parked:refUser('movie'),
    transition:{trigger:refUser('hold'),reply:null},relatedReplies:[ref(offer)]}});
  assert.equal(result.control.history.at(-1).bodyOmission,'inactive-scene');
  assert.match(result.system,/不因这句话补写此前已抱住、现在松开/);
});

test('resuming a scene uses the latest visible continuation when its opening had no interaction',()=>{
  const intro=anchor('intro','刚才聊到哪了？'),later=anchor('later','原来如此。'),offer=said(later,'offer',peer,['（张开手）过来吧。']);
  const detour=anchor('movie','看电影吧。'),paused=anchor('hold','先暂停一下。');
  const user=messageId=>({roomId:'room',generation:2,kind:'user',messageId});
  const result=build(paused,{history:[intro,later,offer,detour],scene:{version:1,relation:'resume',trigger:user('hold'),
    focus:user('intro'),parked:user('movie'),transition:{trigger:user('hold'),reply:null},relatedReplies:[ref(offer)]}});
  assert.equal(result.control.history.at(-1).bodyOmission,'inactive-scene');
  assert.equal(result.control.history.findLast(g=>!g.bodyOmission).messageId,'later');
  assert.match(result.system,/不因这句话补写此前已抱住、现在松开/);
});

test('a pause sees an earlier visible offer in the previous group even after two unrelated speakers',()=>{
  const paused=anchor('pause','先暂停一下，我们聊点别的'),third={id:'third',name:'另一位'};
  const guidance=/不因这句话补写此前已抱住、现在松开/;
  const generic=/只凭这句话不能补写已经发生的动作或双方接触/;
  for(const invitation of ['抱抱','好呀。']){
    const before=anchor('before',invitation),offer=said(before,'offer',speaker,['（张开手）过来吧']),
      weather=said(before,'weather',peer,['我喜欢晴天。']),music=said(before,'music',third,['这里的音乐真好听。']);
    const history=[before,offer,weather,music];
    const current=build(paused,{history});
    assert.deepEqual(current.control.history[0].responses.map(({speaker})=>speaker.id),[speaker.id,peer.id,third.id]);
    assert.match(current.system,guidance);

    const later=anchor('later','说说你喜欢的电影吧。');
    const intervening=build(paused,{history:[...history,later,said(later,'film',peer,['我也喜欢那部。'])]});
    assert.ok(intervening.control.timeline.some(e=>e.turnId===offer.id));
    assert.doesNotMatch(intervening.system,guidance);assert.match(intervening.system,generic);

    // A deliberate quote keeps the old bubble visible even after its scene was parked.
    const refUser=id=>({roomId:'room',generation:2,kind:'user',messageId:id});
    const parked=build(paused,{history,quotedMessage:{ref:ref(offer),author:{role:'assistant',...speaker},text:offer.assistant[0]},
      scene:{version:1,relation:'pause',trigger:refUser('pause'),focus:refUser('pause'),parked:refUser('before'),
        transition:{trigger:refUser('pause'),reply:null},relatedReplies:[]}});
    assert.equal(parked.control.history[0].bodyOmission,'inactive-scene');
    assert.ok(parked.control.quotedMessage);assert.doesNotMatch(parked.system,guidance);assert.match(parked.system,generic);
  }
});

test('the generation contract separates explicit none from unspecified gender and retains presentation without inferring sex',()=>{
  const source='原创智能助手；男娘或假小子都只作风格参考，未指定性别，自称本台。',prompt=buildExtractPrompt(source);
  assert.ok(prompt.user.endsWith(source));assert.match(prompt.system,/none原设明确无性别、unset不指定/);
  assert.match(prompt.system,/智能助手、AI或机器人身份本身不代表无性别/);
  assert.match(prompt.system,/「男娘」若明确男性就用male/);assert.match(prompt.system,/「假小子」若明确女性就用female/);
  assert.match(prompt.system,/这些词或中性外观本身不能代替明示性别/);assert.match(prompt.system,/不要为了统一字段删去这类风格/);
  const records=GENERATION_RECORDS_EXAMPLE.filter(row=>row[0]!=='gender');
  for(const gender of ['unset','none']){
    const raw=[...records.slice(0,3),['gender',gender],...records.slice(3)].map(row=>JSON.stringify(row)).join('\n'),result=parseGeneratedPreset(raw,source);
    assert.equal(result.ok,true,result.reason);assert.equal(result.preset.chat.gender,gender);assert.equal(result.preset.chat.source.text,source);
  }
});
