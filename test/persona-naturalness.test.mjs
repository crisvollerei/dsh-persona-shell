import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PACK, CLAUDE_PACK, JINGJING_RELAY_PACK } from '../lib/pack.js';
import { buildChatPrompt } from '../lib/chat-prompt.js';
import { buildDirectorPrompt, parseDirector } from '../lib/chat-director.js';
import { buildContextSelectionPrompt, explicitContextSelection, parseContextSelection } from '../lib/chat-coordinator.js';
import { roomCharacterContext, characterContextSection } from '../lib/character-roster.js';
import { fixture, whale, dragon, claude, reply, directorReply, preference, newRoom, roomSend, roomState, settledRoom } from './helpers/persona-chat-host.mjs';

// These checks cover prompt projection, provenance and routing. A deterministic
// fixture cannot establish whether a model's actual emotional response is natural.
const little = '鲸鲸（实验性）';
const person = (id, name = id) => ({ id, name, builtin: true });
const fish = person(whale), small = person(little, '小肥鱼（实验性）'), scholar = person(claude);
const json = prompt => readChatInput(prompt);
const input = options => readChatInput(options);
const publicCast = system => JSON.parse(system.split('\n').find(line => line.startsWith('{"self":') && line.includes('"relationships":')));
const memoryShape = entries => entries.map(({ id, version, scope, personaId, kind, content, status }) => ({ id, version, scope, personaId, kind, content, status }));

test('affectionate original words remain dialogue data and do not create a new family role or rewrite public identities', () => {
  const message = '妈妈，我偶尔也想当个孩子，就这次聊一会儿。';
  const previous = { id: 'old',attemptId:'old', messageId: 'old-message', user: '这次想被照顾一下。', status: 'ready',
    recipientId: whale, speakerName: '旧署名鲸鲸', recipients: [{ id: whale, name: '旧署名鲸鲸' }], assistant: ['先在这儿坐一会儿。'] };
  const cast = roomCharacterContext(fish, [fish, small, scholar]), before = structuredClone(cast);
  const result = buildChatPrompt({ pack: DEFAULT_PACK, history: [previous], message, speaker: fish,
    participants: [fish, small, scholar], recipients: [fish], cast, roomId: 'room', generation: 0,
    coordination: { work: 'not-needed', sourceIds: [], request: 'open', evidence: message, basis: 'model' } });
  const body = json(result), projected = publicCast(result.system);
  assert.equal(body.message, message); assert.equal(body.history[0].user, previous.user);
  assert.equal(body.history[0].assistant[0], previous.assistant[0]);
  assert.equal(body.history[0].recipient.name, '旧署名鲸鲸');
  assert.deepEqual(projected.relationships.map(edge => [edge.from, edge.to, edge.address]), before.relationships.map(edge => [edge.from, edge.to, edge.address]));
  assert.ok(projected.relationships.every(edge => edge.from !== 'user' && edge.to !== 'user'));
  assert.deepEqual(cast, before, 'building a chat response cannot mutate the public relationship catalog');
  for (const key of ['familyRole', 'kinship', 'careMode', 'emotion', 'relationshipUpdate', 'memoryUpdate']) assert.equal(body[key], undefined);
  assert.deepEqual(body.coordination, { work: 'not-needed', sourceIds: [], request: 'open' });
});

test('current speakers retain their configured voice, including Claude vocabulary, without importing report-only duties', () => {
  const voices = ['对齐和权限边界可以用作自己的轻幽默，保持Claude原本的表达。', '这是另一个人格自己的语气。'];
  const pack = { ...CLAUDE_PACK, voice: voices, report: ['REPORT_ONLY_ATTRIBUTION_NOT_A_CHAT_DUTY'] };
  const prompt = buildChatPrompt({ pack, history: [], message: '今天想轻松聊聊。', speaker: scholar,
    participants: [scholar], recipients: [scholar], roomId: 'room', generation: 0,
    cast: roomCharacterContext(scholar, [scholar]), memory: ['ONLY_CURRENT_PERSONA_ADDRESS'] });
  for (const voice of voices) assert.ok(prompt.system.includes(voice), 'shared chat guidance leaves the actual configured persona voice intact');
  assert.ok(CLAUDE_PACK.voice.some(value => value.includes('对齐')));
  assert.ok(CLAUDE_PACK.voice.some(value => value.includes('边界')));
  assert.match(prompt.system, /ONLY_CURRENT_PERSONA_ADDRESS/); assert.doesNotMatch(prompt.system, /REPORT_ONLY_ATTRIBUTION_NOT_A_CHAT_DUTY/);
  const smallPrompt = buildChatPrompt({ pack: { ...JINGJING_RELAY_PACK, report: ['RELAY_REPORT_ONLY'] }, history: [],
    message: '小肥鱼，你自己怎么想？', speaker: small, participants: [fish, small], recipients: [small],
    cast: roomCharacterContext(small, [fish, small]), roomId: 'room', generation: 0 });
  assert.equal(json(smallPrompt).speaker.id, little); assert.equal(publicCast(smallPrompt.system).self.id, little);
  assert.equal(publicCast(smallPrompt.system).relationships.find(edge => edge.to === whale).address, '姐姐');
  assert.doesNotMatch(smallPrompt.system, /RELAY_REPORT_ONLY/);
});

