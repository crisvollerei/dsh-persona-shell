import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,domain,whale,dragon,claude,reply,directorReply,preference,newRoom,roomSend,roomState,settledRoom,flush } from './helpers/persona-chat-host.mjs';
import { quoteKey,resolveChatQuote } from '../lib/chat-quote.js';
import { createPersonaChat } from '../lib/persona-chat.js';
const body=call=>readChatInput(call);
const refs=(f,room)=>f.request('chat-references?room='+encodeURIComponent(room.roomId));
async function sendQuote(f,room,quote,requestId='quoted-input'){
  const s=await roomState(f,room);return f.request('chat',{...room,action:'send',personaId:s.room.targetPersonaId,quote,content:'这句话你怎么看？',requestId,
    revision:s.room.revision,epoch:s.epoch});
}

test('quotes resolve canonical text without changing @ recipients or exposing another persona memory',async t=>{
  const f=fixture(t,{script:()=>reply(['第一条公开话','第二条公开话'])});await f.ready();
  await preference(f,'WHALE_PRIVATE_STYLE',whale);await preference(f,'DRAGON_PRIVATE_STYLE',dragon);
  const room=await newRoom(f);await roomSend(f,room,whale,'原始问题','original');const first=await settledRoom(f,room),turn=first.room.turns.find(turn=>turn.phase!=='anchor');
  const source={roomId:room.roomId,generation:first.room.generation,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index:1};
  assert.equal((await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:[dragon],configRevision:first.room.configRevision,epoch:first.epoch})).status,200);
  assert.equal((await sendQuote(f,room,{...source,text:'FORGED_RAW_TEXT',author:{id:dragon,name:'伪造作者'}})).status,200);
  const done=await settledRoom(f,room),p=body(f.calls.at(-1));
  assert.equal(p.quotedMessage.text,'第二条公开话');assert.equal(p.quotedMessage.author.id,whale);
  assert.deepEqual(p.recipients.map(p=>p.id),[dragon]);assert.doesNotMatch(JSON.stringify(p),/FORGED_RAW_TEXT|伪造作者/);
  assert.match(f.calls.at(-1).system,/DRAGON_PRIVATE_STYLE/);assert.doesNotMatch(f.calls.at(-1).system,/WHALE_PRIVATE_STYLE/);
  assert.equal(done.room.turns.find(turn=>turn.messageId==='quoted-input'&&turn.phase==='anchor').quote.text,'第二条公开话');
  const before=f.calls.length;assert.equal((await sendQuote(f,room,source)).status,200);await f.ready();assert.equal(f.calls.length,before);
  assert.equal((await sendQuote(f,room,{...source,index:0})).status,409);
  const usage=(await refs(f,room)).value.records[0];assert.equal(usage.quote.author.id,whale);assert.equal(usage.memory.length,1);
});

test('foreign rooms, replaced attempts, source changes and clearing cannot reuse a quote',async t=>{
  const f=fixture(t);await f.ready();const a=await newRoom(f,[whale],'甲','a'),b=await newRoom(f,[whale],'乙','b');
  await roomSend(f,a,whale,'原话','same-message');const s=await settledRoom(f,a),turn=s.room.turns.find(turn=>turn.phase!=='anchor');
  await roomSend(f,b,whale,'不同的原话','same-message');await settledRoom(f,b);
  const user={roomId:a.roomId,generation:s.room.generation,kind:'user',messageId:'same-message'};
  const before=f.calls.length;assert.equal((await sendQuote(f,b,user)).status,400);
  assert.equal((await sendQuote(f,a,{roomId:a.roomId,kind:'assistant',turnId:turn.id,attemptId:'old-attempt',index:0})).status,400);
  const changed=await f.request('chat-context',{...a,action:'detach',sessionId:'work',revision:Number(a.contextKey.split(':').at(-1))});
  const next={...a,contextKey:changed.value.id+':'+changed.value.revision};assert.equal((await sendQuote(f,next,user)).status,400);
  const state=await roomState(f,a);await f.request('chat',{...next,action:'clear',personaId:whale,revision:state.room.revision,epoch:state.epoch});
  await roomSend(f,next,whale,'重用消息编号的另一句话','same-message');await settledRoom(f,next);
  assert.equal((await sendQuote(f,next,user)).status,400);assert.equal(f.calls.length,before+1);
});

