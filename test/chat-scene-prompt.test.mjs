import test from 'node:test';
import assert from 'node:assert/strict';
import {buildActorTimeline} from '../lib/chat-messages.js';
import {buildChatPrompt} from '../lib/chat-prompt.js';
import {readChatInput} from './helpers/chat-input.mjs';

const scopeKey='scope',roomId='room',generation=2;
const me={id:'a',name:'甲'},peer={id:'b',name:'乙'};
const pack={identity:'当前人格',voice:[],samples:[],avoid:[],address:{user:'你'}};
const anchor=(id,user,patch={})=>({id,messageId:id,attemptId:id,phase:'anchor',user,userParts:[{id,text:user,at:1}],
  recipients:[],scopeKey,status:'ready',assistant:[],...patch});
const reply=(head,id,who,assistant,patch={})=>({...head,id,attemptId:id,phase:'reaction',recipientId:who.id,speakerName:who.name,
  assistant,userParts:undefined,status:'ready',...patch});
const userRef=id=>({roomId,generation,kind:'user',messageId:id});
const ref=(turn,index=0)=>({roomId,generation,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index});
const frame=(trigger,focus,patch={})=>({version:1,trigger:userRef(trigger.messageId),relation:'continue',focus:userRef(focus.messageId),
  parked:null,transition:null,relatedReplies:[],...patch});
const prompt=(current,extra={})=>buildChatPrompt({pack,speaker:me,participants:[me,peer],roomId,generation,scopeKey,
  currentTurn:current,message:current.user,history:[],...extra});
const timeline=(current,extra={})=>buildActorTimeline({speaker:me,roomId,generation,scopeKey,currentTurn:current,message:current.user,...extra});
const packet=message=>JSON.parse(message.content[0].text);
const eventFor=(p,pointer)=>p.control.timeline.find(event=>event.eventId===pointer?.eventId);

test('a continued user topic carries its own historical summary as prior public work without copying the text into controls',()=>{
  const work=anchor('work','看看这个任务，帮我总结'),own=reply(work,'summary',me,['已完成的主要结论。','必须保留的限制条件。']);
  const now=anchor('opinion','其他人的看法呢'),scene=frame(now,work,{relatedReplies:[ref(own)]});
  const p=prompt(now,{history:[work,own],scene,quotedMessage:{ref:ref(own,1),author:{role:'assistant',id:me.id,name:me.name},text:own.assistant[1]},
    coordination:{work:'required',sourceIds:['source'],request:'unclear'},workContext:{sources:[{sessionId:'source',report:'本轮只读报告。'}]}});
  const value=p.control.conversationScene;
  assert.equal(value.relation,'continue');assert.equal(eventFor(p,value.focus).messageId,work.messageId);
  assert.equal(value.relatedReplies.length,1);assert.equal(eventFor(p,value.relatedReplies[0]).author.id,me.id);
  assert.ok(p.control.sharedResponse.priorReplyEvents.includes(value.relatedReplies[0].eventId),'a persona can see that her own earlier summary already answered the shared task');
  assert.equal(p.control.sharedResponse.workRole,'optional-addition');assert.equal(readChatInput(p).quotedMessage.text,own.assistant[1]);
  for(const line of [work.user,...own.assistant])assert.equal(JSON.stringify(p.messages).split(line).length-1,1);
  assert.doesNotMatch(JSON.stringify({scene:p.control.conversationScene,shared:p.control.sharedResponse}),/已完成的主要结论|必须保留的限制条件|本轮只读报告/);
});

test('without an explicitly bound scene a new user bubble does not infer cross-cycle reply or scene state',()=>{
  const old=anchor('old','此前的任务'),said=reply(old,'said',me,['此前已完成的总结']),now=anchor('now','其他人的看法呢');
  const p=prompt(now,{history:[old,said]});
  assert.equal(p.control.conversationScene,undefined);assert.deepEqual(p.control.sharedResponse.priorReplyEvents,[]);
});

