import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, whale, dragon, newRoom, roomSend, settledRoom, readChatInput, reply, jsonReply} from './helpers/persona-chat-host.mjs';
import {candidateSources,verifiedCandidates,chatMemorySource} from '../lib/chat-memory.js';
import {createStructuredMemory} from '../lib/structured-memory.js';

async function setup(t) {
  const f=fixture(t); await f.ready(); await f.request('settings',{memory:true});
  const room=await newRoom(f,[whale,dragon]);
  const say=async(text,actor=whale,id=text)=>{
    const state=(await f.request('chat?room='+room.roomId)).value;
    if(state.room.targetPersonaId!==actor)assert.equal((await f.request('chat-rooms',{action:'update',roomId:room.roomId,
      configRevision:state.room.configRevision,epoch:state.epoch,targetPersonaIds:[actor]})).status,200);
    assert.equal((await roomSend(f,room,actor,text,id)).status,200);return settledRoom(f,room);
  };
  const text='以后叫我阿澄就好，别叫主人';
  const s=await say(text,whale,'message-one');
  const remember=(patch={})=>f.request('chat/memory',{room:room.roomId,messageId:'message-one',generation:s.room.generation,
    part:0,kind:'agreement',scope:'persona',personaId:whale,content:'叫我阿澄',...patch});
  return {f,room,s,say,remember,text};
}

test('chat memory uses canonical complete evidence and only its authorized actor or room',async t=>{
  const {f,room,say,remember,text}=await setup(t);
  const {value:{entry}}=await remember({quote:'客户端伪造'});
  assert.equal(entry.origin,'chat');assert.equal(entry.evidence[0].quote,text);assert.equal(entry.evidence[0].complete,true);
  await say('还记得吗');assert.ok(readChatInput(f.calls.at(-1)).personalContext.some(x=>x.content===entry.content));
  await say('问问同伴',dragon);assert.ok(!readChatInput(f.calls.at(-1)).personalContext?.some(x=>x.content===entry.content));
  const shared=(await remember({scope:'room',kind:'episode',content:'房间里提到了称呼'})).value.entry;
  assert.equal(shared.sessionId,room.roomId);assert.equal(shared.expiresAt,null);
  await say('再问同伴称呼',dragon);assert.ok(readChatInput(f.calls.at(-1)).personalContext.some(x=>x.content===shared.content));
  const other=await newRoom(f,[dragon],'另外的房间','elsewhere');await roomSend(f,other,dragon);await settledRoom(f,other);
  assert.ok(!readChatInput(f.calls.at(-1)).personalContext?.length);
});

test('partial, assistant, stale, nonmember and disabled chat evidence',async t=>{
  const {f,room,s,say,remember}=await setup(t);
  const partial=(await remember({start:2,end:6})).value.entry;
  assert.equal(partial.evidence[0].complete,false);
  const restored=createStructuredMemory();restored.restore({version:1,entries:[partial]});
  assert.equal(restored.selection({personaId:whale,sessionId:room.roomId,purpose:'chat'}).omitted[0].reason,'not-expression');
  await say('检查片段');assert.ok(!readChatInput(f.calls.at(-1)).personalContext?.length);
  assert.equal((await remember({personaId:'absent'})).value.error,'chat-memory-member');
  assert.equal((await remember({messageId:s.room.turns.at(-1).id})).value.error,'chat-memory-source');
  const current=await settledRoom(f,room);await f.request('chat',{...room,action:'clear',personaId:whale,revision:current.room.revision,epoch:current.epoch});
  assert.equal((await remember()).value.error,'chat-memory-source');
  const count=(await f.request('memory')).value.entries.length;await f.request('settings',{memory:false});
  assert.equal((await remember()).value.error,'memory-disabled');assert.equal((await f.request('memory')).value.entries.length,count);
});

test('chat mutation routes reject non-object JSON before acting on room state', async t => {
  const f = fixture(t); await f.ready();
  for (const [path, error] of [['chat/memory','invalid-memory-entry'], ['chat-rooms','invalid-chat-room'], ['chat-references','invalid-chat-reference']]) {
    for (const body of [null, [], 'text', 1]) {
      const result = await f.request(path, body);
      assert.equal(result.status, 400, path);
      assert.equal(result.value.error, error, path);
    }
  }
});