test('quote lookup never treats provisional text as a public assistant message',()=>{
  const room={id:'r',generation:0,turns:[{id:'t',attemptId:'a',messageId:'m',scopeKey:'scope',status:'pending',user:'用户原话',recipientId:whale,speakerName:'鲸鲸',assistant:['尚未提交的内容']}]};
  assert.equal(resolveChatQuote(room,{roomId:'r',kind:'assistant',turnId:'t',attemptId:'a',index:0},'scope'),null);
  assert.equal(resolveChatQuote(room,{roomId:'r',kind:'user',messageId:'m'},'scope').text,'用户原话');
});

test('the settings reference endpoint is lazy and does not read projects or call models',async t=>{
  const read=[];let projects=0;const storage=domain(Promise.resolve(),{onGet:id=>read.push(id)});
  const f=fixture(t,{storage,extraServices:[['workspaceRegistry',{list(){projects++;return[];}}]]});await f.ready();
  const r=await f.request('chat-references');assert.equal(r.status,200);assert.equal(r.value.initialized,false);
  assert.ok(!read.includes('personaChats'));assert.equal(projects,0);assert.equal(f.calls.length,0);
  assert.equal((await f.request('chat-references',undefined,false)).status,403);
});

test('actual reference pointers persist without copying prompts, original text or persona preferences',async t=>{
  const storage=domain(),f=fixture(t,{storage,script:()=>reply(['公开回应'])});await f.ready();await preference(f,'PRIVATE_STYLE_NEVER_PERSIST_HERE');
  const room=await newRoom(f,[whale]);await roomSend(f,room,whale,'这个输入不应复制进参考账本','request');await settledRoom(f,room);
  const view=(await refs(f,room)).value;assert.equal(view.records.length,1);assert.equal(typeof view.records[0].sentAt,'number');
  assert.equal(view.records[0].memory[0].content,'PRIVATE_STYLE_NEVER_PERSIST_HERE');await f.dispose();
  const raw=storage.tables.get('profile').get('chatReferenceUsage');assert.equal(raw.records.length,1);
  assert.doesNotMatch(JSON.stringify(raw),/PRIVATE_STYLE_NEVER_PERSIST_HERE|这个输入不应复制|公开回应|system|messages/);
  const g=fixture(t,{storage});await g.ready();assert.equal((await g.request('chat-references')).value.initialized,false);
  await g.state();const reopened=(await refs(g,room)).value;assert.equal(reopened.records[0].attemptId,view.records[0].attemptId);
  const memory=(await g.request('memory')).value.entries.find(e=>e.content==='PRIVATE_STYLE_NEVER_PERSIST_HERE');
  assert.equal((await g.request('memory',{action:'delete',id:memory.id,version:memory.version})).status,200);
  const revoked=(await refs(g,room)).value;assert.equal(revoked.records[0].memory[0].available,false);
  assert.doesNotMatch(JSON.stringify(revoked),/PRIVATE_STYLE_NEVER_PERSIST_HERE/);
});