test('pause is acknowledged only by a complete public reply and the state survives a subsequent personal continuation',()=>{
  const work=anchor('work','项目相关的原话'),pause=anchor('pause','算了先不管，和我贴贴');
  const first=prompt(pause,{history:[work],scene:frame(pause,pause,{relation:'pause',parked:userRef(work.messageId),transition:{trigger:userRef(pause.messageId),reply:null}})});
  assert.equal(first.control.conversationScene.transition.acknowledged,false);assert.equal(first.control.conversationScene.transition.reply,null);
  const ack=reply(pause,'ack',peer,['（稍微挪开一点位置）','来，靠一会儿。']);
  const next=anchor('next','其他人也要'),scene=frame(next,pause,{parked:userRef(work.messageId),
    transition:{trigger:userRef(pause.messageId),reply:ref(ack)},relatedReplies:[ref(ack)]});
  const p=prompt(next,{history:[work,pause,ack],scene,coordination:{work:'not-needed',sourceIds:[],request:'unclear'},
    workContext:{sourceCatalog:[{id:'source',name:'已接入任务'}],sources:[{sessionId:'source',report:'MUST_NOT_REENTER_WORK_REPORT'}]}});
  assert.equal(p.control.conversationScene.transition.acknowledged,true);assert.equal(eventFor(p,p.control.conversationScene.transition.reply).turnId,ack.id);
  assert.equal(p.control.sharedResponse.workRole,undefined,'a personal continuation is not an information-audit role');
  assert.equal(readChatInput(p).exchange.length,0,'scene references do not falsify the current-cycle exchange');
  assert.equal(p.control.sharedResponse.priorReplyEvents.length,1);assert.doesNotMatch(JSON.stringify(p),/MUST_NOT_REENTER_WORK_REPORT/);
});

test('scene references cannot import another room, generation, source scope, pending response or excluded transition',()=>{
  const work=anchor('work','真实任务'),pause=anchor('pause','先聊点别的'),ack=reply(pause,'ack',peer,['完整的承接。']),now=anchor('now','继续聊');
  const base=frame(now,pause,{parked:userRef(work.messageId),transition:{trigger:userRef(pause.messageId),reply:ref(ack)},relatedReplies:[ref(ack)]});
  const history=[work,pause,ack];
  for(const scene of [{...base,trigger:{...base.trigger,roomId:'other'}},{...base,focus:{...base.focus,generation:1}},
    {...base,parked:userRef('missing')},{...base,transition:{trigger:userRef(now.messageId),reply:ref(ack)}}]){
    assert.equal(prompt(now,{history,scene}).control.conversationScene,undefined);
  }
  for(const patch of [{scopeKey:'other'},{roomId:'other'},{status:'pending'},{status:'failed'}]){
    const p=prompt(now,{history:[work,pause,{...ack,...patch}],scene:base});assert.equal(p.control.conversationScene,undefined);
    assert.doesNotMatch(JSON.stringify(p.messages),/完整的承接/);
  }
  assert.equal(prompt(now,{history,scene:base,excluded:[ref(ack)]}).control.conversationScene,undefined);
  const invalidRelated=prompt(now,{history,scene:frame(now,work,{relatedReplies:[{...ref(ack),roomId:'other'},ref(ack,1)]})});
  assert.deepEqual(invalidRelated.control.conversationScene.relatedReplies,[]);
  assert.deepEqual(invalidRelated.control.sharedResponse.priorReplyEvents,[]);
  assert.equal(invalidRelated.control.conversationScene.omitted.filter(item=>item.reason==='unavailable').length,2);
});

test('a later continuation can provide the first real transition acknowledgment without binding it to the pause messageId',()=>{
  const work=anchor('work','原先的工作话题',{at:1}),pause=anchor('pause','先歇会',{at:2}),continuation=anchor('continuation','其他人也来',{at:3});
  const ack=reply(continuation,'later-ack',peer,['来，给你留个位置。'],{completedAt:4}),now=anchor('now','接着刚才聊',{at:5});
  const scene=frame(now,pause,{parked:userRef(work.messageId),transition:{trigger:userRef(pause.messageId),reply:ref(ack)},relatedReplies:[ref(ack)]});
  const p=prompt(now,{history:[work,pause,continuation,ack],scene});
  assert.equal(p.control.conversationScene.transition.acknowledged,true);
  assert.equal(eventFor(p,p.control.conversationScene.transition.reply).messageId,continuation.messageId);
  const earlier=reply(work,'too-early',peer,['不能冒充后来的承接。']);
  assert.equal(prompt(now,{history:[work,earlier,pause,continuation],scene:{...scene,transition:{trigger:userRef(pause.messageId),reply:ref(earlier)}}}).control.conversationScene,undefined);
  const future=anchor('future','未来一轮',{at:9}),futureAck=reply(future,'future-ack',peer,['尚未到达的承接。']);
  assert.equal(prompt(now,{history:[work,pause,continuation,future,futureAck],scene:{...scene,transition:{trigger:userRef(pause.messageId),reply:ref(futureAck)}}}).control.conversationScene,undefined);
});