test('remembering a saved bubble for a deleted persona rejects its archived room seat', async t => {
  const {f, room, s, remember} = await setup(t);
  const saved = await f.request('presets', {action:'save', name:'旧成员', pack:{identity:'旧成员'}});
  const id = saved.value.presets.find(p => p.name === '旧成员').id;
  const edited = await f.request('chat-rooms', {action:'update', roomId:room.roomId, epoch:s.epoch,
    configRevision:s.room.configRevision, memberIds:[whale, dragon, id]});
  assert.equal(edited.status, 200);
  assert.equal((await f.request('presets', {action:'delete', id})).status, 200);
  assert.ok((await f.request('chat?room='+room.roomId)).value.room.memberIds.includes(id));
  const before = (await f.request('memory')).value.entries;
  const result = await remember({personaId:id});
  assert.equal(result.status, 400);
  assert.equal(result.value.error, 'chat-memory-member');
  assert.deepEqual((await f.request('memory')).value.entries, before);
});

test('deleting a room retires its candidates without displacing another scope’s pending owner decisions',()=>{
  const m=createStructuredMemory();
  const room='room:to-delete';
  const active=m.mutate({action:'add',entry:{content:'本房间的约定',scope:'session',sessionId:room,kind:'agreement'}});
  const candidate=m.rememberChat({entry:{content:'曾一起吃过饭',scope:'session',sessionId:room,kind:'episode'},
    evidence:{eventId:'bubble',quote:'我们一起吃过饭',source:'message',sessionId:room,complete:true}},'candidate');
  const sibling=m.rememberChat({entry:{content:'约好下次一起吃饭',scope:'session',sessionId:room,kind:'agreement'},evidence:candidate.evidence[0]},'candidate');
  const elsewhere=m.mutate({action:'add',entry:{content:'其他房间约定',scope:'session',sessionId:'room:else',kind:'agreement'}});
  for(let i=0;i<80;i++)m.mutate({action:'propose',operation:'retract',id:elsewhere.id,version:elsewhere.version,statement:`待核对 ${i}`});
  const decisions=m.snapshot().operations;
  assert.equal(m.roomCount(room),3);m.retractRoom(room);
  const after=m.snapshot();assert.deepEqual(after.operations,decisions);
  for(const prior of [active,candidate,sibling]){
    const retired=after.entries.find(e=>e.id===prior.id);
    assert.equal(retired.status,'retracted');assert.equal(retired.version,prior.version+1);assert.deepEqual(retired.evidence,prior.evidence);
  }
  assert.equal(m.roomCount(room),0);assert.equal(m.versionStatus(elsewhere.id),'active');
});

test('room deletion retracts room records with audit and preserves actor records; selection bounds experiences',async t=>{
  const {f,say,room,remember}=await setup(t);
  const personal=(await remember()).value.entry;
  for(const c of ['甲','乙','丙'])await remember({scope:'room',kind:'episode',content:c.repeat(101)});
  const last=await say('回顾称呼，叫我什么');const items=readChatInput(f.calls.at(-1)).personalContext;
  assert.equal(items.length,2);assert.ok(items.some(x=>x.content===personal.content));assert.ok(items.reduce((n,x)=>n+x.content.length,0)<=300);
  assert.equal((await f.request('chat-rooms',{action:'delete',roomId:room.roomId,revision:last.room.revision,epoch:last.epoch,retractMemories:true})).status,200);
  const m=(await f.request('memory')).value;assert.equal(m.entries.filter(e=>e.status==='retracted').length,3);
  assert.equal(m.entries.find(e=>e.id===personal.id).status,'active');assert.equal(m.operations.filter(o=>o.kind==='retract'&&o.status==='applied').length,3);
});

test('settings cannot confirm a room memory after deletion; clear keeps active agreements',async t=>{
  const {f,room,s,remember}=await setup(t);const entry=(await remember({scope:'room'})).value.entry;
  const draft={kind:'episode',scope:'session',sessionId:room.roomId,content:'从设置页记录的经历'};
  const op=(await f.request('memory',{action:'propose-add',entry:draft})).value.result;
  await f.request('chat',{...room,action:'clear',personaId:whale,revision:s.room.revision,epoch:s.epoch});
  const current=await settledRoom(f,room);
  assert.equal((await f.request('memory')).value.entries.find(e=>e.id===entry.id).status,'active');
  await f.request('chat-rooms',{action:'delete',roomId:room.roomId,revision:current.room.revision,epoch:current.epoch,retractMemories:false});
  assert.equal((await f.request('memory',{action:'confirm',id:op.id,version:op.version})).value.error,'memory-room-missing');
  assert.equal((await f.request('memory',{action:'add',entry:draft})).value.error,'memory-room-missing');
});

