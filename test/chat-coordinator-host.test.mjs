import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, reply, directorReply, preference, newRoom, roomSend, roomState, settledRoom, flush, whale, dragon } from './helpers/persona-chat-host.mjs';

const input = options => readChatInput(options);
const selected = (body, extra = {}) => ({ work: 'required', sourceIds: ['work'], request: 'answer', evidence: body.message.slice(0, 120), ...extra });
const selection = (value, finish = 'stop') => (async function* () {
  yield { type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) };
  yield { type: 'finish', reason: { kind: finish } };
})();
const sourceEvents = id => [{ seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: id + '_PRIVATE_WORK_GOAL' }] } },
  { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: id + '_PRIVATE_WORK_REPORT' }] } } },
  { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
function gate(t) { let open; const promise = new Promise(resolve => { open = resolve; }); t.after(open); return { promise, open }; }
function nextReply(body) {
  const answered = new Set(body.events.filter(event => event.author.role === 'assistant').map(event => event.author.id));
  const person = body.recipients.find(person => !answered.has(person.id) && body.states.some(state => state.id === person.id && state.normalReady));
  const event = body.events.findLast(event => event.author.role === 'user');
  return person && event ? { id: person.id, kind: 'normal', to: 'user',
    evidence: { eventId: event.id, index: 0, text: event.messages[0] }, goal: '回应用户这次的原话。' } : null;
}
function host(t, options = {}) {
  const reads = [], events = new Map(['work', 'other'].map(id => [id, sourceEvents(id)]));
  const { contextScript, ...rest } = options;
  const directorScript = options.directorScript ?? (contextScript ? (wire, count) => (async function* () {
    // This context substitute receives the real director input. It supplies one
    // branch of that same model response, never a synthetic extra model call.
    let raw = '', finish = 'stop';
    for await (const chunk of contextScript(wire, count)) {
      if (chunk.type === 'text-delta') raw += chunk.text;
      else if (chunk.type === 'finish') finish = chunk.reason.kind;
      else yield chunk;
    }
    let context; try { context = JSON.parse(raw); } catch { context = { invalidContext: raw }; }
    yield* directorReply(context, nextReply(input(wire)), finish);
  })() : undefined);
  const f = fixture(t, { ...rest, directorScript, extraServices: [
    ['sessions', { get: id => ({ header: { id, title: id + ' 的工作会话', cwd: 'D:/fixture/' + id } }) }],
    ['sessionQuery', { observeSession: async id => { reads.push(id); return { events: events.get(id) ?? [] }; } }],
    ...(options.extraServices ?? []),
  ] });
  const stale = id => {
    const list = events.get(id), start = { seq: 5, type: 'turn/start', data: { turn: 2 } },
      goal = { seq: 6, type: 'user/message', data: { content: [{ type: 'text', text: id + '_NEW_WORK_GOAL' }] } };
    list.push(start, goal, { seq: 7, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: id + '_NEW_WORK_REPORT' }] } } });
    for (const event of [start, goal]) f.bus.emit('session/event', { id, header: {}, append() { assert.fail('context selection cannot write workflow messages'); } }, event);
  };
  return { f, reads, stale };
}
async function twoSources(f) {
  const room = await newRoom(f, [whale, dragon]);
  const attached = await f.request('chat-context', { action: 'attach', roomId: room.roomId, sessionId: 'other', revision: Number(room.contextKey.split(':').at(-1)) });
  assert.equal(attached.status, 200);
  return { roomId: room.roomId, contextKey: attached.value.id + ':' + attached.value.revision };
}
const actualReplies = f => f.calls.filter(call => input(call).speaker);

