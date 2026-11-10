import test from 'node:test';
import assert from 'node:assert/strict';
import { chatThreadNotes } from '../lib/chat-thread.js';
import { fixture, whale, dragon, claude, reply, directorReply, preference, newRoom, roomSend, roomState, settledRoom, flush, domain } from './helpers/persona-chat-host.mjs';
import { createPersonaChat } from '../lib/persona-chat.js';
import {readChatInput} from './helpers/chat-input.mjs';

// Native director fixtures select from actual public events; no legacy plan DTOs.
const directorInput = options => JSON.parse(options.messages[0].content[0].text);
const currentSpeech = value => value.events.slice(value.events.findLastIndex(event => event.author.role === 'user') + 1).filter(event => event.author.role === 'assistant');
const directorContext = (value, work) => {
  const sourceIds = (value.sources ?? []).map(source => source.id);
  return { work: work ?? (sourceIds.length ? 'required' : 'not-needed'), sourceIds: work === 'not-needed' ? [] : sourceIds,
    request: 'answer', evidence: value.message.slice(0, 120) };
};
const directorChoice = (value, id, { kind = 'normal', to = 'user', event = value.events.findLast(event => event.author.role === 'user') } = {}) =>
  id && event ? { id, kind, to, evidence: { eventId: event.id, index: 0, text: event.messages[0] }, goal: '回应这条已公开原话。' } : null;
const directorOrder = (order, work) => options => {
  const value = directorInput(options), sequence = typeof order === 'function' ? order(value) : order;
  return directorReply(directorContext(value, work), directorChoice(value, sequence[currentSpeech(value).length]));
};

const input=options=>readChatInput(options);
async function selectTwo(f, room) {
  const s=await roomState(f,room);
  assert.equal((await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[whale,dragon],
    configRevision:s.room.configRevision,epoch:s.epoch})).status,200);
}

test('older room bookmarks quote actual public words and never claim that a proposal was accepted',()=>{
  const history=Array.from({length:12},(_,i)=>({id:'turn-'+i,messageId:'message-'+i,user:i?'接着聊第'+i+'件事':'设置布局先画草图，我还没决定。',
    status:'ready',recipientId:whale,speakerName:'鲸鲸',assistant:i?['这件事先聊到这里。']:['布局先保留，还是先画草图？'],privateMemory:'DO_NOT_COPY'}));
  history[1].status='failed';history[1].assistant=['设置布局 UNFINISHED'];
  const notes=chatThreadNotes(history,'设置布局的草图还记得吗？');
  assert.ok(notes.some(n=>n.quote==='设置布局先画草图，我还没决定。'&&n.author.role==='user'&&n.messageId==='message-0'));
  assert.ok(notes.some(n=>n.author.id===whale&&n.quote==='布局先保留，还是先画草图？'));
  assert.doesNotMatch(JSON.stringify(notes),/DO_NOT_COPY|UNFINISHED/);
  assert.deepEqual(chatThreadNotes(history,'晚饭吃什么？'),[]);
  assert.ok(notes.length<=4&&notes.reduce((n,x)=>n+x.quote.length,0)<=800);
});

