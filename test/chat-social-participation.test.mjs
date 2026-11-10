import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS, CLAUDE_PACK } from '../lib/pack.js';
import { buildChatPrompt } from '../lib/chat-prompt.js';
import { buildDirectorPrompt, parseDirector } from '../lib/chat-director.js';
import { roomCharacterContext } from '../lib/character-roster.js';
import { fixture, whale, dragon, claude, reply, directorReply, preference, newRoom, roomState, settledRoom } from './helpers/persona-chat-host.mjs';


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

// The judge results below are controlled fixtures. These tests establish the
// information and bounded route available to the model, not semantic accuracy.
const little = '鲸鲸（实验性）';
const members = BUILTIN_PRESETS.map(preset => ({ ...preset, builtin: true }));
const byId = id => members.find(member => member.id === id);
const input = options => readChatInput(options);
const data = prompt => readChatInput(prompt);
const castOf = system => JSON.parse(system.split('\n').find(line => line.startsWith('{"self":') && line.includes('"relationships":')));
const primary = [{ id: whale, name: byId(whale).name }];
const exchange = [{ speaker: primary[0], messages: ['这里是已经完成的公开回应。'] }];
const oldInvite = { id: 'old-turn',attemptId:'old-turn', messageId: 'old-message', user: '你们都是我的妈妈', recipients: primary,
  recipientId: whale, speakerName: byId(whale).name, assistant: ['当时的一句公开回应。'], status: 'ready' };
const currentEvent = message => ({ id: 'actual-user-event', author: { role: 'user', name: '我' }, messages: [message], recipients: primary });
const states = members.map(person => ({ id: person.id, level: 0, normalRemaining: 3, peerRemaining: 1, normalReady: true, peerReady: false, pendingEventIds: ['actual-user-event'], normalPendingEventIds: ['actual-user-event'] }));
const judge = extra => buildDirectorPrompt({ recipients: primary, members, sources: [], states,
  events: [currentEvent(extra.message)], ...extra });

test('the native director receives collective and personal invitations as original words alongside public aliases',()=>{
  for(const message of ['你们都是我的妈妈','小肥鱼为什么不应','小克，你也是妈妈']){
    const result=judge({message}),value=data(result),publicCast=castOf(result.system);
    assert.equal(value.message,message);assert.deepEqual(value.events,[{...currentEvent(message),id:'e1'}]);assert.deepEqual(value.recipients,primary);
    assert.deepEqual(value.members.map(person=>person.id),members.map(person=>person.id));assert.equal(value.task,'chat-room-director');
    assert.ok(publicCast.members.find(person=>person.id===little).preferredAddress.includes('小肥鱼'));
    assert.ok(publicCast.members.find(person=>person.id===claude).preferredAddress.includes('小克'));
    assert.ok(publicCast.members.find(person=>person.id===dragon).preferredAddress.includes('GPT'));
    assert.ok(publicCast.members.find(person=>person.id==='Gemini').preferredAddress.includes('猫猫'));
    assert.ok(value.members.every(person=>Object.keys(person).every(key=>['id','name','identity','voice','preferredAddress'].includes(key))));
    assert.deepEqual(value.candidates,members.map(person=>({id:person.id,opportunities:['normal'],eventIds:['e1']})),
      'eligible opportunities are projected explicitly from readiness, alongside the one public member roster');
  }
});

test('current invitation, third-person mention, negation, old history and explicit quotation remain distinct inputs', () => {
  const quote = { author: { role: 'user', name: '我' }, text: oldInvite.user, memory: 'PRIVATE_QUOTE_FIELD' };
  const cases = [
    { message: '你们都是我的妈妈' },
    { message: '我在讲小肥鱼这个名字，不是在叫她回复。' },
    { message: '小肥鱼这次先别接话。' },
    { message: '这句只是以前的玩笑，不是在邀请大家。', history: [oldInvite], quotedMessage: quote },
  ];
  const values = cases.map(current => data(judge(current)));
  assert.deepEqual(values.map(value => value.message), cases.map(value => value.message));
  assert.deepEqual(values[0].history, []); assert.equal(values[0].quotedMessage, undefined);
  assert.equal(values[3].history[0].user, oldInvite.user);
  assert.deepEqual(values[3].quotedMessage, { author: { role: 'user', name: '我' }, text: oldInvite.user });
  assert.doesNotMatch(JSON.stringify(values), /PRIVATE_QUOTE_FIELD/);
  assert.ok(values.every(value => !('invitation' in value) && !('familyRole' in value) && !('emotion' in value)), 'no keyword-derived invitation or relationship fact is injected');
});

