import test from 'node:test';
import assert from 'node:assert/strict';
import {domain,fixture,newRoom,roomSend,settledRoom,roomState,reply,flush,readChatInput} from './helpers/persona-chat-host.mjs';
import {makeAvatar} from './helpers/avatar-fixture.mjs';

const task=call=>{try{return readChatInput(call).task;}catch{return null;}};
const actors=f=>f.calls.filter(call=>task(call)==='chat-control');
const profile=async f=>(await f.request('chat-profile')).value;
const gender=async(f,userGender)=>f.request('chat-profile',{revision:(await profile(f)).revision,userGender});
const section=call=>{
  const match=call.system.match(/## 聊天性别与相处分寸\n([^\n]+)/u);
  assert.ok(match,'the actual actor request contains owner-controlled gender data');
  return JSON.parse(match[1]);
};
const output=text=>(async function*(){yield{type:'text-delta',index:0,text};yield{type:'finish',reason:{kind:'stop'}};})();
const textOf=call=>call.messages[0].content.find(block=>block.type==='text').text;
async function saveCustom(f,base,chat,name){
  const result=await f.request('presets',{action:'save',name,pack:{...base,identity:'独立守望器，自称本台。',...(chat?{chat}: {})}});
  assert.equal(result.status,200);
  return result.value.presets.find(p=>p.name===name);
}

test('owner gender is optional, authenticated, revision-checked and durable without changing address or avatar',async t=>{
  const storage=domain(),f=fixture(t,{storage});await f.ready();
  assert.equal((await profile(f)).userGender,'unset');
  assert.equal((await f.request('chat-profile',{revision:0,userGender:'male'},false)).status,403);
  assert.equal((await f.request('chat-profile',{revision:0,userGender:'guess-from-name'})).status,400);
  assert.equal((await profile(f)).revision,0);
  const first=await f.request('chat-profile',{revision:0,userGender:'male',userAddress:'不据名字猜性别',avatar:makeAvatar()});
  assert.equal(first.status,200);assert.equal(first.value.userGender,'male');
  const preserved={userAddress:first.value.userAddress,avatar:first.value.avatar,avatarMode:first.value.avatarMode};
  const changed=await gender(f,'female');assert.equal(changed.status,200);assert.equal(changed.value.revision,2);
  assert.deepEqual({userAddress:changed.value.userAddress,avatar:changed.value.avatar,avatarMode:changed.value.avatarMode},preserved);
  const stale=await f.request('chat-profile',{revision:1,userGender:'none'});
  assert.equal(stale.status,409);assert.equal(stale.value.state.userGender,'female');
  assert.equal((await profile(f)).revision,2);assert.equal(f.requests.length,0,'profile writes do not generate');
  await f.dispose();const reopened=fixture(t,{storage});await reopened.ready();
  assert.equal((await profile(reopened)).userGender,'female');assert.equal((await profile(reopened)).revision,2);
  assert.deepEqual({userAddress:(await profile(reopened)).userAddress,avatar:(await profile(reopened)).avatar,avatarMode:(await profile(reopened)).avatarMode},preserved);
  assert.equal((await gender(reopened,'unset')).status,200);assert.equal((await profile(reopened)).userGender,'unset');
  assert.equal(reopened.requests.length,0);
});

test('failed and conflicting gender saves cannot enter an actor request',async t=>{
  let fail=true;const storage=domain(Promise.resolve(),{fail:key=>fail&&key==='chatUserProfile'}),f=fixture(t,{storage});await f.ready();
  assert.equal((await gender(f,'male')).status,503);assert.equal((await profile(f)).userGender,'unset');
  const builtin=(await f.request('presets')).value.presets.find(p=>p.builtin);
  const room=await newRoom(f,[builtin.id],'资料边界','gender-save-failure');
  await roomSend(f,room,builtin.id,'先聊聊今天。','gender-unsaved');await settledRoom(f,room);
  assert.deepEqual(section(actors(f).at(-1)),{userGender:'unset',personaGender:'female'});
  fail=false;assert.equal((await gender(f,'male')).status,200);
  assert.equal((await f.request('chat-profile',{revision:0,userGender:'female'})).status,409);
  await roomSend(f,room,builtin.id,'我想安静待一会儿。','gender-confirmed');await settledRoom(f,room);
  assert.deepEqual(section(actors(f).at(-1)),{userGender:'male',personaGender:'female'});
  assert.match(actors(f).at(-1).system,/不主动发起对用户的肢体接触/);
  assert.match(actors(f).at(-1).system,/用户主动明确邀请时可以直接应邀/);
});

test('all trusted builtins are female while custom none and missing gender remain independent after restart',async t=>{
  const storage=domain(),f=fixture(t,{storage});await f.ready();await gender(f,'male');
  const catalog=(await f.request('presets')).value.presets,builtins=catalog.filter(p=>p.builtin);
  assert.equal(builtins.length,5);
  for(const [index,p] of builtins.entries()){
    const room=await newRoom(f,[p.id],'内置性别'+index,'gender-builtin-'+index);
    await roomSend(f,room,p.id,'说说你的看法。','gender-builtin-message-'+index);await settledRoom(f,room);
    assert.deepEqual(section(actors(f).at(-1)),{userGender:'male',personaGender:'female'});
  }
  const none=await saveCustom(f,builtins[0].pack,{gender:'none',voice:['保持守望器的措辞。'],samples:[]},'无性别守望器');
  const missing=await saveCustom(f,builtins[0].pack,undefined,'未指定守望器');
  assert.equal(none.builtin,false);assert.equal(none.character,undefined);assert.equal(missing.pack.chat,undefined);
  await f.dispose();const reopened=fixture(t,{storage});await reopened.ready();
  const restored=(await reopened.request('presets')).value.presets;
  assert.equal(restored.find(p=>p.id===none.id).pack.chat.gender,'none');assert.equal(restored.find(p=>p.id===missing.id).pack.chat,undefined);
  for(const [p,expected] of [[none,'none'],[missing,'unset']]){
    const room=await newRoom(reopened,[p.id],'自定义'+expected,'gender-custom-'+expected);
    await roomSend(reopened,room,p.id,'先聊一句。','gender-custom-message-'+expected);await settledRoom(reopened,room);
    const call=actors(reopened).at(-1);assert.deepEqual(section(call),{userGender:'male',personaGender:expected});
    if(expected==='none')assert.doesNotMatch(call.system,/用户设置为男性，你是女性：/);
  }
});

test('confirmed changes apply to the next actor request without rewriting or aborting an in-flight turn',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());let first=true;
  const f=fixture(t,{script:()=>first?(first=false,(async function*(){await gate;yield*reply(['这轮先说到这里。']);})()):reply(['接着聊。'])});await f.ready();
  const builtin=(await f.request('presets')).value.presets.find(p=>p.builtin);await gender(f,'male');
  const room=await newRoom(f,[builtin.id],'正在生成','gender-in-flight');
  await roomSend(f,room,builtin.id,'先聊一句。','gender-before');await flush();const supplied=actors(f)[0];
  assert.deepEqual(section(supplied),{userGender:'male',personaGender:'female'});
  await gender(f,'female');assert.equal(supplied.signal.aborted,false);assert.equal(section(supplied).userGender,'male');
  release();await settledRoom(f,room);await roomSend(f,room,builtin.id,'我想抱抱。','gender-after');await settledRoom(f,room);
  const next=actors(f).at(-1);assert.deepEqual(section(next),{userGender:'female',personaGender:'female'});
  assert.match(next.system,/同为女性也不代表用户已同意任何接触/);
  assert.ok(JSON.stringify(next.messages).includes('我想抱抱。'),'the actual invitation stays a user message');
  const state=await roomState(f,room);assert.equal(state.room.turns.find(turn=>turn.phase==='anchor').speakerName,'我');
});

