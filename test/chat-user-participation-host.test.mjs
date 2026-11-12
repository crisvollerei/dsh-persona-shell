import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,reply,newRoom,roomSend,roomState,settledRoom,flush,whale,dragon,claude,readChatInput} from './helpers/persona-chat-host.mjs';

const wire=text=>(async function*(){yield{type:'text-delta',text};yield{type:'finish',reason:{kind:'stop'}};})();
const speech=body=>body.events.filter(event=>event.author.role==='assistant');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,reason,timeoutMs=15000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){await flush();const value=await read();if(predicate(value))return value;await sleep(10);}
  assert.fail(reason);
}
async function targets(f,room,ids){
  const state=await roomState(f,room);
  assert.equal((await f.request('chat-rooms',{...room,action:'update',targetPersonaIds:ids,
    configRevision:state.room.configRevision,epoch:state.epoch})).status,200);
}
function choose(body,id,relation='fresh',point='回应本人收到的这次邀请。'){
  const option=body.choices.find(value=>value.id===id&&value.kind==='normal'&&value.to==='user');
  const scene=body.sceneCatalog.options.find(value=>value.key==='K')
    ??body.sceneCatalog.options.find(value=>value.relation===relation);
  assert.ok(option,'the fixture selects a current legal user invitation');
  assert.ok(scene,'the fixture selects a current public scene relation');
  return wire(`${option.choiceId} N ${scene.key} react | ${point}`);
}

test('a real Host WAIT remains stopped after another selected member five-second cooldown expires',async t=>{
  const f=fixture(t,{runtime:{chatIntervalMs:5000},directorScript:()=>wire('WAIT')});
  await f.ready();const room=await newRoom(f,[whale,dragon],'先等用户','participation-wait');await targets(f,room,[whale,dragon]);
  assert.equal((await roomSend(f,room,whale,'我还在想，先别替我选。','wait-for-user')).status,200);
  const done=await settledRoom(f,room),first=readChatInput(f.directors[0]);
  assert.equal(done.running,false);assert.equal(done.directorFailure,null);
  assert.deepEqual(first.states.map(value=>[value.id,value.level,value.normalRemaining,value.normalReady]),[
    [whale,0,3,true],[dragon,1,2,false],
  ]);
  const requests=f.requests.length;
  await sleep(5200);await flush();
  const later=await roomState(f,room);
  assert.equal(later.running,false);assert.equal(f.requests.length,requests,'cooldown expiry cannot reopen an explicit WAIT');
  assert.equal(f.directors.length,1);assert.equal(f.calls.length,0);
  assert.deepEqual(later.room.turns.map(value=>[value.phase,value.user]),[['anchor','我还在想，先别替我选。']]);
});

test('IDLE preserves a personally invited member until her real cooldown, with unchanged five-person grades and budgets',async t=>{
  const members=[whale,dragon,claude,'鲸鲸（实验性）','Gemini'],snapshots=[];
  const f=fixture(t,{runtime:{chatIntervalMs:5000},directorScript:options=>{
    const body=readChatInput(options);snapshots.push({at:Date.now(),body});
    if(speech(body).length)return wire('WAIT');
    if(!body.choices.some(value=>value.id===dragon&&value.kind==='normal'&&value.to==='user'))return wire('IDLE');
    return choose(body,dragon);
  },script:()=>reply(['我也在。'])});
  await f.ready();const room=await newRoom(f,members,'到自己时应邀','participation-idle');await targets(f,room,[whale,dragon]);
  assert.equal((await roomSend(f,room,whale,'鲸鲸、GPT，都抱抱。','idle-invitation')).status,200);
  const done=await until(()=>roomState(f,room),value=>!value.running,'an IDLE invitation should complete at the real director cadence');
  assert.equal(done.directorFailure,null);assert.equal(f.calls.length,1);assert.equal(snapshots.length,3);
  const initial=snapshots[0].body,eligible=snapshots[1].body,after=snapshots[2].body;
  assert.deepEqual(initial.states.map(value=>[value.id,value.level,value.normalRemaining,value.peerRemaining]),[
    [whale,0,3,1],[dragon,1,2,1],[claude,2,1,1],['鲸鲸（实验性）',2,1,1],['Gemini',2,1,1],
  ]);
  assert.equal(initial.states.find(value=>value.id===dragon).normalReady,false);
  assert.equal(eligible.states.find(value=>value.id===dragon).normalReady,true);
  assert.ok(snapshots[1].at-snapshots[0].at>=5000,'IDLE does not bypass the five-second eligibility/director interval');
  const actor=readChatInput(f.calls[0]);
  assert.equal(actor.speaker.id,dragon);assert.equal(actor.message,'鲸鲸、GPT，都抱抱。');
  assert.deepEqual(actor.replyTarget,{author:{role:'user',name:'我'},text:'鲸鲸、GPT，都抱抱。'});
  assert.equal(actor.opportunity.kind,'normal');assert.equal(actor.opportunity.normalRemainingAfterThis,1);
  assert.equal(actor.opportunity.peerRemainingAfterThis,1);
  assert.deepEqual(after.states.map(value=>[value.id,value.level,value.normalRemaining,value.peerRemaining]),[
    [whale,0,3,1],[dragon,2,1,1],[claude,2,1,1],['鲸鲸（实验性）',2,1,1],['Gemini',2,1,1],
  ]);
  assert.deepEqual(done.room.turns.filter(value=>value.phase!=='anchor').map(value=>value.recipientId),[dragon],
    'unused eligibility does not mechanically dispatch the other four members');
});

