// Real Host with controlled streams: verifies lifecycle/provenance, not model story quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, reply, newRoom, roomSend, roomState, settledRoom, flush, preference,
  whale, dragon, claude, readChatInput } from './helpers/persona-chat-host.mjs';

const wire = text => (async function* () {
  yield { type: 'text-delta', text }; yield { type: 'finish', reason: { kind: 'stop' } };
})();
const speech = body => body.events.filter(event => event.author.role === 'assistant');
const snapshot = storage => JSON.stringify([...storage.tables].map(([name, table]) => [name, [...table]]));
function deferred(t) {
  let release; const promise = new Promise(resolve => { release = resolve; });
  t.after(release); return { promise, release };
}
function select(body, id, guide) {
  const choice = body.choices.find(value => value.id === id && value.kind === 'normal' && value.to === 'user');
  assert.ok(choice, 'the controlled director selects an actually eligible ordinary user target');
  const scene = body.sceneCatalog.options.find(value => value.key === 'K')
    ?? body.sceneCatalog.options.find(value => value.relation === 'fresh');
  assert.ok(scene, 'the scene key comes from the current actual Host catalogue');
  return wire(`${choice.choiceId} N ${scene.key} develop | 接住当前公开原话的一小步。${guide ? '\nSCENE | ' + guide : ''}`);
}
function targetText(options, pointer) {
  const control = readChatInput(options).__control, event = control.timeline.find(value => value.eventId === pointer.eventId);
  assert.ok(event, 'the proposal points at a real included timeline event');
  const position = event.bubbles.findIndex(bubble => bubble.index === pointer.index);
  assert.ok(position >= 0);
  const packet = JSON.parse(options.messages[event.messageIndex].content[0].text), bubble = packet.messages[position];
  return typeof bubble === 'string' ? bubble : packet.messages.find(value => value.index === pointer.index)?.text;
}