test('a real peer question permits one independent return without changing mentions or sharing private memory',async t=>{
  const f=fixture(t,{directorScript:options=>{
    const value=directorInput(options),said=currentSpeech(value);
    const next=said.length<2?directorChoice(value,[whale,dragon][said.length]):said.length===2?
      directorChoice(value,whale,{kind:'peer',to:dragon,event:said[1]}):null;
    return directorReply(directorContext(value),next);
  },script:options=>{
    const p=input(options);return reply(p.responsePlan.kind==='peer'?['这个先保留。']:p.speaker.id===whale?['布局可以先保留。']:['鲸鲸，你说的布局要保留吗？']);
  }});
  await f.ready();await preference(f,'鲸鲸私有的称呼偏好',whale);await preference(f,'GPT私有的称呼偏好',dragon);
  const room=await newRoom(f);await selectTwo(f,room);await roomSend(f,room);const state=await settledRoom(f,room);
  const turns=state.room.turns.filter(turn=>turn.phase!=='anchor');
  assert.deepEqual(turns.map(x=>[x.recipientId,x.responsePlan.kind,x.status]),[[whale,'normal','ready'],[dragon,'normal','ready'],[whale,'peer','ready']]);
  assert.equal(f.calls.length,3);assert.equal(f.directors.length,4);assert.equal(f.requests.length,7);assert.equal(f.plans.length+f.continuations.length,0);
  for(const turn of state.room.turns)assert.deepEqual(turn.recipients.map(p=>p.id),[whale,dragon]);
  assert.deepEqual(input(f.calls[2]).exchange.map(p=>p.speaker.id),[whale,dragon]);
  assert.match(f.calls[2].system,/鲸鲸私有/);assert.doesNotMatch(f.calls[1].system,/鲸鲸私有/);
  assert.ok(f.directors.every(call=>!/私有的称呼/.test(call.system+call.messages[0].content[0].text)));
  assert.match(f.calls[2].system,/最多 2 条消息、合计 600 字符/);
  const restored=createPersonaChat();restored.restore(f.storage.tables.get('profile').get('personaChats'));
  assert.equal(restored.read(room.roomId).turns.at(-1).responsePlan.kind,'peer');
  assert.deepEqual(restored.read(room.roomId).turns.at(-1).assistant,['这个先保留。']);
});

test('room bookmarks survive recent-history rollover but cannot cross rooms or reference scopes',async t=>{
  const f=fixture(t,{script:()=>reply(['布局先保留，还是先画草图？'])});await f.ready();
  const a=await newRoom(f,[whale],'布局讨论','room-a'),b=await newRoom(f,[whale],'另一间','room-b');
  await roomSend(f,a,whale,'设置布局先画草图，我还没决定。','old-topic');await settledRoom(f,a);
  for(let i=0;i<9;i++){await roomSend(f,a,whale,'接着说第'+i+'件事','topic-'+i);await settledRoom(f,a);}
  await roomSend(f,a,whale,'设置布局的草图还记得吗？','recall');await settledRoom(f,a);
  assert.ok(input(f.calls.at(-1)).roomNotes.some(n=>n.messageId==='old-topic'&&n.author.role==='user'));
  assert.deepEqual(input(f.calls.at(-1)).roomNotes.find(n=>n.messageId==='old-topic').recipients.map(p=>p.id),[whale]);
  assert.equal(input(f.calls.at(-1)).history.length,8);
  await roomSend(f,b,whale,'设置布局的草图还记得吗？','foreign');await settledRoom(f,b);
  assert.deepEqual(input(f.calls.at(-1)).roomNotes,[]);
  const detached=await f.request('chat-context',{...a,action:'detach',sessionId:'work',revision:Number(a.contextKey.split(':').at(-1))});
  assert.equal(detached.status,200);const next={...a,contextKey:detached.value.id+':'+detached.value.revision};
  assert.equal((await roomSend(f,next,whale,'设置布局的草图还记得吗？','new-scope')).status,200);await settledRoom(f,next);
  assert.deepEqual(input(f.calls.at(-1)).roomNotes,[]);
});

test('durable new input waits for the active complete reply and retires later unstarted speech',async t=>{
  let release,fail=false;const gate=new Promise(r=>{release=r;});t.after(()=>release());
  const storage=domain(Promise.resolve(),{fail:id=>fail&&id==='chatInputQueue'});
  const f=fixture(t,{storage,directorScript:directorOrder(value=>value.message==='公开讨论'?[whale,claude,dragon]:[whale]),
    script:options=>input(options).speaker.id===claude?(async function*(){await gate;yield*reply(['完整回复的第一段。','完整回复的第二段。']);})():reply(['主讲已经回应。'])});
  await f.ready();const room=await newRoom(f,[whale,claude,dragon]);await roomSend(f,room);await flush();
  const before=await roomState(f,room);assert.equal(before.canYield,false);assert.equal(before.canQueue,true);assert.equal(f.calls.length,2);
  const send={...room,action:'send',personaId:whale,requestId:'new-user-input',content:'先听我说新想法',revision:before.room.revision-1,
    configRevision:before.room.configRevision,afterMessageId:before.roundMessageId,epoch:before.epoch};
  fail=true;assert.equal((await f.request('chat',send)).status,503);fail=false;
  assert.equal((await roomState(f,room)).roundId,before.roundId);
  assert.equal((await f.request('chat',send)).status,200);await flush();assert.equal(f.calls.length,2);
  assert.equal(f.calls[1].signal.aborted,false,'a durable new message waits for the already speaking persona package');
  release();const done=await settledRoom(f,room),old=done.room.turns.filter(x=>x.messageId===before.roundMessageId&&x.phase!=='anchor');
  assert.deepEqual(old.find(x=>x.recipientId===claude).assistant,['完整回复的第一段。','完整回复的第二段。']);
  assert.equal(old.some(x=>x.recipientId===dragon),false,'native directing never preallocates unstarted actors');
  assert.equal(f.calls.some(call=>input(call).message==='公开讨论'&&input(call).speaker.id===dragon),false);
  assert.equal(done.room.turns.filter(x=>x.user===send.content&&x.phase==='anchor').length,1);
  assert.equal(input(f.calls.at(-1)).message,send.content);assert.equal(f.calls.length,3);
});

