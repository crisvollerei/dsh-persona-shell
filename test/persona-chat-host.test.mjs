import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAvatar } from './helpers/avatar-fixture.mjs';
import { flush, whale, dragon, claude, reply, directorReply, domain, fixture, preference, newRoom, roomSend, roomState, settledRoom } from './helpers/persona-chat-host.mjs';


// Native director fixtures select from actual public events; no legacy plan DTOs.
const directorInput = options => readChatInput(options);
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

function publicCast(options) {
  const line=options.system.split('\n').find(value=>value.startsWith('{"self":')&&value.includes('"relationships":'));
  assert.ok(line,'the Host supplies a structured public character context');return JSON.parse(line);
}

test('builtin chat speakers receive female identities and directed names without rewriting erroneous historical dialogue',async t=>{
  const wrong='龙哥那句先记下。';const f=fixture(t,{script:()=>reply([wrong])});await f.ready();
  await preference(f,'FISH_RELATION_PRIVATE');await preference(f,'DRAGON_RELATION_PRIVATE',dragon);
  await preference(f,'说话时喜欢把大肥龙称作龙哥');
  const binding=await newRoom(f);await roomSend(f,binding,whale,'先聊一句','relation-history');await settledRoom(f,binding);
  const before=await roomState(f,binding);
  assert.equal((await f.request('chat-rooms',{action:'update',roomId:binding.roomId,configRevision:before.room.configRevision,
    epoch:before.epoch,targetPersonaIds:[whale,dragon]})).status,200);
  await roomSend(f,binding,whale,'GPT 是女性，别把历史误称当设定','relation-current');await settledRoom(f,binding);
  const [fishCall,dragonCall]=f.calls.slice(-2),fishCast=publicCast(fishCall),dragonCast=publicCast(dragonCall);
  assert.equal(fishCast.self.id,whale);assert.equal(dragonCast.self.id,dragon);
  assert.ok(fishCast.members.every(person=>person.gender==='female'&&person.pronoun==='她'));
  assert.deepEqual(fishCast.relationships.map(edge=>[edge.from,edge.to,edge.address]),[[whale,dragon,'GPT']]);
  assert.deepEqual(dragonCast.relationships.map(edge=>[edge.from,edge.to,edge.address]),[[dragon,whale,'鲸鲸']]);
  assert.match(fishCall.system,/身份和相互称呼依此处，不随历史误称或玩笑改变/);
  assert.doesNotMatch(fishCall.system,/DRAGON_RELATION_PRIVATE/);assert.doesNotMatch(dragonCall.system,/FISH_RELATION_PRIVATE/);
  for(const call of [fishCall,dragonCall]){
    const input=readChatInput(call);assert.equal(input.history[0].assistant[0],wrong);
  }
  assert.deepEqual((await roomState(f,binding)).room.turns.filter(turn => turn.phase !== 'anchor')[0].assistant,[wrong],'raw history is evidence, not silently rewritten canon');
});

test('one listener decision sees public builtin gender and relations while keeping candidate summaries and work data separate',async t=>{
  const work='WORK_BODY_NOT_FOR_CAST_OR_JUDGE',project={id:'role-project',path:'D:/work/CharacterRoom',sessionIds:['work']};
  const f=fixture(t,{directorScript:directorOrder([whale,'Gemini']),extraServices:[['workspaceRegistry',{list:()=>[project]}],['sessions',{get:id=>({header:{id,cwd:project.path}})}],
    ['sessionQuery',{observeSession:async()=>({events:[{seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:work}]}}}],
      [Symbol.dispose](){}})}]]});await f.ready();
  await preference(f,'FISH_JUDGE_PRIVATE');await preference(f,'DRAGON_JUDGE_PRIVATE',dragon);await preference(f,'CLAUDE_JUDGE_PRIVATE',claude);
  const binding=await newRoom(f,[whale,dragon,claude,'Gemini']);await roomSend(f,binding,whale,'大家怎么称呼彼此','relation-judge');await settledRoom(f,binding);
  assert.equal(f.directors.length,3);assert.equal(f.plans.length+f.continuations.length,0);assert.equal(f.calls.length,2);
  assert.match(JSON.stringify(f.calls[0].messages),new RegExp(work),'the primary genuinely had an explicit raw source');
  const judge=f.directors[0],cast=publicCast(judge),input=readChatInput(judge);
  assert.equal(cast.self,null);assert.equal(cast.members.length,4);assert.equal(cast.relationships.length,12);
  assert.ok(cast.members.every(person=>person.gender==='female'));
  assert.ok(cast.relationships.some(edge=>edge.from===claude&&edge.to===dragon&&edge.address==='GPT'));
  assert.ok(cast.relationships.some(edge=>edge.from===dragon&&edge.to==='Gemini'&&edge.address==='猫猫'));
  assert.deepEqual(input.members.map(person=>person.id),[whale,dragon,claude,'Gemini']);
  assert.ok(input.members.every(person=>Object.keys(person).every(key=>['id','identity','name','voice','preferredAddress'].includes(key))));
  assert.equal(input.events.length,1);assert.equal(input.events[0].author.role,'user','the first native judgement sees only actual prior public events');
  assert.equal(input.workContext,undefined);assert.equal(input.memory,undefined);
  assert.doesNotMatch(judge.system+JSON.stringify(input),/FISH_JUDGE_PRIVATE|DRAGON_JUDGE_PRIVATE|CLAUDE_JUDGE_PRIVATE|WORK_BODY_NOT_FOR_CAST_OR_JUDGE/);
  const cat = publicCast(f.calls[1]);
  assert.equal(cat.self.id, 'Gemini'); assert.deepEqual(cat.self.preferredAddress, ['猫猫']);
  assert.equal(cat.relationships.find(r => r.to === dragon).address, 'GPT');
  assert.doesNotMatch(f.calls[1].system, /FISH_JUDGE_PRIVATE|DRAGON_JUDGE_PRIVATE|CLAUDE_JUDGE_PRIVATE/);
});

test('the two builtin whale speakers keep distinct room identities and separate the working assistant sister from room companions',async t=>{
  const experiment='鲸鲸（实验性）',f=fixture(t);await f.ready();const binding=await newRoom(f,[whale,experiment]);
  const state=await roomState(f,binding);await f.request('chat-rooms',{action:'update',roomId:binding.roomId,configRevision:state.room.configRevision,
    epoch:state.epoch,targetPersonaIds:[whale,experiment]});
  await roomSend(f,binding,whale,'两位鲸鲸分别说一句','two-whales');await settledRoom(f,binding);
  assert.equal(f.calls.length,2);assert.equal(f.directors.length,3);assert.equal(f.plans.length+f.continuations.length,0);
  const first=publicCast(f.calls[0]),second=publicCast(f.calls[1]);
  assert.equal(first.self.id,whale);assert.equal(first.self.kind,'whale-maid');
  assert.equal(second.self.id,experiment);assert.equal(second.self.name,'小肥鱼（实验性）');
  assert.ok(second.self.selfReference.includes('小肥鱼'));assert.equal(second.self.kind,'chibi-whale-maid');
  assert.equal(first.relationships[0].to,experiment);assert.equal(first.relationships[0].address,'小肥鱼');
  assert.equal(second.relationships[0].to,whale);assert.equal(second.relationships[0].address,'姐姐');
  assert.match(f.calls[1].system,/本人聊天[^\n]*正式工作转述由另一渠道承载/);
  assert.match(f.calls[1].system,/保持原话作者与事实归属/);
  assert.doesNotMatch(f.calls[1].system,/龙哥|龙姐|Claude小姐/);
  assert.match(f.calls[1].system,/大肥鱼是(?:自己的)?亲姐姐/);
  assert.deepEqual((await roomState(f,binding)).room.turns.filter(turn => turn.phase !== 'anchor').map(turn=>turn.recipientId),[whale,experiment]);
});

test('a solo relay can identify her big sister without reading that persona’s memory or adding her to the conversation',async t=>{
  const small = '鲸鲸（实验性）', f=fixture(t); await f.ready(); await preference(f,'OLDER_SISTER_PRIVATE',whale);
  const room=await newRoom(f,[small]); await roomSend(f,room,small,'你姐姐是谁？'); await settledRoom(f,room);
  assert.equal(f.calls.length,1);assert.equal(f.directors.length,1);assert.equal(f.plans.length+f.continuations.length,0);
  const call=f.calls[0], cast=publicCast(call), input=readChatInput(call);
  assert.deepEqual(input.participants.map(p=>p.id),[small]); assert.deepEqual(cast.relationships,[]);
  assert.match(call.system,/大肥鱼是(?:自己的)?亲姐姐/); assert.match(call.system,/本人聊天[^\n]*正式工作转述由另一渠道承载/);
  assert.doesNotMatch(call.system+JSON.stringify(input),/OLDER_SISTER_PRIVATE/);
});

