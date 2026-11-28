import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,domain,whale,newRoom,roomState,jsonReply,flush } from './helpers/persona-chat-host.mjs';
import { createStructuredMemory } from '../lib/structured-memory.js';
import { exportAssets,planAssetImport } from '../lib/asset-backup.js';
import { DEFAULT_PACK } from '../lib/pack.js';
import {normalizeChatProfile} from '../lib/persona-chat-profile.js';

const card={id:'old-card',name:'新角色',pack:DEFAULT_PACK,builtin:false};
const room={id:'room:1',name:'旧房间',turns:[{user:'聊天原文不进备份'}]};
test('portable cards keep authored chat expression and reject out-of-bounds fields before import',()=>{
  const chat=normalizeChatProfile({voice:['保持简短'],source:{text:'试说时语句简短',identity:DEFAULT_PACK.identity,voice:['保持简短'],enabled:true}});
  assert.equal(chat.source?.enabled,true);
  const preset={...card,pack:{...DEFAULT_PACK,chat}};
  const exported=exportAssets({presets:[preset],entries:[],rooms:[]},{id:preset.id});
  const empty={presets:[],entries:[],rooms:[],limit:30};
  assert.deepEqual(planAssetImport(exported,empty).cards[0].pack.chat,preset.pack.chat);
  exported.pack.chat.voice=['长'.repeat(401)];assert.throws(()=>planAssetImport(exported,empty),/invalid-backup/);
});
function makeFile(){
  const memory=createStructuredMemory();
  memory.rememberChat({entry:{kind:'episode',scope:'session',sessionId:room.id,content:'一起去看烟花'},evidence:{source:'message',complete:true,eventId:'old#0',quote:'我们一起看过烟花',sessionId:room.id}});
  memory.mutate({action:'add',entry:{kind:'preference',scope:'shared',content:'简洁一点'}});
  return exportAssets({presets:[card],entries:memory.snapshot().entries,rooms:[room]},{plugin:'test'});
}
test('validates the complete file before planning, skips missing rooms or moves them to a chosen private scope',()=>{
  const file=makeFile(), state={presets:[card],entries:[],rooms:[],limit:30};
  assert.doesNotMatch(JSON.stringify(file),/聊天原文不进备份/);
  const skip=planAssetImport(file,state);assert.equal(skip.summary.missingRoom,1);assert.equal(skip.summary.entries,1);
  const plan=planAssetImport(file,state,card.id);assert.deepEqual(plan.summary.personas,['新角色（导入）']);
  const [e,shared]=plan.additions;assert.notEqual(e.id,file.memory.entries[0].id);assert.equal(e.scope,'persona');assert.equal(e.personaId,card.id);
  assert.equal(e.origin,'chat');assert.deepEqual(e.evidence,file.memory.entries[0].evidence);assert.equal(shared.status,'candidate');
  file.memory.entries.at(-1).content='x'.repeat(241);assert.throws(()=>planAssetImport(file,state),/invalid-backup/);
});
test('host import requires a current preview and does not expose partial records on a storage failure',async t=>{
  let fail=false;const storage=domain(undefined,{fail:id=>fail && id==='structuredMemory'});
  const f=fixture(t,{storage});await f.ready();const file=makeFile();
  const request={file,fallbackPersona:whale};const preview=await f.request('backup',{action:'preview',...request});assert.equal(preview.status,200);
  const accept={action:'import',...request,token:preview.value.token};fail=true;assert.equal((await f.request('backup',accept)).status,503);
  assert.equal(storage.tables.get('presets').size,0);assert.equal((await f.request('memory')).value.entries.length,0);
  fail=false;assert.equal((await f.request('backup',accept)).status,200);assert.equal((await f.request('backup',accept)).status,409);
  const entries=(await f.request('memory')).value.entries;assert.equal(entries.length,2);assert.ok(entries.every(e=>e.status==='candidate'));
  await f.dispose();const next=fixture(t,{storage});await next.ready();assert.deepEqual((await next.request('memory')).value.entries,entries);
});
test('an interrupted import rolls back only newly allocated IDs on restart',async t=>{
  const storage=domain();const f=fixture(t,{storage});await f.ready();await f.request('memory',{action:'add',entry:{kind:'preference',content:'保留的原有记录',scope:'shared'}});await f.dispose();
  const profile=storage.tables.get('profile'), m=profile.get('structuredMemory');m.entries.push({...m.entries[0],id:'new'});
  storage.tables.get('presets').set('partial',{...card,id:'partial'});profile.set('pendingAssetImport',{entries:['new'],cards:['partial']});
  const next=fixture(t,{storage});await next.ready();assert.equal((await next.request('memory')).value.entries.length,1);
  assert.equal(storage.tables.get('presets').has('partial'),false);assert.equal(profile.has('pendingAssetImport'),false);
});