test('a focus made of merged user parts and a whole related reply outrank ordinary recent history',()=>{
  const parts=Array.from({length:8},(_,i)=>({id:'part-'+i,text:String(i).repeat(430)+'完整分段'+i,at:i}));
  const work=anchor(parts[0].id,parts.map(part=>part.text).join('\n'),{userParts:parts}),summary=reply(work,'summary',peer,['主要结论'+ '甲'.repeat(1800),'限制与风险'+ '乙'.repeat(1800)]);
  const history=[work,summary];
  for(let i=0;i<10;i++){const head=anchor('filler-'+i,'后续无关话题'+i);history.push(head,reply(head,'filler-reply-'+i,peer,['无关发言'+String(i).repeat(900)]));}
  const now=anchor('now','还是说回这件事'),scene=frame(now,work,{focus:userRef(parts[0].id),focusParts:parts.map(part=>userRef(part.id)),relatedReplies:[ref(summary)]});
  const result=timeline(now,{history,scene,chars:8000});assert.equal(result.conversationScene.focusParts.length,8);
  assert.equal(result.conversationScene.relatedReplies.length,1);assert.deepEqual(result.conversationScene.omitted,[]);
  for(const part of parts)assert.ok(result.messages.some(message=>message.content[0].text.includes(part.text)));
  const item=result.timeline.find(event=>event.eventId===result.conversationScene.relatedReplies[0].eventId);
  assert.deepEqual(packet(result.messages[item.messageIndex]).messages.map(message=>message.text),summary.assistant,'all original conditions remain in their original order');
});

test('budget omission cannot make an acknowledged transition pending or present a partial related reply as complete',()=>{
  const work=anchor('work','旧工作话题'),pause=anchor('pause','先不聊工作，靠过来'),ack=reply(pause,'ack',peer,['甲'.repeat(80),'后半段保留条件'+ '乙'.repeat(80)]),now=anchor('now','其他人也要');
  const scene=frame(now,pause,{parked:userRef(work.messageId),transition:{trigger:userRef(pause.messageId),reply:ref(ack)},relatedReplies:[ref(ack)]});
  const result=timeline(now,{history:[work,pause,ack],scene,chars:130,quotedMessage:{ref:ref(ack),author:{role:'assistant',id:peer.id},text:ack.assistant[0]}});
  const view=result.conversationScene;assert.equal(view.transition.acknowledged,true);assert.equal(view.transition.reply,null);assert.deepEqual(view.relatedReplies,[]);
  assert.ok(view.omitted.some(item=>item.part==='transition-reply'&&item.reason==='budget'));
  assert.ok(view.omitted.some(item=>item.part==='related-reply'&&item.reason==='budget'));
  assert.ok(result.quotedMessage,'an explicit original quote keeps its independent pointer');
  const projected=result.timeline.find(event=>event.turnId===ack.id);assert.equal(projected.omittedBubbles,1);assert.deepEqual(packet(result.messages[projected.messageIndex]).messages.map(item=>item.text),[ack.assistant[0]]);
  assert.ok(!JSON.stringify(result.messages).includes('后半段保留条件'),'the missing complete bubble is explicitly omitted rather than sliced');
});

