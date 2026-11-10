import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatInputQueue } from '../lib/chat-input-queue.js';

const recipients = [{ id: 'a', name: '甲' }];
const input = (requestId, content = requestId, extra = {}) => ({ roomId: 'room', requestId, content, recipients,
  memberIds: ['a', 'b'], referenceRevision: 0, scopeKey: 'scope', contextKey: 'context', ...extra });
const quote = (messageId = 'quoted') => ({ author: { role: 'user', name: 'ignored user alias' }, text: '公开原话',
  ref: { roomId: 'room', generation: 1, kind: 'user', messageId } });

test('default transport has no room-wide cooldown and preserves raw split messages in a single bounded pending batch', async () => {
  let now = 0; const q = createChatInputQueue({ now: () => now });
  const first = await q.enqueue(input('one', '第一段原话。')), second = await q.enqueue(input('two', '第二段\n仍是原话。'));
  assert.equal(first.created, true); assert.equal(second.merged, true); assert.equal(second.batch.id, 'one');
  assert.deepEqual(second.batch.parts, [{ id: 'one', text: '第一段原话。', at: 0 }, { id: 'two', text: '第二段\n仍是原话。', at: 0 }]);
  assert.equal(second.batch.message, '第一段原话。\n第二段\n仍是原话。'); assert.equal(q.notBefore('room'), 0);
  assert.equal((await q.claim('room', 'one')).status, 'sending'); await q.complete('room', 'one'); await q.finishRound('room');
  await q.enqueue(input('three')); assert.ok(await q.claim('room', 'three'), 'the per-persona scheduler, rather than transport, controls model pacing');
});

test('merging requires the same frozen mention order, membership, reference revision, scope, context and quotation', async () => {
  const cases = [
    { recipients: [{ id: 'b', name: '乙' }] }, { memberIds: ['b', 'a'] }, { referenceRevision: 1 },
    { scopeKey: 'different' }, { contextKey: 'different' }, { quote: quote('another') },
  ];
  for (const change of cases) {
    const q = createChatInputQueue({ now: () => 0 }); await q.enqueue(input('one', '原话', { quote: quote() }));
    const next = await q.enqueue(input('two', '新原话', { quote: quote(), ...change }));
    assert.equal(next.merged, false, JSON.stringify(change)); assert.equal(q.list('room').length, 2);
  }
  const q = createChatInputQueue({ now: () => 0 });
  await q.enqueue(input('one', '原话', { recipients: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] }));
  assert.equal((await q.enqueue(input('two', '新原话', { recipients: [{ id: 'b', name: '乙' }, { id: 'a', name: '甲' }] }))).merged, false);
});

test('broadcast input preserves an empty mention list and requires an explicit frozen member roster', async () => {
  const q = createChatInputQueue({ now: () => 0 });
  await assert.rejects(q.enqueue({ roomId: 'room', requestId: 'missing-roster', content: '大家好', recipients: [] }), /invalid-chat-input/);
  const first = await q.enqueue(input('broadcast', '大家好', { recipients: [] }));
  assert.deepEqual(first.batch.recipients, []); assert.deepEqual(first.batch.memberIds, ['a', 'b']);
  const second = await q.enqueue(input('broadcast-part', '再补充一句', { recipients: [] }));
  assert.equal(second.merged, true); assert.equal(second.batch.message, '大家好\n再补充一句');
  assert.deepEqual(second.batch.parts.map(part => part.id), ['broadcast', 'broadcast-part']);
  const restored = createChatInputQueue({ now: () => 0 }); await restored.restore(q.snapshot());
  assert.deepEqual(restored.list('room')[0].recipients, []); assert.deepEqual(restored.list('room')[0].memberIds, ['a', 'b']);
});

test('up to eight ordered mentions survive buffering and restoration while another order remains a separate batch', async () => {
  const q = createChatInputQueue({ now: () => 0 }), members = Array.from({ length: 8 }, (_, index) => 'p' + index);
  const people = members.map((id, index) => ({ id, name: '角色' + index }));
  await q.enqueue(input('all-eight', '按这次顺序选中', { recipients: people, memberIds: members }));
  const same = await q.enqueue(input('all-eight-part', '仍然是同一批', { recipients: people, memberIds: members }));
  assert.equal(same.merged, true); assert.deepEqual(same.batch.recipients, people);
  const reversed = [...people].reverse();
  assert.equal((await q.enqueue(input('reverse-eight', '这次换个顺序', { recipients: reversed, memberIds: members }))).merged, false);
  const restored = createChatInputQueue({ now: () => 0 }); await restored.restore(q.snapshot());
  assert.deepEqual(restored.list('room').map(batch => batch.recipients), [people, reversed]);
  await assert.rejects(q.enqueue(input('nine', '超出房间容量', { recipients: [...people, { id: 'p8', name: '角色8' }], memberIds: [...members, 'p8'] })), /invalid-chat-input/);
});