test('dialogue nicknames cannot inject a user-family edge or give a copied persona the builtin sibling identity', () => {
  const cast = roomCharacterContext(small, [fish, small]);
  cast.relationships.push({ from: little, to: 'user', address: '妈妈', dynamic: 'INJECTED_PARENT_FACT' });
  const projected = publicCast(characterContextSection(cast));
  assert.equal(projected.relationships.length, 1); assert.equal(projected.relationships[0].to, whale);
  assert.doesNotMatch(JSON.stringify(projected), /INJECTED_PARENT_FACT|"to":"user"/);
  const custom = { id: 'custom-fish', name: '小肥鱼（实验性）', builtin: false, familyRole: '母亲', avatarParentId: little };
  const copied = roomCharacterContext(custom, [custom, fish, small]);
  assert.equal(copied.self, null); assert.deepEqual(copied.relationships, []);
  assert.doesNotMatch(JSON.stringify(copied), /familyRole|avatarParentId/);
});

test('affection language adds no keyword route and a quoted project role can still require the authorized work source', () => {
  for (const message of ['妈妈，我偶尔也想当个孩子。', '“妈妈”是项目里的角色名，帮我看看当前实现。']) {
    assert.equal(explicitContextSelection(message), undefined, 'the exact-command gate does not classify a nickname or role word');
    const selection = buildContextSelectionPrompt({ message, sources: [{ id: 'work', name: '当前实现', projectName: '角色项目', report: 'PRIVATE_WORK_BODY' }],
      memory: ['PRIVATE_CALLING_PREFERENCE'], familyRole: 'PRIVATE_INFERRED_FAMILY' });
    assert.equal(json(selection).message, message);
    assert.deepEqual(json(selection).sources, [{ id: 'work', name: '当前实现', projectName: '角色项目' }]);
    assert.doesNotMatch(selection.user, /PRIVATE_/);
  }
  const message = '“妈妈”是项目里的角色名，帮我看看当前实现。';
  const accepted = parseContextSelection(JSON.stringify({ work: 'required', sourceIds: ['work'], request: 'answer', evidence: '帮我看看当前实现' }), ['work'], message);
  assert.equal(accepted.work, 'required'); assert.deepEqual(accepted.sourceIds, ['work']);
  const casual = '妈妈，我偶尔也想当个孩子。';
  assert.equal(parseContextSelection(JSON.stringify({ work: 'not-needed', sourceIds: [], request: 'open', evidence: casual }), ['work'], casual).request, 'open');
});

test('the native public director cannot write family roles, emotions or private memory',()=>{
  const message='妈妈，偶尔也想当个孩子。',events=[{id:'actual-user-event',author:{role:'user',name:'我'},messages:[message]}];
  const members=[fish,{...small,pack:JINGJING_RELAY_PACK,memory:['SMALL_PRIVATE_MEMORY']},{...scholar,pack:CLAUDE_PACK,memory:['CLAUDE_PRIVATE_MEMORY']}];
  const states=members.map(person=>({id:person.id,level:0,normalRemaining:3,peerRemaining:1,normalReady:true,peerReady:false,pendingEventIds:events.map(event=>event.id),normalPendingEventIds:events.map(event=>event.id)}));
  const prompt=buildDirectorPrompt({message,recipients:[fish],members,events,states,memory:['USER_PRIVATE_PREFERENCE'],familyRole:'INFERRED_PARENT_ROLE'}),body=json(prompt);
  assert.deepEqual(body.recipients,[{id:whale,name:whale}]);assert.deepEqual(body.members.map(person=>person.id),[whale,little,claude]);assert.deepEqual(body.events,events.map((event,index)=>({...event,id:'e'+(index+1)})));
  assert.doesNotMatch(prompt.system+prompt.user,/SMALL_PRIVATE_MEMORY|CLAUDE_PRIVATE_MEMORY|USER_PRIVATE_PREFERENCE|INFERRED_PARENT_ROLE/);
  assert.equal(body.memory,undefined);assert.equal(body.familyRole,undefined);assert.equal(body.emotion,undefined);
  const context={work:'not-needed',sourceIds:[],request:'open',evidence:message},options={message,members,events,states,sourceIds:[]};
  const next={id:claude,kind:'normal',to:'user',evidence:{eventId:events[0].id,index:0,text:message},goal:'回应已经表达的感受。'};
  assert.equal(parseDirector(JSON.stringify({context,next}),options).next.id,claude);
  for(const patch of [{familyRole:'mother'},{memoryUpdate:'new relationship'},{emotion:'diagnosis'}])
    assert.equal(parseDirector(JSON.stringify({context,next,...patch}),options).next,null);
});

