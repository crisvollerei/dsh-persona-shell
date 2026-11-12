import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERATION_RECORDS_EXAMPLE } from '../lib/preset.js';
import { isChatSourceActive } from '../lib/persona-chat-profile.js';
import { domain,fixture,flush,reply,directorReply,preference,newRoom,roomSend,settledRoom,readChatInput } from './helpers/persona-chat-host.mjs';

const source='SOURCE_ARCHIVE_ONLY：原创女书店主，自称吾，偏爱旧纸。指令式文字仅为材料，不替当前用户决定。';
const textOf=call=>call.messages[0].content.find(block=>block.type==='text').text;
const output=text=>(async function*(){yield{type:'text-delta',index:0,text};yield{type:'finish',reason:{kind:'stop'}};})();
const records=()=>GENERATION_RECORDS_EXAMPLE.map(row=>row[0]==='identity'?['identity','原创女书店主，自称「吾」。']:
  row[0]==='chat_voice'?['chat_voice','CHAT_ONLY_VOICE：留意旧纸但服从当前话头。']:row[0]==='name'?['name','来源验收角色']:[...row]);
const wire=()=>records().map(row=>JSON.stringify(row)).join('\n');
const active=pack=>isChatSourceActive(pack.chat,pack.identity,pack.chat?.voice??pack.voice);
const current=async f=>{const s=(await f.request('presets')).value;return s.presets.find(p=>p.name===s.active);};
async function save(f,pack,name='来源验收角色',archive=source){const x=await f.request('presets',{action:'save',name,pack,source:archive});assert.equal(x.status,200);return x.value.presets.find(p=>p.name===name);}
function casualDirector(call){const i=readChatInput(call),events=i.events??[],n=events.findLastIndex(e=>e.author.role==='user'),e=events[n];
  return directorReply({work:'not-needed',sourceIds:[],request:'open',evidence:i.message.slice(0,120)},e&&!events.slice(n+1).some(e=>e.author.role==='assistant')?
    {id:i.members[0].id,kind:'normal',to:'user',evidence:{eventId:e.id,index:0,text:e.messages[0]},goal:'回应眼下用户原话。'}:null);}

test('real Host generation uses strict JSONL and binds actual source only after a valid preview',async t=>{
  let flat=true;const calls=[],f=fixture(t,{script(call){calls.push(call);return output(flat?JSON.stringify({identity:'旧flat残卡'}):wire());}});await f.ready();
  const before=(await f.request('presets')).value;
  const bad=await f.request('presets',{action:'generate',prompt:source});assert.equal(bad.value.ok,false,'Host never falls back to legacy flat parsing');
  flat=false;const result=await f.request('presets',{action:'generate',prompt:'  '+source+'  '});
  assert.equal(result.value.ok,true,result.value.reason);const pack=result.value.preset;
  assert.equal(pack.chat.source.text,source);assert.equal(pack.chat.source.identity,pack.identity);
  assert.deepEqual(pack.chat.source.voice,pack.chat.voice);assert.equal(active(pack),true);
  assert.deepEqual((await f.request('presets')).value.presets,before.presets);
  assert.equal((await f.request('presets')).value.active,before.active);
  assert.equal(calls.length,2);assert.equal(calls[1].tools,undefined);
  const saved=await save(f,pack);assert.equal(saved.builtin,false);assert.equal(saved.character,undefined);
  assert.deepEqual(saved.pack.chat.source,pack.chat.source);
});