test('avatar forks keep their copied voice card but never inherit builtin character DTOs or room self identities',async t=>{
  const f=fixture(t);await f.ready();const before=(await f.request('presets')).value.presets,builtin=before.find(person=>person.id===whale);
  assert.equal(builtin.character.id,whale);assert.equal(builtin.character.gender,'female');assert.equal(builtin.character.relations.length,4);
  const changed=await f.request('presets',{action:'avatar',id:whale,requestId:'relation-fork-avatar',expectedAvatar:builtin.avatar,avatar:makeAvatar()});
  assert.equal(changed.status,200);const fork=changed.value.presets.find(person=>!person.builtin);
  assert.ok(fork);assert.notEqual(fork.id,whale);assert.deepEqual(fork.pack,builtin.pack);assert.equal(fork.character,undefined);
  assert.equal(changed.value.presets.find(person=>person.id===whale).character.gender,'female');
  const binding=await newRoom(f,[fork.id,dragon],'自定义关系隔离','fork-relations');
  await roomSend(f,binding,fork.id,'按我的角色卡说话','fork-speaks');await settledRoom(f,binding);
  const cast=publicCast(f.calls[0]);assert.equal(cast.self,null);assert.deepEqual(cast.members.map(person=>person.id),[dragon]);
  assert.deepEqual(cast.relationships,[]);assert.match(f.calls[0].system,/self=null 的自定义角色不继承内置关系/);
  await f.dispose();const next=fixture(t,{storage:f.storage});await next.ready();
  const restored=(await next.request('presets')).value.presets.find(person=>person.id===fork.id);
  assert.equal(restored.character,undefined);assert.deepEqual(restored.pack,fork.pack);
});

test('an avatar copy of the experimental relay keeps its voice and worker attribution without claiming the original social identity',async t=>{
  const f=fixture(t);await f.ready();
  const source=(await f.request('presets')).value.presets.find(p=>p.id==='鲸鲸（实验性）');
  const saved=await f.request('presets',{action:'avatar',id:source.id,requestId:'relay-fork',expectedAvatar:source.avatar,avatar:makeAvatar()});
  assert.equal(saved.status,200);
  const fork=saved.value.presets.find(p=>p.avatarParentId===source.id)??saved.value.presets.find(p=>!p.builtin);
  assert.ok(fork);assert.notEqual(fork.id,source.id);
  assert.equal((await f.request('presets',{action:'rename',id:fork.id,name:'潮声'})).status,200);
  const room=await newRoom(f,[fork.id,whale],'副本和内置大肥鱼');
  await roomSend(f,room,fork.id);await settledRoom(f,room);
  const call=f.calls[0],cast=publicCast(call);
  assert.equal(readChatInput(call).speaker.name,'潮声');
  assert.equal(cast.self,null);assert.deepEqual(cast.relationships,[]);
  assert.deepEqual(cast.members.map(p=>p.id),[whale]);
  assert.match(call.system,/自称「小肥鱼」/);assert.match(call.system,/姐姐.*原本的助手/);
  assert.doesNotMatch(call.system,/鲸鲸（实验性）|亲姐妹|亲妹妹|亲姐姐|大肥鱼是姐姐，小肥鱼是妹妹|龙哥|Claude小姐|猫猫/);
});

test('selected personas cooperate through public same-round messages while keeping private memory isolated',async t=>{
  let dragonCalls=0;const f=fixture(t,{script:options=>{
    const input=readChatInput(options);
    return input.speaker.id===dragon?reply(['龙的回复'],++dragonCalls===1?'max-tokens':'stop'):reply(['鲸的回复']);
  }});await f.ready();await preference(f,'WHALE_ONLY');await preference(f,'DRAGON_ONLY',dragon);
  const binding=await newRoom(f),selection=await f.request('chat-rooms',{action:'update',roomId:binding.roomId,configRevision:0,epoch:0,targetPersonaIds:[whale,dragon]});
  assert.equal(selection.status,200);assert.equal(f.calls.length,0);
  const sent=await roomSend(f,binding,whale,'你们怎么看','both');assert.equal(sent.status,200);await flush();
  assert.equal(f.calls.length,2);const inputs=f.calls.map(c=>readChatInput(c));
  assert.ok(inputs.every(p=>p.history.length===0),'the same-round exchange is separate from prior user messages');
  assert.deepEqual(inputs[0].exchange,[]);
  assert.deepEqual(inputs[1].exchange,[{speaker:{id:whale,name:whale},messages:['鲸的回复']}]);
  assert.doesNotMatch(JSON.stringify(inputs[1]),/WHALE_ONLY/,'cooperation shares the public words, never another persona private context');
  assert.match(f.calls[0].system,/WHALE_ONLY/);assert.doesNotMatch(f.calls[0].system,/DRAGON_ONLY/);
  assert.match(f.calls[1].system,/DRAGON_ONLY/);assert.doesNotMatch(f.calls[1].system,/WHALE_ONLY/);
  let state=(await f.request('chat?room='+encodeURIComponent(binding.roomId))).value;
  const first=state.room.turns.filter(turn => turn.phase !== 'anchor')[0],failed=state.room.turns.filter(turn => turn.phase !== 'anchor')[1];assert.equal(first.messageId,failed.messageId);
  assert.equal(first.status,'ready');assert.equal(failed.status,'failed');assert.equal(state.rooms[0].turnCount,1);
  const duplicate=await f.request('chat',{action:'send',...binding,personaId:whale,requestId:'both',content:'你们怎么看',revision:1,epoch:0});
  assert.equal(duplicate.status,200);assert.equal(f.calls.length,2);
  assert.equal((await f.request('chat',{action:'retry',...binding,personaId:whale,id:failed.id,attemptId:'retry-only-dragon',revision:state.room.revision,epoch:0})).status,200);
  await flush();assert.equal(f.calls.length,3);assert.equal(readChatInput(f.calls[2]).speaker.id,dragon);
  state=(await f.request('chat?room='+encodeURIComponent(binding.roomId))).value;
  assert.deepEqual(state.room.turns.filter(turn => turn.phase !== 'anchor').map(t=>t.status),['ready','ready']);assert.deepEqual(state.room.turns.filter(turn => turn.phase !== 'anchor')[0].assistant,['鲸的回复']);
  await roomSend(f,binding,whale,'接着聊','both-next');await flush();
  const next=readChatInput(f.calls[3]);assert.equal(next.history.length,1);assert.equal(next.history[0].responses.length,2);
});

test('primary speakers start in order; removing the active one lets the next speak, and stop retires the round',async t=>{
  const releases=[];const f=fixture(t,{script:options=>(async function*(){await new Promise(r=>releases.push(r));yield* reply(['LATE']);})()});
  t.after(()=>releases.forEach(r=>r()));await f.ready();const binding=await newRoom(f);
  await f.request('chat-rooms',{action:'update',roomId:binding.roomId,configRevision:0,epoch:0,targetPersonaIds:[whale,dragon]});
  await roomSend(f,binding);await flush();assert.equal(f.calls.length,1,'the second selected persona waits for the first');
  let state=(await f.request('chat?room='+encodeURIComponent(binding.roomId))).value;
  assert.deepEqual(state.activeAttemptIds,[state.room.turns.filter(turn => turn.phase !== 'anchor')[0].attemptId]);
  await f.request('chat-rooms',{action:'update',roomId:binding.roomId,configRevision:1,epoch:0,memberIds:[dragon]});await flush();
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.calls[1].signal.aborted,false);
  state=(await f.request('chat?room='+encodeURIComponent(binding.roomId))).value;assert.equal(state.running,true);
  const pending=state.room.turns.filter(turn => turn.phase !== 'anchor').find(t=>t.status==='pending');
  await f.request('chat',{action:'cancel',...binding,personaId:dragon,id:pending.id,attemptId:pending.attemptId,messageId:pending.messageId,roundId:state.roundId,epoch:0});
  await flush();assert.ok(f.calls.every(c=>c.signal.aborted));releases.forEach(r=>r());await flush();
  state=(await f.request('chat?room='+encodeURIComponent(binding.roomId))).value;
  assert.deepEqual(state.room.turns.filter(turn => turn.phase !== 'anchor').map(t=>t.status),['cancelled','cancelled']);assert.ok(state.room.turns.filter(turn => turn.phase !== 'anchor').every(t=>t.assistant.length===0));
});

test('the native director may choose an unselected member without reading private memory or raw work bodies',async t=>{
  const f=fixture(t,{directorScript:directorOrder([whale,dragon]),config:{chatThinking:true},
    modelInfo:async()=>({reasoning:{efforts:[{id:'off'},{id:'low'},{id:'high'}],defaultEffort:'low'}})});
  await f.ready();await preference(f,'PRIMARY_PRIVATE_MEMORY');await preference(f,'LISTENER_PRIVATE_MEMORY',dragon);
  const binding=await newRoom(f);assert.equal(f.directors.length,0);await roomSend(f,binding,whale,'你们对这件事有什么看法');const state=await settledRoom(f,binding);
  assert.equal(f.directors.length,3);assert.equal(f.calls.length,2);assert.equal(f.plans.length+f.continuations.length,0);
  assert.deepEqual(state.room.turns.filter(turn=>turn.phase!=='anchor').map(turn=>[turn.recipientId,turn.responsePlan.kind,turn.status]),[[whale,'normal','ready'],[dragon,'normal','ready']]);
  const decision=f.directors[0],input=directorInput(decision);assert.equal(decision.maxTokens,2048);assert.equal(decision.reasoningEffort,'off');assert.equal(f.calls[0].reasoningEffort,'low');
  assert.equal(input.message,'你们对这件事有什么看法');assert.deepEqual(input.members.map(person=>person.id),[whale,dragon]);
  assert.equal(input.events.length,1);assert.equal(input.workContext,undefined);
  assert.deepEqual(directorInput(f.directors[1]).events.at(-1).messages,['鲸鲸在呢。','想聊什么？']);
  assert.ok(f.directors.every(call=>!/PRIMARY_PRIVATE_MEMORY|LISTENER_PRIVATE_MEMORY|WORK_SESSION_SECRET/.test(call.system+call.messages[0].content[0].text)));
  assert.match(f.calls[1].system,/LISTENER_PRIVATE_MEMORY/);assert.doesNotMatch(f.calls[1].system,/PRIMARY_PRIVATE_MEMORY/);
  const reaction=directorInput(f.calls[1]);assert.equal(reaction.phase,'reaction');assert.equal(reaction.exchange[0].speaker.id,whale);
  assert.deepEqual(state.room.turns.at(-1).recipients.map(person=>person.id),[whale],'an autonomous actor does not become an invented user mention');
  const before=f.requests.length;await roomSend(f,binding,whale,'你们对这件事有什么看法');await flush();assert.equal(f.requests.length,before,'duplicate delivery creates no new judgement');
});

