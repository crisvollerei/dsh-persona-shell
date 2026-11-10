import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaChat, parseChatReply, parseChatResponse, CHAT_LIMITS } from '../lib/persona-chat.js';
import { buildChatPrompt } from '../lib/chat-prompt.js';
import { readChatInput } from './helpers/chat-input.mjs';
const send = (chat, id = 'one', personaId = 'whale', revision = chat.read(personaId)?.revision ?? 0) =>
  chat.send({ personaId, name: personaId, requestId: id, content: '用户原话 ' + id, revision, epoch: chat.epoch() });
const finish = (chat, start, extra = {}) => chat.finish({ personaId: start.room.personaId, roomId: start.room.id,
  id: start.turn.id, attemptId: start.turn.attemptId, status: 'ready', messages: ['第一句。', '第二句。'], ...extra });

test('provider replies tolerate a complete JSON fence or ordinary paragraphs without accepting broken protocol', () => {
  assert.deepEqual(parseChatResponse('```json\n{"messages":["在呢。","慢慢聊。"]}\n```'), ['在呢。', '慢慢聊。']);
  assert.deepEqual(parseChatResponse('在呢。\n\n慢慢聊。'), ['在呢。', '慢慢聊。']);
  for (const wire of ['{"messages":["未完成"', '["不支持的数组"]', '{"messages":["好"],"thinking":"SECRET"}',
    '```json\n{"messages":["没闭合"]}', '<think>SECRET</think>好', '先想一想\n<thinking>SECRET</thinking>', '好'.repeat(2001)]) {
    assert.equal(parseChatResponse(wire), undefined, wire.slice(0, 40));
  }
});

test('retry against a changed scope requires explicit acknowledgement and retires old attempts', async () => {
  const chat = createPersonaChat(); const first = await send(chat); await finish(chat, first, { status: 'failed', failure: 'format' });
  const body = { personaId: 'whale', id: first.turn.id, attemptId: 'new-scope', revision: 2, name: '鲸', contextKey: 'context:new:2' };
  await assert.rejects(chat.retry(body), /chat-context-changed/);
  const retried = await chat.retry({ ...body, previousContextKey: null });
  assert.equal(retried.turn.contextKey, 'context:new:2'); assert.equal(retried.turn.failure, null);
  assert.equal(chat.read('whale').turns.length, 1); assert.equal(await finish(chat, first), false);
  assert.equal((await chat.retry({ ...body, previousContextKey: null })).created, false);
});

test('a user message is visible only after storage acknowledges it; failures retain the old state', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const chat = createPersonaChat({ persist: async () => gate }); const task = send(chat);
  await Promise.resolve(); assert.equal(chat.read('whale'), null); release(); await task;
  assert.equal(chat.read('whale').turns[0].user, '用户原话 one');
  const failed = createPersonaChat({ persist: async () => { throw Error('disk'); } });
  await assert.rejects(send(failed), /disk/); assert.equal(failed.read('whale'), null);
});

test('repeated delivery of one client id is idempotent even after a completed answer', async () => {
  let writes = 0; const chat = createPersonaChat({ persist: async () => { writes++; } });
  const first = await send(chat); await finish(chat, first); const duplicate = await send(chat, 'one', 'whale', 0);
  assert.equal(duplicate.created, false); assert.equal(duplicate.turn.status, 'ready');
  assert.equal(writes, 2); assert.equal(chat.read('whale').turns.length, 1);
  await assert.rejects(chat.send({ personaId: 'whale', name: '鲸', requestId: 'one', content: '不同的内容', revision: 0 }), /id-conflict/);
});

test('persona ids isolate histories and stale versions cannot append or clear messages', async () => {
  const chat = createPersonaChat(); const whale = await send(chat); await finish(chat, whale);
  await send(chat, 'dragon-one', 'dragon');
  assert.equal(chat.read('dragon').turns[0].user, '用户原话 dragon-one');
  assert.equal(chat.read('whale').turns[0].user, '用户原话 one');
  await assert.rejects(send(chat, 'two', 'whale', 0), /conflict/);
  await assert.rejects(chat.clear({ personaId: 'whale', revision: 0 }), /conflict/);
});