test('chat selects at most two experiences within 300 chars after expression preferences',async t=>{
  const {f,say,remember}=await setup(t);
  await f.request('memory',{action:'add',entry:{kind:'preference',scope:'persona',personaId:whale,content:'请叫我阿澄'}});
  for(const c of ['甲','乙','丙'])await remember({scope:'room',kind:'episode',content:c.repeat(141)});
  await say('叫我什么');const input=readChatInput(f.calls.at(-1));assert.equal(input.personalContext.length,2);
  assert.equal(input.personalContext.reduce((count,x)=>count+x.content.length,0),282);assert.match(f.calls.at(-1).system,/请叫我阿澄/);
});

test('settings edits preserve the chat audience and original whole or partial evidence across reload', async t => {
  const {f, room, say, remember} = await setup(t);
  for (const partial of [false, true]) {
    const {value:{entry}} = await remember(partial ? {start:2, end:6, content:'片段约定'} : {});
    const content = entry.content + '（修订）';
    const edited = (await f.request('memory', {action:'update', id:entry.id, version:entry.version, content, pinned:true})).value.result;
    assert.equal(edited.origin, 'chat');
    assert.deepEqual(edited.evidence, entry.evidence);
    const op = (await f.request('memory', {action:'propose', operation:'revise', id:edited.id, version:edited.version,
      content:content+'。', statement:'修正标点'})).value.result;
    const applied = (await f.request('memory', {action:'confirm', id:op.id, version:op.version})).value.result;
    const saved = (await f.request('memory')).value.entries;
    const replacement = saved.find(e => e.id === applied.resultId);
    assert.deepEqual(replacement.evidence, entry.evidence);
    assert.equal(applied.evidence[0].source, 'settings');
    const memory = createStructuredMemory();
    for (const legacy of [false, true]) {
      memory.restore({version:1, entries:saved.map(e => legacy && e.id === replacement.id ? {...e, origin:'correction', evidence:op.evidence} : e)});
      const context = {personaId:whale, sessionId:room.roomId};
      assert.equal(memory.select({...context, purpose:'rewrite'}).length, 0);
      assert.deepEqual(memory.references([replacement], {...context, purpose:'rewrite'}), []);
      assert.equal(memory.select({...context, purpose:'chat'}).some(e => e.id === replacement.id), !partial);
    }
    await say('回看设置更正 ' + partial);
    assert.equal(readChatInput(f.calls.at(-1)).personalContext?.some(e => e.content === replacement.content) ?? false, !partial);
  }
});

test('identical settings and chat agreements keep independent evidence and lifetimes', () => {
  const entry = {kind:'agreement', scope:'persona', personaId:whale, content:'同一句约定'};
  const evidence = {source:'message', complete:false, quote:'约定', eventId:'m#0', sessionId:'room:test'};
  for (const chatFirst of [false, true]) {
    const memory = createStructuredMemory();
    const chat = () => memory.rememberChat({entry, evidence});
    const settings = () => memory.mutate({action:'add', entry});
    const [first, second] = chatFirst ? [chat(),settings()] : [settings(),chat()];
    assert.notEqual(first.id, second.id);
    assert.deepEqual(memory.select({personaId:whale, purpose:'rewrite'}).map(e=>e.origin), ['manual']);
    assert.deepEqual(memory.select({personaId:whale, purpose:'chat'}).map(e=>e.origin), ['manual']);
  }
});

test('manual room discovery uses whole owner quotes and leaves a rejected source out of later batches', async t => {
  let invalidate = true, batches = 0;
  const f = fixture(t, {script(options) {
    if (!options.system.includes('整理聊天室的用户原话')) return reply();
    const {sources} = JSON.parse(options.messages[0].content[0].text);
    assert.equal(sources.length, 1);
    batches++;
    return jsonReply({entries:[{eventId:sources[0].id, quote:invalidate?'同伴说的话':sources[0].text,
      scope:sources[0].scope, kind:'episode', content:'下周三面试'}]});
  }});
  await f.ready(); await f.request('settings',{memory:true});
  const room = await newRoom(f,[whale]);
  await roomSend(f,room,whale,'下周三要去面试','original');
  const view = await settledRoom(f,room);
  const discover = () => f.request('chat/memory',{action:'discover',room:room.roomId,generation:view.room.generation??0,
    referenceRevision:view.room.referenceRevision??0,scopeKey:view.scopeKey});
  assert.equal(batches,0);
  assert.equal((await discover()).value.error,'chat-memory-source');
  assert.equal((await f.request('memory')).value.entries.length,0);
  invalidate=false;
  assert.deepEqual((await discover()).value,{count:1});
  const [candidate]=(await f.request('memory')).value.entries;
  assert.equal(candidate.status,'candidate'); assert.equal(candidate.origin,'chat'); assert.equal(candidate.scope,'persona');
  assert.equal(candidate.evidence[0].quote,'下周三要去面试');assert.equal(candidate.evidence[0].complete,true);
  await f.request('memory',{action:'reject',id:candidate.id,version:candidate.version});
  assert.equal((await discover()).value.count,0);assert.equal(batches,2);
});