test('a failed, truncated, duplicate-field, out-of-room or forged native decision preserves prior complete replies',async t=>{
  const cases=[
    ['failure',()=> (async function*(){throw Error('PRIVATE_PROVIDER_ERROR');})()],
    ['truncated',(value,next)=>directorReply(directorContext(value),next,'max-tokens')],
    ['duplicate-field',(value,next)=>(async function*(){yield{type:'text-delta',text:'{"context":'+JSON.stringify(directorContext(value))+',"next":null,"next":'+JSON.stringify(next)+'}'};yield{type:'finish',reason:{kind:'stop'}};})()],
    ['unknown',(value,next)=>directorReply(directorContext(value),{...next,id:'not-in-this-room'})],
    ['wrong-author',(value,next)=>directorReply(directorContext(value),{...next,to:whale})],
    ['malformed',()=> (async function*(){yield{type:'text-delta',text:'{"context":'};yield{type:'finish',reason:{kind:'stop'}};})()],
  ];
  for(const [name,invalid] of cases)await t.test(name,async sub=>{
    const f=fixture(sub,{directorScript:options=>{const value=directorInput(options);
      return currentSpeech(value).length?invalid(value,directorChoice(value,dragon)):directorReply(directorContext(value),directorChoice(value,whale));}});
    await f.ready();const binding=await newRoom(f);await roomSend(f,binding);const state=await settledRoom(f,binding);
    assert.equal(f.directors.length,2);assert.equal(f.calls.length,1);assert.equal(state.room.turns.filter(turn=>turn.phase!=='anchor').length,1);
    assert.equal(state.room.turns.at(-1).status,'ready');assert.doesNotMatch(JSON.stringify(state),/PRIVATE_PROVIDER_ERROR/);
  });
});

test('a pending native director is retired by stop, source edit, clear, unload or a durable newer user message',async t=>{
  for(const action of ['stop','source','clear','unload','new-message'])await t.test(action,async sub=>{
    let release;const gate=new Promise(resolve=>{release=resolve;});sub.after(release);
    const f=fixture(sub,{directorScript:options=>{const value=directorInput(options),said=currentSpeech(value);
      if(!said.length)return directorReply(directorContext(value),directorChoice(value,whale));
      if(value.message!=='公开讨论')return directorReply(directorContext(value),null);
      return(async function*(){await gate;yield*directorReply(directorContext(value),directorChoice(value,dragon));})();}});
    await f.ready();const binding=await newRoom(f);await roomSend(f,binding);await flush();const before=await roomState(f,binding);
    assert.equal(before.roundPhase,'listening');assert.equal(f.directors.length,2);assert.ok(before.roundId);assert.equal(before.room.turns.at(-1).status,'ready');
    if(action==='stop')assert.equal((await f.request('chat',{action:'cancel',...binding,personaId:whale,messageId:before.roundMessageId,roundId:before.roundId,attempts:[],epoch:before.epoch})).status,200);
    else if(action==='source')assert.equal((await f.request('chat-context',{action:'attach',roomId:binding.roomId,sessionId:'other',primary:true,revision:2})).status,200);
    else if(action==='clear')assert.equal((await f.request('chat',{action:'clear',...binding,personaId:whale,revision:before.room.revision,epoch:before.epoch})).status,200);
    else if(action==='unload')await f.dispose();
    else assert.equal((await roomSend(f,binding,whale,'新的问题','new-message')).status,200);
    await flush();assert.equal(f.directors[1].signal.aborted,true);release();await flush();const after=await roomState(f,binding);
    assert.equal(after.room.turns.filter(turn=>turn.phase!=='anchor').length,action==='clear'?0:action==='new-message'?2:1);
    assert.equal(f.calls.length,action==='new-message'?2:1);assert.ok(f.calls.every(call=>directorInput(call).speaker.id===whale),'late native selection cannot dispatch its stale actor');
  });
});

test('frozen ordered mentions and membership remain attached to the user turn while later target edits affect only new sends',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(release);
  const f=fixture(t,{script:(_options,index)=>(async function*(){if(index===2)await gate;yield*reply();})()});await f.ready();const binding=await newRoom(f,[whale,dragon,claude]);
  await roomSend(f,binding,whale,'你们觉得呢？','one-addressee');await settledRoom(f,binding);
  const change=(version,patch)=>f.request('chat-rooms',{action:'update',...binding,configRevision:version,epoch:0,...patch});
  assert.equal((await change(0,{targetPersonaIds:[whale,dragon]})).status,200);assert.equal(f.calls.length,1);
  await roomSend(f,binding,whale,'你们觉得呢？','two-addressees');await flush();
  assert.equal((await change(1,{memberIds:[whale,dragon],targetPersonaIds:[dragon]})).status,200);release();await settledRoom(f,binding);
  const [alone,first,second]=f.calls.map(directorInput);assert.equal(alone.message,first.message);
  assert.deepEqual(alone.recipients.map(person=>person.id),[whale]);assert.deepEqual(first.recipients.map(person=>person.id),[whale,dragon]);assert.deepEqual(second.recipients,first.recipients);
  assert.deepEqual(first.participants.map(person=>person.id),[whale,dragon,claude]);assert.deepEqual(second.participants.map(person=>person.id),[whale,dragon]);
  assert.ok(f.directors.every(call=>directorInput(call).task==='chat-room-director'));assert.equal(f.plans.length+f.continuations.length,0);
});

test('a removed mentioned member is never dispatched while a later native selection keeps original mentions and the live roster',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(release);
  const f=fixture(t,{directorScript:directorOrder(value=>[whale,dragon,claude].filter(id=>value.members.some(person=>person.id===id))),
    script:options=>(async function*(){const value=directorInput(options);if(value.speaker.id===whale)await gate;yield*reply([value.speaker.id+' 的公开回复']);})()});
  await f.ready();const binding=await newRoom(f,[whale,dragon,claude]);
  await f.request('chat-rooms',{action:'update',...binding,configRevision:0,epoch:0,targetPersonaIds:[whale,dragon]});await roomSend(f,binding);await flush();assert.equal(f.calls.length,1);
  await f.request('chat-rooms',{action:'update',...binding,configRevision:1,epoch:0,memberIds:[whale,claude]});await flush();assert.equal(f.calls.length,1);
  release();const state=await settledRoom(f,binding);assert.deepEqual(f.calls.map(call=>directorInput(call).speaker.id),[whale,claude]);
  assert.equal(state.room.turns.some(turn=>turn.recipientId===dragon),false);assert.equal(state.room.turns.at(-1).status,'ready');
  assert.equal(directorInput(f.calls[1]).exchange[0].speaker.id,whale);
  for(const call of [...f.calls,...f.directors])assert.deepEqual(directorInput(call).recipients.map(person=>person.id),[whale,dragon]);
  assert.deepEqual(directorInput(f.calls[1]).participants.map(person=>person.id),[whale,claude]);assert.deepEqual(publicCast(f.calls[1]).members.map(person=>person.id).sort(),[whale,claude].sort());
});

test('a matched pending-message stop needs no roundId and prevents any unstarted native selection',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(release);
  const f=fixture(t,{directorScript:directorOrder([whale,dragon,claude]),
    script:options=>(async function*(){if(directorInput(options).speaker.id===dragon)await gate;yield*reply();})()});
  await f.ready();const binding=await newRoom(f,[whale,dragon,claude]);await f.request('chat-rooms',{action:'update',...binding,configRevision:0,epoch:0,targetPersonaIds:[whale,dragon]});
  await roomSend(f,binding);await flush();assert.equal(f.calls.length,2);assert.equal(f.directors.length,2);
  const state=await roomState(f,binding),pending=state.room.turns.find(turn=>turn.status==='pending');
  assert.equal((await f.request('chat',{action:'cancel',...binding,personaId:whale,id:pending.id,attemptId:pending.attemptId,messageId:pending.messageId,epoch:state.epoch})).status,200);
  release();const stopped=await settledRoom(f,binding);assert.equal(f.directors.length,2);assert.equal(f.calls.length,2);
  assert.deepEqual(stopped.room.turns.filter(turn=>turn.phase!=='anchor').map(turn=>turn.status),['ready','cancelled']);
});

test('manual native retries retain complete earlier actors and do not fabricate or regenerate unstarted seats',async t=>{
  const counts=new Map(),f=fixture(t,{directorScript:directorOrder([whale,dragon,claude]),script:options=>{
    const id=directorInput(options).speaker.id,count=(counts.get(id)??0)+1;counts.set(id,count);
    return reply([id+' PUBLIC_V'+count],id===dragon&&count===1?'max-tokens':'stop');}});
  await f.ready();const binding=await newRoom(f,[whale,dragon,claude]);await roomSend(f,binding);let state=await settledRoom(f,binding);
  const prior=state.room.turns.find(turn=>turn.recipientId===whale),failed=state.room.turns.find(turn=>turn.recipientId===dragon);assert.equal(prior.status,'ready');assert.equal(failed.status,'failed');
  assert.equal((await f.request('chat',{action:'retry',...binding,personaId:dragon,id:failed.id,attemptId:'native-manual-retry',revision:state.room.revision,epoch:state.epoch})).status,200);
  state=await settledRoom(f,binding);assert.deepEqual(state.room.turns.find(turn=>turn.id===prior.id),prior);assert.equal(counts.get(whale),1);assert.equal(counts.get(dragon),2);assert.equal(counts.get(claude),1);
  assert.deepEqual(state.room.turns.filter(turn=>turn.phase!=='anchor').map(turn=>turn.status),['ready','ready','ready']);
  assert.equal(new Set(state.room.turns.map(turn=>turn.messageId)).size,1);assert.equal(f.plans.length+f.continuations.length,0);
});