test('public nicknames cannot substitute for canonical director ids or bypass a member’s normal quota',()=>{
  const message='小肥鱼和小克，你们觉得呢？',event=currentEvent(message),options={message,members,events:[event],states,sourceIds:[]};
  const action=id=>({id,kind:'normal',to:'user',evidence:{eventId:event.id,index:0,text:message},goal:'回应这句原话。'});
  const wire=next=>JSON.stringify({context:{work:'not-needed',sourceIds:[],request:'answer',evidence:message},next});
  assert.equal(parseDirector(wire(action(little)),options).next.id,little);
  for(const id of ['小肥鱼','小克','猫猫','user-mother'])assert.equal(parseDirector(wire(action(id)),options).next,null);
  assert.equal(parseDirector(wire([action(little),action(claude)]),options).next,null,'one director decision cannot dispatch an array of speakers');
  assert.equal(parseDirector(wire(action(little)),{...options,states:states.map(state=>state.id===little?{...state,level:3,normalRemaining:0,normalReady:false}:state)}).next,null);
  assert.equal(parseDirector(wire({...action(little),extra:true}),options).next,null);
});

test('calling the current character and asking her to address the user preserve opposite direction and the original speaker', () => {
  const person = byId(claude), prior = { ...oldInvite, user: '刚才我叫鲸鲸妈妈。' };
  const prompt = message => buildChatPrompt({ pack: CLAUDE_PACK, history: [prior], message, speaker: { id: claude, name: person.name },
    participants: members.map(({ id, name }) => ({ id, name })), recipients: [{ id: claude, name: person.name }],
    cast: roomCharacterContext(person, members), roomId: 'room', generation: 0 });
  const called = prompt('你也是妈妈'), requested = prompt('叫我妈妈');
  assert.equal(data(called).message, '你也是妈妈'); assert.equal(data(requested).message, '叫我妈妈');
  assert.equal(data(called).speaker.id, claude); assert.equal(data(requested).speaker.id, claude);
  assert.equal(data(called).history[0].recipient.id, whale, 'the earlier nickname remains attributed to its actual recipient');
  assert.equal(castOf(called.system).self.id, claude); assert.equal(castOf(requested.system).self.id, claude);
  assert.deepEqual(CLAUDE_PACK.address.user, '你', 'temporary dialogue cannot mutate the persona default address');
  assert.ok(castOf(called.system).relationships.every(edge => edge.to !== 'user' && edge.from !== 'user'));
});

