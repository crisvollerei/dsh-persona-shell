import test from 'node:test';
import assert from 'node:assert/strict';
import { chatAssignment } from '../lib/chat-discussion.js';
import { buildChatPrompt } from '../lib/chat-prompt.js';
import { buildParticipationPrompt, parseParticipation } from '../lib/chat-participation.js';
import { parseChatResponse } from '../lib/persona-chat.js';
import { readChatInput } from './helpers/chat-input.mjs';

const pack = { identity: '保持当前角色身份', voice: ['保持当前角色语气'], samples: [], avoid: [], report: ['REPORT_RULE_NOT_FOR_CHAT'], address: { user: '你' } };
const recipients = [{ id: 'b', name: '乙' }, { id: 'a', name: '甲' }];
const turn = (id = 'a', phase = 'primary') => ({ recipientId: id, phase, recipients });
const prompt = extra => buildChatPrompt({ pack, history: [], message: '你们分别说说看法', roomId: 'room', generation: 3,
  speaker: { id: 'a', name: '甲' }, recipients, ...extra });
const read = readChatInput;
const user = (messageId, text) => ({ ref: { roomId: 'room', generation: 3, kind: 'user', messageId }, author: { role: 'user', name: '我' }, text });
const proposal = (id = 'one', extra = {}) => ({ id, version: 1, title: '一项候选', status: 'proposal', reviewedBy: 'user-in-settings',
  source: { ref: { roomId: 'room', generation: 3, kind: 'assistant', turnId: 't', attemptId: 'a', index: 0 }, author: { role: 'assistant', id: 'b', name: '乙' }, text: '可以先画一张草图。' },
  evidence: null, ...extra });
const originalTurn = (extra = {}) => ({ id: 't', messageId: 'original', attemptId: 'a', roomId: 'room', scopeKey: null,
  recipientId: 'b', speakerName: '乙', user: '先讨论草图。', recipients, status: 'ready', assistant: ['可以先画一张草图。'], ...extra });
const originalUser = (messageId, content) => ({ id: 'anchor-' + messageId, messageId, attemptId: 'attempt-' + messageId,
  roomId: 'room', scopeKey: null, phase: 'anchor', recipientId: 'user', user: content, recipients: [], status: 'ready', assistant: [] });

test('temporary duties follow frozen mention order and completed public speech, independently of persona identity', () => {
  const publicReply = [{ speaker: { id: 'b', name: '乙' }, messages: ['先解释一个主要观点。'] }];
  assert.deepEqual(chatAssignment(turn('b'), []), { kind: 'respond', order: 1, primaryCount: 2 });
  assert.deepEqual(chatAssignment(turn('a'), publicReply), { kind: 'complement', order: 2, primaryCount: 2 });
  const reversed = { ...turn('b'), recipients: recipients.slice().reverse() };
  assert.deepEqual(chatAssignment(reversed, [{ speaker: { id: 'a', name: '甲' }, messages: ['现在甲先讲。'] }]), { kind: 'complement', order: 2, primaryCount: 2 });
  assert.deepEqual(recipients.map(p => p.id), ['b', 'a']);
});

test('failed, pending and empty predecessor replies cannot assign a second primary to complement unavailable speech', () => {
  for (const exchange of [[], [{ speaker: { id: 'b' }, messages: [] }], [{ speaker: { id: 'b' }, messages: [''] }],
    [{ status: 'failed', recipientId: 'b', assistant: ['REJECTED_PREVIEW'] }], [{ status: 'pending', recipientId: 'b', assistant: ['STREAMING_PREVIEW'] }]]) {
    assert.equal(chatAssignment(turn(), exchange).kind, 'respond');
  }
  assert.equal(chatAssignment(turn(), [{ status: 'ready', recipientId: 'b', assistant: ['完整公开内容。'] }]).kind, 'complement');
  const fallback = read(prompt({ assignment: { kind: 'complement', order: 2, primaryCount: 2 }, exchange: [
    { status: 'failed', recipientId: 'b', speakerName: '乙', assistant: ['DO_NOT_TREAT_AS_PUBLIC'] }] }));
  assert.equal(fallback.assignment.kind, 'respond'); assert.deepEqual(fallback.exchange, []);
  assert.doesNotMatch(JSON.stringify(fallback), /DO_NOT_TREAT_AS_PUBLIC/);
});

test('listener and one-time return duties retain the original addressees without turning them into new primary seats', () => {
  assert.deepEqual(chatAssignment(turn('c', 'reaction')), { kind: 'contribute', primaryCount: 2 });
  assert.deepEqual(chatAssignment(turn('b', 'followup')), { kind: 'answer-peer', order: 1, primaryCount: 2 });
  const result = read(prompt({ phase: 'reaction', assignment: { kind: 'contribute', primaryCount: 2, privateMemory: 'NOT_PUBLIC' } }));
  assert.deepEqual(result.recipients, recipients); assert.deepEqual(result.assignment, { kind: 'contribute', primaryCount: 2 });
  assert.doesNotMatch(JSON.stringify(result), /NOT_PUBLIC/);
});

