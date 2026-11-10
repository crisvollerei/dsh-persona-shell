import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { domain, fixture, flush, newRoom, roomSend, roomState, settledRoom, reply, whale } from './helpers/persona-chat-host.mjs';

const QUEUE = 'chatInputQueue';
const input = options => readChatInput(options);
function gate(t) {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  t.after(open);
  return { promise, open };
}
async function until(read, predicate, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await flush();
    const value = await read();
    if (predicate(value)) return value;
  }
  assert.fail(message);
}

test('a failed transport completion preserves durable raw input and explicit retry resumes its pending round exactly once', async t => {
  let failed = false;
  const storage = domain(Promise.resolve(), {
    beforePut(id, value) {
      if (id === QUEUE && !failed && value.receipts.some(receipt => receipt.requestId === 'completion-window' && receipt.completed)) {
        const room = storage.tables.get('profile').get('personaChats').rooms.find(room => room.turns.some(turn => turn.id === 'completion-window'));
        assert.equal(room.turns.at(-1).phase, 'anchor', 'the raw user anchor really committed before the transport acknowledgement failed');
        failed = true;
        throw Error('PRIVATE_COMPLETION_WRITE_FAILURE');
      }
    },
  });
  const f = fixture(t, { storage, script: () => reply(['只为这条已保存的消息回答一次。']) });
  await f.ready();
  const room = await newRoom(f, [whale], '运输确认恢复', 'completion-room');
  const sent = await roomSend(f, room, whale, '这是一条不能丢失或重复调用的原话。', 'completion-window');
  assert.equal(sent.status, 200);
  const interrupted = await until(() => roomState(f, room), state => state.queuedInputs[0]?.status === 'failed', 'the failed acknowledgement remains explicitly retryable');
  assert.equal(failed, true);
  assert.equal(f.calls.length, 0);
  assert.equal(interrupted.queuedInputs[0].failure, 'save');
  assert.deepEqual(interrupted.queuedInputs[0].parts.map(part => part.text), ['这是一条不能丢失或重复调用的原话。']);
  assert.equal(interrupted.room.turns[0].phase, 'anchor');
  assert.equal(storage.tables.get('profile').get('personaChats').rooms.find(value => value.id === room.roomId).turns[0].phase, 'anchor');
  assert.doesNotMatch(JSON.stringify(interrupted), /PRIVATE_COMPLETION_WRITE_FAILURE/);

  const retried = await f.request('chat', { action: 'retry-input', ...room, personaId: whale,
    requestId: 'completion-window', epoch: interrupted.epoch });
  assert.equal(retried.status, 200);
  const settled = await settledRoom(f, room);
  assert.equal(f.calls.length, 1);
  assert.equal(input(f.calls[0]).message, '这是一条不能丢失或重复调用的原话。');
  assert.equal(settled.queuedInputs.length, 0);
  assert.equal(settled.room.turns.length, 2); assert.equal(settled.room.turns[1].phase, 'reaction');
  assert.equal(settled.room.turns[0].status, 'ready');
  assert.deepEqual(settled.room.turns[0].userParts.map(part => part.text), ['这是一条不能丢失或重复调用的原话。']);

  assert.equal((await roomSend(f, room, whale, '这是一条不能丢失或重复调用的原话。', 'completion-window')).status, 200);
  await flush();
  assert.equal(f.calls.length, 1, 'a repeated acknowledged request cannot replay a completed model call');
});

test('a new input persistence failure does not abort or corrupt the persona already answering', async t => {
  const speaking = gate(t);
  let rejectNext = false, activeSignal;
  const storage = domain(Promise.resolve(), {
    beforePut(id, value) {
      if (id === QUEUE && rejectNext && value.receipts.some(receipt => receipt.requestId === 'unsaved-new-input')) {
        rejectNext = false;
        throw Error('PRIVATE_INPUT_WRITE_FAILURE');
      }
    },
  });
  const f = fixture(t, { storage, script: options => (async function* () {
    activeSignal = options.signal;
    await speaking.promise;
    yield* reply(['这一轮仍然完整回答。']);
  })() });
  await f.ready();
  const room = await newRoom(f, [whale], '保存失败不打断', 'save-fail-room');
  await roomSend(f, room, whale, '正在回答的已保存原话。', 'old-active');
  await until(() => Promise.resolve(f.calls.length), count => count === 1, 'the original persona call starts');
  rejectNext = true;
  const failed = await roomSend(f, room, whale, '这次输入尚未存好。', 'unsaved-new-input');
  assert.equal(failed.status, 503);
  assert.equal(failed.value.error, 'chat-input-save-failed');
  assert.equal(activeSignal.aborted, false);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(failed.value), /PRIVATE_INPUT_WRITE_FAILURE/);
  speaking.open();
  const state = await settledRoom(f, room);
  assert.equal(state.queuedInputs.length, 0);
  assert.deepEqual(state.room.turns.filter(turn => turn.phase !== 'anchor').map(turn => [turn.user, turn.status]), [['正在回答的已保存原话。', 'ready']]);
  assert.equal(state.room.turns.filter(turn => turn.phase === 'anchor').length, 1);
  assert.equal(f.calls.length, 1);
});

for (const operation of ['clear', 'delete', 'unload']) {
  test(`${operation} prevents a delayed claimed input from starting a new model call`, async t => {
    const saving = gate(t);
    let holding = false;
    const storage = domain(Promise.resolve(), {
      async beforePut(id, value) {
        if (id === QUEUE && !holding && value.rooms.some(room => room.batches.some(batch => batch.id === 'late-drain' && batch.status === 'sending'))) {
          holding = true;
          await saving.promise;
        }
      },
    });
    const f = fixture(t, { storage });
    await f.ready();
    const room = await newRoom(f, [whale], '迟到排队隔离', 'late-' + operation);
    assert.equal((await roomSend(f, room, whale, '这条排队原话不能在房间退休后偷偷调用。', 'late-drain')).status, 200);
    await until(() => Promise.resolve(holding), value => value, 'the queue claim reaches its controlled persistence boundary');
    const before = await roomState(f, room);
    let stopping;
    if (operation === 'unload') stopping = f.dispose();
    else if (operation === 'clear') {
      stopping = f.request('chat', { action: 'clear', ...room, personaId: whale, revision: before.room.revision, epoch: before.epoch });
    } else {
      stopping = f.request('chat-rooms', { action: 'delete', roomId: room.roomId, revision: before.room.revision, epoch: before.epoch });
    }
    if (operation !== 'unload') {
      await until(() => Promise.resolve(storage.tables.get('profile').get('personaChats')),
        value => operation === 'delete' ? !value.rooms.some(value => value.id === room.roomId)
          : value.rooms.find(value => value.id === room.roomId)?.referenceRevision > (before.room.referenceRevision ?? 0),
        'the room retirement is durable before the delayed claim returns');
    } else await flush();
    saving.open();
    const stopped = await stopping;
    if (operation !== 'unload') assert.equal(stopped.status, 200);
    await flush();
    assert.equal(f.calls.length, 0);
    assert.equal(f.requests.length, 0, 'no planner or persona model request may start after retirement');
    const durable = storage.tables.get('profile').get('personaChats');
    if (operation === 'clear') assert.deepEqual(durable.rooms.find(value => value.id === room.roomId).turns, []);
    if (operation === 'delete') assert.equal(durable.rooms.some(value => value.id === room.roomId), false);
    if (operation !== 'unload') assert.equal(storage.tables.get('profile').get(QUEUE).rooms.some(value => value.roomId === room.roomId), false);
  });
}