test('pausing a cited older fragment is durable, version checked, room isolated and reversible',async t=>{
  let fail=false;const storage=domain(Promise.resolve(),{fail:id=>fail&&id==='personaChats'}),f=fixture(t,{storage,script:()=>reply(['草图布局先保留吗？'])});
  await f.ready();const a=await newRoom(f,[whale],'布局','a'),b=await newRoom(f,[whale],'其他房间','b');
  for(let i=0;i<10;i++){assert.equal((await roomSend(f,a,whale,i?'另一个话题'+i:'设置布局先画草图，我还没决定。','m'+i)).status,200);await settledRoom(f,a);}
  await roomSend(f,a,whale,'设置布局的草图还记得吗？','recall');await settledRoom(f,a);
  const view=(await refs(f,a)).value,note=view.records[0].notes.find(n=>n.available&&n.author.role==='user');assert.ok(note);
  const policy={roomId:a.roomId,ref:note.ref,excluded:true,referenceRevision:view.referenceRevision,epoch:view.epoch};
  fail=true;assert.equal((await f.request('chat-references',policy)).status,503);fail=false;
  assert.equal((await refs(f,a)).value.excluded.length,0);
  assert.equal((await f.request('chat-references',policy)).status,200);
  const restored=createPersonaChat();restored.restore(storage.tables.get('profile').get('personaChats'));
  assert.equal(restored.read(a.roomId).excludedReferences.length,1);
  assert.equal((await f.request('chat-references',policy)).status,409);
  assert.equal((await refs(f,b)).value.excluded.length,0);
  await roomSend(f,a,whale,'设置布局的草图还记得吗？','recall-again');await settledRoom(f,a);
  assert.ok(!body(f.calls.at(-1)).roomNotes.some(n=>quoteKey(n.ref)===quoteKey(note.ref)));
  const paused=(await refs(f,a)).value;assert.equal(paused.excluded[0].text,note.text);
  assert.equal((await f.request('chat-references',{...policy,referenceRevision:paused.referenceRevision,excluded:false})).status,200);
  await roomSend(f,a,whale,'设置布局的草图还记得吗？','recall-back');await settledRoom(f,a);
  assert.ok(body(f.calls.at(-1)).roomNotes.some(n=>quoteKey(n.ref)===quoteKey(note.ref)));
  const latest=await roomState(f,a);await f.request('chat',{...a,action:'clear',personaId:whale,revision:latest.room.revision,epoch:latest.epoch});
  assert.equal((await refs(f,a)).value.records.length,0);assert.equal((await refs(f,a)).value.excluded.length,0);
});

test('work references distinguish the current goal and previous-turn report, and settings never refresh stale text',async t=>{
  let reads=0;const events=[
    {seq:1,type:'turn/start',data:{turn:1}},
    {seq:2,type:'user/message',data:{content:[{type:'text',text:'第一轮目标'}]}},
    {seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:'第一轮汇报原话'}]}}},
    {seq:4,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
    {seq:5,type:'turn/start',data:{turn:2}},
    {seq:6,type:'user/message',data:{content:[{type:'text',text:'当前轮次目标'}]}},
  ];
  const f=fixture(t,{extraServices:[['sessions',{get:id=>({header:{id,title:'工作来源'}})}],
    ['sessionQuery',{observeSession:async()=>{reads++;return{events};}}]]});await f.ready();const room=await newRoom(f,[whale]);
  await roomSend(f,room);await settledRoom(f,room);const before=reads;
  const view=(await refs(f,room)).value,work=view.records[0].work[0];
  assert.equal(work.goalSeq,6);assert.equal(work.reportSeq,null);assert.equal(work.reportStatus,'none');
  assert.equal(work.goal,'当前轮次目标');assert.deepEqual(work.previousReport,{turn:1,seq:3,text:'第一轮汇报原话'});
  const event={seq:7,type:'user/message',data:{content:[{type:'text',text:'刚追加的新目标'}]}};events.push(event);f.bus.emit('session/event',{id:'work',header:{}},event);
  const stale=(await refs(f,room)).value;assert.equal(reads,before);
  assert.equal(stale.records[0].work[0].available,false);assert.doesNotMatch(JSON.stringify(stale),/当前轮次目标|刚追加的新目标|第一轮汇报原话/);
});

test('clearing a room drops pending reference records and delayed settlement cannot restore them',async t=>{
  let release;const gate=new Promise(r=>{release=r;});t.after(()=>release());
  const f=fixture(t,{script:()=> (async function*(){await gate;yield*reply(['迟到的回复']);})()});await f.ready();
  const room=await newRoom(f,[whale]);await roomSend(f,room);await flush();assert.equal((await refs(f,room)).value.records.length,1);
  const s=await roomState(f,room);assert.equal((await f.request('chat',{...room,action:'clear',personaId:whale,revision:s.room.revision,epoch:s.epoch})).status,200);
  release();await settledRoom(f,room);assert.deepEqual((await refs(f,room)).value.records,[]);
});