test('gender metadata reaches only the actor, not the shared director, formal reports, history or memory',async t=>{
  const session={id:'gender-isolation-work',header:{},append(){assert.fail('chat metadata cannot write work history');}},agent={session,status:'running'};
  const reports=[],notices=[],f=fixture(t,{config:{progressNotices:true,progressMinutes:1},extraServices:[['agents',{get:id=>id===session.id?agent:undefined}]],script(call){
    if(task(call)==='chat-control')return reply(['现在只聊眼前这一句。']);
    if(call.system.startsWith('你是一个独立的状态播报员')){notices.push(call);return output('还没有收到新的正文汇报。');}
    reports.push(call);return output(textOf(call).split('待改写：\n').at(-1));
  }});await f.ready();const before=(await f.request('memory')).value.entries;await gender(f,'male');
  const builtin=(await f.request('presets')).value.presets.find(p=>p.builtin),custom=await saveCustom(f,builtin.pack,{gender:'none',voice:['只保留自己的表达。'],samples:[]},'渠道隔离守望器');
  const room=await newRoom(f,[custom.id],'只读资料','gender-isolation-room');
  await roomSend(f,room,custom.id,'今天想谈谈下雨。','gender-isolation-message');const state=await settledRoom(f,room);
  assert.deepEqual(section(actors(f).at(-1)),{userGender:'male',personaGender:'none'});
  assert.ok(f.directors.length>0);
  for(const call of f.directors)assert.doesNotMatch(JSON.stringify(call),/"userGender"|"personaGender"|聊天性别与相处分寸/);
  assert.doesNotMatch(JSON.stringify(state.room),/"userGender"|"personaGender"|聊天性别与相处分寸/);
  const conversation=(await f.request('conversation?session='+session.id)).value;
  await f.request('conversation',{action:'select',sessionId:session.id,revision:conversation.revision,personaId:custom.id,trigger:'inherit'});
  let seq=0;const event=(type,data)=>f.bus.emit('session/event',session,{type,seq:++seq,data});
  event('turn/start',{turn:1});event('assistant/message',{turn:1,message:{role:'assistant',content:[{type:'text',text:'本地2项检查通过，设备尚未验证。'}]}});
  event('turn/end',{turn:1,reason:{kind:'completed'}});await flush();assert.equal(reports.length,1);
  for(const call of reports)assert.doesNotMatch(JSON.stringify(call),/"userGender"|"personaGender"|聊天性别与相处分寸/);
  assert.equal(notices.length,0);assert.deepEqual((await f.request('memory')).value.entries,before);
});