test('merged focus parts are admitted together or explicitly omitted instead of silently losing a trailing condition',()=>{
  const parts=[{id:'first',text:'甲'.repeat(90),at:1},{id:'condition',text:'重要条件'+ '乙'.repeat(90),at:2}],work=anchor(parts[0].id,parts.map(part=>part.text).join('\n'),{userParts:parts});
  const now=anchor('now','继续'),scene=frame(now,work,{focus:userRef('first'),focusParts:parts.map(part=>userRef(part.id))});
  const result=timeline(now,{history:[work],scene,chars:120});
  assert.equal(result.conversationScene.focus,null);assert.deepEqual(result.conversationScene.focusParts,[]);
  assert.ok(result.conversationScene.omitted.some(item=>item.part==='focus-parts'&&item.reason==='budget'));
  assert.doesNotMatch(JSON.stringify(result.messages),/甲{20}|乙{20}/);
  assert.equal(timeline(now,{history:[work],scene:{...scene,focusParts:[userRef('first'),userRef('missing')]}}).conversationScene,undefined);
});

test('merged pause and continuation triggers preserve the later user part that actually changes the interaction',()=>{
  const parts=[{id:'pause',text:'嗯',at:1},{id:'pause-invite',text:'先歇会，抱抱我',at:2}],pause=anchor('pause',parts.map(part=>part.text).join('\n'),{userParts:parts});
  const firstScene=frame(pause,pause,{relation:'pause',triggerParts:parts.map(part=>userRef(part.id)),focusParts:parts.map(part=>userRef(part.id)),
    transition:{trigger:userRef('pause'),reply:null},transitionTriggerParts:parts.map(part=>userRef(part.id))});
  const first=prompt(pause,{scene:firstScene});assert.equal(first.control.conversationScene.triggerParts.length,2);
  assert.equal(first.control.conversationScene.transitionTriggerParts.length,2);assert.equal(first.control.conversationScene.transition.acknowledged,false);
  const ack=reply(pause,'ack',peer,['来，靠一会儿。']),nowParts=[{id:'now',text:'还有',at:3},{id:'now-others',text:'其他人也要',at:4}],now=anchor('now',nowParts.map(part=>part.text).join('\n'),{userParts:nowParts});
  const p=prompt(now,{history:[pause,ack],scene:frame(now,pause,{triggerParts:nowParts.map(part=>userRef(part.id)),focusParts:parts.map(part=>userRef(part.id)),
    transition:{trigger:userRef('pause'),reply:ref(ack)},transitionTriggerParts:parts.map(part=>userRef(part.id)),relatedReplies:[ref(ack)],omittedRelatedReplies:3})});
  const view=p.control.conversationScene;assert.equal(view.transition.acknowledged,true);assert.equal(view.triggerParts.length,2);
  assert.equal(view.transitionTriggerParts.length,2);assert.equal(view.focusParts.length,2);
  for(const literal of [parts[1].text,nowParts[1].text])assert.equal(JSON.stringify(p.messages).split(literal).length-1,1);
  assert.ok(view.omitted.some(item=>item.part==='related-reply'&&item.reason==='history-limit'&&item.count===3));
  assert.equal(prompt(pause,{scene:{...firstScene,triggerParts:[userRef('pause')]}}).control.conversationScene,undefined,
    'a locator for an input group cannot silently conceal its second part');
});

test('a paused scene retrieves its active focus while parked speech stays stored with completion metadata',()=>{
  const work=anchor('work','OLD_WORK_USER：检查发布前的项目'),summary=reply(work,'summary',peer,['OLD_WORK_BODY：已改设置页。','OLD_WORK_CONDITION：真实客户端尚未验证，不可声称验收。']);
  const pause=anchor('pause','先歇会，和我贴贴'),scene=frame(pause,pause,{relation:'pause',parked:userRef(work.messageId),transition:{trigger:userRef(pause.messageId),reply:null}});
  const history=[work,summary],original=structuredClone(history),p=prompt(pause,{history,scene,
    discussionState:[{id:'old-note',version:1,title:'旧项目状态',status:'discussing',reviewedBy:'user-in-settings',source:{ref:ref(summary),author:{role:'assistant',...peer},text:summary.assistant[0]}}]});
  assert.equal(p.control.conversationScene.historySelection,'active-focus');assert.equal(p.control.conversationScene.parked,null);
  assert.ok(p.control.conversationScene.omitted.some(value=>value.part==='parked'&&value.reason==='inactive-scene'));
  assert.doesNotMatch(JSON.stringify(p.messages),/OLD_WORK_USER|OLD_WORK_BODY|OLD_WORK_CONDITION/);
  const old=p.control.history.find(value=>value.messageId===work.messageId);
  assert.equal(old.bodyOmission,'inactive-scene');assert.equal(old.omittedUserParts,1);assert.deepEqual(old.userEvents,[]);
  assert.equal(old.responses[0].status,'ready');assert.equal(old.responses[0].omittedBubbles,2);assert.equal(old.responses[0].eventId,null);
  assert.deepEqual(p.control.roomNotes,[]);assert.deepEqual(p.control.discussionState,[]);assert.deepEqual(history,original,'retrieval does not edit the store or old original conditions');
  const selection=timeline(pause,{history,scene,notes:[{ref:userRef(work.messageId),quote:work.user,author:{role:'user'},messageId:work.messageId}]});
  assert.deepEqual(selection.roomNotes,[]);assert.doesNotMatch(JSON.stringify(selection.messages),/OLD_WORK_USER|OLD_WORK_BODY|OLD_WORK_CONDITION/);
});

