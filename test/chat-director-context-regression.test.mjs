import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recentChatHistory,buildChatPrompt } from '../lib/chat-prompt.js';
import { fixture,directorReply,reply,newRoom,roomSend,roomState,settledRoom,whale,dragon } from './helpers/persona-chat-host.mjs';

const pack={identity:'测试角色',voice:[],samples:[],avoid:[],address:{user:'你'}};
const body=options=>readChatInput(options);
const context=value=>({work:'not-needed',sourceIds:[],request:'open',evidence:value.message});
const choice=(value,id,event=value.events.findLast(item=>item.author.role==='user'),to='user')=>({id,kind:'normal',to,
  evidence:{eventId:event.id,index:0,text:event.messages[0]},goal:'接住这次待回应的原话，不重答已完成的称呼。'});
const turn=(messageId,id,texts,extra={})=>({id,messageId,attemptId:id,user:'这次用户的完整原话。',recipients:[],recipientId:id,speakerName:id,status:'ready',phase:'reaction',assistant:texts,...extra});
const contentSize=history=>history.reduce((sum,item)=>sum+item.user.length+(item.quotedMessage?.text.length??0)
  +(item.assistant??[]).reduce((size,line)=>size+line.length,0)+(item.responses??[]).reduce((size,response)=>size+response.assistant.reduce((n,line)=>n+line.length,0),0),0);

test('an oversized latest multi-person group retains its exact user words, completed authors and only whole public bubbles',()=>{
  const user='保留这一轮原话，不要把超预算当成没有聊过。',history=[turn('old','old',['较早的真实回应。'],{user:'较早的真实提问。'})];
  history.push(turn('latest','anchor',[],{user,recipientId:'user',phase:'anchor'}));
  for(let i=0;i<32;i++)history.push(turn('latest','speaker-'+i,[String(i).padStart(2,'0')+'答'.repeat(998)],{user,emittedOrder:i}));
  const original=structuredClone(history),projected=recentChatHistory(history,{chars:6000,groups:4}),latest=projected.at(-1);
  assert.ok(projected.length>0);assert.equal(latest.user,user);assert.equal(latest.partiallyOmitted,true);assert.equal(latest.responses.length,32);
  assert.ok(latest.responses.every(response=>response.status==='ready'));assert.ok(latest.responses.some(response=>response.omittedBubbles===1));
  assert.deepEqual(latest.responses.filter(response=>response.assistant.length).map(response=>response.speaker.id),['speaker-27','speaker-28','speaker-29','speaker-30','speaker-31']);
  for(const response of latest.responses)for(const line of response.assistant)assert.ok(history.some(item=>item.recipientId===response.speaker.id&&item.assistant.includes(line)));
  assert.ok(contentSize(projected)<=6000);assert.deepEqual(history,original,'context projection never rewrites stored original words');
});

test('the configurable recent projection retains legacy single-author shape and never clips explicit quote text',()=>{
  const history=Array.from({length:4},(_,i)=>turn('message-'+i,'person-'+i,['回复 '+i],{user:'原话 '+i}));
  const selected=recentChatHistory(history,{chars:6000,groups:2});assert.deepEqual(selected.map(item=>item.user),['原话 2','原话 3']);
  assert.deepEqual(selected[1],{user:'原话 3',recipients:[],assistant:['回复 3'],status:'ready',recipient:{id:'person-3',name:'person-3'}});
  const quoted=turn('long','person',['较长回复'.repeat(500)],{quote:{author:{role:'assistant',id:'source',name:'原作者'},text:'引用原话'.repeat(1200)}});
  const limited=recentChatHistory([quoted],{chars:6000,groups:4})[0];
  assert.equal(limited.quotedMessage.text,quoted.quote.text);assert.deepEqual(limited.assistant,[]);assert.equal(limited.omittedBubbles,1);assert.equal(limited.status,'ready');
  assert.ok(contentSize([limited])<=6000);
  const unavailableQuote=turn('quote-budget','person',['仍能完整保留的回复。'],{user:'原'.repeat(4000),quote:{author:{role:'assistant',id:'source',name:'原作者'},text:'引'.repeat(3000)}});
  const withoutQuote=recentChatHistory([unavailableQuote],{chars:6000})[0];assert.equal(withoutQuote.user,unavailableQuote.user);
  assert.equal(withoutQuote.quotedMessage,undefined);assert.equal(withoutQuote.quotedMessageOmitted,true);assert.deepEqual(withoutQuote.assistant,unavailableQuote.assistant);
});