test('native social choices can answer a collective invitation while keeping original mentions, quotes and private preferences unchanged',async t=>{
  const collective='你们都是我的妈妈',named='小肥鱼为什么不应',quoting='这句只是引用，不是在喊大家。';
  const selection=new Map([[collective,[whale,little,claude]],[named,[whale,little]],[quoting,[whale]]]);
  const f=fixture(t,{script:()=>reply(['受控公开回应。']),directorScript:directorOrder(value=>selection.get(value.message)??[])});
  await f.ready();await preference(f,'FISH_SOCIAL_PRIVATE',whale);await preference(f,'SMALL_SOCIAL_PRIVATE',little);await preference(f,'CLAUDE_SOCIAL_PRIVATE',claude);
  const before=(await f.request('memory')).value.entries,room=await newRoom(f,[whale,little,claude,dragon,'Gemini'],'当前社交邀请','social-invite');
  const send=async(message,id,extra={})=>{const current=await roomState(f,room);assert.equal((await f.request('chat',{...room,action:'send',personaId:whale,content:message,requestId:id,
    revision:current.room.revision,epoch:current.epoch,...extra})).status,200);return settledRoom(f,room);};
  let state=await send(collective,'social-collective');assert.deepEqual(state.room.turns.filter(turn=>turn.phase!=='anchor').map(turn=>turn.recipientId),[whale,little,claude]);
  assert.equal(f.calls.length,3);assert.equal(f.directors.length,4);const first=directorInput(f.directors[0]);
  assert.equal(first.message,collective);assert.equal(first.events.length,1);assert.ok(first.members.some(person=>person.id===little));
  assert.deepEqual(input(f.calls[2]).exchange.map(value=>value.speaker.id),[whale,little]);
  for(const turn of state.room.turns)assert.deepEqual(turn.recipients.map(person=>person.id),[whale]);
  state=await send(named,'social-named');assert.deepEqual(state.room.turns.filter(turn=>turn.messageId==='social-named'&&turn.phase!=='anchor').map(turn=>turn.recipientId),[whale,little]);
  const namedJudge=directorInput(f.directors.at(-1));assert.equal(namedJudge.message,named);assert.ok(namedJudge.history.some(value=>value.user===collective));
  assert.ok(castOf(f.directors.at(-1).system).members.find(member=>member.id===little).preferredAddress.includes('小肥鱼'));
  state=await send(quoting,'social-quote',{quote:{roomId:room.roomId,generation:state.room.generation??0,kind:'user',messageId:'social-collective'}});
  const quoted=directorInput(f.directors.at(-1));assert.equal(quoted.message,quoting);assert.deepEqual(quoted.quotedMessage,{author:{role:'user',name:'我'},text:collective});
  assert.deepEqual(state.room.turns.filter(turn=>turn.messageId==='social-quote'&&turn.phase!=='anchor').map(turn=>turn.recipientId),[whale]);
  assert.equal(f.calls.length,6);assert.equal(f.directors.length,9);assert.equal(f.requests.length,15);assert.equal(f.plans.length+f.continuations.length,0);assert.deepEqual(state.room.targetPersonaIds,[whale]);
  assert.match(f.calls[1].system,/SMALL_SOCIAL_PRIVATE/);assert.doesNotMatch(f.calls[1].system,/FISH_SOCIAL_PRIVATE|CLAUDE_SOCIAL_PRIVATE/);
  assert.match(f.calls[2].system,/CLAUDE_SOCIAL_PRIVATE/);assert.doesNotMatch(f.calls[2].system,/FISH_SOCIAL_PRIVATE|SMALL_SOCIAL_PRIVATE/);
  assert.ok(f.directors.every(call=>!/FISH_SOCIAL_PRIVATE|SMALL_SOCIAL_PRIVATE|CLAUDE_SOCIAL_PRIVATE/.test(call.system+call.messages[0].content[0].text)));
  assert.deepEqual((await f.request('memory')).value.entries,before,'temporary social invitations never become family memories');
});

test('native social selection uses the current member state and actual evidence without an extra listener mode',async t=>{
  for(const [name,choice] of [['eligible',(value)=>directorChoice(value,little)],['alias',(value)=>directorChoice(value,'小肥鱼')],
    ['unknown',(value)=>directorChoice(value,'not-a-member')],['forged-evidence',(value)=>({...directorChoice(value,little),evidence:{eventId:'invented',index:0,text:'invented'}})]])await t.test(name,async sub=>{
    const f=fixture(sub,{script:()=>reply(['受控顺序回应。']),directorScript:options=>{const value=directorInput(options),said=currentSpeech(value);
      return directorReply(directorContext(value),said.length<2?directorChoice(value,[claude,whale][said.length]):said.length===2?choice(value):null);}});
    await f.ready();const room=await newRoom(f,[whale,little,claude,dragon,'Gemini'],'当前候选约束','social-order-'+name),current=await roomState(f,room);
    await f.request('chat-rooms',{...room,action:'update',configRevision:current.room.configRevision,epoch:current.epoch,targetPersonaIds:[claude,whale]});
    const before=await roomState(f,room);assert.equal((await f.request('chat',{...room,action:'send',personaId:claude,content:'你们都说一句，小肥鱼也来。',requestId:'social-order-message',revision:before.room.revision,epoch:before.epoch})).status,200);
    const after=await settledRoom(f,room),expected=name==='eligible'?[claude,whale,little]:[claude,whale];
    assert.deepEqual(f.calls.map(call=>input(call).speaker.id),expected);assert.deepEqual(after.room.targetPersonaIds,[claude,whale]);
    assert.ok(after.room.turns.every(turn=>turn.recipients.map(person=>person.id).join('|')===[claude,whale].join('|')));
    assert.ok(f.directors.every(call=>input(call).task==='chat-room-director'));assert.equal(f.plans.length+f.continuations.length,0);
  });
});