test('old unread inbox entries cannot reopen a parked topic and are explicitly omitted',()=>{
  const work=anchor('work','OLD_UNREAD_USER'),summary=reply(work,'summary',peer,['OLD_UNREAD_REPLY','OLD_UNREAD_CONDITION']),pause=anchor('pause','抱一会儿');
  const result=timeline(pause,{history:[work,summary],scene:frame(pause,pause,{relation:'pause',parked:userRef('work'),transition:{trigger:userRef('pause'),reply:null}}),
    inbox:[{author:{role:'user'},refs:[userRef('work'),userRef('pause')]},{author:{role:'assistant',id:peer.id},refs:[ref(summary),ref(summary,1)]}]});
  assert.doesNotMatch(JSON.stringify(result.messages),/OLD_UNREAD_USER|OLD_UNREAD_REPLY|OLD_UNREAD_CONDITION/);
  assert.equal(result.inbox.length,1);assert.equal(result.timeline.find(value=>value.eventId===result.inbox[0]).messageId,pause.messageId);
  assert.ok(result.conversationScene.omitted.some(value=>value.part==='inbox'&&value.reason==='inactive-scene'&&value.count===2));
});

test('an explicit quote preserves its one parked original without widening the old topic or old inbox',()=>{
  const work=anchor('work','OLD_UNQUOTED_USER'),summary=reply(work,'summary',peer,['EXPLICIT_QUOTED_ORIGINAL','OLD_UNQUOTED_CONDITION']),pause=anchor('pause','先抱抱，不过这句是什么意思');
  const options={history:[work,summary],scene:frame(pause,pause,{relation:'pause',parked:userRef('work'),transition:{trigger:userRef('pause'),reply:null}}),
    quotedMessage:{ref:ref(summary),author:{role:'assistant',...peer},text:summary.assistant[0]},
    replyTarget:{ref:userRef('pause'),author:{role:'user'},text:pause.user},inbox:[{author:{role:'assistant',id:peer.id},refs:[ref(summary),ref(summary,1)]}],chars:140};
  const result=timeline(pause,options);assert.ok(result.quotedMessage);assert.ok(result.replyTarget);
  assert.equal(JSON.stringify(result.messages).split(summary.assistant[0]).length-1,1);
  assert.doesNotMatch(JSON.stringify(result.messages),/OLD_UNQUOTED_USER|OLD_UNQUOTED_CONDITION/);assert.deepEqual(result.inbox,[]);
  const quoted=result.timeline.find(value=>value.turnId===summary.id);assert.equal(quoted.omittedBubbles,1);
  assert.equal(timeline(pause,{...options,quotedMessage:{...options.quotedMessage,ref:{...ref(summary),roomId:'other'}}}).quotedMessage,undefined);
});