test('duties leave the speaker card and own expression preferences intact, while preserving strict chat output', () => {
  const result = prompt({ memory: ['本人称呼偏好'], assignment: { kind: 'respond', order: 2, primaryCount: 2 } });
  assert.match(result.system, /保持当前角色身份/); assert.match(result.system, /保持当前角色语气/); assert.match(result.system, /本人称呼偏好/);
  assert.doesNotMatch(result.system, /REPORT_RULE_NOT_FOR_CHAT/);
  assert.deepEqual(read(result).assignment, { kind: 'respond', order: 2, primaryCount: 2 });
  assert.deepEqual(parseChatResponse('{"messages":["一句自然回应。"]}'), ['一句自然回应。']);
  assert.equal(parseChatResponse('{"messages":["一句自然回应。"],"assignment":"respond"}'), undefined);
});

test('room discussion context preserves exact source authors and owner-reviewed states without promoting proposals to decisions', () => {
  const items = [proposal(), proposal('two', { title: '已经选定草图', status: 'confirmed', evidence: user('confirmation', '就先采用这张草图。') }),
    proposal('three', { status: 'deferred', evidence: user('postpone', '这张草图先放一放。') })];
  const result = read(prompt({ discussionState: items, memory: [], history: [originalTurn(),
    originalUser('confirmation', '就先采用这张草图。'), originalUser('postpone', '这张草图先放一放。')] }));
  assert.deepEqual(result.discussionState.map(({ source, evidence, ...item }) => ({ ...item,
    source: { ref: source.ref, author: source.author, text: source.text },
    evidence: evidence ? { ref: evidence.ref, author: evidence.author, text: evidence.text } : null })), items);
  assert.deepEqual(result.discussionState.map(e => e.status), ['proposal', 'confirmed', 'deferred']);
  assert.equal(result.discussionState[0].source.author.id, 'b'); assert.equal(result.discussionState[1].evidence.author.role, 'user');
  assert.equal(result.memory, undefined); assert.deepEqual(items[0].evidence, null);
});

test('discussion projection excludes unreviewed, foreign, cleared and unsupported decision evidence and private extra fields', () => {
  const original = proposal();
  const invalid = [proposal('foreign', { source: { ...original.source, ref: { ...original.source.ref, roomId: 'another-room' }, text: 'FOREIGN_ROOM' } }),
    proposal('cleared', { source: { ...original.source, ref: { ...original.source.ref, generation: 2 }, text: 'CLEARED_ROOM' } }),
    proposal('guess', { reviewedBy: 'model', source: { ...original.source, text: 'UNREVIEWED_GUESS' } }),
    proposal('unconfirmed', { status: 'confirmed', source: { ...original.source, text: 'NO_USER_CONFIRMATION' }, evidence: original.source })];
  const retained = proposal('allowed', { privateMemory: 'PRIVATE_MEMORY', source: { ...original.source, privateSample: 'PRIVATE_SAMPLE' } });
  const result = read(prompt({ discussionState: [...invalid, retained], history: [originalTurn()] }));
  assert.equal(result.discussionState.length, 1); assert.equal(result.discussionState[0].id, 'allowed');
  assert.doesNotMatch(JSON.stringify(result), /FOREIGN_ROOM|CLEARED_ROOM|UNREVIEWED_GUESS|NO_USER_CONFIRMATION|PRIVATE_MEMORY|PRIVATE_SAMPLE/);
});

test('discussion context bounds whole source statements instead of clipping or copying arbitrary room metadata', () => {
  const long = '整句原话。'.repeat(180), source = proposal().source;
  const result = read(prompt({ history: [originalTurn({ assistant: [long] })],
    discussionState: Array.from({ length: 20 }, (_, i) => proposal('topic-' + i, { source: { ...source, text: long } })) }));
  assert.ok(result.discussionState.length > 0 && result.discussionState.length <= 8);
  assert.ok(result.discussionState.reduce((n, item) => n + item.title.length + item.source.text.length, 0) <= 3000);
  assert.ok(result.discussionState.every(item => item.source.text === long));
});

test('the shared listener judge keeps a bounded subset protocol and sees no discussion board or private state', () => {
  const result = buildParticipationPrompt({ message: '还有别的角度吗', recipients, exchange: [], limit: 1,
    candidates: [{ id: 'c', name: '丙', pack, memory: ['PRIVATE_MEMORY'] }], discussionState: [proposal()] });
  assert.equal(read(result).discussionState, undefined); assert.doesNotMatch(result.user, /PRIVATE_MEMORY|一项候选/);
  assert.deepEqual(parseParticipation('{"participants":["c"]}', ['c'], 1), ['c']);
  assert.deepEqual(parseParticipation('{"participants":["c"],"discussionState":[]}', ['c'], 1), []);
});
