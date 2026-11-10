import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectorPrompt, parseDirector } from '../lib/chat-director.js';
import { chatSchedulerEventKey } from '../lib/chat-scheduler.js';
import { fixture, directorReply, reply, newRoom, roomSend, roomState, settledRoom, whale, dragon } from './helpers/persona-chat-host.mjs';

const input = options => readChatInput(options);
const context = value => ({ work: 'not-needed', sourceIds: [], request: 'answer', evidence: value.message });
const choose = (id, event, to = 'user') => ({ id, kind: 'normal', to,
  evidence: { eventId: event.id, index: 0, text: event.messages[0] }, goal: '回应这一条已公开原话。' });
async function broadcast(f, room) {
  const state = await roomState(f, room);
  assert.equal((await f.request('chat-rooms', { ...room, action: 'update', targetPersonaIds: [],
    configRevision: state.room.configRevision, epoch: state.epoch })).status, 200);
}

// These scripts deliberately return valid-looking but stale wire evidence. They
// exercise the Host's actual admission boundary rather than a well-behaved model.
test('broadcast does not let a persona repeatedly answer the same already-handled user event after her grade changes', async t => {
  const f = fixture(t, { directorScript: options => {
    const value = input(options), original = value.events.find(event => event.author.role === 'user');
    return directorReply(context(value), choose(whale, original));
  }, script: () => reply(['这条用户原话已经接住了。']) });
  await f.ready(); const room = await newRoom(f, [whale, dragon], '广播原话只处理一次', 'wire-stale-user');
  await broadcast(f, room); await roomSend(f, room, whale, '今天先画草图。', 'wire-user');
  const state = await settledRoom(f, room);
  assert.equal(f.calls.length, 1, 'a cooldown or remaining quota cannot create a new external message');
  assert.equal(state.room.turns.filter(turn => turn.phase === 'anchor').length, 1);
  assert.equal(state.room.turns.find(turn => turn.phase === 'anchor').user, '今天先画草图。');
});

test('a real public peer invitation permits an independent return while its same evidence cannot be consumed a second time', async t => {
  const f = fixture(t, { directorScript: options => {
    const value = input(options), said = value.events.filter(event => event.author.role === 'assistant');
    const original = value.events.find(event => event.author.role === 'user');
    const action = !said.length ? choose(whale, original) : said.length === 1 ? choose(dragon, original)
      : {...choose(whale, said.find(event => event.author.id === dragon), dragon),kind:'peer'};
    return directorReply(context(value), action);
  }, script: options => reply([input(options).speaker.id === dragon ? '鲸鲸，草图的入口放左边怎么样？' : '先把入口放在左边。']) });
  await f.ready(); const room = await newRoom(f, [whale, dragon], '新同伴消息仍可承接', 'wire-stale-peer');
  await broadcast(f, room); await roomSend(f, room, whale, '讨论一下入口位置。', 'wire-peer-user');
  const state = await settledRoom(f, room);
  assert.deepEqual(f.calls.map(options => input(options).speaker.id), [whale, dragon, whale]);
  assert.equal(input(f.calls[2]).responsePlan.to, dragon);
  assert.ok(input(f.calls[2]).exchange.some(event => event.speaker.id === dragon
    && event.messages.includes('鲸鲸，草图的入口放左边怎么样？')));
  assert.equal(state.room.turns.filter(turn => turn.phase !== 'anchor').length, 3);
});

test('a long latest public round retains its original user context and complete recent bubbles for the director', () => {
  const user = '刚才讨论的是设置页草图，先别开始改代码。';
  const first = '甲'.repeat(1600), last = '乙'.repeat(1600);
  const history = [{ id: 'prior', messageId: 'prior-user', user, status: 'ready', recipientId: whale,
    speakerName: whale, recipients: [], assistant: [first, last], privateMemory: 'DO_NOT_PROJECT_PRIVATE' }];
  const prompt = buildDirectorPrompt({ message: '那下一步呢？', members: [{ id: whale, name: whale }], history });
  const value = readChatInput(prompt);
  assert.ok(value.history.some(turn => turn.user === user), 'a size-limited recent round must not erase the whole conversational premise');
  const bubbles = value.history.flatMap(turn => turn.assistant ?? (turn.responses ?? []).flatMap(response => response.assistant ?? response.messages ?? []));
  assert.ok(bubbles.includes(last), 'keep a bounded whole latest bubble rather than dropping or fabricating the prior answer');
  assert.ok(bubbles.every(text => text === first || text === last), 'do not cut or summarize original evidence');
  assert.doesNotMatch(prompt.user, /DO_NOT_PROJECT_PRIVATE/);
});