test('a reference policy change retires only its own room and rejects late replies',async t=>{
  let release;const gate=new Promise(r=>{release=r;});t.after(()=>release());
  const f=fixture(t,{script:options=>body(options).message.endsWith('_RUN')?(async function*(){await gate;yield*reply(['NEW_LATE_OUTPUT']);})():reply(['原始回应'])});
  await f.ready();const a=await newRoom(f,[whale],'甲','a'),b=await newRoom(f,[dragon],'乙','b');
  await roomSend(f,a,whale,'旧话题','old');await settledRoom(f,a);
  await roomSend(f,a,whale,'A_RUN','a-live');await roomSend(f,b,dragon,'B_RUN','b-live');await flush();
  const view=(await refs(f,a)).value;
  assert.equal((await f.request('chat-references',{roomId:a.roomId,referenceRevision:view.referenceRevision,epoch:view.epoch,
    ref:{roomId:a.roomId,generation:0,kind:'user',messageId:'old'},excluded:true})).status,200);
  release();const [doneA,doneB]=await Promise.all([settledRoom(f,a),settledRoom(f,b)]);
  assert.equal(doneA.room.turns.at(-1).status,'cancelled');assert.equal(doneB.room.turns.at(-1).status,'ready');
  assert.doesNotMatch(JSON.stringify(doneA.room.turns),/NEW_LATE_OUTPUT/);
});

test('reference details resolve the original question, frozen @ order and speaking phase only within their room',async t=>{
  const f=fixture(t,{script:()=>reply(['保留公开观点。']),directorScript:options=>{
    const value=body(options),answered=new Set(value.events.filter(event=>event.author.role==='assistant').map(event=>event.author.id));
    const ids=value.members.length===3?[dragon,whale,claude]:value.recipients.map(person=>person.id),id=ids.find(id=>!answered.has(id)),event=value.events.findLast(event=>event.author.role==='user');
    return directorReply({work:'not-needed',sourceIds:[],request:'answer',evidence:value.message},id?{id,kind:'normal',to:'user',evidence:{eventId:event.id,index:0,text:event.messages[0]},goal:'回应原问题。'}:null);
  }});await f.ready();
  const a=await newRoom(f,[whale,dragon,claude],'甲','origin-a'),b=await newRoom(f,[dragon],'乙','origin-b');
  const initial=await roomState(f,a);
  assert.equal((await f.request('chat-rooms',{...a,action:'update',targetPersonaIds:[dragon,whale],configRevision:initial.room.configRevision,epoch:initial.epoch})).status,200);
  const s=await roomState(f,a);
  assert.equal((await f.request('chat',{...a,action:'send',personaId:dragon,recipientIds:[dragon,whale],content:'甲房间的原始问题',
    requestId:'same-id',revision:s.room.revision,epoch:s.epoch})).status,200);
  await settledRoom(f,a);await roomSend(f,b,dragon,'乙房间的不同问题','same-id');await settledRoom(f,b);
  const done=await roomState(f,a);
  await f.request('chat-rooms',{...a,action:'update',targetPersonaIds:[claude],configRevision:done.room.configRevision,epoch:done.epoch});
  const view=(await refs(f,a)).value;assert.equal(view.records.length,3);
  for(const record of view.records){
    assert.equal(record.request.available,true);assert.equal(record.request.text,'甲房间的原始问题');
    assert.deepEqual(record.request.recipients.map(p=>p.id),[dragon,whale]);
  }
  assert.ok(view.records.every(record=>record.request.phase==='reaction'&&record.request.order===undefined));
  assert.deepEqual(f.calls.filter(call=>body(call).message==='甲房间的原始问题').map(call=>body(call).speaker.id),[dragon,whale,claude]);
  assert.doesNotMatch(JSON.stringify(view),/乙房间的不同问题/);
  assert.equal((await refs(f,b)).value.records[0].request.text,'乙房间的不同问题');
});