test('one shared room preserves speaker identity across target changes while private memory stays isolated',async t=>{
  const f=fixture(t);await f.ready();await preference(f,'WHALE_PRIVATE_MEMORY');await preference(f,'DRAGON_PRIVATE_MEMORY',dragon);
  const room=await newRoom(f);await roomSend(f,room);await flush();
  const first=(await f.request('chat?room='+encodeURIComponent(room.roomId))).value;
  assert.equal((await f.request('chat-rooms',{action:'update',roomId:room.roomId,targetPersonaId:dragon,configRevision:0,epoch:first.epoch})).status,200);
  assert.equal(f.calls.length,1,'choosing a different reply target does not start a call');
  await roomSend(f,room,dragon,'轮到龙来聊','dragon-in-room');await flush();
  const prompt=readChatInput(f.calls[1]);
  assert.equal(prompt.history[0].recipient.id,whale);assert.equal(prompt.speaker.id,dragon);assert.equal(prompt.participants.length,2);
  assert.match(f.calls[1].system,/DRAGON_PRIVATE_MEMORY/);assert.doesNotMatch(f.calls[1].system,/WHALE_PRIVATE_MEMORY/);
  const result=(await f.request('chat?room='+encodeURIComponent(room.roomId))).value.room;
  assert.deepEqual(result.turns.filter(turn=>turn.phase!=='anchor').map(turn=>turn.recipientId),[whale,dragon]);assert.equal(result.turns.filter(turn=>turn.phase!=='anchor').length,2);
});

test('changing a target keeps an in-flight original speaker; removing that speaker cancels late output',async t=>{
  let release,signal;const f=fixture(t,{script:options=>(async function*(){signal=options.signal;await new Promise(r=>{release=r;});yield* reply(['迟到的内容']);})()});
  await f.ready();const room=await newRoom(f);await roomSend(f,room);await flush();
  await f.request('chat-rooms',{action:'update',roomId:room.roomId,targetPersonaId:dragon,configRevision:0,epoch:0});
  assert.equal(signal.aborted,false,'target selection affects the next request');
  await f.request('chat-rooms',{action:'update',roomId:room.roomId,memberIds:[dragon],configRevision:1,epoch:0});
  assert.equal(signal.aborted,true);release();await flush();
  const state=(await f.request('chat?room='+encodeURIComponent(room.roomId))).value;
  assert.equal(state.room.turns.filter(turn => turn.phase !== 'anchor')[0].recipientId,whale);assert.equal(state.room.turns.filter(turn => turn.phase !== 'anchor')[0].failure,'member-removed');
  assert.deepEqual(state.room.turns.filter(turn => turn.phase !== 'anchor')[0].assistant,[]);assert.equal(f.calls.length,1);
});

test('room source selections persist, open lazily and cannot cross-bind another room history or context key',async t=>{
  const reads=[];const project={id:'project',path:'D:/work',sessionIds:['work','other']};
  const services=[['workspaceRegistry',{list:()=>[project]}],['sessions',{get:id=>({header:{id,cwd:project.path}})}],
    ['sessionQuery',{observeSession:async id=>{reads.push(id);return{events:[{seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:id+'_REPORT'}]}}}],[Symbol.dispose](){}};}}]];
  const f=fixture(t,{extraServices:services});await f.ready();assert.deepEqual(reads,[]);
  const a=await newRoom(f,[whale],'甲房间','a'),b=await newRoom(f,[whale],'乙房间','b');
  const state=(await f.request('chat-context',{action:'attach',roomId:b.roomId,sessionId:'other',primary:true,revision:2})).value;
  b.contextKey=state.id+':'+state.revision;
  assert.equal((await roomSend(f,{...a,contextKey:b.contextKey})).status,409);
  await roomSend(f,b);await flush();const source=readChatInput(f.calls[0]).workContext;
  assert.equal(source.primarySessionId,'other');
  assert.deepEqual((await f.request('chat?room='+encodeURIComponent(a.roomId))).value.room.sources,['work']);
  assert.equal((await f.request('chat?room='+encodeURIComponent(a.roomId))).value.room.turns.filter(turn => turn.phase !== 'anchor').length,0);
  const storage=f.storage;await f.dispose();const before=reads.length,next=fixture(t,{storage,extraServices:services});await next.ready();
  await next.request('chat?room='+encodeURIComponent(b.roomId));assert.equal(reads.length,before,'restoring room metadata does not load work references');
  const opened=(await next.request('chat-context',{action:'open',roomId:b.roomId,viewer:'new-window',sequence:1,sessionId:'unrelated'})).value;
  assert.equal(opened.primarySessionId,'other');assert.deepEqual(opened.sources.map(s=>s.sessionId),['work','other']);assert.ok(!reads.includes('unrelated'));
  assert.equal(next.calls.length,0);
  await roomSend(next,{roomId:b.roomId,contextKey:opened.id+':'+opened.revision},whale,'重启后接着聊','after-restart');await flush();
  const resumed=readChatInput(next.calls[0]);
  assert.equal(resumed.history.length,1,'unchanged persisted sources retain shared conversation context across host restarts');
  assert.equal(resumed.history[0].user,'公开讨论');
});

test('sending right after a fixed work source finishes reads its latest original report before calling the chat model',async t=>{
  const events=[], work={id:'work',header:{cwd:'D:/work'}};
  const emit=(seq,turn,type,data={})=>events.push({seq,type,data:{turn,...data}});
  const content=text=>[{type:'text',text}];
  emit(1,1,'turn/start');emit(2,1,'user/message',{source:{kind:'user'},content:content('旧任务')});
  emit(3,1,'assistant/message',{message:{content:content('旧轮结果')}});emit(4,1,'turn/end',{reason:{kind:'completed'}});
  const reads=[];const f=fixture(t,{extraServices:[['sessionQuery',{observeSession:async id=>{reads.push(id);return {events:events.slice()};}}]]});
  await f.ready();const binding=await newRoom(f,[whale]);const originalReads=reads.length;
  emit(5,2,'turn/start');emit(6,2,'user/message',{source:{kind:'user'},content:content('这个新目标怎样了？')});
  emit(7,2,'assistant/message',{message:{content:content('第二轮通过，仍需复查。')}});emit(8,2,'turn/end',{reason:{kind:'completed'}});
  f.bus.emit('session/event',work,events.at(-1));
  assert.equal(reads.length,originalReads,'an event is not permission to start another read');
  assert.equal((await roomSend(f,binding)).status,200);await flush();assert.equal(f.calls.length,1);
  const ref=readChatInput(f.calls[0]).workContext;
  assert.equal(reads.length,originalReads+1);assert.deepEqual([ref.sources[0].turn,ref.sources[0].reportSeq,ref.sources[0].report],[2,7,'第二轮通过，仍需复查。']);
  assert.doesNotMatch(JSON.stringify(ref),/旧任务|旧轮结果/);
});

test('one persona can answer in two rooms independently and clearing or deleting one cannot affect the other',async t=>{
  const gates=[],signals=[];const f=fixture(t,{script:options=>(async function*(){signals.push(options.signal);await new Promise(r=>gates.push(r));yield* reply(['只写回自己的房间']);})()});
  await f.ready();const a=await newRoom(f,[whale],'甲','parallel-a'),b=await newRoom(f,[whale],'乙','parallel-b');
  await roomSend(f,a,whale,'甲的消息','a-message');await roomSend(f,b,whale,'乙的消息','b-message');await flush();
  assert.equal(f.calls.length,2);const first=(await f.request('chat?room='+encodeURIComponent(a.roomId))).value;
  await f.request('chat',{action:'clear',roomId:a.roomId,personaId:whale,revision:first.room.revision,epoch:first.epoch});
  assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);
  for(const release of gates)release();await flush();
  const second=(await f.request('chat?room='+encodeURIComponent(b.roomId))).value;
  assert.equal(second.room.turns.filter(turn => turn.phase !== 'anchor')[0].status,'ready');assert.equal((await f.request('chat?room='+encodeURIComponent(a.roomId))).value.room.turns.filter(turn => turn.phase !== 'anchor').length,0);
  const cleared=(await f.request('chat?room='+encodeURIComponent(a.roomId))).value;
  await f.request('chat-rooms',{action:'delete',roomId:a.roomId,revision:cleared.room.revision,epoch:cleared.epoch});
  assert.equal((await f.request('chat?room='+encodeURIComponent(a.roomId))).status,404);
  assert.equal((await f.request('chat?room='+encodeURIComponent(b.roomId))).value.room.turns.filter(turn => turn.phase !== 'anchor').length,1);
});