test('replyTarget keeps the current literal source distinct from an older original message and invented goal',()=>{
  const exchange=[turn('now',dragon,['刚才的称呼已经接住了，现在我问你喜欢哪种颜色？'])];
  const options={pack,history:[],message:'你们都是我的妈妈。',speaker:{id:whale,name:whale},participants:[{id:whale,name:whale},{id:dragon,name:dragon}],exchange,
    currentTurn:turn('now','now',[],{phase:'anchor',recipientId:'user',user:'你们都是我的妈妈。'}),
    directorAssignment:{id:whale,kind:'normal',to:dragon,goal:'不存在的已经执行的工作'},replyTarget:{author:{role:'assistant',id:dragon,name:'伪造的名字'},text:'现在我问你喜欢哪种颜色？'}};
  const prompt=buildChatPrompt(options),input=readChatInput(prompt);
  assert.deepEqual(input.replyTarget,{author:{role:'assistant',id:dragon,name:dragon},text:'现在我问你喜欢哪种颜色？'});
  assert.equal(input.message,options.message);assert.match(prompt.system,/优先接 replyTarget.*已回应的旧句子是背景/);
  assert.equal(readChatInput(buildChatPrompt({...options,replyTarget:{author:{role:'user'},text:'我没有说过的话'}})).replyTarget,undefined);
  assert.equal(readChatInput(buildChatPrompt({...options,replyTarget:{author:{role:'assistant',id:whale},text:options.replyTarget.text}})).replyTarget,undefined);
  assert.equal(readChatInput(buildChatPrompt({...options,exchange:exchange.map(item=>({...item,status:'failed'}))})).replyTarget,undefined);
  assert.deepEqual(readChatInput(buildChatPrompt({...options,replyTarget:{author:{role:'user'},text:'都是我的妈妈'}})).replyTarget,{author:{role:'user',name:'我'},text:'都是我的妈妈'});
});

test('a validated reply target remains available even if the broad exchange budget omitted that old complete bubble',()=>{
  const source=turn('now',dragon,['这是被明确引用的旧气泡原话。'],{emittedOrder:0});
  const exchange=[source,...Array.from({length:12},(_,i)=>turn('now','other-'+i,['新发言'.repeat(500)],{emittedOrder:i+1}))];
  const input=readChatInput(buildChatPrompt({pack,history:[],message:'继续讨论',speaker:{id:whale,name:whale},participants:[],exchange,
    currentTurn:turn('now','now',[],{phase:'anchor',recipientId:'user',user:'继续讨论'}),
    replyTarget:{author:{role:'assistant',id:dragon},text:source.assistant[0]}}));
  assert.ok(input.exchange.some(item=>item.speaker.id===dragon),'the exact target is included once in the shared timeline, ahead of broad recent history');
  assert.deepEqual(input.replyTarget,{author:{role:'assistant',id:dragon,name:dragon},text:source.assistant[0]});
});

test('a speaker cannot re-serve its consumed user sentence when only its own completed reply is new',async t=>{
  const f=fixture(t,{directorScript:options=>{const value=body(options);return directorReply(context(value),choice(value,whale));},
    script:()=>reply(['这句称呼我已经接住了。'])});
  await f.ready();const room=await newRoom(f,[whale,dragon],'消费边界','consumed-context');
  await roomSend(f,room,whale,'鲸鲸，晚上好。','one-user-sentence');await settledRoom(f,room);
  assert.equal(f.calls.length,1,'an original user sentence already handled by this actor is background, not another ordinary turn');
  const after=f.directors.map(body).find(value=>value.events.some(event=>event.author.id===whale));
  assert.equal(after.states.find(state=>state.id===whale).normalReady,false);
});

test('actual same-cycle own and peer replies remain in exchange while inbox and replyTarget identify the new peer sentence',async t=>{
  const sequence=[whale,dragon,whale],f=fixture(t,{directorScript:options=>{const value=body(options),spoken=value.events.filter(event=>event.author.role==='assistant'),id=sequence[spoken.length];
    const peer=spoken.length===2?spoken.at(-1):null,action=id?choice(value,id,peer??undefined,peer?peer.author.id:'user'):null;
    if(peer&&action)action.kind='peer';return directorReply(context(value),action);},
    script:(_,count)=>reply([['我先接住这句招呼。','鲸鲸，现在换个新问题，你喜欢蓝色还是紫色？','我接你刚问的颜色，蓝色吧。'][count-1]])});
  await f.ready();const room=await newRoom(f,[whale,dragon],'真实同轮上下文','same-cycle-context');
  const state=await roomState(f,room);await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[whale,dragon],configRevision:state.room.configRevision,epoch:state.epoch});
  await roomSend(f,room,whale,'大家晚上好，随便聊聊。','public-context');await settledRoom(f,room);
  assert.equal(f.calls.length,3);const final=body(f.calls[2]);
  assert.deepEqual(final.history,[]);assert.equal(final.exchange.length,2);assert.equal(final.exchange[0].speaker.id,whale);
  assert.equal(final.exchange[0].messages[0],'我先接住这句招呼。');assert.ok(final.inbox.some(event=>event.author.id===dragon&&event.messages[0].includes('新问题')));
  assert.ok(!final.inbox.some(event=>event.author.id===whale));assert.equal(final.responsePlan.to,dragon);
  assert.equal(final.replyTarget.author.id,dragon);assert.equal(final.replyTarget.text,'鲸鲸，现在换个新问题，你喜欢蓝色还是紫色？');
});
