import test from 'node:test';
import assert from 'node:assert/strict';
import {buildActorTimeline} from '../lib/chat-messages.js';
import {buildChatPrompt} from '../lib/chat-prompt.js';
import {readChatInput} from './helpers/chat-input.mjs';

const pack={identity:'当前人格',voice:[],samples:[],avoid:[],address:{user:'你'}};
const speaker={id:'a',name:'甲'},other={id:'b',name:'乙'},scopeKey='scope';
const anchor=(id,user,extra={})=>({id,messageId:id,attemptId:id,recipientId:'user',speakerName:'我',phase:'anchor',status:'ready',assistant:[],user,
  userParts:[{id,text:user,at:1}],recipients:[speaker],memberIdsAtSend:['a','b'],scopeKey,...extra});
const reply=(head,id,actor,lines,extra={})=>({...head,id,attemptId:id,recipientId:actor.id,speakerName:actor.name,phase:'reaction',status:'ready',assistant:lines,userParts:undefined,...extra});
const ref=(turn,index=0)=>({roomId:'room',generation:2,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index});
const userRef=id=>({roomId:'room',generation:2,kind:'user',messageId:id});
const prompt=extra=>buildChatPrompt({pack,history:[],message:'当前用户原话',currentTurn:anchor('now','当前用户原话'),speaker,participants:[speaker,other],recipients:[speaker],
  roomId:'room',generation:2,scopeKey,...extra});
const packet=message=>JSON.parse(message.content[0].text);

test('real API roles are relative to the current actor, with complete SDK identity and no replay metadata',()=>{
  const head=anchor('old','上一轮用户原话'),own=reply(head,'own',speaker,['我确实说过的话']),peer=reply(head,'peer',other,['同伴确实说过的话']);
  const first=prompt({history:[head,own,peer]}),second=prompt({history:[head,own,peer],speaker:other});
  const ownMessage=first.messages.find(message=>message.role==='assistant');assert.deepEqual(packet(ownMessage),{messages:own.assistant});
  assert.ok(ownMessage.id);assert.deepEqual(ownMessage.source,{kind:'model',provider:'persona-chat-history',model:'unknown'});
  assert.ok(!('replayState'in ownMessage.source));assert.equal(second.messages.find(message=>message.role==='assistant').content[0].text,JSON.stringify({messages:peer.assistant}));
  const peerMessage=first.messages.find(message=>message.role==='user'&&message.content[0].text.includes(peer.assistant[0]));
  assert.deepEqual(packet(peerMessage).author,{role:'assistant',id:'b',name:'乙'});
  assert.deepEqual(peerMessage.source,{kind:'model',provider:'persona-chat-history',model:'unknown'},'a peer is heard in the user role without falsely attributing her words to the human producer');
  assert.notEqual(peerMessage.id,second.messages.find(message=>message.role==='assistant').id,'SDK identity binds the actor-relative representation');
  assert.equal(first.messages.at(-1).role,'user');assert.equal(packet(first.messages.at(-1)).task,'chat-control');assert.equal(first.user,undefined);
});

test('one timeline retains each original once; control has only pointers and exact user parts remain separate',()=>{
  const current=anchor('part-one','第一条独有原话\n第二条独有原话',{userParts:[{id:'part-one',text:'第一条独有原话',at:1},{id:'part-two',text:'第二条独有原话',at:2}]}),
    one=reply(current,'one',speaker,['甲的唯一回应']),two=reply(current,'two',other,['乙的唯一回应']);
  const result=prompt({message:current.user,currentTurn:current,exchange:[one,two],replyTarget:{ref:userRef('part-two'),author:{role:'user'},text:'第二条独有原话'},
    inbox:[{author:{role:'user'},refs:[userRef('part-one'),userRef('part-two')]},{author:{role:'assistant',id:'b'},refs:[ref(two)]}]});
  const wire=JSON.stringify(result.messages),control=JSON.stringify(result.control);
  for(const literal of ['第一条独有原话','第二条独有原话','甲的唯一回应','乙的唯一回应']){
    assert.equal(wire.split(literal).length-1,1,literal);assert.ok(!control.includes(literal));
  }
  const input=readChatInput(result);assert.equal(input.message,current.user);assert.equal(input.exchange.length,2);assert.equal(input.inbox.length,3);
  assert.deepEqual(input.replyTarget,{author:{role:'user',name:'我'},text:'第二条独有原话'});
  const target=result.control.timeline.find(event=>event.eventId===result.control.replyTarget.eventId);assert.equal(target.bubbles[0].ref.messageId,'part-two');
});