test('one persona cannot queue another message while its current reply is pending', async () => {
  const chat = createPersonaChat(); await send(chat);
  await assert.rejects(send(chat, 'two'), /busy/); assert.equal(chat.read('whale').turns.length, 1);
});

test('retry reuses the user bubble and an older attempt cannot overwrite its answer', async () => {
  const chat = createPersonaChat(); const first = await send(chat); await finish(chat, first, { status: 'failed' });
  const retry = await chat.retry({ personaId: 'whale', id: 'one', attemptId: 'retry-1', revision: 2, name: '鲸' });
  assert.equal(chat.read('whale').turns.length, 1);
  assert.equal(await finish(chat, first), false); await finish(chat, retry);
  const duplicate = await chat.retry({ personaId: 'whale', id: 'one', attemptId: 'retry-1', revision: 2, name: '鲸' });
  assert.equal(duplicate.created, false); assert.equal(duplicate.turn.status, 'ready');
});

test('cancel and clear retire attempts, including after creating another room for the same persona', async () => {
  const chat = createPersonaChat(); const first = await send(chat);
  await chat.cancel({ personaId: 'whale', id: first.turn.id, attemptId: first.turn.attemptId });
  assert.equal(await finish(chat, first), false);
  await chat.clear({ personaId: 'whale', revision: 2 });
  const next = await send(chat, 'new'); assert.notEqual(next.room.id, first.room.id);
  assert.equal(await finish(chat, first), false); await finish(chat, next);
  assert.equal(chat.read('whale').turns.length, 1);
});

test('invalidated persona or memory during a slow answer save repairs storage and never publishes the old reply', async () => {
  let value, block = false, release, began;
  const gate = new Promise((r) => { release = r; }); const started = new Promise((r) => { began = r; });
  const chat = createPersonaChat({ persist: async (next) => { if (block) { block = false; began(); await gate; } value = next; } });
  const first = await send(chat); let valid = true; block = true;
  const task = finish(chat, first, { valid: () => valid }); await started; valid = false; release();
  assert.equal(await task, false); assert.equal(chat.read('whale').turns[0].status, 'pending');
  assert.deepEqual(value.rooms[0].turns[0].assistant, []);
});

test('restoration never resumes generation and rejects malformed or partial role messages', async () => {
  const chat = createPersonaChat(); await send(chat); const raw = chat.snapshot();
  raw.rooms[0].turns.push({ ...raw.rooms[0].turns[0], id: 'bad', status: 'ready', assistant: [''] });
  const next = createPersonaChat(); next.restore(raw);
  assert.equal(next.read('whale').turns.length, 1); assert.equal(next.read('whale').turns[0].status, 'interrupted');
  assert.equal(parseChatReply('{"messages":["good"],"tool":"run"}'), undefined);
  assert.equal(parseChatReply('{"messages":["partial"'), undefined);
  assert.equal(parseChatReply(JSON.stringify({ messages: Array(7).fill('too many') })), undefined);
});

test('history stays bounded and context contains only recent chat, style and supplied memory', async () => {
  const chat = createPersonaChat();
  for (let n = 0; n < CHAT_LIMITS.turns + 2; n++) { const start = await send(chat, 'm' + n); await finish(chat, start); }
  const room = chat.read('whale'); assert.equal(room.turns.length, CHAT_LIMITS.turns);
  const prompt = buildChatPrompt({ pack: { identity: '角色设定', voice: ['轻松'], samples: ['语气'], avoid: ['禁区'],
    report: ['DO_NOT_IMPORT_REPORT_RULES'], address: { user: '你' } }, history: room.turns,
    message: '最新消息', memory: ['叫我阿晴'], roomId: room.id,
    generation: room.generation, scopeKey: room.turns[0].scopeKey });
  assert.equal(readChatInput(prompt).history.length, CHAT_LIMITS.history);
  assert.doesNotMatch(prompt.system, /DO_NOT_IMPORT_REPORT_RULES/); assert.match(prompt.system, /叫我阿晴/);
  assert.doesNotMatch(prompt.system, /goalHasAttachments|reportStatus/); assert.match(prompt.system, /没有工具执行/); assert.match(prompt.system, /人格本人聊天[^\n]*正式工作转述由另一渠道承载/);
});