test('resume retrieves the original work conditions while omitting the paused interaction body',()=>{
  const work=anchor('work','请检查发布条件'),summary=reply(work,'summary',peer,['原始结论：布局已改。','原始限制：12项离线通过，真实客户端没验，发布未批准。']);
  const pause=anchor('pause','PAUSED_INVITATION：先抱会儿'),ack=reply(pause,'ack',peer,['PAUSED_RESPONSE：给你留个位置。']),now=anchor('resume','继续刚才没验的风险');
  const scene=frame(now,work,{relation:'resume',parked:userRef('pause'),transition:{trigger:userRef('resume'),reply:null},relatedReplies:[ref(summary)]});
  const result=timeline(now,{history:[work,summary,pause,ack],scene});
  for(const text of [work.user,...summary.assistant])assert.equal(JSON.stringify(result.messages).split(text).length-1,1);
  assert.doesNotMatch(JSON.stringify(result.messages),/PAUSED_INVITATION|PAUSED_RESPONSE/);
  assert.equal(result.history.find(value=>value.messageId==='pause').responses[0].status,'ready');
  const restored=timeline(now,{history:structuredClone([work,summary,pause,ack]),scene:structuredClone(scene)});
  assert.deepEqual(restored.messages,result.messages);assert.deepEqual(restored.conversationScene,result.conversationScene);
});

test('ongoing interaction is the top actor instruction only after a whole reply commits, preserving stream and reply order',()=>{
  const work=anchor('work','OLD_WORK_STREAM'),pause=anchor('pause','来贴贴'),draft=reply(pause,'draft',peer,['STREAM_PREVIEW_MUST_STAY_PRIVATE'],{status:'pending'});
  const pendingScene=frame(pause,pause,{relation:'pause',parked:userRef('work'),transition:{trigger:userRef('pause'),reply:null}});
  const first=prompt(pause,{history:[work],exchange:[draft],scene:pendingScene});
  assert.equal(first.control.conversationScene.transition.acknowledged,false);assert.doesNotMatch(first.system.split('\n')[0],/当前互动已经开始/);
  assert.doesNotMatch(JSON.stringify(first.messages),/STREAM_PREVIEW_MUST_STAY_PRIVATE|OLD_WORK_STREAM/);
  const ready={...draft,status:'ready',assistant:['（挪近一点）','来，这里。']},now=anchor('continue','其他人也来');
  const scene=frame(now,pause,{parked:userRef('work'),transition:{trigger:userRef('pause'),reply:ref(ready)},relatedReplies:[ref(ready)]});
  const second=prompt(now,{history:[work,pause,ready],scene});
  assert.match(second.system.split('\n')[0],/当前互动已经开始.*延续自己这一拍/);
  const event=second.control.timeline.find(value=>value.turnId===ready.id),body=packet(second.messages[event.messageIndex]);
  assert.deepEqual(body.messages.map(value=>value.text),ready.assistant);assert.equal(second.control.conversationScene.transition.acknowledged,true);
  assert.ok(second.control.sharedResponse.priorReplyEvents.includes(event.eventId));assert.doesNotMatch(JSON.stringify(second.messages),/OLD_WORK_STREAM/);
});