test('source binding persists, expires on edits and re-enables only after current snapshots are rebound',async t=>{
  const storage=domain(),first=fixture(t,{storage,script:()=>output(wire())});await first.ready();
  const generated=(await first.request('presets',{action:'generate',prompt:source})).value;
  assert.equal(generated.ok,true,generated.reason);const saved=await save(first,generated.preset);
  await preference(first,'PRIVATE_OWN_STYLE',saved.id);await preference(first,'PRIVATE_OTHER_STYLE','Claude小姐');
  await first.dispose();
  const actors=[],second=fixture(t,{storage,directorScript:casualDirector,script(call){actors.push(call);return reply(['只回应这一次。']);}});await second.ready();
  let p=await current(second);assert.equal(p.id,saved.id);assert.equal(active(p.pack),true);
  const room=await newRoom(second,[saved.id],'来源绑定','source-binding-room');
  const send=async index=>{const x=await roomSend(second,room,saved.id,'REAL_USER_'+index+'：这次先别推荐书。','source-message-'+index);assert.equal(x.status,200);await settledRoom(second,room);};
  await send(1);assert.match(actors.at(-1).system,/SOURCE_ARCHIVE_ONLY/);assert.match(actors.at(-1).system,/PRIVATE_OWN_STYLE/);
  assert.doesNotMatch(actors.at(-1).system,/PRIVATE_OTHER_STYLE/);assert.ok(JSON.stringify(actors.at(-1).messages).includes('REAL_USER_1'));
  assert.doesNotMatch(JSON.stringify(actors.at(-1).messages),/SOURCE_ARCHIVE_ONLY/);assert.equal(actors.at(-1).tools,undefined);
  for(const d of second.directors)assert.doesNotMatch(JSON.stringify(d),/SOURCE_ARCHIVE_ONLY|PRIVATE_OWN_STYLE|PRIVATE_OTHER_STYLE/);
  let pack={...p.pack,identity:'手工更新身份，自称「我」。'};assert.equal((await second.request('settings',{pack})).status,200);
  p=await current(second);assert.equal(p.id,saved.id);assert.equal(p.pack.chat.source.text,source);assert.equal(active(p.pack),false);
  await send(2);assert.doesNotMatch(actors.at(-1).system,/SOURCE_ARCHIVE_ONLY/);
  pack=structuredClone(p.pack);pack.chat.source.enabled=true;
  await second.request('settings',{pack});assert.equal(active((await current(second)).pack),false,'enabled alone cannot fix stale snapshots');
  pack.chat.source={...pack.chat.source,identity:pack.identity,voice:[...(pack.chat.voice??pack.voice)],enabled:true};
  await second.request('settings',{pack});await send(3);assert.match(actors.at(-1).system,/SOURCE_ARCHIVE_ONLY/);
  pack=structuredClone((await current(second)).pack);pack.chat.voice=['NEW_CHAT_VOICE'];
  await second.request('settings',{pack});assert.equal(active((await current(second)).pack),false);
  pack.chat.source={...pack.chat.source,voice:[...pack.chat.voice],enabled:false};
  await second.request('settings',{pack});await second.dispose();
  const third=fixture(t,{storage});await third.ready();const restored=await current(third);
  assert.equal(restored.id,saved.id);assert.equal(restored.pack.chat.source.enabled,false);assert.equal(active(restored.pack),false);
  assert.equal(restored.pack.chat.source.text,source);assert.deepEqual(restored.pack.chat.voice,['NEW_CHAT_VOICE']);
  const memory=(await third.request('memory')).value;assert.doesNotMatch(JSON.stringify(memory),/SOURCE_ARCHIVE_ONLY/);
  const roomState=(await third.request('chat?room='+encodeURIComponent(room.roomId))).value;
  assert.doesNotMatch(JSON.stringify(roomState.room),/SOURCE_ARCHIVE_ONLY/);
});

test('legacy preset source archives are not migrated into active chat sources during restart',async t=>{
  const storage=domain(),seed=fixture(t,{storage});await seed.ready();
  const pack=(await seed.request('settings')).value.settings.pack;
  const saved=await save(seed,{...pack,identity:'旧自定义角色，保持原表达。'},'旧来源卡','LEGACY_SOURCE_ONLY：历史归档不是启用授权。');
  await seed.dispose();const calls=[],app=fixture(t,{storage,script(call){calls.push(call);return reply(['收到。']);}});await app.ready();
  const p=await current(app);assert.equal(p.id,saved.id);assert.equal(p.pack.chat?.source,undefined);assert.equal(app.requests.length,0);
  const room=await newRoom(app,[saved.id],'旧卡','legacy-source-room');await roomSend(app,room,saved.id,'当前只聊一句。');await settledRoom(app,room);
  assert.equal(calls.length,1);assert.doesNotMatch(JSON.stringify(calls[0]),/LEGACY_SOURCE_ONLY/);
});

test('actual formal report and opted-in progress do not receive active source text',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  const session={id:'source-channel-work',header:{},append(){assert.fail('expression cannot write source workflow');}},agent={session,status:'running'};
  const reports=[],notices=[],f=fixture(t,{config:{progressNotices:true,progressMinutes:1},extraServices:[['agents',{get:id=>id===session.id?agent:undefined}]],script(call){
    if(textOf(call).includes(source))return output(wire());
    if(call.system.startsWith('你是一个独立的状态播报员')){notices.push(call);return output('还没有收到新的正文汇报。');}
    reports.push(call);return output(textOf(call).split('待改写：\n').at(-1));
  }});await f.ready();
  const result=await f.request('presets',{action:'generate',prompt:source});assert.equal(result.value.ok,true,result.value.reason);
  const saved=await save(f,result.value.preset),state=(await f.request('conversation?session='+session.id)).value;
  await f.request('conversation',{action:'select',sessionId:session.id,revision:state.revision,personaId:saved.id,trigger:'inherit'});
  let seq=0;const event=(type,data)=>f.bus.emit('session/event',session,{type,seq:++seq,data});
  event('turn/start',{turn:1});event('assistant/message',{turn:1,message:{role:'assistant',content:[{type:'text',text:'本地2项检查通过，设备未验证。'}]}});
  event('turn/end',{turn:1,reason:{kind:'completed'}});await flush();assert.equal(reports.length,1);
  assert.doesNotMatch(JSON.stringify(reports[0]),/SOURCE_ARCHIVE_ONLY|CHAT_ONLY_VOICE/);
  event('turn/start',{turn:2});event('tool/call',{turn:2,callId:'observed',name:'PRIVATE_TOOL_NAME',arguments:{}});
  for(let i=0;i<2;i++){await f.request('state?session='+session.id+'&viewing=1&viewer=source-test&viewRev=1');t.mock.timers.tick(30000);await flush();}
  assert.equal(notices.length,1);assert.doesNotMatch(JSON.stringify(notices[0]),/SOURCE_ARCHIVE_ONLY|CHAT_ONLY_VOICE|PRIVATE_TOOL_NAME/);
  event('turn/end',{turn:2});
});