test('room metadata has its own version so a completing message cannot invalidate an unrelated member edit',async t=>{
  const f=fixture(t);await f.ready();const binding=await newRoom(f),before=(await f.request('chat?room='+encodeURIComponent(binding.roomId))).value;
  await roomSend(f,binding);await flush();
  const saved=await f.request('chat-rooms',{action:'update',roomId:binding.roomId,configRevision:before.room.configRevision,epoch:before.epoch,name:'保存后的名称'});
  assert.equal(saved.status,200);assert.equal(saved.value.room.turns.filter(turn => turn.phase !== 'anchor').length,1);
  const conflict=await f.request('chat-rooms',{action:'update',roomId:binding.roomId,configRevision:before.room.configRevision,epoch:before.epoch,name:'迟到的覆盖'});
  assert.equal(conflict.status,409);assert.equal(conflict.value.state.room.name,'保存后的名称');
});

test('a changed source that failed to save cannot reuse the old history scope or dispatch a model call',async t=>{
  let fail=false;const storage=domain(Promise.resolve(),{fail:id=>fail&&id==='personaChats'});
  const f=fixture(t,{storage});await f.ready();const binding=await newRoom(f);
  fail=true;const changed=await f.request('chat-context',{action:'attach',roomId:binding.roomId,sessionId:'other',primary:true,revision:2});
  assert.equal(changed.status,503);const pending={roomId:binding.roomId,contextKey:changed.value.state.id+':'+changed.value.state.revision};
  assert.equal((await roomSend(f,pending)).status,409);assert.equal(f.calls.length,0);
  fail=false;assert.equal((await f.request('chat-context',{action:'refresh',roomId:binding.roomId})).status,200);
  assert.equal((await roomSend(f,pending)).status,200);await flush();assert.equal(f.calls.length,1);
});

test('chat routes are authenticated and startup/open/read never generates a proactive message', async (t) => {
  let release; const f = fixture(t, { storage: domain(new Promise((r) => { release = r; })) });
  assert.equal((await f.request('chat', undefined, false)).status, 403);
  assert.equal((await f.request('chat', { action: 'send', personaId: whale }, false)).status, 403);
  assert.equal((await f.request('chat', { action: 'send', personaId: whale })).status, 503);
  release(); await f.ready(); assert.equal((await f.state()).room, null); assert.equal((await f.state()).ready, true);
  assert.equal(f.calls.length, 0);
});

test('chat model and thinking settings default to rewrite routing but remain independently saved',async t=>{
  const storage=domain();const f=fixture(t,{storage,config:{reasoningEffort:'high',chatThinking:false},
    modelInfo:async()=>({reasoning:{efforts:[{id:'off'},{id:'low'},{id:'high'}],defaultEffort:'low'}})});await f.ready();
  await f.send('默认聊天室',whale,'model-one');await flush();assert.equal(f.calls[0].provider,'p');assert.equal(f.calls[0].model,'m');assert.equal(f.calls[0].reasoningEffort,'off');
  assert.equal((await f.request('settings',{chatProvider:'chat-p',chatModel:'chat-m',chatThinking:true})).status,200);
  await f.send('独立聊天室',whale,'model-two');await flush();assert.equal(f.calls[1].provider,'chat-p');assert.equal(f.calls[1].model,'chat-m');assert.equal(f.calls[1].reasoningEffort,'low');
  const settings=(await f.request('settings')).value.settings;assert.equal(settings.provider,'p');assert.equal(settings.reasoningEffort,'high');assert.equal(settings.chatThinking,true);
  await f.dispose();const restored=fixture(t,{storage});await restored.ready();const saved=(await restored.request('settings')).value.settings;
  assert.equal(saved.chatProvider,'chat-p');assert.equal(saved.chatModel,'chat-m');assert.equal(saved.chatThinking,true);
});

test('startup and ordinary settings do not restore chat records or owner avatars; explicit opening restores once globally',async t=>{
  const gets=[];const f=fixture(t,{storage:domain(Promise.resolve(),{onGet:id=>gets.push(id)})});await f.ready();
  await f.request('settings');f.work();await flush();
  assert.equal(gets.includes('personaChats'),false);assert.equal(gets.includes('chatUserProfile'),false);
  assert.equal((await f.request('chat-context?viewer=one&sequence=0')).status,409);
  assert.equal(gets.includes('personaChats'),false);
  const opened=await f.request('chat-context',{action:'open',viewer:'one',sequence:1,sessionId:'work'});
  assert.equal(opened.status,200);assert.equal(opened.value.primarySessionId,'work');
  const other=await f.request('chat-context',{action:'open',viewer:'two',sequence:1,sessionId:'other'});
  assert.equal(other.value.id,opened.value.id);assert.equal(other.value.primarySessionId,'work');
  assert.equal(gets.filter(id=>id==='personaChats').length,1);assert.equal(gets.filter(id=>id==='chatUserProfile').length,1);assert.equal(f.calls.length,0);
});

test('chat uses only explicit passive sources and does not carry old context history into a changed reference set',async t=>{
  const reads=[];
  const project={id:'p',path:'D:/work/Project',sessionIds:['work','other']};
  const sessions={get:id=>({header:{id,cwd:project.path}})};
  const events=id=>[{seq:1,type:'user/message',data:{content:[{type:'text',text:id+'_GOAL'}]}},
    {seq:2,type:'assistant/message',data:{message:{content:[{type:'text',text:id+'_REPORT'},{type:'thinking',text:'NO_THOUGHT'}]}}}];
  const f=fixture(t,{extraServices:[['workspaceRegistry',{list:()=>[project]}],['sessions',sessions],
    ['sessionQuery',{observeSession:async id=>{reads.push(id);return{events:events(id),[Symbol.dispose](){}};}}]]});await f.ready();
  assert.deepEqual(reads,[]);
  const initial=(await f.request('chat-context',{action:'open',viewer:'one',sequence:1,sessionId:'work'})).value;
  assert.deepEqual(reads,['work']);
  const post=async(context,content,requestId)=>{const state=await f.state();return f.request('chat',{action:'send',personaId:whale,
    revision:state.room?.revision??0,epoch:state.epoch,requestId,content,contextKey:context.id+':'+context.revision});};
  assert.equal((await post(initial,'看看进展','first')).status,200);await flush();
  const first=readChatInput(f.calls[0]);assert.match(JSON.stringify(first),/work_REPORT/);assert.doesNotMatch(JSON.stringify(first),/other_REPORT|NO_THOUGHT/);
  const added=(await f.request('chat-context',{action:'attach',sessionId:'other',revision:initial.revision})).value;
  assert.equal((await post(initial,'过期来源','old')).status,409);
  assert.equal((await post(added,'两个会话有什么进展','second')).status,200);await flush();
  const second=readChatInput(f.calls[1]);assert.equal(second.history.length,0);assert.match(JSON.stringify(second),/other_REPORT/);
  const removed=(await f.request('chat-context',{action:'detach',sessionId:'other',revision:added.revision})).value;
  const state=await f.state();const beforeSuggestions=f.calls.length;
  assert.equal((await f.request('chat/suggestions',{personaId:whale,roomId:state.room.id,revision:state.room.revision,epoch:state.epoch,
    contextKey:removed.id+':'+removed.revision,instruction:''})).status,400);
  assert.equal(f.calls.length,beforeSuggestions,'old-scope history cannot drive a new-scope suggestion call');
  await f.request('chat-context',{action:'presence',viewer:'one',sequence:2,visible:false});
  assert.equal((await post(added,'关闭后不能发起','closed')).status,409);
});

test('chat defaults to the current session report persona without changing either persona choice or reading work text', async (t) => {
  const f = fixture(t); await f.ready();
  const selected = await f.request('conversation', { action: 'select', sessionId: 'work', personaId: dragon, trigger: 'inherit', revision: 0 });
  assert.equal(selected.status, 200);
  const followed = await f.request('chat?session=work');
  assert.equal(followed.value.personaId, dragon); assert.equal(followed.value.reportPersonaId, dragon);
  assert.equal((await f.request('chat?session=other')).value.personaId, whale);
  assert.equal((await f.request('chat?session=work&persona=' + encodeURIComponent(whale))).value.personaId, whale);
  assert.equal((await f.request('conversation?session=work')).value.effectivePersonaId, dragon);
  assert.equal((await f.request('chat?session=')).status, 400); assert.equal(f.calls.length, 0);
});

test('chat uses only its own history, scoped preferences and no working tools or transcript', async (t) => {
  const f = fixture(t,{config:{chatThinking:false}}); await f.ready(); await preference(f, 'WHALE_ONLY_STYLE'); await preference(f, 'DRAGON_ONLY_STYLE', dragon);
  f.work(); assert.equal((await f.send('第一条聊天')).status, 200); await flush();
  const first = (await f.state()).room.turns.filter(turn => turn.phase !== 'anchor')[0]; assert.equal(first.status, 'ready'); assert.equal(first.assistant.length, 2);
  assert.equal(f.calls[0].tools, undefined); assert.equal(f.calls[0].reasoningEffort, 'off');
  assert.match(f.calls[0].system, /WHALE_ONLY_STYLE/); assert.doesNotMatch(JSON.stringify(f.calls[0]), /DRAGON_ONLY_STYLE|WORK_SESSION_SECRET/);
  await f.send('第二条聊天', whale, 'client-two'); await flush();
  const prompt = readChatInput(f.calls[1]); assert.equal(prompt.history[0].user, '第一条聊天');
  assert.deepEqual(prompt.history[0].assistant, ['鲸鲸在呢。', '想聊什么？']);
  await f.send('龙的聊天', dragon, 'dragon-one'); await flush();
  const other = readChatInput(f.calls[2]); assert.deepEqual(other.history, []);
  assert.doesNotMatch(f.calls[2].system, /WHALE_ONLY_STYLE/);
  const usage = (await f.request('memory')).value.usage.records; assert.equal(usage.filter((r) => r.channel === 'chat').length, 3);
  assert.equal(f.storage.tables.get('sessions')?.size ?? 0, 0, 'chat never creates working result rows');
});

