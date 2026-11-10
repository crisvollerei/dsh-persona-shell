import test from 'node:test';
import assert from 'node:assert/strict';
import { changeDiscussion,discussionView } from '../lib/chat-discussion.js';
import { resolveChatQuote } from '../lib/chat-quote.js';
import { chatThreadNotes } from '../lib/chat-thread.js';
import { buildActorTimeline } from '../lib/chat-messages.js';
import { fixture, domain, flush, newRoom, roomSend, roomState, settledRoom, reply, whale, readChatInput } from './helpers/persona-chat-host.mjs';

const head=(messageId,parts,extra={})=>({id:messageId,messageId,attemptId:messageId,phase:'anchor',recipientId:'user',speakerName:'我',
  status:'ready',assistant:[],scopeKey:'scope',recipients:[{id:'a',name:'甲'}],at:1,
  user:parts.map(part=>part.text).join('\n'),userParts:parts,...extra});
const userRef=(messageId,patch={})=>({roomId:'room',generation:0,kind:'user',messageId,...patch});
const original=()=>head('original',[{id:'original',text:'先聊今天的晚饭。'},{id:'original-part-2',text:'草图保持留白。'}]);
const confirmation=()=>head('confirmed',[{id:'confirmed',text:'确认草图的方案。'},{id:'confirmed-part-2',text:'我认可，保留这处留白。'}],{at:3});
const decide=(room,source,evidence,patch={})=>changeDiscussion(room,{action:'add',requestId:'topic',discussionRevision:0,title:'草图留白',status:'confirmed',
  source:userRef(source),evidence:userRef(evidence),...patch},'scope',10);
const noteHistory=()=>[original(),...Array.from({length:8},(_,index)=>head('recent-'+index,[{id:'recent-'+index,text:'最近的普通闲聊。'}]))];

test('discussion confirmation accepts real second-part originals and second-part owner evidence without merging their text',()=>{
  for(const [source,evidence]of [['original-part-2','confirmed'],['original','confirmed-part-2'],['original-part-2','confirmed-part-2']]){
    const room={id:'room',generation:0,turns:[original(),confirmation()]};
    assert.ok(resolveChatQuote(room,userRef(source),'scope'));assert.ok(resolveChatQuote(room,userRef(evidence),'scope'));
    room.discussion=decide(room,source,evidence);const [entry]=discussionView(room,'scope').entries;
    assert.equal(entry.available,true);assert.equal(entry.source.ref.messageId,source);assert.equal(entry.evidence.ref.messageId,evidence);
    assert.equal(entry.source.author.role,'user');assert.equal(entry.evidence.author.role,'user');
    assert.equal(entry.source.text,source==='original'?'先聊今天的晚饭。':'草图保持留白。');
    assert.equal(entry.evidence.text,evidence==='confirmed'?'确认草图的方案。':'我认可，保留这处留白。');
  }
});

test('part-aware timing still rejects an earlier user part and never treats same-round input as confirmation of a later assistant proposal',()=>{
  const first=original(),room={id:'room',generation:0,turns:[first,confirmation()]};
  assert.throws(()=>decide(room,'original-part-2','original'),/chat-discussion-evidence-required/);
  const sameRound=decide(room,'original','original-part-2');assert.equal(sameRound.entries[0].status,'confirmed','the owner may clarify an earlier user part later in the same input batch');
  const reply={...first,id:'assistant',attemptId:'assistant-attempt',phase:'reaction',recipientId:'a',speakerName:'甲',assistant:['这是一个候选草图。'],completedAt:2};
  const withReply={...room,turns:[first,reply,confirmation()]},source={roomId:'room',generation:0,kind:'assistant',turnId:reply.id,attemptId:reply.attemptId,index:0};
  assert.throws(()=>decide(withReply,'unused','original-part-2',{source}),/chat-discussion-evidence-required/);
  const board=decide(withReply,'unused','confirmed-part-2',{source});withReply.discussion=board;
  const [entry]=discussionView(withReply,'scope').entries;assert.equal(entry.available,true);assert.equal(entry.source.author.id,'a');
});

test('a valid part ID cannot bypass room, generation, scope or completion evidence boundaries',()=>{
  const room={id:'room',generation:0,turns:[original(),confirmation()]};
  for(const source of [userRef('original-part-2',{roomId:'other'}),userRef('original-part-2',{generation:1}),userRef('missing-part')])
    assert.throws(()=>decide(room,'unused','confirmed-part-2',{source}),/chat-quote-unavailable/);
  const otherScope=structuredClone(room);otherScope.turns[1].scopeKey='other-scope';
  assert.throws(()=>decide(otherScope,'original-part-2','confirmed-part-2'),/chat-discussion-evidence-required/);
});