test('short wire aliases resolve only to this projection’s canonical evidence and retain author and literal checks', () => {
  const roomId = 'room:00000000-0000-4000-8000-000000000000';
  const key = turnId => chatSchedulerEventKey({ roomId, generation: 0,
    sourceScope: JSON.stringify([roomId + ':sources:0', 'quote"slash\\']), turnId, attemptId: 'attempt-' + turnId });
  const events = [{ id: key('user-anchor'), author: { role: 'user', name: '我' }, messages: ['大家先聊入口。'] },
    { id: key('dragon-reply'), author: { role: 'assistant', id: dragon, name: dragon }, messages: ['鲸鲸，入口放左边怎么样？'] }];
  const members = [{ id: whale, name: whale, builtin: true }, { id: dragon, name: dragon, builtin: true }];
  const states = [{ id: whale, level: 1, normalRemaining: 2, peerRemaining: 1, normalReady: true, peerReady: true,
    pendingEventIds: [events[1].id], normalPendingEventIds: [] }];
  const message = events[0].messages[0], options = { message, members, events, states, sourceIds: [] };
  const projected = JSON.parse(buildDirectorPrompt(options).user);
  assert.deepEqual(projected.events.map(event => event.id), ['e1', 'e2']);
  assert.deepEqual(projected.states[0].pendingEventIds, ['e2']);
  assert.doesNotMatch(JSON.stringify(projected), /user-anchor|dragon-reply|quote\\"slash/,
    'the model should not need to copy nested canonical JSON ids');
  const action = { ...choose(whale, projected.events[1], dragon), kind: 'peer' };
  const wire = next => JSON.stringify({ context: context({ message }), next });
  const valid = parseDirector(wire(action), options);
  assert.equal(valid.next.evidence.eventId, events[1].id);
  assert.equal(valid.next.evidence.text, events[1].messages[0]);
  assert.equal(parseDirector('```json\n' + wire(action) + '\n```', options).next.evidence.eventId, events[1].id,
    'a harmless single JSON fence does not require copying long canonical ids');
  assert.equal(parseDirector('说明：' + wire(action), options).next, null);
  const duplicate = '{"context":' + JSON.stringify(context({ message })) + ',"next":null,"next":' + JSON.stringify(action) + '}';
  assert.equal(parseDirector('```json\n' + duplicate + '\n```', options).next, null,
    'fence tolerance cannot conceal duplicate authority-bearing fields');
  for (const invalid of [{ ...action, to: 'user' },
    { ...action, evidence: { ...action.evidence, eventId: 'e3' } },
    { ...action, evidence: { ...action.evidence, text: '鲸鲸，已经全部完成了。' } },
    { ...action, evidence: { ...action.evidence, index: 1 } },
    { ...action, evidence: { ...action.evidence, eventId: key('foreign-event') } }])
    assert.equal(parseDirector(wire(invalid), options).next, null);
  const noPending = { ...options, states: [{ ...states[0], pendingEventIds: [] }] };
  assert.equal(parseDirector(wire(action), noPending).next, null, 'a public event is not automatically an unconsumed event');
  const normal = { ...action, kind: 'normal' };
  assert.equal(parseDirector(wire(normal), options).next, null,
    'a real peer call may use its independent opportunity without becoming a broadcast normal invitation');
  assert.equal(parseDirector(wire(choose(whale, projected.events[0])), options).next, null,
    'genuine old user words still fail the per-persona pending-event boundary');
});

test('a long current public exchange preserves its user anchor within the budget and keeps alias evidence room-local', () => {
  const roomId = 'budget-room', sourceScope = 'budget-room:sources:0';
  const key = (turnId, owner = roomId) => chatSchedulerEventKey({ roomId: owner, generation: 0,
    sourceScope: owner === roomId ? sourceScope : 'foreign:sources:0', turnId, attemptId: 'attempt-' + turnId });
  const user = '当前用户原话。'.repeat(500);
  assert.ok(user.length > 2000 && user.length <= 4000);
  const events = [{ id: key('user-anchor'), author: { role: 'user', name: '我' }, messages: [user] },
    ...[1, 2, 3].map(number => ({ id: key('reply-' + number), author: { role: 'assistant', id: 'actor-' + number, name: '角色' + number },
      messages: [String(number).repeat(2000), '甲'.repeat(2000), '乙'.repeat(2000)] }))];
  const members = [{ id: whale, name: whale }, ...events.slice(1).map(event => ({ id: event.author.id, name: event.author.name }))];
  const states = [{ id: whale, level: 0, normalRemaining: 3, peerRemaining: 1, normalReady: true, peerReady: false,
    pendingEventIds: [events[0].id], normalPendingEventIds: [events[0].id] }];
  const options = { message: user, members, states, events, sourceIds: [] };
  const projected = JSON.parse(buildDirectorPrompt(options).user);
  const anchor = projected.events.find(event => event.author.role === 'user');
  assert.ok(anchor, 'long completed replies cannot crowd out the current user before an untouched member answers');
  assert.deepEqual(anchor.messages, [user]);
  assert.ok(projected.events.reduce((sum, event) => sum + event.messages.join('').length, 0) <= 14000);
  let previous = -1;
  for (const event of projected.events) {
    const position = event.author.role === 'user' ? 0 : events.findIndex(original => original.author.id === event.author.id);
    assert.ok(position > previous, 'retained whole events keep their actual public order'); previous = position;
    assert.deepEqual(event.messages, events[position].messages, 'budgeting never cuts or summarizes a factual bubble');
  }
  const next = { ...choose(whale, anchor), evidence: { eventId: anchor.id, index: 0, text: user.slice(0, 100) } };
  const wire = value => JSON.stringify({ context: { work: 'not-needed', sourceIds: [], request: 'answer', evidence: user.slice(0, 100) }, next: value });
  assert.equal(parseDirector(wire(next), options).next.evidence.eventId, events[0].id);
  assert.equal(parseDirector(wire({ ...next, evidence: { ...next.evidence, eventId: key('user-anchor', 'foreign-room') } }), options).next, null);
  assert.equal(parseDirector(wire({ ...next, evidence: { ...next.evidence, text: '别的来源里的原话。' } }), options).next, null);
});