test('reference questions do not resolve replaced attempts or messages from an earlier reference scope',async t=>{
  const f=fixture(t,{script:(_,n)=>reply(['公开回应'],n===1?'max-tokens':'stop')});await f.ready();
  const room=await newRoom(f,[whale]);await roomSend(f,room,whale,'必须对应原尝试的提问','origin');
  const first=await settledRoom(f,room),turn=first.room.turns.find(turn=>turn.phase!=='anchor'),old=(await refs(f,room)).value.records[0];
  assert.equal(old.request.text,'必须对应原尝试的提问');
  assert.equal((await f.request('chat',{...room,action:'retry',personaId:whale,id:turn.id,attemptId:'replacement-attempt',
    revision:first.room.revision,epoch:first.epoch})).status,200);await settledRoom(f,room);
  const retried=(await refs(f,room)).value;
  assert.deepEqual(retried.records.find(r=>r.id===old.id).request,{available:false});
  assert.equal(retried.records[0].request.text,'必须对应原尝试的提问');
  const ctx=(await f.request('chat-context',{...room,action:'open',viewer:'scope-inspection',sequence:1,sessionId:'work'})).value;
  assert.equal((await f.request('chat-context',{...room,action:'detach',sessionId:'work',revision:ctx.revision})).status,200);
  const changed=(await refs(f,room)).value;assert.ok(changed.records.every(r=>!r.request.available));
  assert.doesNotMatch(JSON.stringify(changed),/必须对应原尝试的提问/);
});

test('reference metadata retains an omitted previous report without copying its body',async t=>{
  const longReport='上轮原文不应复制。'.repeat(650),storage=domain();
  const events=[{seq:1,type:'turn/start',data:{turn:1}},
    {seq:2,type:'assistant/message',data:{message:{content:[{type:'text',text:longReport}]}}},
    {seq:3,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
    {seq:4,type:'turn/start',data:{turn:2}},
    {seq:5,type:'user/message',data:{content:[{type:'text',text:'本轮的新目标'}]}}];
  const f=fixture(t,{storage,extraServices:[['sessions',{get:id=>({header:{id,title:'工作来源'}})}],
    ['sessionQuery',{observeSession:async()=>({events})}]]});await f.ready();const room=await newRoom(f,[whale]);
  await roomSend(f,room);await settledRoom(f,room);
  assert.equal(body(f.calls.at(-1)).workContext.sources[0].previousReportOmitted,true);
  const work=(await refs(f,room)).value.records[0].work[0];assert.equal(work.previousReportOmitted,true);
  assert.equal(work.previousReport.turn,1);assert.equal(work.previousReport.seq,2);assert.equal(work.previousReport.text,'');
  assert.equal(work.previousReport.excerpt.coverage,'partial-unknown');
  await f.dispose();const stored=storage.tables.get('profile').get('chatReferenceUsage');
  assert.equal(stored.records[0].work[0].previousReportOmitted,true);assert.doesNotMatch(JSON.stringify(stored),/上轮原文不应复制/);
});

test('settings resolve exactly the historical excerpt sent under the shared budget, without refreshing or persisting its body',async t=>{
  const previous=Array.from({length:22},(_,i)=>`上轮原文片段${i}：${'布局记录。'.repeat(55)}\n\n`).join('');
  const current='本轮过程原文。'.repeat(500),goal='本轮目标。'.repeat(200);let reads=0;
  const events=[{seq:1,type:'turn/start',data:{turn:1}},
    {seq:2,type:'assistant/message',data:{message:{content:[{type:'text',text:previous}]}}},
    {seq:3,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
    {seq:4,type:'turn/start',data:{turn:2}},
    {seq:5,type:'user/message',data:{content:[{type:'text',text:goal}]}},
    {seq:6,type:'assistant/message',data:{message:{content:[{type:'text',text:current}]}}}];
  const storage=domain(),f=fixture(t,{storage,extraServices:[['sessions',{get:id=>({header:{id,title:'工作来源'}})}],
    ['sessionQuery',{observeSession:async()=>{reads++;return{events};}}]]});
  await f.ready();const room=await newRoom(f,[whale]);await roomSend(f,room);await settledRoom(f,room);
  const actual=body(f.calls.at(-1)).workContext.sources[0],before=reads;
  assert.equal(actual.reportStatus,'progress');assert.ok(actual.previousReport.text.length>0&&actual.previousReport.text.length<5000);
  const work=(await refs(f,room)).value.records[0].work[0];
  assert.equal(reads,before,'inspecting usage cannot refresh a source');assert.equal(work.available,true);
  assert.equal(work.report,current);assert.equal(work.previousReport.text,actual.previousReport.text);
  assert.deepEqual(work.previousReport.excerpt,actual.previousReport.excerpt);
  await f.dispose();const persisted=storage.tables.get('profile').get('chatReferenceUsage');
  assert.doesNotMatch(JSON.stringify(persisted),/上轮原文片段|本轮过程原文/);
});