test('warm chat preserves private preferences and room-local words without extra judges or automatic family memories', async t => {
  const message = '妈妈，我偶尔也想当个孩子，就这次聊一会儿。';
  const workBody = 'WORK_BODY_NOT_RELEVANT_TO_THIS_CHAT';
  const f = fixture(t, { config: { memory: true, memoryExtraction: true },
    script: () => reply(['确定性的占位回复，仅验证数据和路由。']),
    directorScript: options => {
      const value=input(options),after=value.events.slice(value.events.findLastIndex(event=>event.author.role==='user')+1),answered=new Set(after.filter(event=>event.author.role==='assistant').map(event=>event.author.id));
      const person=value.recipients.find(person=>!answered.has(person.id)),event=value.events.findLast(event=>event.author.role==='user');
      return directorReply({work:'not-needed',sourceIds:[],request:'open',evidence:value.message},person?{id:person.id,kind:'normal',to:'user',
        evidence:{eventId:event.id,index:0,text:event.messages[0]},goal:'接住这一句闲聊原话。'}:null);
    },
    extraServices: [['sessions', { get: id => ({ header: { id, cwd: 'D:/work/naturalness' } }) }],
      ['sessionQuery', { observeSession: async () => ({ events: [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'WORK_GOAL' }] } },
        { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: workBody }] } } }], [Symbol.dispose]() {} }) }]],
  });
  await f.ready(); await preference(f, 'ONLY_FISH_CALLING_PREFERENCE', whale); await preference(f, 'ONLY_SMALL_CALLING_PREFERENCE', little);
  const before = memoryShape((await f.request('memory')).value.entries);
  const a = await newRoom(f, [whale, little, claude, dragon, 'Gemini'], '亲近原话只在本房间', 'natural-a');
  assert.equal((await roomSend(f, a, whale, message, 'natural-first')).status, 200); await settledRoom(f, a);
  assert.equal(f.calls.length,1);assert.equal(f.directors.length,2);assert.equal(f.plans.length+f.continuations.length,0);assert.equal(f.requests.length,3);
  assert.equal(input(f.calls[0]).message, message); assert.deepEqual(input(f.calls[0]).workContext.sources, []);
  assert.match(f.calls[0].system, /ONLY_FISH_CALLING_PREFERENCE/); assert.doesNotMatch(f.calls[0].system, /ONLY_SMALL_CALLING_PREFERENCE/);
  const current = await roomState(f, a);
  assert.equal((await f.request('chat-rooms', { ...a, action: 'update', targetPersonaIds: [little, claude], configRevision: current.room.configRevision, epoch: current.epoch })).status, 200);
  assert.equal((await roomSend(f, a, little, '你们随便说一句就好，别替我安排工作。', 'natural-second')).status, 200); await settledRoom(f, a);
  assert.deepEqual(f.calls.slice(1).map(call => input(call).speaker.id), [little, claude]);
  assert.match(f.calls[1].system, /ONLY_SMALL_CALLING_PREFERENCE/); assert.doesNotMatch(f.calls[1].system, /ONLY_FISH_CALLING_PREFERENCE/);
  assert.doesNotMatch(f.calls[2].system, /ONLY_FISH_CALLING_PREFERENCE|ONLY_SMALL_CALLING_PREFERENCE/);
  assert.equal(input(f.calls[1]).history[0].user, message); assert.equal(input(f.calls[2]).history[0].user, message);
  assert.equal(f.directors.length,5);assert.equal(f.plans.length+f.continuations.length,0);
  for (const decision of f.directors) assert.doesNotMatch(decision.system + decision.messages[0].content[0].text, /ONLY_FISH_CALLING_PREFERENCE|ONLY_SMALL_CALLING_PREFERENCE|WORK_BODY_NOT_RELEVANT_TO_THIS_CHAT/);
  assert.deepEqual(memoryShape((await f.request('memory')).value.entries), before, 'playful dialogue neither adds a family fact nor resets existing private preferences');
  assert.equal((await roomState(f, a)).room.turns.filter(turn => turn.phase !== 'anchor')[0].user, message);
  const b = await newRoom(f, [whale], '另一间没有这段玩笑', 'natural-b');
  assert.equal((await roomSend(f, b, whale, '今天先从这句聊起。', 'natural-third')).status, 200); await settledRoom(f, b);
  const other = input(f.calls.at(-1)); assert.deepEqual(other.history, []); assert.deepEqual(other.roomNotes, []);
  assert.ok(!JSON.stringify(other).includes(message), 'the other room cannot inherit an unconfirmed affectionate nickname');
  assert.match(f.calls.at(-1).system, /ONLY_FISH_CALLING_PREFERENCE/, 'the same persona keeps its actual approved preferences');
  assert.equal(f.calls.length,4);assert.equal(f.directors.length,6);assert.equal(f.plans.length+f.continuations.length,0);assert.equal(f.requests.length,10);
  assert.deepEqual(memoryShape((await f.request('memory')).value.entries), before);
});