test('canonical pointers deduplicate projections but never collapse equal words from different real messages',()=>{
  const old=anchor('old','真实重复原话'),one=reply(old,'first',speaker,['是的']),two=reply(old,'second',speaker,['是的']);
  const result=prompt({history:[old,one,two,one],exchange:[]});assert.equal(result.messages.filter(message=>message.role==='assistant').length,2);
  assert.equal(result.control.timeline.filter(event=>event.author.role==='user'&&event.messageId==='old').length,1);
  const again=prompt({history:[old,one,two,one]});assert.deepEqual(result.messages,again.messages,'same source view has stable message ids');
});

test('the exact target ref selects the original bubble even when the same author repeats identical words later',()=>{
  const current=anchor('now','你们接着聊'),first=reply(current,'first-identical',other,['重复的公开原句']),last=reply(current,'last-identical',other,['重复的公开原句']);
  const result=prompt({currentTurn:current,message:current.user,exchange:[first,last],replyTarget:{ref:ref(first),author:{role:'assistant',id:'b'},text:first.assistant[0]}});
  const target=result.control.timeline.find(event=>event.eventId===result.control.replyTarget.eventId);assert.equal(target.turnId,first.id);
  assert.equal(result.control.timeline.filter(event=>event.author.id==='b').length,2);
  const ambiguous=prompt({currentTurn:current,message:current.user,exchange:[first,last],replyTarget:{author:{role:'assistant',id:'b'},text:first.assistant[0]}});
  assert.equal(ambiguous.control.replyTarget,undefined,'old literal-only callers cannot silently choose a different matching bubble');
});

test('scope, room, original author and generation guard targeted and quoted history',()=>{
  const current=anchor('now','当前用户原话'),safe=reply(current,'safe',other,['真实目标原句']),foreign=reply(current,'foreign',other,['其他范围私聊'],{scopeKey:'other'}),
    outside=reply(current,'outside',other,['另一个房间私聊'],{roomId:'other-room'}),pending=reply(current,'pending',other,['未完成泄漏'],{status:'pending'});
  const result=prompt({exchange:[safe,foreign,outside,pending],replyTarget:{ref:ref(safe),author:{role:'assistant',id:'b',name:'假名字'},text:'目标原句'},
    quotedMessage:{ref:ref(foreign),author:{role:'assistant',id:'b'},text:foreign.assistant[0]}});
  assert.deepEqual(readChatInput(result).replyTarget,{author:{role:'assistant',id:'b',name:'乙'},text:'目标原句'});
  assert.equal(result.control.quotedMessage,undefined);assert.doesNotMatch(JSON.stringify(result),/其他范围私聊|另一个房间私聊|未完成泄漏|假名字/);
  for(const target of [{ref:ref(safe),author:{role:'assistant',id:'a'},text:'真实目标原句'},
    {ref:{...ref(safe),generation:1},author:{role:'assistant',id:'b'},text:'真实目标原句'},
    {ref:ref(safe),author:{role:'assistant',id:'b'},text:'编造的原句'}])assert.equal(prompt({exchange:[safe],replyTarget:target}).control.replyTarget,undefined);
});

test('recalled quote and discussion evidence point to the original public source without injecting duplicate speech',()=>{
  const old=anchor('old','已经确认的用户依据'),source=reply(old,'source',other,['先保留这个候选方案']),quote={ref:ref(source),author:{role:'assistant',id:'b',name:'乙'},text:source.assistant[0]},
    state={id:'state',version:1,title:'用户整理标签',status:'confirmed',source:quote,evidence:{ref:userRef('old'),author:{role:'user',name:'我'},text:old.user},reviewedBy:'user-in-settings'};
  const result=prompt({history:[old,source],quotedMessage:quote,discussionState:[state]});
  assert.equal(result.control.discussionState.length,1);assert.ok(result.control.quotedMessage.pointer);assert.ok(!('text'in result.control.quotedMessage));
  assert.equal(JSON.stringify(result.messages).split(source.assistant[0]).length-1,1);assert.equal(JSON.stringify(result.messages).split(old.user).length-1,1);
  const decoded=readChatInput(result);assert.equal(decoded.quotedMessage.text,source.assistant[0]);assert.equal(decoded.discussionState[0].evidence.text,old.user);
  const forged=prompt({history:[old,source],quotedMessage:{...quote,text:'无源引文'},discussionState:[{...state,evidence:{...state.evidence,text:'无源确认'}}]});
  assert.equal(forged.control.quotedMessage,undefined);assert.deepEqual(forged.control.discussionState,[]);
});