test('requests are idempotent per room before and after completion, while conflicting content and scope are refused', async () => {
  const q = createChatInputQueue({ now: () => 0 }); await q.enqueue(input('one', '原话'));
  const before = q.snapshot(), replay = await q.enqueue(input('one', '原话', { at: 100, clientTime: { timeZone: 'Asia/Tokyo' } }));
  assert.equal(replay.created, false); assert.equal(replay.completed, false); assert.deepEqual(q.snapshot(), before);
  await assert.rejects(q.enqueue(input('one', '不同原话')), /chat-input-conflict/);
  await assert.rejects(q.enqueue(input('one', '原话', { referenceRevision: 2 })), /chat-input-conflict/);
  await q.complete('room', 'one'); const done = q.snapshot();
  const completed = await q.enqueue(input('one', '原话')); assert.equal(completed.created, false); assert.equal(completed.completed, true); assert.equal(completed.batch, null);
  assert.deepEqual(q.snapshot(), done); assert.equal(q.peek('room'), null);
  assert.equal((await q.enqueue(input('one', '另一房间的原话', { roomId: 'other' }))).created, true);
});

test('a sending batch is locked, later input gets its own batch, and failed input does not block a newer pending batch', async () => {
  const q = createChatInputQueue({ now: () => 0 }); await q.enqueue(input('first')); const locked = await q.claim('room', 'first');
  const second = await q.enqueue(input('second')); assert.equal(second.merged, false); assert.deepEqual(locked.parts.map(part => part.id), ['first']);
  assert.equal(q.peek('room'), null); assert.equal(await q.claim('room', 'second'), null);
  await q.fail('room', 'first', 'provider secret with credentials');
  assert.equal(q.list('room')[0].failure, 'unknown'); assert.equal(q.peek('room').id, 'second');
  assert.ok(await q.claim('room', 'second')); assert.equal((await q.retry('room', 'first')).status, 'pending');
  assert.equal(q.peek('room'), null); await q.complete('room', 'second'); assert.equal(q.peek('room').id, 'first');
  assert.ok(await q.claim('room', 'first'));
  assert.doesNotMatch(JSON.stringify(q.snapshot()), /provider secret|credentials/);
});

test('cancelling affects one pending or failed batch, preserves other input, and tombstones old acknowledgements', async () => {
  const q = createChatInputQueue({ now: () => 0 }); await q.enqueue(input('one')); await q.enqueue(input('two', '不同引用', { quote: quote() }));
  assert.equal(await q.cancel('room', 'one'), true); assert.deepEqual(q.list('room').map(batch => batch.id), ['two']);
  const old = await q.enqueue(input('one')); assert.equal(old.created, false); assert.equal(old.completed, true); assert.equal(old.cancelled, true);
  await q.claim('room', 'two'); await assert.rejects(q.cancel('room', 'two'), /chat-input-busy/);
  await q.fail('room', 'two', 'network'); assert.equal(await q.cancel('room', 'two'), true); assert.equal(q.list('room').length, 0);
});

test('only explicit generation retirement forgets that room receipts while ordinary clearing keeps replay protection', async () => {
  const q = createChatInputQueue({ now: () => 0 });
  await q.enqueue(input('same-id', '旧一代原话'));
  await q.enqueue(input('same-id', '另一房间的原话', { roomId: 'other' }));
  await q.complete('other', 'same-id');
  await q.clear('room');
  assert.equal((await q.enqueue(input('same-id', '旧一代原话'))).cancelled, true);
  await assert.rejects(q.enqueue(input('same-id', '新一代原话')), /chat-input-conflict/);
  assert.equal(await q.clear('room', { forgetReceipts: true }), true, 'receipt retirement also works after the room queue was already removed');
  assert.equal(q.snapshot().receipts.some(receipt => receipt.roomId === 'room'), false);
  const fresh = await q.enqueue(input('same-id', '新一代原话', { referenceRevision: 1 }));
  assert.equal(fresh.created, true); assert.equal(fresh.batch.message, '新一代原话');
  assert.equal((await q.enqueue(input('same-id', '另一房间的原话', { roomId: 'other' }))).completed, true);
  assert.equal(q.snapshot().receipts.filter(receipt => receipt.roomId === 'other').length, 1);
});