test('recalled merged user input uses only the matching literal part and its actual pointer, so the actor can verify it',()=>{
  const history=noteHistory(),notes=chatThreadNotes(history,'草图留白',8,{roomId:'room',generation:0});
  assert.equal(notes.length,1);assert.equal(notes[0].quote,'草图保持留白。');assert.equal(notes[0].ref.messageId,'original-part-2');
  assert.equal(notes[0].messageId,'original-part-2');assert.equal(notes[0].author.role,'user');assert.deepEqual(notes[0].recipients,history[0].recipients);
  const current=head('now',[{id:'now',text:'草图留白'}]),timeline=buildActorTimeline({history,currentTurn:current,message:current.user,
    speaker:{id:'a'},roomId:'room',generation:0,scopeKey:'scope',notes});
  assert.equal(timeline.roomNotes.length,1);assert.equal(timeline.roomNotes[0].ref.messageId,'original-part-2');
  assert.ok(timeline.roomNotes[0].pointer);assert.equal(timeline.roomNotes[0].author.role,'user');
  const source=resolveChatQuote({id:'room',generation:0,turns:history},notes[0].ref,'scope');assert.equal(source.text,notes[0].quote);
});

test('part exclusions and malformed part lists do not leak an excluded or fabricated combined quote through the first part',()=>{
  const history=noteHistory(),options={roomId:'room',generation:0,excluded:[userRef('original-part-2')]};
  assert.deepEqual(chatThreadNotes(history,'草图留白',8,options),[]);
  for(const mutate of [turn=>turn.userParts[1].text='篡改后的另一句话。',turn=>turn.userParts.push({...turn.userParts[0]}),turn=>turn.userParts=[]]){
    const changed=structuredClone(history);mutate(changed[0]);
    assert.deepEqual(chatThreadNotes(changed,'草图留白',8,{roomId:'room',generation:0}),[]);
  }
});

test('settings confirms two actual buffered second parts through the Host without copying their bodies or calling a model',async t=>{
  let releaseBusy,releaseOriginal;
  const busy=new Promise(resolve=>{releaseBusy=resolve;}),originalReply=new Promise(resolve=>{releaseOriginal=resolve;});
  t.after(()=>{releaseBusy();releaseOriginal();});
  const storage=domain(),f=fixture(t,{storage,script:options=>(async function*(){
    const message=readChatInput(options).message;
    if(message==='先等这一轮')await busy;
    if(message==='先聊今天的晚饭。\n草图保持留白。')await originalReply;
    yield*reply(['只回应这轮公开原话。']);
  })()});
  await f.ready();const binding=await newRoom(f,[whale]);
  await roomSend(f,binding,whale,'先等这一轮','occupied');await flush();assert.equal(f.calls.length,1);
  for(const part of original().userParts)assert.equal((await roomSend(f,binding,whale,part.text,part.id)).status,200);
  assert.deepEqual((await roomState(f,binding)).queuedInputs[0].parts.map(part=>part.id),['original','original-part-2']);
  releaseBusy();
  const deadline=Date.now()+3000;
  while(f.calls.length<2&&Date.now()<deadline)await flush();
  assert.equal(f.calls.length,2,'the original merged round reaches the controlled reply boundary');
  for(const part of confirmation().userParts)assert.equal((await roomSend(f,binding,whale,part.text,part.id)).status,200);
  assert.deepEqual((await roomState(f,binding)).queuedInputs[0].parts.map(part=>part.id),['confirmed','confirmed-part-2']);
  releaseOriginal();const settled=await settledRoom(f,binding);
  const before=f.requests.length,path='chat-references?room='+encodeURIComponent(binding.roomId),view=(await f.request(path)).value;
  const source={...userRef('original-part-2'),roomId:binding.roomId,generation:settled.room.generation};
  const evidence={...userRef('confirmed-part-2'),roomId:binding.roomId,generation:settled.room.generation};
  const saved=await f.request('chat-discussion',{roomId:binding.roomId,epoch:view.epoch,discussionRevision:view.discussion.revision,
    action:'add',requestId:'buffered-proof',title:'草图留白',status:'confirmed',source,evidence});
  assert.equal(saved.status,200);
  const [entry]=(await f.request(path)).value.discussion.entries;
  assert.equal(entry.available,true);assert.equal(entry.source.text,'草图保持留白。');assert.equal(entry.evidence.text,'我认可，保留这处留白。');
  assert.deepEqual(entry.source.ref,source);assert.deepEqual(entry.evidence.ref,evidence);assert.equal(f.requests.length,before);
  const board=storage.tables.get('profile').get('personaChats').rooms.find(room=>room.id===binding.roomId).discussion;
  assert.doesNotMatch(JSON.stringify(board),/草图保持留白|我认可|晚饭/,'the settings board persists exact pointers and its owner label, not copied source words');
});