test('budget preserves the exact current target, complete original bubbles and ready author status without clipping',()=>{
  const current=anchor('now','当前用户原话'),source=reply(current,'source',other,['被明确接住的较早气泡']),exchange=[source,
    ...Array.from({length:31},(_,index)=>reply(current,'large-'+index,index%2?speaker:other,['第'+index+'段'+String(index).repeat(900)],{emittedOrder:index+1}))];
  const timeline=buildActorTimeline({currentTurn:current,message:current.user,exchange,speaker,roomId:'room',generation:2,scopeKey,chars:6000,
    replyTarget:{ref:ref(source),author:{role:'assistant',id:'b'},text:source.assistant[0]}});
  assert.ok(timeline.replyTarget);assert.equal(timeline.messages.filter(message=>message.content[0].text.includes(source.assistant[0])).length,1);
  const bodyChars=timeline.timeline.reduce((sum,event)=>sum+packet(timeline.messages[event.messageIndex]).messages.reduce((n,bubble)=>n+(typeof bubble==='string'?bubble:bubble.text).length,0),0);
  assert.ok(bodyChars<=6000);assert.ok(timeline.messages.every(message=>message.content[0].text.trim()));assert.ok(timeline.messages.filter(message=>message.role==='assistant').every(message=>packet(message).messages.length>0));
  assert.ok(timeline.currentMessage.eventIds.length);assert.ok(timeline.messages.length<exchange.length+2,'over-budget complete bubbles are omitted, not sliced');
});

test('work references, clock, current private preferences and controls never become public character history',()=>{
  const result=prompt({memory:['ONLY_THIS_PERSONA_PRIVATE'],workContext:{key:'work',scopeKey,sources:[{sessionId:'work',goal:'READ_ONLY_WORK_GOAL',report:'READ_ONLY_WORK_REPORT'}]},
    coordination:{work:'required',sourceIds:['work'],request:'answer'},directorAssignment:{id:'a',kind:'normal',to:'user',goal:'TEMPORARY_DIRECTION'}});
  const history=result.messages.slice(0,-1);assert.doesNotMatch(JSON.stringify(history),/ONLY_THIS_PERSONA_PRIVATE|READ_ONLY_WORK_GOAL|READ_ONLY_WORK_REPORT|TEMPORARY_DIRECTION/);
  assert.match(result.system,/ONLY_THIS_PERSONA_PRIVATE/);assert.doesNotMatch(JSON.stringify(result.control),/ONLY_THIS_PERSONA_PRIVATE/);
  assert.equal(result.control.workContext.sources[0].goal,'READ_ONLY_WORK_GOAL');assert.equal(result.control.directorAssignment.goal,'TEMPORARY_DIRECTION');
});

test('excluded originals are not reintroduced by target, quote, note or discussion pointers',()=>{
  const old=anchor('old','历史用户原话'),source=reply(old,'source',other,['已排除的公开原话']),quote={ref:ref(source),author:{role:'assistant',id:'b',name:'乙'},text:source.assistant[0]};
  const result=prompt({history:[old,source],quotedMessage:quote,excluded:[ref(source)]});
  assert.doesNotMatch(JSON.stringify(result.messages),/已排除的公开原话/);assert.equal(result.control.quotedMessage,undefined);
  assert.equal(readChatInput(result).history[0].status,'ready');assert.equal(readChatInput(result).history[0].omittedBubbles,1);
});

test('many tiny bubbles have bounded control metadata while omitted completed replies remain attributable',()=>{
  const history=[];let current,exchange;
  for(let group=0;group<9;group++){
    const head=anchor('message-'+group,'这一轮的真实用户原话'),turns=Array.from({length:32},(_,index)=>reply(head,'turn-'+group+'-'+index,
      {id:'p'+index%8,name:'公开角色'+index%8},Array.from({length:6},(_,bubble)=>'第'+group+'轮'+index+'人的'+bubble+'句。'),{emittedOrder:index}));
    if(group<8)history.push(head,...turns);else{current=head;exchange=turns;}
  }
  const result=prompt({history,currentTurn:current,exchange,message:current.user,speaker:{id:'p0',name:'公开角色0'}}),control=result.control;
  assert.ok(control.timeline.length<=64);assert.ok(JSON.stringify(control).length<36000,'full quoteRefs must not be repeated for every tiny assistant bubble');
  const originalReady=history.filter(turn=>turn.phase!=='anchor').length;
  const retained=control.history.flatMap(group=>group.responses).reduce((count,response)=>count+(response.eventId?1:response.omittedReplies??1),0);
  assert.equal(retained,originalReady,'metadata compaction never turns prior ready authors into people who did not answer');
  assert.ok(control.history.flatMap(group=>group.responses).some(response=>response.omittedReplies>1));
  for(const event of control.timeline.filter(event=>event.author.role==='assistant')){
    assert.ok(event.turnId&&event.attemptId);assert.ok(event.bubbles.every(bubble=>!('ref'in bubble)));
    assert.ok(packet(result.messages[event.messageIndex]).messages.length>0);
  }
});