test('settings-authored room agreements stay chat-only after migration, adoption, revision and another backup',()=>{
  const m=createStructuredMemory();
  const entry=m.mutate({action:'add',entry:{scope:'session',sessionId:room.id,kind:'agreement',content:'汇报先说结论'}});
  const destination={presets:[card],entries:[],rooms:[],limit:30};
  const backup=(entries,rooms=[])=>exportAssets({presets:[],entries,rooms},{type:'memory'});
  const file=backup([entry],[room]);
  const [imported]=planAssetImport(file,destination,card.id).additions;
  assert.equal(imported.origin,'manual');assert.equal(imported.scope,'persona');assert.equal(imported.status,'candidate');
  assert.deepEqual(imported.evidence,entry.evidence);
  m.restore({version:1,entries:[imported]});
  const accept=m.mutate({action:'propose',operation:'accept',id:imported.id,version:imported.version});
  m.mutate({action:'confirm',id:accept.id,version:accept.version});
  const chat={purpose:'chat',personaId:card.id,sessionId:'room:new'};
  const rewrite={...chat,purpose:'rewrite',sessionId:'work'};
  const [active]=m.select(chat);assert.equal(active.id,imported.id);assert.deepEqual(m.select(rewrite),[]);
  assert.deepEqual(m.references([active],rewrite),[]);
  const regular=m.mutate({action:'add',entry:{scope:'persona',personaId:card.id,kind:'agreement',content:entry.content}});
  assert.notEqual(regular.id,active.id);
  assert.throws(()=>m.mutate({action:'merge',refs:[active,regular],keep:active.id,content:active.content}),/invalid-memory-merge/);
  m.observe({sessionId:'work',personaId:card.id,seq:1,text:'开始工作'});
  assert.ok(!m.batch().targets.some(e=>e.id===active.id));
  const op=m.mutate({action:'propose',operation:'revise',id:active.id,version:active.version,content:'先说结论，然后说明细节',statement:'聊天里这样叫我'});
  const confirmed=m.mutate({action:'confirm',id:op.id,version:op.version});
  const revised=m.snapshot().entries.find(e=>e.id===confirmed.resultId);
  assert.equal(revised.evidence[0].source,'settings');assert.equal(revised.chatOnly,true);
  const [again]=planAssetImport(backup([revised]),destination).additions;
  m.restore({version:1,entries:[again]});
  const edited=m.mutate({action:'accept',id:again.id,version:again.version});
  m.mutate({action:'update',id:edited.id,version:edited.version,content:'聊天里先说明结论',pinned:false});
  assert.equal(m.select(chat)[0].chatOnly,true);assert.deepEqual(m.select(rewrite),[]);
});