test('opted-in progress receives neither user gender nor the optional chat persona gender',async t=>{
  // Progress uses a controlled clock in its own Host; the room scheduler keeps
  // its real-clock lifecycle in the preceding tests.
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  const session={id:'gender-progress-work',header:{},append(){assert.fail('progress cannot write source history');}},agent={session,status:'running'};
  const notices=[],f=fixture(t,{config:{progressNotices:true,progressMinutes:1},extraServices:[['agents',{get:id=>id===session.id?agent:undefined}]],script(call){
    notices.push(call);return output('还没有收到新的正文汇报。');
  }});await f.ready();await gender(f,'male');
  const base=(await f.request('presets')).value.presets.find(p=>p.builtin).pack;
  const custom=await saveCustom(f,base,{gender:'none',voice:['聊天独有取舍。'],samples:[]},'进度隔离守望器');
  const state=(await f.request('conversation?session='+session.id)).value;
  assert.equal((await f.request('conversation',{action:'select',sessionId:session.id,revision:state.revision,personaId:custom.id,trigger:'inherit'})).status,200);
  const before=(await f.request('memory')).value.entries;let seq=0;
  const event=(type,data)=>f.bus.emit('session/event',session,{type,seq:++seq,data});
  event('turn/start',{turn:1});event('tool/call',{turn:1,callId:'observed',name:'PRIVATE_TOOL_NAME',arguments:{}});
  for(let i=0;i<2;i++){await f.request('state?session='+session.id+'&viewing=1&viewer=gender-progress-test&viewRev=1');t.mock.timers.tick(30000);await flush();}
  assert.equal(notices.length,1);assert.match(notices[0].system,/你是一个独立的状态播报员/);
  assert.doesNotMatch(JSON.stringify(notices[0]),/"userGender"|"personaGender"|聊天性别与相处分寸|聊天独有取舍|PRIVATE_TOOL_NAME/);
  assert.deepEqual((await f.request('memory')).value.entries,before);event('turn/end',{turn:1});await flush();
});