test('an active user chain retains intermediate conditions even when nobody produced a ready reply',()=>{
  const work=anchor('work','PARKED_WORK_OUTSIDE_ACTIVE_CHAIN'),pause=anchor('pause','靠着就好');
  const parts=[{id:'mid',text:'还有一个要求',at:2},{id:'mid-condition',text:'别碰肩膀，靠着就好。',at:3}],mid=anchor('mid',parts.map(value=>value.text).join('\n'),{userParts:parts});
  mid.scene=frame(mid,pause);
  const failed=reply(mid,'failed',peer,['FAILED_PREVIEW'],{status:'failed'}),now=anchor('now','嗯，就这样');
  const scene=frame(now,pause,{parked:userRef('work'),transition:{trigger:userRef('pause'),reply:null},
    activeUserGroups:[[userRef('pause')],parts.map(part=>userRef(part.id)),[userRef('now')]],omittedActiveUserGroups:0});
  const options={history:[work,pause,mid,failed],scene},p=prompt(now,options);
  for(const part of parts)assert.equal(JSON.stringify(p.messages).split(part.text).length-1,1);
  assert.equal(p.control.conversationScene.activeUserGroups.length,3);assert.equal(p.control.conversationScene.transition.acknowledged,false);
  assert.doesNotMatch(JSON.stringify(p.messages),/PARKED_WORK_OUTSIDE_ACTIVE_CHAIN|FAILED_PREVIEW/);
  const middle=p.control.history.find(group=>group.messageId==='mid');assert.equal(middle.bodyOmission,undefined);assert.equal(middle.userEvents.length,2);
  assert.equal(middle.responses[0].status,'failed');
  for(const change of [
    [[userRef('pause')],[{...userRef('mid'),roomId:'other'}],[userRef('now')]],
    [[userRef('pause')],[{...userRef('mid'),generation:0}],[userRef('now')]],
    [[userRef('pause')],[userRef('mid')],[userRef('now')]],
    [[userRef('pause')],[userRef('mid'),userRef('missing')],[userRef('now')]],
  ])assert.equal(prompt(now,{...options,scene:{...scene,activeUserGroups:change}}).control.conversationScene,undefined,'unavailable or incomplete chain refs cannot claim a complete active context');
  assert.equal(prompt(now,{...options,history:[work,pause,{...mid,scopeKey:'other'},failed]}).control.conversationScene,undefined);
  const withoutRelation=prompt(now,{...options,history:[work,pause,{...mid,scene:undefined},failed]});
  assert.ok(withoutRelation.control.conversationScene.omitted.some(value=>value.part==='active-user-group'&&value.reason==='unavailable'));
  assert.doesNotMatch(JSON.stringify(withoutRelation.messages),/别碰肩膀/,'missing saved focus association stays unknown rather than inventing a link');
  const oldWorkWithScene={...work,scene:frame(work,work,{relation:'fresh'})},forgedOldGroup=prompt(now,{...options,history:[oldWorkWithScene,pause,mid,failed],
    scene:{...scene,activeUserGroups:[[userRef('pause')],[userRef('work')],...scene.activeUserGroups.slice(1)]}});
  assert.doesNotMatch(JSON.stringify(forgedOldGroup.messages),/PARKED_WORK_OUTSIDE_ACTIVE_CHAIN/);
  assert.ok(forgedOldGroup.control.conversationScene.omitted.some(value=>value.part==='active-user-group'&&value.reason==='unavailable'));
});

test('recent whole active user conditions outrank old related reply bodies and omissions remain unknown',()=>{
  const pause=anchor('pause','先坐坐'),parts=[{id:'mid',text:'LIMIT_FIRST：'+ '甲'.repeat(55),at:2},{id:'mid-condition',text:'LIMIT_SECOND：'+ '乙'.repeat(55),at:3}];
  const mid=anchor('mid',parts.map(value=>value.text).join('\n'),{userParts:parts}),oldReply=reply(pause,'old-reply',peer,['OLD_RELATED_LONG：'+ '丙'.repeat(220)]),now=anchor('now','按刚才那样');
  mid.scene=frame(mid,pause);
  const scene=frame(now,pause,{transition:{trigger:userRef('pause'),reply:ref(oldReply)},relatedReplies:[ref(oldReply)],
    activeUserGroups:[[userRef('pause')],parts.map(part=>userRef(part.id)),[userRef('now')]],omittedActiveUserGroups:2});
  const result=timeline(now,{history:[pause,oldReply,mid],scene,chars:190});
  for(const part of parts)assert.ok(JSON.stringify(result.messages).includes(part.text));
  assert.doesNotMatch(JSON.stringify(result.messages),/OLD_RELATED_LONG/);assert.equal(result.conversationScene.transition.acknowledged,true);
  assert.ok(result.conversationScene.omitted.some(value=>value.part==='active-user-group'&&value.reason==='history-limit'&&value.count===2));
  assert.ok(result.conversationScene.omitted.some(value=>value.part==='related-reply'&&value.reason==='budget'));
  const tight=timeline(now,{history:[pause,oldReply,mid],scene,chars:95});
  assert.doesNotMatch(JSON.stringify(tight.messages),/LIMIT_FIRST|LIMIT_SECOND/,'merged constraints must not be split into a misleading partial original');
  assert.ok(tight.conversationScene.omitted.some(value=>value.part==='active-user-group'&&value.reason==='budget'));
  assert.equal(tight.history.find(group=>group.messageId==='mid').bodyOmission,undefined,'a budget omission is not a topic change');
  const unread=timeline(now,{history:[pause,oldReply,mid],scene,chars:95,
    inbox:[{author:{role:'user'},refs:[userRef(parts[0].id)]}]});
  assert.doesNotMatch(JSON.stringify(unread.messages),/LIMIT_FIRST|LIMIT_SECOND/,
    'an implicit inbox part cannot bypass whole-group selection and hide a trailing condition');
});