test('duplicate delivery does not regenerate and restoring history never starts a request', async (t) => {
  const f = fixture(t); await f.ready(); await f.send('只发一次'); await flush();
  assert.equal((await f.request('chat', { action: 'send', personaId: whale, requestId: 'client-one', content: '只发一次', revision: 0 })).status, 200);
  await flush(); assert.equal(f.calls.length, 1); assert.equal((await f.state()).room.turns.filter(turn => turn.phase !== 'anchor').length, 1);
  await f.dispose(); const next = fixture(t, { storage: f.storage }); await next.ready();
  assert.equal((await next.state()).room.turns.filter(turn => turn.phase !== 'anchor')[0].status, 'ready'); assert.equal(next.calls.length, 0);
});

test('truncated chat keeps the user message and explicit retry does not duplicate its bubble', async (t) => {
  const f = fixture(t, { script: (_options, n) => reply(['回复'], n === 1 ? 'max-tokens' : 'stop') }); await f.ready();
  await f.send('消息别丢'); await flush(); const state = await f.state(); const turn = state.room.turns.filter(turn => turn.phase !== 'anchor')[0];
  assert.equal(turn.status, 'failed'); assert.deepEqual(turn.assistant, []);
  assert.equal(turn.failure, 'length');
  assert.equal((await f.request('chat', { action: 'retry', personaId: whale, id: turn.id, attemptId: 'retry-one', revision: state.room.revision })).status, 200);
  await flush(); assert.equal((await f.state()).room.turns.filter(turn => turn.phase !== 'anchor').length, 1); assert.equal((await f.state()).room.turns.filter(turn => turn.phase !== 'anchor')[0].status, 'ready');
  assert.equal(f.calls.length, 2);
});

test('a format failure can retry a fenced reply and plain text without duplicating the user message', async t => {
  const raw = body => (async function* () { yield { type: 'text-delta', text: body }; yield { type: 'finish', reason: { kind: 'stop' } }; })();
  const f = fixture(t, { script: (_, n) => raw(n === 1 ? '{"messages":["未完成"' : n === 2
    ? '```json\n{"messages":["可以看参考啦。","慢慢聊。"]}\n```' : '第一句。\n\n第二句。') });
  await f.ready(); await f.send('再聊聊'); await flush(); const state = await f.state();
  assert.equal(state.room.turns.filter(turn => turn.phase !== 'anchor')[0].failure, 'format');
  await f.request('chat', { action: 'retry', personaId: whale, id: state.room.turns.filter(turn => turn.phase !== 'anchor')[0].id, attemptId: 'format-retry', revision: state.room.revision });
  await flush(); const next = await f.state(); assert.equal(next.room.turns.filter(turn => turn.phase !== 'anchor').length, 1);
  assert.deepEqual(next.room.turns.filter(turn => turn.phase !== 'anchor')[0].assistant, ['可以看参考啦。', '慢慢聊。']); assert.equal(next.room.turns.filter(turn => turn.phase !== 'anchor')[0].failure, null);
  await f.send('普通回复也可以', whale, 'plain'); await flush();
  assert.deepEqual((await f.state()).room.turns.filter(turn => turn.phase !== 'anchor')[1].assistant, ['第一句。', '第二句。']);
});

test('failed calls preserve only safe failure categories across restoration, never provider detail', async t => {
  const f = fixture(t, { script: () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { status: 429, code: 'RATE_LIMIT', message: 'SECRET_PROVIDER_REQUEST' } } };
  })() }); await f.ready(); await f.send('稍后再试'); await flush();
  const state = await f.state(); assert.equal(state.room.turns.filter(turn => turn.phase !== 'anchor')[0].failure, 'rate-limit');
  assert.doesNotMatch(JSON.stringify(state), /SECRET_PROVIDER_REQUEST|RATE_LIMIT/);
  await f.dispose(); const restored = fixture(t, { storage: f.storage }); await restored.ready();
  assert.equal((await restored.state()).room.turns.filter(turn => turn.phase !== 'anchor')[0].failure, 'rate-limit'); assert.equal(restored.calls.length, 0);
});

test('retry after a host restart needs confirmation of the new scope and excludes the old scope history', async t => {
  const f = fixture(t, { script: (_, n) => n === 1 ? reply() : reply(['不完整'], 'max-tokens') }); await f.ready();
  const opened = (await f.request('chat-context', { action: 'open', viewer: 'one', sequence: 1, sessionId: 'work' })).value;
  const oldKey = opened.id + ':' + opened.revision;
  await f.request('chat', { action: 'send', personaId: whale, requestId: 'old-ready', content: '旧范围的聊天', revision: 0, contextKey: oldKey }); await flush();
  const state = await f.state();
  await f.request('chat', { action: 'send', personaId: whale, requestId: 'failed-one', content: '保留这句',
    revision: state.room.revision, epoch: state.epoch, contextKey: oldKey }); await flush();
  await f.dispose(); const next = fixture(t, { storage: f.storage }); await next.ready();
  const context = (await next.request('chat-context', { action: 'open', viewer: 'new', sequence: 1, sessionId: 'other' })).value;
  const before = await next.state(); const failed = before.room.turns.find(turn=>turn.messageId==='failed-one'&&turn.phase!=='anchor'); const body = { action: 'retry', personaId: whale, id: failed.id, attemptId: 'retry-new-host',
    revision: before.room.revision, epoch: before.epoch, contextKey: context.id + ':' + context.revision };
  assert.equal((await next.request('chat', body)).status, 409); assert.equal(next.calls.length, 0);
  assert.equal((await next.request('chat', { ...body, previousContextKey: oldKey })).status, 200); await flush();
  assert.equal(next.calls.length, 1); const prompt = readChatInput(next.calls[0]);
  assert.deepEqual(prompt.history, []); assert.equal(prompt.message, '保留这句');
  assert.equal((await next.state()).room.turns.filter(turn => turn.phase !== 'anchor').length, 2);
});

test('stopping an in-flight reply permits a new message and its late chunks cannot replace the new answer', async (t) => {
  let release, signal; const gate = new Promise((r) => { release = r; });
  const f = fixture(t, { script: (options, n) => n === 1 ? (async function* () { signal = options.signal; await gate; yield* reply(['OLD_LATE_REPLY']); })() : reply(['新的回复']) });
  await f.ready(); await f.send('旧消息'); await flush(); const turn = (await f.state()).room.turns.filter(turn => turn.phase !== 'anchor')[0];
  await f.request('chat', { action: 'cancel', personaId: whale, id: turn.id, attemptId: turn.attemptId });
  assert.equal(signal.aborted, true);
  await f.send('新消息', whale, 'new-message'); await flush(); release(); await flush();
  const state = await f.state(); assert.equal(state.room.turns.filter(turn => turn.phase !== 'anchor').length, 2); assert.equal(state.room.turns.filter(turn => turn.phase !== 'anchor')[0].status, 'cancelled');
  assert.deepEqual(state.room.turns.filter(turn => turn.phase !== 'anchor')[1].assistant, ['新的回复']); assert.doesNotMatch(JSON.stringify(state.room), /OLD_LATE_REPLY/);
});

test('clearing chat is isolated from other personas and late results cannot recreate the cleared room', async (t) => {
  let release; const gate = new Promise((r) => { release = r; });
  const f = fixture(t, { script: (_options, n) => n === 1 ? (async function* () { await gate; yield* reply(['不能恢复']); })() : reply() });
  await f.ready(); await preference(f, '保留这个偏好'); await f.send('待清理'); await flush();
  await f.send('龙的历史', dragon, 'dragon'); await flush(); const state = await f.state();
  await f.request('chat', { action: 'clear', personaId: whale, revision: state.room.revision });
  release(); await flush(); assert.equal((await f.state()).room, null); assert.equal((await f.state(dragon)).room.turns.filter(turn => turn.phase !== 'anchor').length, 1);
  assert.ok((await f.request('memory')).value.entries.some((e) => e.content === '保留这个偏好'));
});

test('a send that cannot be saved makes no model call and can be safely resubmitted', async (t) => {
  let fail = true; const storage = domain(Promise.resolve(), { fail: (id) => fail && id === 'personaChats' });
  const f = fixture(t, { storage }); await f.ready(); assert.equal((await f.send('等待保存')).status, 503);
  assert.equal(f.calls.length, 0); assert.equal((await f.state()).room, null);
  fail = false; await f.send('等待保存'); await flush(); assert.equal(f.calls.length, 1);
});

test('unload during model lookup cannot dispatch late or automatically replay the pending turn on restart', async (t) => {
  let release; const catalog = new Promise((r) => { release = r; });
  const f = fixture(t, { config: { model: '' }, listModels: () => catalog }); await f.ready();
  await f.send('等待模型'); await flush(); await f.dispose(); release([{ id: 'late' }]); await flush(); assert.equal(f.calls.length, 0);
  const next = fixture(t, { storage: f.storage }); await next.ready(); const restored=await next.state();
  assert.equal(restored.room.turns.length,1);assert.equal(restored.room.turns[0].phase,'anchor');assert.equal(restored.room.turns[0].user,'等待模型');
  assert.equal(next.calls.length,0);assert.equal(next.directors.length,0,'opening an unanswered user anchor cannot replay a model request');
});