test('one native metadata-only director combines source selection and next-speaker selection without a separate selector call', async t => {
  const { f, reads } = host(t, { config: { chatThinking: true }, modelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }),
    directorScript: options => directorReply(selected(input(options), { sourceIds: ['other'] }), nextReply(input(options))) });
  await f.ready(); await preference(f, 'WHALE_PRIVATE_MEMORY_MARKER'); await preference(f, 'DRAGON_PRIVATE_MEMORY_MARKER', dragon);
  const room = await twoSources(f), before = await roomState(f, room);
  assert.equal((await f.request('chat-rooms', { ...room, action: 'update', targetPersonaIds: [dragon, whale], configRevision: before.room.configRevision, epoch: before.epoch })).status, 200);
  const baseline = reads.length; await roomSend(f, room, dragon, '你们都说说工作下一步', 'coordinated'); await settledRoom(f, room);
  assert.equal(f.directors.length, 2); assert.equal(f.selections.length, 0); const call = f.directors[0], body = input(call);
  assert.equal(body.task, 'chat-room-director'); assert.equal(body.message, '你们都说说工作下一步');
  assert.deepEqual(body.recipients.map(person => person.id), [dragon, whale]);
  assert.equal(call.reasoningEffort, 'off'); assert.equal(call.tools, undefined);
  assert.ok(f.directors.every(options => options.reasoningEffort === 'off'));
  assert.doesNotMatch(JSON.stringify(f.directors), /PRIVATE_WORK_GOAL|PRIVATE_WORK_REPORT|PRIVATE_MEMORY_MARKER/);
  assert.equal(actualReplies(f).length, 2);
  for (const response of actualReplies(f)) {
    assert.deepEqual(input(response).workContext.sources.map(s => s.sessionId), ['other']);
    assert.deepEqual(input(response).coordination, { work: 'required', sourceIds: ['other'], request: 'answer' });
  }
  assert.deepEqual(reads.slice(baseline), []);
  const usage = (await f.request('model-usage')).value.purposes.find(row => row.purpose === 'chat-participation');
  assert.equal(usage.calls, 2); assert.equal(f.plans.length + f.continuations.length, 0);
  const ledger = (await f.request('chat-references?room=' + encodeURIComponent(room.roomId))).value.records;
  assert.ok(ledger.length >= 2); assert.ok(ledger.every(row => row.coordination.selectedSourceIds.join() === 'other'));
  assert.doesNotMatch(JSON.stringify(ledger.map(row => row.coordination)), /PRIVATE_WORK_|PRIVATE_MEMORY_|你们都说说工作下一步/);
});

test('required work context refreshes only selected attached sources, without reading the other stale source', async t => {
  const { f, reads, stale } = host(t, { contextScript: options => selection(selected(input(options), { sourceIds: ['other'] })) });
  await f.ready(); const room = await twoSources(f); stale('work'); stale('other'); const baseline = reads.length;
  await roomSend(f, room, whale, '说一下后台工作', 'required-source'); await settledRoom(f, room);
  assert.deepEqual(reads.slice(baseline), ['other']); const answer = input(actualReplies(f).at(-1));
  assert.deepEqual(answer.workContext.sources.map(source => source.sessionId), ['other']);
  assert.match(JSON.stringify(answer.workContext), /other_NEW_WORK_GOAL|other_NEW_WORK_REPORT/);
  assert.doesNotMatch(JSON.stringify(answer.workContext), /work_PRIVATE_WORK_GOAL|work_NEW_WORK_GOAL/);
});

test('not-needed, unclear, malformed and truncated decisions provide an empty but scoped work envelope', async t => {
  for (const kind of ['not-needed', 'unclear', 'invalid', 'truncated']) await t.test(kind, async sub => {
    const { f, reads, stale } = host(sub, { contextScript: options => kind === 'invalid' ? selection('{"work":"required","sourceIds":["unattached"],"request":"answer","evidence":"forged"}')
      : selection(selected(input(options), { work: kind === 'truncated' ? 'required' : kind, sourceIds: kind === 'truncated' ? ['work'] : [] }), kind === 'truncated' ? 'max-tokens' : 'stop') });
    await f.ready(); const room = await twoSources(f); stale('work'); stale('other'); const baseline = reads.length;
    await roomSend(f, room, whale, '先陪我聊聊，不看工作', 'empty-envelope'); const done = await settledRoom(f, room);
    assert.equal(done.room.turns.at(-1).status, 'ready'); assert.deepEqual(reads.slice(baseline), []);
    if (kind === 'truncated') {
      assert.equal(actualReplies(f).length, 0); assert.equal(done.directorFailure.code, 'invalid');
      assert.equal(done.room.turns[0].phase, 'anchor'); return;
    }
    const context = input(actualReplies(f).at(-1)).workContext;
    assert.deepEqual(context.sources, []); assert.equal(context.key, room.contextKey); assert.match(context.scopeKey, new RegExp(room.roomId));
    assert.doesNotMatch(JSON.stringify(context), /PRIVATE_WORK_|NEW_WORK_/);
  });
});

test('a timed-out director keeps the user anchor retryable without reading work material or guessing a forced speaker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const wait = gate(t);
  const { f, reads, stale } = host(t, { config: { timeoutMs: 1000 }, contextScript: options => (async function* () { await wait.promise; yield* selection(selected(input(options))); })() });
  await f.ready(); const room = await newRoom(f, [whale]); stale('work'); const baseline = reads.length;
  await roomSend(f, room, whale, '先说说看法', 'selector-timeout'); t.mock.timers.tick(0); await flush(); assert.equal(f.directors.length, 1);
  t.mock.timers.tick(1001); await flush(); const done = await settledRoom(f, room);
  assert.equal(done.room.turns.at(-1).status, 'ready'); assert.deepEqual(reads.slice(baseline), []);
  assert.equal(actualReplies(f).length, 0); assert.equal(done.room.turns[0].phase, 'anchor');
  assert.equal(done.directorFailure.code, 'timeout'); wait.open(); await flush();
  assert.equal(actualReplies(f).length, 0, 'late director text cannot create a reply after its deadline');
});

