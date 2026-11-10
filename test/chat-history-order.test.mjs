import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedChatResponses, publicCoordinationHistory } from '../lib/chat-coordinator.js';
import { recentChatHistory, publicChatExchange, buildChatPrompt } from '../lib/chat-prompt.js';
import { buildTurnPlanPrompt } from '../lib/chat-turn-plan.js';
import { resolveChatQuote } from '../lib/chat-quote.js';
import { readChatInput } from './helpers/chat-input.mjs';

const recipients = [{ id: 'a', name: '甲' }, { id: 'c', name: '丙' }];
const quote = { ref: { roomId: 'room', generation: 0, kind: 'user', messageId: 'older' },
  author: { role: 'user', name: '我' }, text: '较早的引用原话。' };
const turn = (id, extra = {}) => ({ id: 'turn-' + id, messageId: 'message', attemptId: 'attempt-' + id,
  recipientId: id, speakerName: { a: '甲', b: '乙', c: '丙' }[id], recipients,
  user: '原来同时点名甲与丙。', status: 'ready', assistant: [id + ' 的第一段。', id + ' 的第二段。'],
  contextKey: 'context', scopeKey: 'room:sources:0', ...extra });
const reordered = () => [turn('a', { emittedOrder: 1, quote }), turn('b', { emittedOrder: 0 }),
  turn('c', { status: 'pending', assistant: [] })];
const ids = values => values.map(value => value.recipientId);

test('public replies follow actual starts while the unstarted seat and canonical user owner remain intact', () => {
  const turns = reordered(), original = structuredClone(turns), ordered = orderedChatResponses(turns);
  assert.deepEqual(ids(ordered), ['b', 'a', 'c']);
  assert.deepEqual(turns, original, 'ordering is a projection and never changes canonical turn or bubble indices');
  assert.equal(ordered[0], turns[1]);
  const recent = recentChatHistory(turns)[0], coordination = publicCoordinationHistory(turns)[0];
  assert.deepEqual(recent.responses.map(reply => reply.speaker.id), ['b', 'a', 'c']);
  assert.deepEqual(coordination.responses.map(reply => reply.speaker.id), ['b', 'a']);
  for (const history of [recent, coordination]) {
    assert.equal(history.user, original[0].user);
    assert.deepEqual(history.recipients, recipients, 'frozen mentions remain user order rather than response order');
    assert.deepEqual(history.quotedMessage, { author: quote.author, text: quote.text });
  }
  assert.deepEqual(publicChatExchange(turns).map(reply => reply.speaker.id), ['b', 'a']);
  assert.equal(recent.responses.at(-1).status, 'pending');
  assert.deepEqual(recent.responses.at(-1).assistant, [], 'an unstarted seat contributes no invented public speech');
});

test('the next speaking prompt and shared turn plan agree on the previous actual speaker order without copying private fields', () => {
  const history = [{ id: 'older-anchor', messageId: 'older', attemptId: 'older-attempt', phase: 'anchor',
    user: quote.text, recipients: [], status: 'ready', assistant: [], scopeKey: 'room:sources:0' }, ...reordered()];
  for (const item of history) Object.assign(item, { privateMemory: 'PRIVATE_MEMORY_MARKER',
    model: { secret: 'PRIVATE_PROVIDER_MARKER' }, pack: { identity: 'PRIVATE_CARD_MARKER' } });
  const speaking = readChatInput(buildChatPrompt({ pack: { identity: '当前角色', voice: [], samples: [], avoid: [], address: { user: '你' } },
    history, message: '继续刚才的话题。', roomId: 'room', generation: 0, scopeKey: 'room:sources:0', quotedMessage: quote }));
  const planning = JSON.parse(buildTurnPlanPrompt({ history, message: '继续刚才的话题。', recipients,
    members: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }, { id: 'c', name: '丙' }] }).user);
  assert.deepEqual(speaking.history.at(-1).responses.filter(reply => reply.status === 'ready').map(reply => reply.speaker.id), ['b', 'a']);
  assert.deepEqual(planning.history.at(-1).responses.map(reply => reply.speaker.id), ['b', 'a']);
  assert.deepEqual(planning.recipients, recipients);
  assert.deepEqual(planning.history.at(-1).recipients, recipients);
  assert.deepEqual({ ref: speaking.quotedMessage.ref, author: speaking.quotedMessage.author, text: speaking.quotedMessage.text }, quote);
  assert.doesNotMatch(JSON.stringify([speaking, planning]), /PRIVATE_MEMORY_MARKER|PRIVATE_PROVIDER_MARKER|PRIVATE_CARD_MARKER|emittedOrder/);
});

test('visual response ordering never changes a quoted second bubble or its original author and attempt', () => {
  const turns = reordered(), room = { id: 'room', generation: 0, turns };
  const pointer = { roomId: 'room', generation: 0, kind: 'assistant', turnId: 'turn-a', attemptId: 'attempt-a', index: 1 };
  const original = resolveChatQuote(room, pointer, 'room:sources:0');
  orderedChatResponses(turns); recentChatHistory(turns); publicCoordinationHistory(turns); publicChatExchange(turns);
  assert.deepEqual(resolveChatQuote(room, pointer, 'room:sources:0'), original);
  assert.equal(original.text, 'a 的第二段。');
  assert.deepEqual(original.author, { role: 'assistant', id: 'a', name: '甲' });
  assert.deepEqual(original.ref, pointer);
  assert.deepEqual(turns.map(item => item.id), ['turn-a', 'turn-b', 'turn-c']);
});

test('old ready replies retain canonical order and only protocol-valid emitted ordinals can reorder them', () => {
  const legacy = [turn('a'), turn('b'), turn('c')];
  assert.deepEqual(ids(orderedChatResponses(legacy)), ['a', 'b', 'c']);
  assert.deepEqual(publicChatExchange(legacy).map(reply => reply.speaker.id), ['a', 'b', 'c']);
  for (const invalid of [-1, 32, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const values = [turn('a', { emittedOrder: invalid }), turn('b', { emittedOrder: 0 })];
    assert.deepEqual(ids(orderedChatResponses(values)), ['a', 'b'], String(invalid));
  }
  const valid = [turn('a', { emittedOrder: 11 }), turn('b', { emittedOrder: 0 })];
  assert.deepEqual(ids(orderedChatResponses(valid)), ['b', 'a']);
});

test('started failures keep their real position while unstarted pending seats do not precede published replies', () => {
  const turns = [turn('c', { status: 'pending', assistant: [] }), turn('a', { emittedOrder: 1 }),
    turn('b', { emittedOrder: 0, status: 'failed', assistant: [] })];
  const history = recentChatHistory(turns)[0];
  assert.deepEqual(history.responses.map(reply => [reply.speaker.id, reply.status]), [['b', 'failed'], ['a', 'ready'], ['c', 'pending']]);
  assert.deepEqual(publicChatExchange(turns), [{ speaker: { id: 'a', name: '甲' }, messages: ['a 的第一段。', 'a 的第二段。'] }]);
  assert.deepEqual(publicCoordinationHistory(turns)[0].responses.map(reply => reply.speaker.id), ['a']);
});