test('chat capacity refuses new rooms without evicting another persona, and a clear frees capacity', async () => {
  const chat = createPersonaChat();
  for (let i = 0; i < CHAT_LIMITS.rooms; i++) await send(chat, 'm', 'persona-' + i);
  await assert.rejects(send(chat, 'm', 'extra'), /capacity/);
  assert.equal(chat.read('persona-0').turns.length, 1);
  await chat.clear({ personaId: 'persona-0', revision: 1 }); await send(chat, 'm', 'extra');
  assert.equal(chat.snapshot().rooms.length, CHAT_LIMITS.rooms);
});

test('chat context budget retains whole original user statements and complete bubbles with explicit omissions', () => {
  const history = Array.from({ length: 8 }, (_, n) => ({ id: 'turn-' + n, messageId: 'message-' + n,
    attemptId: 'attempt-' + n, roomId: 'room', scopeKey: null, recipientId: 'a', speakerName: '甲', recipients: [],
    user: String(n) + '好'.repeat(3999), assistant: ['首'.repeat(2000), '续'.repeat(2000), '末'.repeat(1000)], status: 'ready' }));
  const prompt = buildChatPrompt({ pack: { identity: '角色', voice: [], samples: [], avoid: [], address: { user: '你' } },
    history, message: '现在', memory: [], roomId: 'room', scopeKey: null });
  const value = readChatInput(prompt), retained = value.history;
  assert.equal(retained.length, 8, 'omitted groups remain author/status pointers rather than invented or clipped text');
  assert.equal(retained.at(-1).user, history[7].user); assert.deepEqual(retained.at(-1).assistant, history[7].assistant);
  assert.ok(retained.some(group => group.omittedBubbles), 'the budget explicitly marks excluded full bubbles');
  let chars = value.message.length;
  for (const [index, group] of retained.entries()) {
    assert.ok(group.user === '' || group.user === history[index].user, 'a user statement is never sliced');
    assert.ok(group.assistant.every(bubble => history[index].assistant.includes(bubble)), 'assistant bubbles remain exact originals');
    assert.deepEqual(group.recipient, { id: 'a', name: '甲' }); assert.equal(group.status, 'ready');
    chars += group.user.length + group.assistant.reduce((count, bubble) => count + bubble.length, 0);
  }
  assert.ok(chars <= 18000); assert.ok(chars > 9000, 'the newer budget can retain complete bubbles from more than one group');
});

test('clearing retires old sends, clears and cancels even when a new room reuses the same revision', async () => {
  const chat = createPersonaChat(); const start = await send(chat); await finish(chat, start);
  await chat.clear({ personaId: 'whale', revision: 2, epoch: 0 });
  await assert.rejects(chat.send({ personaId: 'whale', name: 'whale', requestId: 'late-old-send', content: '不应恢复', revision: 0, epoch: 0 }), /chat-conflict/);
  const fresh = await send(chat, 'new'); await finish(chat, fresh);
  await assert.rejects(chat.clear({ personaId: 'whale', revision: 2, epoch: 0 }), /chat-conflict/);
  await assert.rejects(chat.cancel({ personaId: 'whale', id: fresh.turn.id, attemptId: fresh.turn.attemptId, epoch: 0 }), /chat-conflict/);
  assert.equal(chat.read('whale').turns[0].user, '用户原话 new');
  const restored = createPersonaChat(); restored.restore(chat.snapshot()); assert.equal(restored.epoch(), 1);
  assert.deepEqual(restored.contacts(), [{ personaId: 'whale', name: 'whale' }]);
});