test('source changes, room clearing and explicit cancellation prevent a late selection from dispatching a reply', async t => {
  for (const change of ['source', 'clear', 'cancel']) await t.test(change, async sub => {
    const wait = gate(sub), { f } = host(sub, { contextScript: options => (async function* () { await wait.promise; yield* selection(selected(input(options))); })() });
    await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room, whale, '等待协调', 'pending-selection'); await flush();
    const pending = await roomState(f, room); assert.equal(pending.roundPhase, 'preparing'); assert.equal(f.directors.length, 1);
    if (change === 'source') {
      assert.equal((await f.request('chat-context', { action: 'detach', ...room, sessionId: 'work', revision: Number(room.contextKey.split(':').at(-1)) })).status, 200);
    } else if (change === 'clear') {
      assert.equal((await f.request('chat', { action: 'clear', ...room, personaId: whale, revision: pending.room.revision, epoch: pending.epoch })).status, 200);
    } else {
      assert.equal((await f.request('chat', { action: 'cancel', ...room, personaId: whale, messageId: pending.roundMessageId,
        roundId: pending.roundId, attempts: [], epoch: pending.epoch })).status, 200);
    }
    wait.open(); await flush(); assert.equal(actualReplies(f).length, 0);
    assert.ok((await roomState(f, room)).room.turns.filter(turn => turn.phase !== 'anchor').every(turn => turn.status !== 'ready'));
  });
});

test('clearing one room during selection does not cancel another room or leak its chosen work source', async t => {
  const wait = gate(t), { f } = host(t, { contextScript: options => input(options).message === 'A等待' ? (async function* () { await wait.promise; yield* selection(selected(input(options))); })()
    : selection(selected(input(options), { work: 'not-needed', sourceIds: [] })) });
  await f.ready(); const a = await newRoom(f, [whale], '甲', 'a'), b = await newRoom(f, [dragon], '乙', 'b');
  await roomSend(f, a, whale, 'A等待', 'a-message'); await flush(); await roomSend(f, b, dragon, 'B照常', 'b-message'); const doneB = await settledRoom(f, b);
  assert.equal(doneB.room.turns.at(-1).status, 'ready');
  const sa = await roomState(f, a); await f.request('chat', { ...a, action: 'clear', personaId: whale, revision: sa.room.revision, epoch: sa.epoch });
  wait.open(); await flush(); assert.equal(actualReplies(f).length, 1); assert.equal(input(actualReplies(f)[0]).message, 'B照常');
  assert.deepEqual(input(actualReplies(f)[0]).workContext.sources, []);
});

test('an explicit reply retry does not inherit the failed attempt work materials or create another user anchor', async t => {
  const { f } = host(t, { contextScript: options => selection(selected(input(options))),
    script: (_, count) => reply(['公开回应'], count === 1 ? 'max-tokens' : 'stop') });
  await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room, whale, '重试这次回复', 'retry-message');
  const failed = await settledRoom(f, room), turn = failed.room.turns.at(-1); assert.equal(turn.status, 'failed');
  assert.equal((await f.request('chat', { ...room, action: 'retry', personaId: whale, id: turn.id, attemptId: 'fresh-retry', revision: failed.room.revision, epoch: failed.epoch })).status, 200);
  const done = await settledRoom(f, room); assert.equal(done.room.turns.at(-1).status, 'ready');
  assert.equal(f.directors.length, 1, 'an explicit actor retry does not replay the already completed director or add an empty solo judgement');
  assert.equal(done.room.turns.filter(turn => turn.phase === 'anchor').length, 1); assert.equal(actualReplies(f).length, 2);
  assert.equal(input(actualReplies(f)[0]).workContext.sources.length, 1); assert.deepEqual(input(actualReplies(f).at(-1)).workContext.sources, []);
});

test('unload aborts and drains a pending selector so late model deltas cannot start a persona response', async t => {
  const wait = gate(t), { f } = host(t, { contextScript: options => (async function* () { await wait.promise; yield* selection(selected(input(options))); })() });
  await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room, whale, '等待后卸载', 'unload-selection'); await flush();
  assert.equal(f.directors.length, 1); const call = f.directors[0]; await f.dispose(); assert.equal(call.signal.aborted, true);
  wait.open(); await flush(); assert.equal(actualReplies(f).length, 0);
});