test('a member can address a peer through actual evidence and an empty decision adds no background speech',async t=>{
  const f=fixture(t,{directorScript:options=>{const value=directorInput(options),said=currentSpeech(value);
    return directorReply(directorContext(value),said.length<2?directorChoice(value,[whale,claude][said.length]):said.length===2?
      directorChoice(value,whale,{kind:'peer',to:claude,event:said[1]}):null);},
    script:options=>reply(input(options).speaker.id===claude?['鲸鲸，那张草图先给谁看？']:
      input(options).responsePlan.kind==='peer'?['Claude小姐，先给你看。']:['我想先画一张草图。'])});
  await f.ready();const room=await newRoom(f,[whale,claude]);await roomSend(f,room);const state=await settledRoom(f,room);
  assert.deepEqual(state.room.turns.filter(turn=>turn.phase!=='anchor').map(t=>t.responsePlan.kind),['normal','normal','peer']);
  assert.equal(f.calls.length,3);assert.equal(f.directors.length,4);assert.deepEqual(input(f.calls[2]).recipients.map(p=>p.id),[whale]);
  const before=f.requests.length;await flush();assert.equal(f.requests.length,before,'a settled empty decision starts no timer-based model polling');
});

test('self-introductions do not create peer opportunities or force all remaining normal opportunities',async t=>{
  const f=fixture(t,{script:()=>reply(['鲸鲸在呢。','你想聊什么？'])});await f.ready();
  const room=await newRoom(f);await selectTwo(f,room);await roomSend(f,room);await settledRoom(f,room);
  assert.equal(f.calls.length,2);assert.equal(f.directors.length,3);assert.equal(f.requests.length,5);
  assert.ok(f.calls.every(call=>input(call).responsePlan.kind==='normal'));assert.equal(f.plans.length+f.continuations.length,0);
});

test('a failed peer return retries its own seat without regenerating prior speech or refilling its normal grades',async t=>{
  let returned=0;const f=fixture(t,{directorScript:options=>{const value=directorInput(options),said=currentSpeech(value);
    const ready=value.states.find(state=>state.id===whale)?.peerReady;
    return directorReply(directorContext(value),said.length<2?directorChoice(value,[whale,dragon][said.length]):said.length===2&&ready?
      directorChoice(value,whale,{kind:'peer',to:dragon,event:said[1]}):null);},script:options=>{
      const p=input(options);if(p.responsePlan.kind==='peer')return reply(['我答这一个问题就好。'],++returned===1?'max-tokens':'stop');
      return reply([p.speaker.id===dragon?'鲸鲸，你看这条怎么处理？':'先放在这里。']);}});
  await f.ready();const room=await newRoom(f);await selectTwo(f,room);await roomSend(f,room);
  const failed=await settledRoom(f,room),turn=failed.room.turns.at(-1);assert.equal(turn.responsePlan.kind,'peer');assert.equal(turn.status,'failed');
  assert.equal((await f.request('chat',{...room,action:'retry',id:turn.id,attemptId:'return-retry',personaId:whale,revision:failed.room.revision,epoch:failed.epoch})).status,200);
  const done=await settledRoom(f,room);assert.equal(done.room.turns.at(-1).status,'ready');
  assert.deepEqual(done.room.turns.slice(0,3),failed.room.turns.slice(0,3));assert.equal(f.calls.length,4);
  assert.deepEqual(f.calls.map(call=>input(call).speaker.id),[whale,dragon,whale,whale]);
  assert.equal(input(f.calls.at(-1)).opportunity.normalRemainingAfterThis,2);assert.equal(input(f.calls.at(-1)).opportunity.peerRemainingAfterThis,0);
});