test('a committed first invitation reply and its invented user satisfaction remain assistant evidence until real user feedback arrives',async t=>{
  // The deliberately wrong first text is a provenance fixture. This test does
  // not claim that prompting prevents the model from generating that mistake.
  const seed='先聊桌上的草图。',invitation='先不聊草图了，鲸鲸和 GPT，都抱抱。';
  const claim='你已经满意了。',feedback='我还没满意，先别替我说。GPT，接着说你自己的想法。';
  const f=fixture(t,{directorScript:options=>{
    const body=readChatInput(options),said=speech(body);
    if(body.message===seed)return said.length?wire('WAIT'):choose(body,whale);
    if(body.message===feedback){
      assert.equal(body.quotedMessage.author.role,'assistant');assert.equal(body.quotedMessage.author.id,whale);
      assert.equal(body.quotedMessage.text,claim);
      assert.equal(body.events.filter(value=>value.author.role==='user').length,1);
      assert.deepEqual(body.events.find(value=>value.author.role==='user').messages,[feedback]);
      return said.length?wire('WAIT'):choose(body,dragon,'continue','接用户真正补充的意见，再说自己的想法。');
    }
    assert.equal(body.message,invitation);
    assert.deepEqual(body.events.find(value=>value.author.role==='user').messages,[invitation]);
    assert.ok(body.events.filter(value=>value.author.role==='user').every(value=>!value.messages.includes(claim)));
    if(said.length===1){assert.equal(said[0].author.id,whale);assert.ok(said[0].messages.includes(claim));}
    return said.length===2?wire('WAIT'):choose(body,said.length?dragon:whale,'pause');
  },script:options=>{
    const body=readChatInput(options);
    if(body.message===seed)return reply(['草图先留在桌上。']);
    if(body.message===feedback)return reply(['我先坐你旁边。']);
    return body.speaker.id===whale?reply(['（张开手。）',claim]):reply(['我也在。']);
  }});
  await f.ready();const room=await newRoom(f,[whale,dragon],'邀请与用户反馈','participation-evidence');
  assert.equal((await roomSend(f,room,whale,seed,'participation-seed')).status,200);await settledRoom(f,room);
  await targets(f,room,[whale,dragon]);
  assert.equal((await roomSend(f,room,whale,invitation,'participation-invitation')).status,200);
  let done=await settledRoom(f,room);assert.equal(done.directorFailure,null);
  const actors=f.calls.filter(options=>readChatInput(options).message===invitation),second=readChatInput(actors[1]);
  assert.deepEqual(actors.map(options=>readChatInput(options).speaker.id),[whale,dragon]);
  assert.ok(second.conversationScene.transition.reply,'the first committed reply has a public transition pointer');
  assert.equal(second.message,invitation);assert.deepEqual(second.replyTarget,{author:{role:'user',name:'我'},text:invitation});
  const userText=[...second.__events.values()].filter(value=>value.author.role==='user').flatMap(value=>value.messages);
  assert.ok(userText.includes(invitation));assert.ok(!userText.includes(claim),'a role declaration cannot be relabelled as user-authored feedback');
  assert.ok([...second.__events.values()].some(value=>value.author.role==='assistant'&&value.author.id===whale&&value.messages.includes(claim)));
  assert.deepEqual(done.room.turns.filter(value=>value.phase==='anchor').map(value=>value.user),[seed,invitation]);
  const first=done.room.turns.find(value=>value.messageId==='participation-invitation'&&value.recipientId===whale);
  await targets(f,room,[dragon]);const state=await roomState(f,room);
  assert.equal((await f.request('chat',{...room,action:'send',personaId:dragon,content:feedback,requestId:'participation-feedback',
    quote:{roomId:room.roomId,generation:state.room.generation??0,kind:'assistant',turnId:first.id,attemptId:first.attemptId,index:1},
    revision:state.room.revision,epoch:state.epoch})).status,200);
  done=await settledRoom(f,room);assert.equal(done.directorFailure,null);
  const resumed=readChatInput(f.calls.at(-1));
  assert.equal(resumed.speaker.id,dragon);assert.equal(resumed.message,feedback);
  assert.deepEqual(resumed.replyTarget,{author:{role:'user',name:'我'},text:feedback});
  assert.equal(resumed.quotedMessage.author.role,'assistant');assert.equal(resumed.quotedMessage.author.id,whale);
  assert.equal(resumed.quotedMessage.text,claim);
  assert.deepEqual(done.room.turns.filter(value=>value.phase==='anchor').map(value=>value.user),[seed,invitation,feedback]);
  assert.equal(resumed.opportunity.normalRemainingAfterThis,2,'only the real new user input refreshes the selected member cycle');
});