test('a short scene proposal reaches only its actual actor and never becomes streamed speech, memory or the next director input', async t => {
  const gate = deferred(t), guide = 'UNDELIVERED_SCENE_GUIDE：留意门口的旧伞，把发现留给用户接。';
  const message = '我们一起想象雨夜小店。小克穿长裙，鲸鲸先看看门边。', otherMessage = '另一间房只聊茶杯。';
  const publicWhale = '门边有一把旧伞。', publicDragon = '柜台上还留着一盏灯。', otherReply = '这只茶杯挺顺手。';
  const f = fixture(t, {
    directorScript: options => {
      const body = readChatInput(options), count = speech(body).length;
      if (body.message === otherMessage) return count ? wire('WAIT') : select(body, whale);
      assert.equal(body.message, message);
      return count > 1 ? wire('WAIT') : select(body, count ? dragon : whale, count ? undefined : guide);
    },
    script: options => {
      const body = readChatInput(options);
      if (body.message === otherMessage) return reply([otherReply]);
      if (body.speaker.id === dragon) return reply([publicDragon]);
      return (async function* () {
        yield { type: 'text-delta', text: '{"messages":[' + JSON.stringify(publicWhale) };
        await gate.promise;
        yield { type: 'text-delta', text: ']}' }; yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  });
  await f.ready(); await preference(f, 'ONLY_WHALE_PRIVATE_FICTION_PREFERENCE', whale);
  const a = await newRoom(f, [whale, dragon, claude], '雨夜', 'fiction-room-a');
  const b = await newRoom(f, [whale], '茶杯', 'fiction-room-b');
  assert.equal((await roomSend(f, a, whale, message, 'fiction-first')).status, 200);
  await flush(); assert.equal(f.calls.length, 1);
  const first = readChatInput(f.calls[0]), control = first.__control;
  assert.equal(first.sceneDirection.text, guide);
  assert.deepEqual(first.sceneDirection.source, { eventId: control.replyTarget.eventId, index: control.replyTarget.index });
  assert.equal(targetText(f.calls[0], first.sceneDirection.source), message);
  assert.match(f.calls[0].system, /ONLY_WHALE_PRIVATE_FICTION_PREFERENCE/);
  const pending = await roomState(f, a);
  assert.equal(pending.room.turns.at(-1).status, 'pending');
  assert.ok(!JSON.stringify(pending).includes(guide));
  assert.ok(!snapshot(f.storage).includes(guide), 'an uncommitted stream cannot persist the proposal as a scene fact');
  assert.equal((await roomSend(f, b, whale, otherMessage, 'fiction-other-room')).status, 200);
  const other = await settledRoom(f, b);
  assert.deepEqual(other.room.turns.filter(turn => turn.phase !== 'anchor').map(turn => turn.assistant), [[otherReply]]);
  const otherCall = f.calls.find(options => readChatInput(options).message === otherMessage);
  assert.equal(readChatInput(otherCall).sceneDirection, undefined);
  assert.ok(!JSON.stringify(otherCall).includes(guide));
  gate.release(); const done = await settledRoom(f, a);
  assert.equal(done.directorFailure, null);
  assert.deepEqual(done.room.turns.filter(turn => turn.phase !== 'anchor').map(turn => turn.assistant), [[publicWhale], [publicDragon]]);
  const next = f.calls.find(options => readChatInput(options).message === message && readChatInput(options).speaker.id === dragon);
  assert.equal(readChatInput(next).sceneDirection, undefined, 'a proposal is not inherited by the next actor');
  assert.ok(JSON.stringify(next.messages).includes(publicWhale), 'only the actual committed peer speech is carried forward');
  assert.ok(!JSON.stringify(next).includes(guide));
  assert.doesNotMatch(next.system, /ONLY_WHALE_PRIVATE_FICTION_PREFERENCE/);
  for (const options of f.directors) assert.ok(!JSON.stringify(options).includes(guide), 'the next director never reads its unspoken proposal');
  for (const value of [done, (await f.request('memory')).value]) assert.ok(!JSON.stringify(value).includes(guide));
  assert.ok(!snapshot(f.storage).includes(guide));
  assert.ok(done.room.turns.every(turn => !Object.hasOwn(turn.responsePlan ?? {}, 'sceneDirection')));
});

for (const restart of [false, true]) test(`failed scene output loses its proposal on an explicit ${restart ? 'post-restart' : 'live'} retry`, async t => {
  const guide = 'FAILED_ONLY_GUIDE：只给这次未交付的下一位参考。';
  let selected = false;
  const f = fixture(t, {
    directorScript: options => selected ? wire('WAIT') : (selected = true, select(readChatInput(options), whale, guide)),
    script: (_options, number) => reply([number === 1 ? '这是被截断而未提交的正文。' : '这次只回应原来的用户消息。'], number === 1 ? 'max-tokens' : 'stop'),
  });
  await f.ready(); const original = await newRoom(f, [whale, dragon], '重试边界', 'fiction-retry-' + restart);
  assert.equal((await roomSend(f, original, whale, '一起想象灯塔门口的场景。', 'fiction-failed')).status, 200);
  const failedState = await settledRoom(f, original), failed = failedState.room.turns.find(turn => turn.phase !== 'anchor');
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure, 'length'); assert.deepEqual(failed.assistant, []);
  assert.equal(readChatInput(f.calls[0]).sceneDirection.text, guide);
  assert.ok(!snapshot(f.storage).includes(guide));
  let current = f, binding = original;
  if (restart) {
    await f.dispose();
    current = fixture(t, { storage: f.storage, directorScript: () => wire('WAIT'), script: () => reply(['这次只回应原来的用户消息。']) });
    await current.ready();
    assert.equal(current.requests.length, 0, 'restoring a room does not initialize any scene model call');
    const opened = await current.request('chat-context', { action: 'open', roomId: original.roomId,
      viewer: 'fiction-restarted-viewer', sequence: 1, sessionId: 'work' });
    assert.equal(opened.status, 200);
    binding = { roomId: original.roomId, contextKey: opened.value.id + ':' + opened.value.revision };
  }
  const before = await roomState(current, binding), count = current.calls.length;
  assert.equal((await current.request('chat', { action: 'retry', ...binding, personaId: whale, id: failed.id,
    attemptId: 'fiction-manual-retry-' + restart, revision: before.room.revision, epoch: before.epoch,
    ...(binding.contextKey !== original.contextKey ? { previousContextKey: original.contextKey } : {}) })).status, 200);
  const after = await settledRoom(current, binding);
  assert.equal(current.calls.length, count + 1);
  const retried = current.calls.at(-1);
  assert.equal(readChatInput(retried).sceneDirection, undefined);
  assert.ok(!JSON.stringify(retried).includes(guide));
  assert.equal(after.room.turns.filter(turn => turn.phase === 'anchor').length, 1, 'manual retry does not invent another user input');
  assert.equal(after.room.turns.filter(turn => turn.phase !== 'anchor').length, 1, 'manual retry reuses only the real failed seat');
  assert.equal(after.room.turns.find(turn => turn.phase !== 'anchor').status, 'ready');
});

test('late SCENE selection is retired by source edits, clear-generation or a newer user input', async t => {
  for (const action of ['source', 'clear', 'new-user']) await t.test(action, async sub => {
    const gate = deferred(sub), guide = 'STALE_GUIDE_' + action, oldMessage = '一起想象旧港口的第一幕。', newMessage = '改聊花园，接我现在这句话。';
    const f = fixture(sub, { directorScript: options => {
      const body = readChatInput(options);
      if (body.message !== oldMessage) return speech(body).length ? wire('WAIT') : select(body, whale);
      return (async function* () { await gate.promise; yield* select(body, whale, guide); })();
    }, script: () => reply(['这里只接新的用户原话。']) });
    await f.ready(); const binding = await newRoom(f, [whale, dragon], action, 'fiction-stale-' + action);
    assert.equal((await roomSend(f, binding, whale, oldMessage, 'fiction-old-' + action)).status, 200);
    await flush(); const before = await roomState(f, binding);
    assert.equal(f.directors.length, 1); assert.equal(f.calls.length, 0);
    if (action === 'source') assert.equal((await f.request('chat-context', { action: 'attach', roomId: binding.roomId,
      sessionId: 'other', primary: true, revision: 2 })).status, 200);
    else if (action === 'clear') assert.equal((await f.request('chat', { action: 'clear', ...binding, personaId: whale,
      revision: before.room.revision, epoch: before.epoch })).status, 200);
    else assert.equal((await roomSend(f, binding, whale, newMessage, 'fiction-new-user')).status, 200);
    await flush(); assert.equal(f.directors[0].signal.aborted, true);
    gate.release(); await flush();
    if (action !== 'new-user') {
      const opened = await f.request('chat-context', { action: 'open', roomId: binding.roomId, viewer: 'fiction-fresh-' + action,
        sequence: 1, sessionId: action === 'source' ? 'other' : 'work' });
      const fresh = { roomId: binding.roomId, contextKey: opened.value.id + ':' + opened.value.revision };
      assert.equal((await roomSend(f, fresh, whale, newMessage, 'fiction-fresh-user-' + action)).status, 200);
    }
    const after = await settledRoom(f, binding);
    assert.equal(f.calls.length, 1, 'the aborted selection never dispatches its stale actor');
    assert.equal(readChatInput(f.calls[0]).message, newMessage);
    assert.equal(readChatInput(f.calls[0]).sceneDirection, undefined);
    assert.ok(!JSON.stringify(after).includes(guide));
    assert.ok(!JSON.stringify(f.calls).includes(guide));
    if (action === 'clear') {
      assert.ok(after.room.generation > before.room.generation);
      assert.ok(after.room.turns.every(turn => turn.user !== oldMessage));
    }
    if (action === 'source') assert.notEqual(readChatInput(f.calls[0]).scopeKey, before.scopeKey);
  });
});

test('optional SCENE keeps identical ordinary actor order, eligibility and budgets in two-, three- and five-person rooms', async t => {
  for (const members of [[whale, dragon], [whale, dragon, claude], [whale, dragon, claude, '鲸鲸（实验性）', 'Gemini']]) {
    const arms = [];
    for (const withGuide of [false, true]) {
      const f = fixture(t, { directorScript: options => {
        const body = readChatInput(options), id = members[speech(body).length];
        return id ? select(body, id, withGuide ? '当前一拍只留一个可以接续的小发现。' : undefined) : wire('WAIT');
      }, script: options => reply([readChatInput(options).speaker.id + ' 的实际公开回应。']) });
      await f.ready(); const binding = await newRoom(f, members, '普通多人', 'fiction-order-' + members.length + '-' + withGuide);
      assert.equal((await roomSend(f, binding, whale, '一起想象窗边的小店，大家按自己的想法接话。', 'fiction-order-user')).status, 200);
      const done = await settledRoom(f, binding);
      assert.equal(done.directorFailure, null);
      const requests = f.calls.map(options => readChatInput(options));
      assert.deepEqual(requests.map(body => body.speaker.id), members);
      assert.ok(requests.every(body => (body.sceneDirection !== undefined) === withGuide));
      assert.ok(requests.every(body => body.opportunity.kind === 'normal'));
      arms.push({ calls: f.calls.length, directors: f.directors.length,
        states: f.directors.map(options => readChatInput(options).states.map(({ id, level, normalRemaining, peerRemaining, normalReady, peerReady }) =>
          ({ id, level, normalRemaining, peerRemaining, normalReady, peerReady }))),
        opportunities: requests.map(body => body.opportunity),
        completed: done.room.turns.filter(turn => turn.phase !== 'anchor').map(({ recipientId, status, emittedOrder }) => ({ recipientId, status, emittedOrder })) });
    }
    assert.deepEqual(arms[1], arms[0], members.length + '-person SCENE cannot add calls, upgrade eligibility or spend an extra opportunity');
  }
});