test('discovery excludes quotes, actors, questions and continuing scenes before inference', () => {
  const base={phase:'anchor',user:'周三有面试',recipients:[{id:whale}],scopeKey:'a'};
  const changes=[{}, {phase:'reply'}, {quote:{}}, {user:'会成功吗？'}, {scene:{relation:'continue'}}, {scopeKey:'b'}];
  const room={id:'room:a',memberIds:[whale],turns:changes.map((c,i)=>({...base,messageId:'m'+i,...c}))};
  const sources=candidateSources(room,'a',[]);
  assert.deepEqual(sources.map(s=>s.id),['m0#0']);
  for(const scope of ['room','shared'])assert.throws(()=>verifiedCandidates([{eventId:'m0#0',quote:base.user,scope,kind:'episode',content:base.user}],sources,room,'a'),/chat-memory-source/);
  room.excludedReferences=[{roomId:room.id,generation:0,kind:'user',messageId:'m0'}];
  assert.deepEqual(candidateSources(room,'a',[]),[]);
  assert.throws(()=>chatMemorySource(room,'a',{room:room.id,part:0,messageId:'m0',kind:'episode',scope:'room'}),/chat-memory-source/);
});

test('discovery never widens a departed or multi-recipient subset to the room',()=>{
  const memberIds=['a','b','c'];
  const targets=[['departed'],['a','b'],['a'],[],memberIds,['a','removed']];
  const room={id:'room:r',memberIds,turns:targets.map((ids,i)=>({phase:'anchor',user:'明天去看展览',messageId:'m'+i,
    recipients:ids.map(id=>({id})),scopeKey:'scope'}))};
  const read=available=>candidateSources(room,'scope',[],available).map(s=>[s.messageId,s.personaId]);
  assert.deepEqual(read(memberIds),[['m2','a'],['m3',null],['m4',null]]);
  assert.deepEqual(read(['b','c']),[['m3',null]]);
});

test('attached public reply resolves for owner review only and expires with its original room generation',async t=>{
  const {f,say,remember,room}=await setup(t);
  const entry=(await remember({includeReply:true})).value.entry;
  const read=async()=>(await f.request('memory')).value.entries.find(e=>e.id===entry.id);
  assert.ok((await read()).contextNote.text);assert.equal(entry.evidence.length,1);
  const used=await say('提到了什么约定');const body=readChatInput(f.calls.at(-1));assert.ok(body.personalContext.some(e=>e.content===entry.content));
  assert.ok(!JSON.stringify(body.personalContext).includes('contextRef'));
  await f.request('chat',{...room,action:'clear',personaId:whale,revision:used.room.revision,epoch:used.epoch});assert.equal((await read()).contextNote,undefined);
});

for(const action of ['disable','detach','clear'])test('ongoing candidate discovery rejects late output on '+action,async t=>{
  let entered,release,signal;const started=new Promise(r=>entered=r);
  const f=fixture(t,{script:opts=>!opts.system.includes('整理聊天室的用户原话')?reply():(async function*(){
    signal=opts.signal;entered();await new Promise(r=>release=r);yield*jsonReply({entries:[]});
  })()});await f.ready();await f.request('settings',{memory:true});const b=await newRoom(f,[whale]);
  await roomSend(f,b,whale,'下周三有面试','candidate-late');const state=await settledRoom(f,b);
  const outcome=f.request('chat/memory',{action:'discover',room:b.roomId,scopeKey:state.scopeKey,generation:state.room.generation??0,referenceRevision:state.room.referenceRevision??0});
  await started;
  if(action==='disable')await f.request('settings',{memory:false});
  else if(action==='detach')await f.request('chat-context',{action:'detach',...b,sessionId:'work',revision:Number(b.contextKey.split(':').at(-1))});
  else await f.request('chat',{...b,action:'clear',personaId:whale,revision:state.room.revision,epoch:state.epoch});
  const aborted=signal.aborted;release();assert.equal(aborted,true);assert.notEqual((await outcome).status,200);assert.equal((await f.request('memory')).value.entries.length,0);
});
