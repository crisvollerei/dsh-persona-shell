import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, reply, directorReply, newRoom, roomSend, roomState, whale, dragon, flush } from './helpers/persona-chat-host.mjs';

const body=options=>readChatInput(options);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,reason,ms=15000){
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){await flush();const value=await read();if(predicate(value))return value;await sleep(10);}
  assert.fail(reason);
}
async function stop(f,room){
  const state=await roomState(f,room);
  if(!state.running)return;
  assert.equal((await f.request('chat',{...room,action:'cancel',personaId:whale,roundId:state.roundId,messageId:state.roundMessageId,attempts:[],epoch:state.epoch})).status,200);
  await flush();
}

test('real Host grades wait five seconds within a user cycle, keep independent inboxes and refresh only for new user input',async t=>{
  const starts=[];
  const f=fixture(t,{runtime:{chatIntervalMs:5000},directorScript:options=>{
    const value=body(options),last=value.events.findLastIndex(event=>event.author.role==='user'),event=value.events[last];
    const said=value.events.slice(last+1).filter(event=>event.author.role==='assistant');
    const sequence=value.message==='新用户轮刷新机会'?[whale]:[whale,dragon,whale],id=sequence[said.length];
    const target=said.length?said.at(-1):event;
    return directorReply({work:'not-needed',sourceIds:[],request:'open',evidence:value.message},id?{id,kind:said.length===1?'peer':'normal',to:said.length?target.author.id:'user',
      evidence:{eventId:target.id,index:0,text:target.messages[0]},goal:'接住这条新的公开原话。'}:null);
  },script:options=>{
    starts.push({at:Date.now(),body:body(options)});
    return(async function*(){if(starts.length===1)await sleep(250);yield*reply(['GPT，一轮里的第一段。','这仍是同一轮的第二段。']);})();
  }});
  await f.ready();const room=await newRoom(f,[whale,dragon],'独立收件箱','pacing-host'),initial=await roomState(f,room);
  await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[],configRevision:initial.room.configRevision,epoch:initial.epoch});
  assert.equal((await roomSend(f,room,whale,'第一段公开用户原话','first')).status,200);
  const firstState=await until(()=>roomState(f,room),state=>state.room.turns.some(turn=>turn.recipientId===whale&&turn.status==='ready'),'first complete package should commit');
  const first=firstState.room.turns.find(turn=>turn.recipientId===whale);assert.equal(first.assistant.length,2);
  await sleep(60);assert.equal(starts.length,1,'the two emitted bubbles count as one complete package and never cause immediate reentry');
  const b=await until(()=>starts.find(value=>value.body.speaker.id===dragon),Boolean,'the second persona should retain her independent grade-zero opportunity');
  assert.ok(b.at<first.completedAt+5000,'the shared director may choose B before A’s own completion-based cooldown ends');
  assert.equal(b.body.opportunity.normalRemainingAfterThis,3);assert.equal(b.body.opportunity.kind,'peer');
  assert.ok(b.body.inbox.some(value=>value.author.role==='user'&&value.messages.includes('第一段公开用户原话')),JSON.stringify(b.body.inbox));
  assert.ok(b.body.inbox.some(value=>value.author.id===whale&&value.messages.length===2),'a full peer package is one inbox item');
  const a=await until(()=>starts.filter(value=>value.body.speaker.id===whale)[1],Boolean,'A should become eligible again in the same user cycle');
  assert.ok(a.at>=first.completedAt+5000,'the grade-one cooldown starts after the complete package');
  assert.equal(a.body.message,'第一段公开用户原话');assert.equal(a.body.opportunity.normalRemainingAfterThis,1);
  assert.ok(a.body.inbox.some(value=>value.author.id===dragon&&value.messages.length===2));
  await until(()=>roomState(f,room),state=>state.room.turns.filter(turn=>turn.phase!=='anchor'&&turn.status==='ready').length===3,'the third complete package should commit');
  await stop(f,room);assert.equal(starts.length,3);
  const state=await roomState(f,room);await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[whale],configRevision:state.room.configRevision,epoch:state.epoch});
  const sentAt=Date.now(),beforeDirectors=f.directors.length;assert.equal((await roomSend(f,room,whale,'新用户轮刷新机会','fresh-user')).status,200);
  await sleep(80);assert.equal(f.directors.length,beforeDirectors,'new user input refreshes persona grades without bypassing the shared five-second director cadence');
  const refreshed=await until(()=>starts[3],Boolean,'the refreshed grade-zero persona should respond at the next shared director slot',8000);
  assert.ok(refreshed.at-sentAt<8000);assert.ok(refreshed.at<a.at+10000,'a new user turn removes the old grade-two personal cooldown');
  assert.equal(refreshed.body.opportunity.normalRemainingAfterThis,2);
  await until(()=>roomState(f,room),value=>value.room.turns.at(-1).status==='ready','the refreshed complete reply should commit',2000);
  await stop(f,room);assert.equal(starts.length,4);assert.equal(f.plans.length+f.continuations.length,0);
});