test('batch and room capacities count all retained public input and leave state unchanged when full', async () => {
  const q = createChatInputQueue({ now: () => 0 });
  for (let index = 0; index < 16; index++) await q.enqueue(input('p' + index, '字'));
  assert.deepEqual(q.list('room').map(batch => batch.parts.length), [8, 8]); const full = q.snapshot();
  await assert.rejects(q.enqueue(input('overflow', '字')), /chat-input-capacity/); assert.deepEqual(q.snapshot(), full);
  const long = createChatInputQueue({ now: () => 0 });
  for (let index = 0; index < 4; index++) await long.enqueue(input('long' + index, '字'.repeat(4000)));
  assert.equal(long.list('room').length, 4); await assert.rejects(long.enqueue(input('too-many-chars', '字')), /chat-input-capacity/);
  const rooms = createChatInputQueue({ now: () => 0 });
  for (let index = 0; index < 32; index++) await rooms.enqueue(input('same-id', '原话', { roomId: 'r' + index }));
  await assert.rejects(rooms.enqueue(input('same-id', '原话', { roomId: 'r32' })), /chat-input-capacity/);
  await rooms.clear('r0'); assert.equal((await rooms.enqueue(input('same-id', '原话', { roomId: 'r32' }))).created, true);
});

test('public quote, members and client time are cloned and private extras never enter stored batches', async () => {
  const q = createChatInputQueue({ now: () => 0 }), source = input('one', '公开输入', {
    quote: { ...quote(), privateMemory: 'QUOTE_PRIVATE', author: { role: 'user', name: 'USER_PRIVATE_ALIAS', private: 'AUTHOR_PRIVATE' } },
    clientTime: { timeZone: 'Asia/Hong_Kong', utcOffsetMinutes: 480, privateMemory: 'TIME_PRIVATE' },
  });
  const pending = q.enqueue(source); source.content = 'CALLER_MUTATION'; source.memberIds.push('outside');
  const saved = (await pending).batch; assert.equal(saved.message, '公开输入'); assert.deepEqual(saved.memberIds, ['a', 'b']);
  assert.deepEqual(saved.clientTime, { timeZone: 'Asia/Hong_Kong', utcOffsetMinutes: 480 }); assert.equal(saved.quote.author.name, '我');
  assert.deepEqual(saved.quote.ref, quote().ref); assert.doesNotMatch(JSON.stringify(q.snapshot()), /PRIVATE|CALLER_MUTATION|outside/);
  saved.parts[0].text = 'RETURN_MUTATION'; const listed = q.list('room'); listed[0].recipients[0].name = 'MUTATED';
  assert.equal(q.peek('room').message, '公开输入'); assert.equal(q.peek('room').recipients[0].name, '甲');
});

test('writes serialize and become visible only after persistence, without changing receipt timestamps while a write waits', async () => {
  let now = 0, release, entered; const started = new Promise(resolve => { entered = resolve; }), persisted = [];
  const q = createChatInputQueue({ now: () => now, persist: async value => { persisted.push(value); if (persisted.length === 1) { entered(); await new Promise(resolve => { release = resolve; }); } } });
  const first = q.enqueue(input('first')); await started; assert.equal(q.snapshot().revision, 0); assert.deepEqual(q.list('room'), []);
  now = 100; const secondInput = input('second'), second = q.enqueue(secondInput); secondInput.content = 'MUTATED'; now = 1000;
  let drained = false; const drainedPromise = q.drain().then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false);
  release(); await Promise.all([first, second, drainedPromise]);
  assert.deepEqual(persisted.map(value => value.revision), [1, 2]); assert.equal(q.snapshot().revision, 2);
  assert.deepEqual(q.peek('room').parts.map(part => [part.id, part.at]), [['first', 0], ['second', 100]]);
  assert.equal(q.peek('room').message, 'first\nsecond');
});