test('legacy UUID rooms round trip and same-word historical or expired records do not shadow an active grant',()=>{
  const oldRoom={id:'chat:12345678-0000-0000-0000-000000000001',name:'旧房间'};
  const m=createStructuredMemory();
  const active=m.rememberChat({entry:{scope:'session',sessionId:oldRoom.id,kind:'agreement',content:'聊天先说结论'},
    evidence:{eventId:'original#0',quote:'先说结论吧',source:'message',complete:true,sessionId:oldRoom.id}});
  assert.equal(active.expiresAt,null);
  const entries=[{...active,id:'history',status:'retracted'},{...active,id:'expired',expiresAt:1},active];
  const file=exportAssets({presets:[],entries,rooms:[oldRoom]},{type:'memory',history:true});
  const context={presets:[],entries:[],rooms:[oldRoom],limit:30};
  const plan=planAssetImport(file,context);
  assert.deepEqual(plan.additions.map(e=>[e.status,e.expiresAt]),[['retracted',null],['candidate',1],['candidate',null]]);
  assert.equal(planAssetImport(file,{...context,entries:plan.additions}).summary.duplicates,3);
  m.restore({version:1,entries:plan.additions});
  const candidate=plan.additions[2];m.mutate({action:'accept',id:candidate.id,version:candidate.version});
  assert.equal(m.select({purpose:'chat',sessionId:oldRoom.id})[0].evidence[0].sessionId,oldRoom.id);
  file.memory.entries[0].evidence[0].sessionId='room:elsewhere';
  assert.throws(()=>planAssetImport(file,context),/invalid-backup/);
});

for (const scenario of ['new observation','room deletion']) test('an import preserves concurrent '+scenario, async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  let pause=false;
  const storage=domain(undefined,{async beforePut(key){
    if(pause && key==='structuredMemory'){pause=false;entered.resolve();await release.promise;}
  }});
  const f=fixture(t,{storage,config:{memory:true}});await f.ready();
  const binding=await newRoom(f,[whale]);const view=await roomState(f,binding);
  const memory=createStructuredMemory();
  memory.mutate({action:'add',entry:{kind:'agreement',scope:'session',sessionId:binding.roomId,content:'使用短句'}});
  const file=exportAssets({presets:[],entries:memory.snapshot().entries,rooms:[view.room]},{type:'memory'});
  const {value:{token}}=await f.request('backup',{action:'preview',file});
  pause=true;const saving=f.request('backup',{action:'import',token,file});await entered.promise;
  if(scenario==='new observation'){
    try {f.work('以后叫我 Alice');} finally {release.resolve();}
    assert.equal((await saving).status,409);
    const disk=storage.tables.get('profile').get('structuredMemory');
    assert.deepEqual(disk.entries.map(e=>e.content),['以后叫我 Alice']);
    assert.deepEqual(disk.entries,(await f.request('memory')).value.entries);
  }else{
    const deleting=f.request('chat-rooms',{action:'delete',roomId:binding.roomId,revision:view.room.revision,epoch:view.epoch,retractMemories:true});
    release.resolve();assert.equal((await saving).status,200);assert.equal((await deleting).status,200);
    assert.deepEqual((await f.request('memory')).value.entries.map(e=>e.status),['retracted']);
  }
});

test('an import cancels a running extraction and discards its late candidates',async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=fixture(t,{config:{memory:true,memoryExtraction:true},script(options){return(async function*(){
    const [source]=JSON.parse(options.messages[0].content[0].text).sources;
    entered.resolve(options.signal);await release.promise;
    yield*jsonReply({entries:[{kind:'episode',scope:'persona',content:'迟到候选',evidence:[{eventId:source.id,quote:source.text}]}]});
  })();}});
  await f.ready();f.work('刚开始准备周末出游');await f.request('memory',{action:'consolidate'});
  const signal=await entered.promise;
  try{
    const file=makeFile();const {value:{token}}=await f.request('backup',{action:'preview',file});
    assert.equal((await f.request('backup',{action:'import',file,token})).status,200);
    assert.equal(signal.aborted,true);
  } finally {release.resolve();}
  await flush();assert.ok(!(await f.request('memory')).value.entries.some(e=>e.content==='迟到候选'));
});