test('new personas created in the same millisecond have distinct identities and histories', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const f = fixture(t); await f.ready();
  const one = await f.request('presets', { action: 'save', name: '角色甲', pack: { identity: '甲' } });
  const two = await f.request('presets', { action: 'save', name: '角色乙', pack: { identity: '乙' } });
  const idA = one.value.presets.find((p) => p.name === '角色甲').id, idB = two.value.presets.find((p) => p.name === '角色乙').id;
  assert.notEqual(idA, idB); await f.send('甲的私聊', idA); await flush(); assert.equal((await f.state(idB)).room, null);
});

test('editing a custom persona cancels its old chat reply, while deletion preserves an archived readable history', async (t) => {
  let release; const gate = new Promise((r) => { release = r; });
  const f = fixture(t, { script: () => (async function* () { await gate; yield* reply(['旧人格迟到回复']); })() }); await f.ready();
  const saved = await f.request('presets', { action: 'save', name: '聊天角色', pack: { identity: '旧身份' } });
  const id = saved.value.presets.find((p) => p.name === '聊天角色').id;
  await f.send('先等等', id); await flush();
  await f.request('presets', { action: 'save', name: '聊天角色', pack: { identity: '新身份' } }); await flush();
  release(); await flush(); assert.notEqual((await f.state(id)).room.turns.filter(turn => turn.phase !== 'anchor')[0].status, 'ready');
  assert.doesNotMatch(JSON.stringify((await f.state(id)).room), /旧人格迟到回复/);
  await f.request('presets', { action: 'delete', id });
  const archived = await f.state(id); assert.equal(archived.contacts.find((p) => p.id === id).archived, true);
  assert.equal((await f.send('不应发送', id, 'after-delete')).status, 400);
  assert.equal((await f.request('chat', { action: 'clear', personaId: id, revision: archived.room.revision })).status, 200);
  assert.equal((await f.request('chat?persona=' + encodeURIComponent(id))).status, 404);
});

test('chat reads no saved preferences when memory is disabled and does not auto-learn long-term memory from chat', async (t) => {
  const f = fixture(t); await f.ready(); await preference(f, 'PRIVATE_OLD_STYLE');
  await f.request('settings', { memory: false }); await f.send('语气要严肃'); await flush();
  assert.doesNotMatch(f.calls[0].system, /PRIVATE_OLD_STYLE/);
  const memory = (await f.request('memory')).value;
  assert.equal(memory.entries.length, 1); assert.equal(memory.usage.records.length, 0);
  await f.request('settings', { memory: true }); await f.send('称呼要改一下', whale, 'second'); await flush();
  assert.equal((await f.request('memory')).value.entries.length, 1);
});

const suggestions = (items = ['先比较一下两种方案吧。', '实现起来会有多复杂？', '能举个具体例子吗？'], finish = 'stop') => (async function* () {
  yield { type: 'text-delta', index: 0, text: JSON.stringify({ suggestions: items }) };
  yield { type: 'finish', reason: { kind: finish } };
})();
const suggest = async (f, instruction = '给我几句追问', id = whale) => {
  const state = await f.state(id), room = state.room;
  return f.request('chat/suggestions', { personaId: id, roomId: room?.id ?? null, revision: room?.revision ?? 0, epoch: state.epoch, instruction });
};

test('message area needs no settings gate, ignores a legacy off flag and still never generates on read', async (t) => {
  const storage = domain(); storage.tables.set('profile', new Map([['settings', { chatEnabled: false }]]));
  const f = fixture(t, { storage, config: { chatEnabled: false } }); await f.ready();
  await f.state(); await f.state(dragon); assert.equal(f.calls.length, 0);
  assert.equal((await f.send('现在聊聊')).status, 200); await flush(); assert.equal(f.calls.length, 1);
  await f.dispose(); const next = fixture(t, { storage }); await next.ready();
  assert.equal((await next.state()).room.turns.filter(turn => turn.phase !== 'anchor')[0].user, '现在聊聊'); assert.equal(next.calls.length, 0);
  assert.equal(Object.hasOwn((await next.request('settings')).value.settings, 'chatEnabled'), false);
});

test('quick reply candidates are transient user drafts, with only the selected persona discussion and no work or memory injection', async (t) => {
  const f = fixture(t, { config:{chatThinking:false},script: (options) => readChatInput(options).instruction !== undefined ? suggestions() : reply() });
  await f.ready(); await preference(f, 'ROLE_STYLE_NOT_USER_VOICE'); f.work();
  await f.send('讨论这个想法'); await flush(); await f.send('DRAGON_PRIVATE_DISCUSSION', dragon, 'dragon'); await flush();
  const before = (await f.state()).room, memoryBefore = (await f.request('memory')).value;
  const answer = await suggest(f, '帮我追问实现成本'); assert.equal(answer.status, 200); assert.equal(answer.value.suggestions.length, 3);
  const call = f.calls.at(-1), input = readChatInput(call);
  assert.equal(input.instruction, '帮我追问实现成本'); assert.equal(input.history[0].user, '讨论这个想法');
  assert.doesNotMatch(JSON.stringify(call), /DRAGON_PRIVATE_DISCUSSION|WORK_SESSION_SECRET|ROLE_STYLE_NOT_USER_VOICE/);
  assert.equal(call.tools, undefined); assert.equal(call.reasoningEffort, 'off');
  assert.deepEqual((await f.state()).room, before);
  assert.deepEqual((await f.request('memory')).value.usage, memoryBefore.usage);
  assert.deepEqual((await f.request('memory')).value.entries, memoryBefore.entries);
  assert.equal(f.storage.tables.get('sessions')?.size ?? 0, 0);
  assert.equal((await f.request('chat/suggestions', { personaId: whale, roomId: before.id, revision: before.revision - 1, instruction: '旧上下文' })).status, 409);
  assert.equal((await f.request('chat/suggestions', {}, false)).status, 403);
});

test('suggestions can start from an unsent requirement without creating a room and reject malformed or incomplete results', async (t) => {
  const f = fixture(t, { script: (_options, n) => n === 1 ? suggestions() : n === 2 ? suggestions(['未完成'], 'max-tokens') : reply(['不是候选结构']) });
  await f.ready(); assert.equal((await suggest(f, '')).status, 400); assert.equal(f.calls.length, 0);
  assert.equal((await suggest(f, '我想围绕文档设计继续聊')).status, 200); assert.equal((await f.state()).room, null);
  assert.equal((await suggest(f)).status, 422); assert.equal((await suggest(f)).status, 422);
  assert.equal((await f.state()).room, null);
});

test('suggestion context changes reject stale delivery and a newer candidate request aborts the older one', async (t) => {
  const gates = []; const signals = [];
  const f = fixture(t, { script: (options) => (async function* () { signals.push(options.signal);
    await new Promise((r) => gates.push(r)); yield* suggestions();
  })() }); await f.ready();
  const first = suggest(f); await flush(); const second = suggest(f, '换一组'); await flush();
  assert.notEqual((await first).status, 200); assert.equal(signals[0].aborted, true);
  // Room creation changes the source revision while the candidate request is pending.
  await f.send('更新讨论'); await flush(); gates[1]();
  assert.equal((await second).status, 409);
  for (const open of gates) open(); await flush();
  assert.equal((await f.state()).room.turns.filter(turn => turn.phase !== 'anchor').length, 1);
});