test('a new durable input retires an unstarted plan without losing the prior user words or replaying its late result', async t => {
  const wait = gate(t), { f } = host(t, { contextScript: options => (async function* () {
    if (input(options).message === '先处理这条') await wait.promise;
    yield* selection(selected(input(options)));
  })() });
  await f.ready(); const room = await newRoom(f, [whale]);
  assert.equal((await roomSend(f, room, whale, '先处理这条', 'first')).status, 200); await flush();
  const preparing = await roomState(f, room); assert.equal(preparing.roundPhase, 'preparing');
  assert.equal((await roomSend(f, room, whale, '这句是接下来的补充', 'second')).status, 200);
  assert.equal(f.directors.length, 1); assert.equal(actualReplies(f).length, 0);
  const done = await settledRoom(f, room); assert.equal(done.room.turns.length, 3);
  assert.equal(done.room.turns[0].user, '先处理这条'); assert.equal(done.room.turns[0].phase, 'anchor');
  assert.deepEqual(done.room.turns[0].assistant, []);
  assert.equal(done.room.turns[1].user, '这句是接下来的补充'); assert.equal(done.room.turns[1].status, 'ready');
  assert.equal(f.directors.length, 2, 'only the aborted old judgement and the new user turn need model dispatch'); assert.equal(actualReplies(f).length, 1);
  assert.equal(input(actualReplies(f)[0]).history[0].user, '先处理这条');
  assert.equal(input(actualReplies(f)[0]).message, '这句是接下来的补充');
  assert.equal(f.directors[0].signal.aborted, true);
  wait.open(); await flush(); assert.equal(actualReplies(f).length, 1, 'late planning deltas cannot resurrect the retired response');
});

test('a room with no attached source skips work selection while preserving its own recent original words', async t => {
  const { f } = host(t); await f.ready(); const initial = await newRoom(f, [whale]);
  const detached = await f.request('chat-context', { action: 'detach', ...initial, sessionId: 'work', revision: Number(initial.contextKey.split(':').at(-1)) });
  assert.equal(detached.status, 200); const room = { roomId: initial.roomId, contextKey: detached.value.id + ':' + detached.value.revision };
  await roomSend(f, room, whale, '上次提到的草图先保留，暂不执行。', 'no-source-origin'); await settledRoom(f, room);
  await roomSend(f, room, whale, '继续说说那个草图', 'no-source-next'); await settledRoom(f, room);
  assert.equal(f.selections.length, 0); const answer = input(actualReplies(f).at(-1));
  assert.equal(answer.history[0].user, '上次提到的草图先保留，暂不执行。');
  assert.deepEqual(answer.workContext.sources, []); assert.equal(answer.workContext.key, room.contextKey);
});

test('releasing the last room viewer during selection keeps the sent round alive without reading hidden work sources', async t => {
  for (const work of ['required', 'not-needed']) await t.test(work, async sub => {
    const wait = gate(sub), { f, reads, stale } = host(sub, {
      contextScript: options => (async function* () {
        await wait.promise;
        yield* selection(selected(input(options), { work, sourceIds: work === 'required' ? ['work'] : [], request: 'advice' }));
      })(),
    });
    await f.ready(); const room = await newRoom(f, [whale]); stale('work'); const baseline = reads.length;
    assert.equal((await roomSend(f, room, whale, '先给我一点建议', 'hide-during-selection')).status, 200);
    await flush(); assert.equal(f.directors.length, 1);
    const preparing = await roomState(f, room); assert.equal(preparing.roundPhase, 'preparing');
    const hidden = await f.request('chat-context', { action: 'presence', roomId: room.roomId,
      viewer: 'viewer-room-create', sequence: 2, visible: false });
    assert.equal(hidden.status, 200); assert.equal(hidden.value.active, false);
    wait.open(); const done = await settledRoom(f, room);
    assert.equal(done.room.turns.at(-1).status, 'ready'); assert.equal(actualReplies(f).length, 1);
    assert.deepEqual(reads.slice(baseline), []);
    const body = input(actualReplies(f)[0]), context = body.workContext;
    assert.equal(context.key, room.contextKey); assert.match(context.scopeKey, new RegExp(room.roomId));
    assert.deepEqual(context.sources, []); assert.doesNotMatch(JSON.stringify(context), /PRIVATE_WORK_|NEW_WORK_/);
    assert.deepEqual(body.coordination, { work: work === 'required' ? 'unclear' : 'not-needed', sourceIds: [], request: 'advice' });
    const records = (await f.request('chat-references?room=' + encodeURIComponent(room.roomId))).value.records;
    assert.ok(records.length > 0);
    assert.ok(records.every(record => record.coordination.basis === (work === 'required' ? 'unavailable' : 'model')));
    assert.ok(records.every(record => record.coordination.selectedSourceIds.length === 0));
  });
});
