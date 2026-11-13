import test from 'node:test';
import assert from 'node:assert/strict';
import {buildActorTimeline} from '../lib/chat-messages.js';
import {focusChatReading} from '../lib/chat-reading.js';
import {buildChatPrompt} from '../lib/chat-prompt.js';
import {readChatInput} from './helpers/chat-input.mjs';

const roomId='reading-room',scopeKey='reading-scope',generation=1,self={id:'self',name:'本人'},peer={id:'peer',name:'同伴'};
const user=(id,text,patch={})=>({id,messageId:id,attemptId:id,user:text,userParts:[{id,text,at:1}],phase:'anchor',recipients:[],
  roomId,scopeKey,status:'ready',assistant:[],at:1,...patch});
const reply=(head,id,speaker,messages,patch={})=>({...head,id,attemptId:id,phase:'reaction',userParts:undefined,recipientId:speaker.id,speakerName:speaker.name,
  assistant:messages,status:'ready',completedAt:2,...patch});
const userRef=id=>({roomId,generation,kind:'user',messageId:id});
const replyRef=(turn,index=0)=>({roomId,generation,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index});
const build=(head,extra={})=>buildActorTimeline({currentTurn:head,message:head.user,speaker:self,roomId,generation,scopeKey,...extra});
const packet=message=>JSON.parse(message.content[0].text);
const canonical=view=>view.timeline.map(event=>({eventId:event.eventId,author:event.author,bubbles:event.bubbles,
  original:packet(view.messages[event.messageIndex]),omittedBubbles:event.omittedBubbles}));
const target=head=>({ref:userRef(head.id),author:{role:'user',name:'我'},text:head.user});

test('user-facing reading reorders originals without deleting, duplicating or mutating public chronology',()=>{
  const head=user('now','我要抱抱。'),one=reply(head,'one',peer,['同伴第一泡。','同伴第二泡。']),two=reply(head,'two',{id:'p2',name:'另一位'},['另一位原话。']);
  const before=build(head,{exchange:[one,two],replyTarget:target(head)}),copy=structuredClone(before),after=focusChatReading(before);
  assert.deepEqual(before,copy);assert.deepEqual(canonical(after),canonical(before));
  assert.deepEqual(after.messages.map(message=>message.id).toSorted(),before.messages.map(message=>message.id).toSorted());
  assert.deepEqual(after.timeline.map(event=>event.eventId),before.timeline.map(event=>event.eventId));
  assert.equal(after.timeline[0].messageIndex,after.messages.length-1);assert.equal(packet(after.messages.at(-1)).author.role,'user');
  assert.deepEqual(after.timeline.map(event=>event.contextRole),['current-user','peer-background','peer-background']);
  assert.equal(new Set(after.timeline.map(event=>event.messageIndex)).size,after.messages.length);
});

test('merged current user parts remain an atomic ordered group, including trailing conditions',()=>{
  const parts=[{id:'now',text:'先听我说',at:1},{id:'condition',text:'只讨论，不要执行。',at:2}],head=user('now',parts.map(part=>part.text).join('\n'),{userParts:parts}),said=reply(head,'said',peer,['先前公开话。']);
  const before=build(head,{exchange:[said],replyTarget:{ref:userRef('condition'),author:{role:'user',name:'我'},text:parts[1].text}}),after=focusChatReading(before);
  assert.deepEqual(canonical(after),canonical(before));
  assert.deepEqual(after.messages.slice(-2).map(message=>packet(message).messages[0].text),parts.map(part=>part.text));
  assert.deepEqual(after.readingFocus.currentUserEventIds,after.currentMessage.eventIds);
});

test('an older exact peer target keeps all admitted bubbles and never rebinds identical later words',()=>{
  const head=user('now','接着聊'),one=reply(head,'one',peer,['重复原话','目标这一轮的后续条件']),two=reply(head,'two',peer,['重复原话','较新的另一轮']);
  const before=build(head,{exchange:[one,two],replyTarget:{ref:replyRef(one),author:{role:'assistant',...peer},text:'重复原话'}}),after=focusChatReading(before);
  assert.deepEqual(canonical(after),canonical(before));assert.deepEqual(after.replyTarget,before.replyTarget);
  const end=packet(after.messages.at(-1));assert.deepEqual(end.messages.map(b=>b.text),one.assistant);
  assert.equal(after.timeline.find(event=>event.contextRole==='reply-target').turnId,'one');
  const userEvent=after.timeline.find(event=>event.author.role==='user');assert.equal(userEvent.messageIndex,after.messages.length-2);
});