test('builtin avatars are owner-only local images and avatar edits fork once without inheriting private memory or chat', async (t) => {
  const f = fixture(t); await f.ready(); await preference(f, 'OLD_PRIVATE_MEMORY'); await f.send('原角色的聊天'); await flush();
  const before = (await f.request('presets')).value.presets; const builtin = before.find((p) => p.id === whale);
  for (const item of before.filter((p) => p.builtin)) {
    assert.match(item.avatar, /^\/persona-shell\/avatar\//);
    const asset = await f.request(item.avatar.slice('/persona-shell/'.length)); assert.equal(asset.status, 200);
    assert.equal(asset.value.toString('ascii', 0, 4), 'RIFF');
    assert.equal((await f.request(item.avatar.slice('/persona-shell/'.length), undefined, false)).status, 403);
  }
  const body = { action: 'avatar', id: whale, requestId: 'first-avatar-change', expectedAvatar: builtin.avatar, avatar: makeAvatar() };
  const result = await f.request('presets', body); assert.equal(result.status, 200);
  const fork = result.value.presets.find((p) => !p.builtin);
  assert.equal(result.value.active, fork.name); assert.equal(result.value.presets.find((p) => p.id === whale).avatar, builtin.avatar);
  assert.notEqual(fork.id, whale); assert.deepEqual(fork.pack, builtin.pack);
  assert.equal((await f.state(fork.id)).room, null); assert.equal((await f.state()).room.turns.filter(turn => turn.phase !== 'anchor').length, 1);
  await f.send('新角色聊聊', fork.id, 'fork-message'); await flush(); assert.doesNotMatch(f.calls.at(-1).system, /OLD_PRIVATE_MEMORY/);
  assert.equal((await f.request('presets', body)).value.presets.length, before.length + 1, 'retry cannot fork twice');
  const image = await f.request(fork.avatar.slice('/persona-shell/'.length)); assert.deepEqual(image.value, Buffer.from(body.avatar.split(',')[1], 'base64'));
  assert.doesNotMatch(JSON.stringify(result.value), /data:image|base64/);
  await f.dispose(); const next = fixture(t, { storage: f.storage }); await next.ready();
  assert.equal((await next.request('presets')).value.presets.find((p) => p.id === fork.id).avatar, fork.avatar);
});

test('custom avatar updates and removal keep persona identity, reports and chat, while card edits preserve the picture', async (t) => {
  const f = fixture(t); await f.ready();
  let saved = await f.request('presets', { action: 'save', name: '无头像角色', pack: { identity: '自定义角色' } });
  const custom = saved.value.presets.find((p) => p.name === '无头像角色'); assert.equal(custom.avatar, undefined);
  await f.send('保留聊天', custom.id); await flush(); const room = (await f.state(custom.id)).room;
  const changed = await f.request('presets', { action: 'avatar', id: custom.id, avatar: makeAvatar(), expectedAvatar: null, requestId: 'custom-avatar-one' });
  const avatar = changed.value.presets.find((p) => p.id === custom.id).avatar;
  assert.equal(changed.value.presets.length, saved.value.presets.length); assert.deepEqual((await f.state(custom.id)).room, room);
  await f.request('settings', { pack: { identity: '调整后的身份' } }); await flush();
  saved = await f.request('presets', { action: 'save', name: '无头像角色', pack: { identity: '再次修改身份' } });
  assert.equal(saved.value.presets.find((p) => p.id === custom.id).avatar, avatar);
  const removed = await f.request('presets', { action: 'avatar', id: custom.id, avatar: null, expectedAvatar: avatar, requestId: 'remove-avatar-one' });
  assert.equal(removed.value.presets.find((p) => p.id === custom.id).avatar, undefined);
  assert.equal((await f.state(custom.id)).contacts.find((p) => p.id === custom.id).avatar, undefined);
  assert.deepEqual((await f.state(custom.id)).room, room);
});

test('a builtin card fork keeps its original picture and changing only an avatar leaves an in-flight reply valid', async (t) => {
  let release, signal; const gate = new Promise((r) => { release = r; });
  const f = fixture(t, { script: (options) => (async function* () { signal = options.signal; await gate; yield* reply(['完成这条回复']); })() });
  await f.ready(); await f.request('settings', { pack: { identity: '只调整了角色说话方式' } }); await flush();
  const list = (await f.request('presets')).value.presets, custom = list.find((p) => !p.builtin);
  assert.ok(custom.avatar); assert.deepEqual((await f.request(custom.avatar.slice('/persona-shell/'.length))).value,
    (await f.request(list.find((p) => p.id === whale).avatar.slice('/persona-shell/'.length))).value);
  await f.send('正在聊', custom.id); await flush();
  assert.equal((await f.request('presets', { action: 'avatar', id: custom.id, avatar: makeAvatar(), expectedAvatar: custom.avatar,
    requestId: 'cosmetic-avatar-only' })).status, 200);
  assert.equal(signal.aborted, false); release(); await flush();
  assert.deepEqual((await f.state(custom.id)).room.turns.filter(turn => turn.phase !== 'anchor')[0].assistant, ['完成这条回复']);
});

test('failed avatar save keeps the old image and failed/stale operations cannot overwrite newer cards', async (t) => {
  let fail = false, block = false, release, began;
  const started = new Promise((r) => { began = r; });
  const storage = domain(Promise.resolve(), { fail: () => fail, beforePut: async (id) => {
    if (block && id.startsWith('preset-avatar-')) { block = false; began(); await new Promise((r) => { release = r; }); }
  } });
  const f = fixture(t, { storage }); await f.ready();
  const before = (await f.request('presets')).value.presets, builtin = before.find((p) => p.id === whale);
  const body = { action: 'avatar', id: whale, avatar: makeAvatar(), expectedAvatar: builtin.avatar, requestId: 'avatar-retry-one' };
  fail = true; assert.equal((await f.request('presets', body)).status, 503);
  assert.deepEqual((await f.request('presets')).value.presets, before); fail = false; block = true;
  const task = f.request('presets', body); await started;
  assert.equal((await f.request('settings', { pack: { identity: '并发修改' } })).status, 409);
  assert.equal((await f.request('presets', { action: 'delete', id: whale })).status, 409);
  release(); assert.equal((await task).status, 200);
  assert.equal((await f.request('presets', { ...body, requestId: 'bad-image-retry', avatar: 'https://remote.invalid/x.png' })).status, 400);
  const fork = (await f.request('presets')).value.presets.find((p) => !p.builtin);
  assert.equal((await f.request('presets', { ...body, id: fork.id, avatar: null, expectedAvatar: null })).status, 409);
  assert.equal(f.calls.length, 0);
});

test('suggestion request pending capability lookup cannot dispatch after unload', async (t) => {
  let resolveModel; const info = new Promise((r) => { resolveModel = r; });
  const f = fixture(t, { config: { model: '' }, listModels: () => info }); await f.ready();
  const task = suggest(f); await flush(); await f.dispose();
  assert.equal((await task).status, 409); resolveModel([{ id: 'late' }]); await flush(); assert.equal(f.calls.length, 0);
});

test('discussion updated during capability preparation is checked again before dispatching candidates', async (t) => {
  let release; const metadata = new Promise((r) => { release = r; });
  const f = fixture(t, { modelInfo: () => metadata }); await f.ready();
  const task = suggest(f); await flush(); await f.send('先发出这个想法'); await flush();
  release({}); assert.equal((await task).status, 409); await flush();
  assert.equal(f.calls.length, 1); assert.equal(readChatInput(f.calls[0]).message, '先发出这个想法');
});

test('user avatars are owner-only, shared for display across roles and never passed to any model or memory', async (t) => {
  let fail = false; const storage = domain(Promise.resolve(), { fail: (id) => fail && id === 'chatUserProfile' });
  const f = fixture(t, { storage }); await f.ready();
  assert.equal((await f.request('chat-profile', undefined, false)).status, 403);
  const input = { revision: 0, avatar: makeAvatar() };
  fail = true; assert.equal((await f.request('chat-profile', input)).status, 503);
  assert.equal((await f.request('chat-profile')).value.avatar, null); fail = false;
  const saved = (await f.request('chat-profile', input)).value; assert.equal(saved.revision, 1);
  assert.doesNotMatch(JSON.stringify(saved), /data:image|base64/);
  const imagePath = saved.avatar.slice('/persona-shell/'.length);
  assert.equal((await f.request(imagePath, undefined, false)).status, 403);
  assert.deepEqual((await f.request(imagePath)).value, Buffer.from(input.avatar.split(',')[1], 'base64'));
  assert.equal((await f.state()).userProfile.avatar, saved.avatar); assert.equal((await f.state(dragon)).userProfile.avatar, saved.avatar);
  assert.equal(f.calls.length, 0); await f.send('你好'); await flush();
  assert.doesNotMatch(JSON.stringify(f.calls), /data:image|base64|chat-profile\/avatar/);
  assert.equal((await f.request('chat-profile', { revision: 0, avatar: null })).status, 409);
  await f.dispose(); const next = fixture(t, { storage }); await next.ready();
  assert.equal((await next.request('chat-profile')).value.avatar, saved.avatar);
  await next.request('chat-profile', { revision: 1, avatar: null });
  assert.equal((await next.request(imagePath)).status, 404); assert.equal(next.calls.length, 0);
});

test('old requests after a successful clear cannot recreate messages or clear a replacement room', async (t) => {
  const f = fixture(t); await f.ready(); const before = await f.state();
  await f.send('需要清掉的消息'); await flush(); const first = await f.state();
  await f.request('chat', { action: 'clear', personaId: whale, revision: first.room.revision, epoch: first.epoch });
  assert.equal((await f.request('chat', { action: 'send', personaId: whale, requestId: 'late', content: '迟到的消息', revision: 0, epoch: before.epoch })).status, 409);
  await f.send('新的聊天', whale, 'fresh'); await flush();
  assert.equal((await f.request('chat', { action: 'clear', personaId: whale, revision: first.room.revision, epoch: first.epoch })).status, 409);
  assert.equal((await f.state()).room.turns.filter(turn => turn.phase !== 'anchor')[0].user, '新的聊天');
});

test('preset save, rename, apply and delete return storage errors before changing live persona state', async (t) => {
  let fail = false; const storage = domain(Promise.resolve(), { fail: () => fail });
  const f = fixture(t, { storage }); await f.ready(); const before = (await f.request('settings')).value.settings;
  const presetsBefore = (await f.request('presets')).value.presets;
  fail = true; assert.equal((await f.request('presets', { action: 'save', name: '可靠保存', pack: { identity: '新角色' } })).status, 503);
  assert.deepEqual((await f.request('presets')).value.presets, presetsBefore);
  assert.equal((await f.request('settings', { pack: { identity: '不可丢失的输入' } })).status, 503);
  assert.deepEqual((await f.request('settings')).value.settings.pack, before.pack);
  fail = false; const saved = await f.request('presets', { action: 'save', name: '可靠保存', pack: { identity: '新角色' } });
  const id = saved.value.presets.find((p) => p.name === '可靠保存').id;
  fail = true;
  for (const body of [{ action: 'rename', id, name: '不能假成功' }, { action: 'apply', id: dragon }, { action: 'delete', id }]) {
    assert.equal((await f.request('presets', body)).status, 503);
    assert.equal((await f.request('settings')).value.settings.presetName, '可靠保存');
    assert.ok((await f.request('presets')).value.presets.some((p) => p.id === id && p.name === '可靠保存'));
  }
  fail = false;
});

test('a failed active-pointer write compensates a newly persisted persona before acknowledging the failure', async (t) => {
  let fail = false;
  const storage = domain(Promise.resolve(), { fail: (id) => fail && id === 'activePreset' });
  const f = fixture(t, { storage }); await f.ready(); fail = true;
  assert.equal((await f.request('presets', { action: 'save', name: '不能留下半份预设', pack: { identity: '未完成' } })).status, 503);
  assert.equal(storage.tables.get('presets').size, 0);
  assert.equal((await f.request('settings')).value.settings.presetName, whale);
  fail = false;
});