test('stopping during a native follow-on decision prevents its delayed third reply',async t=>{
  let release;const gate=new Promise(r=>{release=r;});t.after(()=>release());
  const f=fixture(t,{directorScript:options=>{const value=directorInput(options),said=currentSpeech(value);
    if(said.length<2)return directorReply(directorContext(value),directorChoice(value,[whale,dragon][said.length]));
    return(async function*(){await gate;yield*directorReply(directorContext(value),directorChoice(value,whale,{kind:'peer',to:dragon,event:said[1]}));})();},
    script:options=>reply([input(options).speaker.id===dragon?'鲸鲸，你来确认一下？':'这条先留着。'])});
  await f.ready();const room=await newRoom(f);await selectTwo(f,room);await roomSend(f,room);await flush();
  const state=await roomState(f,room);assert.equal(state.roundPhase,'listening');assert.equal(f.calls.length,2);
  assert.equal((await f.request('chat',{...room,action:'cancel',personaId:whale,messageId:state.roundMessageId,attempts:[],roundId:state.roundId,epoch:state.epoch})).status,200);
  assert.equal(f.directors.at(-1).signal.aborted,true);release();await settledRoom(f,room);assert.equal(f.calls.length,2);
});

test('changing reference scope while the native director waits prevents stale peer speech',async t=>{
  let release;const gate=new Promise(r=>{release=r;});t.after(()=>release());
  const f=fixture(t,{directorScript:options=>{const value=directorInput(options),said=currentSpeech(value);
    if(said.length<2)return directorReply(directorContext(value),directorChoice(value,[whale,dragon][said.length]));
    return(async function*(){await gate;yield*directorReply(directorContext(value),directorChoice(value,whale,{kind:'peer',to:dragon,event:said[1]}));})();},
    script:options=>reply([input(options).speaker.id===dragon?'鲸鲸，这一条你怎么看？':'这条先留着。'])});
  await f.ready();const room=await newRoom(f);await selectTwo(f,room);await roomSend(f,room);await flush();
  assert.equal(f.directors.length,3);const changed=await f.request('chat-context',{...room,action:'detach',sessionId:'work',revision:Number(room.contextKey.split(':').at(-1))});
  assert.equal(changed.status,200);assert.equal(f.directors.at(-1).signal.aborted,true);release();await settledRoom(f,room);assert.equal(f.calls.length,2);
});

test('a peer reply exceeding its short budget cannot replace complete public predecessors or trigger extra replies',async t=>{
  const f=fixture(t,{directorScript:options=>{const value=directorInput(options),said=currentSpeech(value),ready=value.states.find(state=>state.id===whale)?.peerReady;
    return directorReply(directorContext(value),said.length<2?directorChoice(value,[whale,dragon][said.length]):said.length===2&&ready?
      directorChoice(value,whale,{kind:'peer',to:dragon,event:said[1]}):null);},
    script:options=>reply(input(options).responsePlan.kind==='peer'?['第一句','第二句','多出来的第三段']:[input(options).speaker.id===dragon?'鲸鲸，你说呢？':'先留着。'])});
  await f.ready();const room=await newRoom(f);await selectTwo(f,room);await roomSend(f,room);const state=await settledRoom(f,room);
  assert.deepEqual(state.room.turns.filter(turn=>turn.phase!=='anchor').map(turn=>turn.status),['ready','ready','failed']);
  assert.equal(state.room.turns.at(-1).failure,'too-long');assert.equal(f.calls.length,3);assert.deepEqual(state.room.turns.at(-1).assistant,[]);
});
