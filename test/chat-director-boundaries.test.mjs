import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,domain,reply,directorReply,newRoom,roomSend,roomState,settledRoom,flush,whale,dragon} from './helpers/persona-chat-host.mjs';
import {possiblePeerCall} from '../lib/chat-director.js';
import {BUILTIN_PRESETS} from '../lib/pack.js';
const input=options=>readChatInput(options);
const context=body=>({work:'not-needed',sourceIds:[],request:'open',evidence:body.message});

test('a directed public sibling address can qualify for review without giving copied personas the builtin relationship',()=>{
  const members=BUILTIN_PRESETS.map(p=>({...p,builtin:true})),older=members.find(p=>p.id===whale),younger=members.find(p=>p.id==='鲸鲸（实验性）');
  const event={author:{role:'assistant',id:younger.id,name:younger.name},messages:['姐姐，你怎么看这件事？']};
  assert.equal(possiblePeerCall(older,event,members),true);
  assert.equal(possiblePeerCall(older,{...event,author:{role:'assistant',id:dragon,name:dragon}},members),false);
  const copied={...younger,id:'custom-little-fish',builtin:false};
  assert.equal(possiblePeerCall(older,{...event,author:{role:'assistant',id:copied.id,name:copied.name}},[older,copied]),false);
});

test('all accepted user fragments remain separately selectable as literal settings evidence',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(release);
  const f=fixture(t,{script:options=>(async function*(){if(input(options).message==='先等这一轮')await gate;yield*reply(['完整回应。']);})()});
  await f.ready();const room=await newRoom(f,[whale]);await roomSend(f,room,whale,'先等这一轮','occupied');await flush();
  assert.equal((await roomSend(f,room,whale,'第一段原话','fragment-first')).status,200);
  assert.equal((await roomSend(f,room,whale,'第二段原话','fragment-second')).status,200);
  assert.equal((await roomState(f,room)).queuedInputs[0].parts.length,2);
  release();await settledRoom(f,room);
  const state=await roomState(f,room),anchor=state.room.turns.find(t=>t.messageId==='fragment-first'&&t.phase==='anchor');
  assert.deepEqual(anchor.userParts.map(p=>p.text),['第一段原话','第二段原话']);
  const draft=(await f.request('chat-work-draft?room='+encodeURIComponent(room.roomId))).value;
  for(const [id,text]of[['fragment-first','第一段原话'],['fragment-second','第二段原话']]){
    const choice=draft.choices.find(q=>q.ref.kind==='user'&&q.ref.messageId===id);
    assert.ok(choice);assert.equal(choice.text,text);assert.equal(choice.author.role,'user');
  }
});

test('restart and explicit director retry cannot restore normal or independent opportunities consumed by actual new-event exchanges',async t=>{
  const storage=domain();
  const f=fixture(t,{storage,directorScript:options=>{
    const body=input(options),said=body.events.filter(event=>event.author.role==='assistant'),count=said.length;
    const id=count%2===0?whale:dragon,event=count===0?body.events.find(event=>event.author.role==='user'):said.at(-1);
    return directorReply(context(body),count<8?{id,kind:count===1||count===6?'peer':'normal',to:count===0?'user':event.author.id,
      evidence:{eventId:event.id,index:0,text:event.messages[0]},goal:'接住这条新的公开同伴原话。'}:null);
  },script:options=>reply(input(options).speaker.id===dragon?['鲸鲸，你怎么看？']:['GPT，这句话你会怎么接？'])});
  await f.ready();const room=await newRoom(f,[whale,dragon]),before=await roomState(f,room);
  await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[],configRevision:before.room.configRevision,epoch:before.epoch});
  await roomSend(f,room,whale,'聊一下这件事','exhausted');await settledRoom(f,room);
  const prior=await roomState(f,room);assert.equal(prior.room.turns.filter(turn=>turn.recipientId===whale).length,4);assert.equal(prior.room.turns.filter(turn=>turn.recipientId===dragon).length,4);
  assert.deepEqual(f.calls.filter(options=>input(options).speaker.id===whale).map(options=>input(options).opportunity.kind),['normal','normal','normal','peer']);
  await f.dispose();const restored=fixture(t,{storage});await restored.ready();
  const opened=(await restored.request('chat-context',{action:'open',roomId:room.roomId,viewer:'restored-viewer',sequence:1,sessionId:'work'})).value;
  const binding={roomId:room.roomId,contextKey:opened.id+':'+opened.revision},state=await roomState(restored,binding);
  assert.equal((await restored.request('chat',{...binding,action:'retry-director',personaId:whale,messageId:'exhausted',epoch:state.epoch})).status,200);
  await settledRoom(restored,binding);assert.equal(restored.calls.length,0);assert.equal(restored.directors.length,0);
  assert.deepEqual((await roomState(restored,binding)).room.turns,prior.room.turns);
});