test('explicit quotes and discussion evidence retain original attribution without becoming the response target',()=>{
  const old=user('old','旧话题'),said=reply(old,'old-said',peer,['只读原话。']),head=user('now','怎么看这句？');
  const quote={ref:replyRef(said),author:{role:'assistant',...peer},text:said.assistant[0]};
  const before=build(head,{history:[old,said],quotedMessage:quote,replyTarget:target(head),discussion:[{id:'d',version:1,title:'候选',status:'proposal',source:quote,reviewedBy:'user-in-settings'}]}),after=focusChatReading(before);
  assert.deepEqual(canonical(after),canonical(before));assert.deepEqual(after.quotedMessage,before.quotedMessage);assert.deepEqual(after.discussionState,before.discussionState);
  assert.equal(after.timeline.find(event=>event.turnId===said.id).contextRole,'referenced-peer');
  assert.equal(after.readingFocus.targetEventId,after.replyTarget.eventId);assert.notEqual(after.replyTarget.eventId,after.quotedMessage.pointer.eventId);
});

test('own assistant history retains original SDK identity and cannot be promoted to an external target',()=>{
  const old=user('old','此前用户话'),own=reply(old,'own',self,['我自己的原话。']),head=user('now','现在这句'),said=reply(head,'peer',peer,['同伴这句']);
  const before=build(head,{history:[old,own],exchange:[said],replyTarget:target(head)}),after=focusChatReading(before);
  assert.deepEqual(after.messages.filter(message=>message.role==='assistant'),before.messages.filter(message=>message.role==='assistant'));
  assert.equal(after.timeline.find(event=>event.turnId==='own').contextRole,'self-history');
  const bad=structuredClone(before),ownEvent=bad.timeline.find(event=>event.turnId==='own');bad.replyTarget={eventId:ownEvent.eventId,index:0,author:ownEvent.author};
  assert.equal(focusChatReading(bad),bad);
});

test('malformed, absent or unresolved reading targets fall back without guessing or granting new references',()=>{
  const head=user('now','当前用户'),said=reply(head,'said',peer,['当前同伴']),base=build(head,{exchange:[said],replyTarget:target(head)});
  const mutations=[value=>{delete value.replyTarget;},value=>{value.replyTarget.eventId='missing';},value=>{value.replyTarget.index=9;},
    value=>{value.replyTarget.author={role:'assistant',id:'forged'};},value=>{value.timeline[1].messageIndex=value.timeline[0].messageIndex;},
    value=>{value.messages[1].content[0].text='broken';},value=>{value.timeline[1].author.role='tool';},
    value=>{value.currentMessage.eventIds.push('missing');}];
  for(const mutate of mutations){const value=structuredClone(base);mutate(value);assert.equal(focusChatReading(value),value);assert.equal(value.readingFocus,undefined);}
  const solo=build(head,{replyTarget:target(head)});assert.equal(focusChatReading(solo),solo);
});

test('existing budget omissions and source/room exclusions are not undone by the reading view',()=>{
  const head=user('now','当前'),one=reply(head,'one',peer,['一'.repeat(80),'二'.repeat(80)]),foreign=reply(head,'foreign',peer,['FOREIGN_MUST_NOT_APPEAR'],{roomId:'other',scopeKey:'other'});
  const before=build(head,{history:[foreign],exchange:[one],replyTarget:target(head),chars:100}),after=focusChatReading(before);
  assert.deepEqual(canonical(after),canonical(before));assert.doesNotMatch(JSON.stringify(after),/FOREIGN_MUST_NOT_APPEAR/);
  assert.ok(before.timeline.some(event=>event.omittedBubbles>0));assert.equal(after.messages.length,before.messages.length);
});

test('actual prompt controls resolve the same source, user conditions, task and private expression after presentation changes',()=>{
  const head=user('now','完整说清当前原文。'),said=reply(head,'said',peer,['同伴实际原话。']),work={sessionId:'work',report:'原作者：本地通过，设备未验，没有发布。'};
  const prompt=buildChatPrompt({pack:{identity:'自定义本人',voice:[],samples:[],avoid:[],address:{user:'你'}},speaker:self,roomId,generation,scopeKey,
    currentTurn:head,message:head.user,history:[],exchange:[said],replyTarget:target(head),memory:['ONLY_SELF_PRIVATE'],
    workContext:{scopeKey,sources:[work]},coordination:{work:'required',sourceIds:['work'],request:'answer'},
    directorAssignment:{id:self.id,kind:'normal',to:'user',goal:'回应原文',contribution:{move:'answer',point:'回应原文'}}});
  const decoded=readChatInput(prompt);assert.equal(decoded.message,head.user);assert.equal(decoded.exchange[0].messages[0],said.assistant[0]);
  assert.deepEqual(decoded.workContext.sources,[work]);assert.equal(decoded.directorAssignment.contribution.point,'回应原文');
  assert.match(prompt.system,/timeline 数组仍按实际发生顺序/);assert.match(prompt.system,/不是用户或同伴又说了一次/);
  assert.match(prompt.system,/ONLY_SELF_PRIVATE/);assert.doesNotMatch(JSON.stringify(prompt.messages),/ONLY_SELF_PRIVATE/);
  assert.equal(JSON.stringify(prompt.messages).split(head.user).length-1,1,'no user text is duplicated into a focus summary');
});