test('failed persistence preserves the previous durable state and later writes may retry normally', async () => {
  let diskFailure = false; const q = createChatInputQueue({ now: () => 0, persist: async () => { if (diskFailure) throw Error('disk private details'); } });
  await q.enqueue(input('first')); const before = q.snapshot(); diskFailure = true;
  await assert.rejects(q.enqueue(input('second')), /chat-input-save-failed/); assert.deepEqual(q.snapshot(), before);
  await assert.rejects(q.claim('room', 'first'), /chat-input-save-failed/); assert.deepEqual(q.snapshot(), before);
  diskFailure = false; const second = await q.enqueue(input('second')); assert.equal(second.created, true); assert.equal(q.snapshot().revision, before.revision + 1);
  await q.drain();
});

test('restart preserves public parts, converts both pending and sending to manual-retry failures, and never auto-claims', async () => {
  const first = createChatInputQueue({ now: () => 0 }); await first.enqueue(input('one')); await first.claim('room', 'one');
  await first.enqueue(input('two')); await first.enqueue(input('three', '另一批', { quote: quote() })); await first.fail('room', 'three', 'source-changed');
  const snapshot = first.snapshot(), restored = createChatInputQueue({ now: () => 1000 });
  const result = await restored.restore(snapshot); snapshot.rooms[0].batches[0].message = 'CALLER_MUTATION';
  assert.equal(result.revision, first.snapshot().revision + 1); assert.equal(restored.peek('room'), null);
  assert.deepEqual(restored.list('room').map(batch => [batch.id, batch.status, batch.failure]), [['one', 'failed', 'interrupted'], ['two', 'failed', 'interrupted'], ['three', 'failed', 'source-changed']]);
  assert.equal(restored.list('room')[0].message, 'one'); assert.equal(await restored.claim('room', 'one'), null);
  await restored.enqueue(input('new')); assert.equal(restored.peek('room').id, 'new', 'new input cannot quietly revive failed pre-restart batches');
  await restored.retry('room', 'one'); assert.equal(restored.peek('room').id, 'one'); assert.ok(await restored.claim('room', 'one'));
});

test('invalid snapshots or restore persistence failures cannot partially replace live state', async () => {
  let diskFailure = false; const q = createChatInputQueue({ now: () => 0, persist: async () => { if (diskFailure) throw Error('disk'); } }); await q.enqueue(input('one'));
  const before = q.snapshot(), wrongMessage = structuredClone(before); wrongMessage.rooms[0].batches[0].message = 'tampered';
  for (const value of [{ version: 2, rooms: [], receipts: [] }, wrongMessage, { ...before, receipts: [] }]) {
    await assert.rejects(q.restore(value), /invalid-chat-input-queue/); assert.deepEqual(q.snapshot(), before);
  }
  diskFailure = true; await assert.rejects(q.restore(before), /chat-input-save-failed/); assert.deepEqual(q.snapshot(), before);
});

test('receipts are bounded to 512 completed acknowledgements without dropping active deduplication', async () => {
  const q = createChatInputQueue({ now: () => 0 }); await q.enqueue(input('still-active'));
  for (let index = 0; index < 513; index++) {
    const requestId = 'done-' + index; await q.enqueue(input(requestId, requestId, { scopeKey: 'completed-' + index })); await q.complete('room', requestId);
  }
  assert.equal(q.snapshot().receipts.length, 512); const before = q.snapshot();
  assert.equal((await q.enqueue(input('still-active'))).created, false); assert.deepEqual(q.snapshot(), before);
  const last = await q.enqueue(input('done-512', 'done-512', { scopeKey: 'completed-512' })); assert.equal(last.completed, true); assert.equal(last.created, false);
});

test('invalid input, unfrozen recipients and unsupported quote data are rejected without persisting anything', async () => {
  const q = createChatInputQueue({ now: () => 0 });
  for (const value of [input('bad', ''), input('bad', 'x'.repeat(4001)), input('bad', '原话', { recipients: [{ id: 'outside', name: '外部' }] }),
    input('bad', '原话', { memberIds: ['a', 'a'] }), input('bad', '原话', { referenceRevision: -1 }),
    input('bad', '原话', { quote: { ...quote(), ref: { ...quote().ref, kind: 'assistant' } } }), input('bad', '原话', { privateMemory: 'NO' })])
    await assert.rejects(q.enqueue(value), /invalid-chat-input/);
  assert.equal(q.snapshot().revision, 0); assert.deepEqual(q.snapshot().rooms, []);
});
