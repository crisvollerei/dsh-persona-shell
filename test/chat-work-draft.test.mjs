import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWorkDraft, buildWorkDraftPrompt, parseWorkDraft } from '../lib/chat-work-draft.js';
import { fixture, domain, flush, reply, preference, newRoom, roomSend, roomState, settledRoom, whale, dragon } from './helpers/persona-chat-host.mjs';

const bodyOf = options => readChatInput(options);
const isDraft = options => { try { return Array.isArray(bodyOf(options).quotes); } catch { return false; } };
const draft = (text = '请先画一张设置页面草图，保留现有功能，并列出待确认的问题。', finish = 'stop') => (async function* () {
  yield { type: 'text-delta', index: 0, text: JSON.stringify({ draft: text }) };
  yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } };
  yield { type: 'finish', reason: { kind: finish } };
})();
const script = options => isDraft(options) ? draft() : reply(['这只是公开讨论的建议。']);
const get = async (f, room) => (await f.request('chat-work-draft?room=' + encodeURIComponent(room.roomId))).value;
async function generateBody(f, room, extra = {}) {
  const info = await get(f, room);
  return { action: 'generate', requestId: 'work-draft-one', roomId: room.roomId, epoch: info.epoch, scopeKey: info.scopeKey,
    discussionRevision: info.discussionRevision, refs: [info.choices.find(q => q.ref.kind === 'user').ref], instruction: '整理成可执行的工作指令，未确定的内容先列出。', ...extra };
}
const generate = (f, body) => f.request('chat-work-draft', body);
function gate(t) {
  let open; const promise = new Promise(resolve => { open = resolve; }); t.after(open); return { promise, open };
}
const roomScope = 'r:sources:1';
const userRef = id => ({ roomId: 'r', generation: 0, kind: 'user', messageId: id });
const unitRoom = () => ({ id: 'r', generation: 0, turns: [{ id: 'm1', messageId: 'm1', attemptId: 'a1', recipientId: whale,
  speakerName: whale, recipients: [{ id: whale, name: whale }], user: '先讨论布局，不要开始执行。', assistant: ['可以先画草图。'], status: 'ready', scopeKey: roomScope }] });
const unitBody = extra => ({ roomId: 'r', epoch: 0, scopeKey: roomScope, discussionRevision: 0, refs: [userRef('m1')], instruction: '整理工作指令', ...extra });

test('work draft preparation resolves canonical public words and keeps author attribution instead of trusting client text', () => {
  const room = unitRoom(), prepared = prepareWorkDraft(room, unitBody({ refs: [{ ...userRef('m1'), text: 'FORGED_TEXT', author: { role: 'assistant', name: dragon } }] }), roomScope);
  assert.equal(prepared.quotes[0].text, '先讨论布局，不要开始执行。');
  assert.equal(prepared.quotes[0].author.role, 'user');
  assert.doesNotMatch(JSON.stringify(prepared), /FORGED_TEXT/);
  assert.equal(prepared.instruction, '整理工作指令');
  assert.deepEqual(prepared.basis.refs, [userRef('m1')]);
  const prompt = buildWorkDraftPrompt(prepared), parsed = JSON.parse(prompt.user);
  assert.equal(parsed.quotes[0].text, prepared.quotes[0].text);
  assert.doesNotMatch(JSON.stringify(parsed), /FORGED_TEXT/);
});

test('work draft preparation rejects foreign, cleared, provisional, stale and duplicated evidence before a model can run', () => {
  const room = unitRoom(), assistant = { roomId: 'r', generation: 0, kind: 'assistant', turnId: 'm1', attemptId: 'a1', index: 0 };
  assert.equal(prepareWorkDraft(room, unitBody({ refs: [assistant] }), roomScope).quotes[0].author.id, whale);
  for (const patch of [
    { refs: [] }, { refs: [userRef('m1'), userRef('m1')] }, { refs: [{ ...userRef('m1'), roomId: 'foreign' }] },
    { refs: [{ ...userRef('m1'), generation: 1 }] }, { refs: [{ ...assistant, attemptId: 'replaced' }] },
    { scopeKey: 'old-scope' }, { discussionRevision: 1 }, { instruction: 'x'.repeat(2001) },
  ]) assert.throws(() => prepareWorkDraft(room, unitBody(patch), roomScope));
  room.turns[0].status = 'pending';
  assert.throws(() => prepareWorkDraft(room, unitBody({ refs: [assistant] }), roomScope));
  assert.equal(prepareWorkDraft(room, unitBody(), roomScope).quotes[0].author.role, 'user');
});

test('work draft source count and whole-quote budget are bounded without silently clipping evidence', () => {
  const room = unitRoom();
  room.turns = Array.from({ length: 13 }, (_, i) => ({ ...room.turns[0], id: 'm' + i, messageId: 'm' + i, attemptId: 'a' + i, user: 'x'.repeat(1100) }));
  assert.throws(() => prepareWorkDraft(room, unitBody({ refs: room.turns.map(t => userRef(t.messageId)) }), roomScope));
  assert.throws(() => prepareWorkDraft(room, unitBody({ refs: room.turns.slice(0, 12).map(t => userRef(t.messageId)) }), roomScope));
  assert.equal(prepareWorkDraft(room, unitBody({ refs: room.turns.slice(0, 10).map(t => userRef(t.messageId)) }), roomScope).quotes.length, 10);
});

test('work draft parser requires one complete nonempty bounded draft and does not accept protocol fragments', () => {
  assert.equal(parseWorkDraft('{"draft":"请保留条件，先列待确认项。"}'), '请保留条件，先列待确认项。');
  for (const wire of ['{"draft":""}', '{"draft":"   "}', '{"draft":7}', '{"draft":"未结束"', '["draft"]',
    '{"draft":"正文","send":true}', JSON.stringify({ draft: 'x'.repeat(6001) })]) assert.equal(parseWorkDraft(wire), undefined);
});

test('opening or validating work draft sources is lazy and owner-only, without starting rooms or model calls', async t => {
  const read = [], f = fixture(t, { storage: domain(Promise.resolve(), { onGet: id => read.push(id) }) }); await f.ready();
  const unopened = await f.request('chat-work-draft'); assert.equal(unopened.status, 200); assert.equal(unopened.value.initialized, false);
  assert.ok(!read.includes('personaChats')); assert.equal(f.calls.length, 0);
  assert.equal((await f.request('chat-work-draft', undefined, false)).status, 403);
  assert.equal((await f.request('chat-work-draft', { action: 'generate' }, false)).status, 403);
  const room = await newRoom(f, [whale]); await roomSend(f, room); await settledRoom(f, room);
  const body = await generateBody(f, room), before = f.calls.length;
  const checked = await generate(f, { ...body, action: 'validate' }); assert.equal(checked.status, 200); assert.equal(checked.value.valid, true);
  assert.equal(f.calls.length, before);
});

test('generated work drafts use selected room words and reviewed state, not private persona memory or unrelated work content', async t => {
  const f = fixture(t, { script, config: { chatProvider: 'draft-provider', chatModel: 'draft-model', chatThinking:false } }); await f.ready();
  await preference(f, 'WHALE_PRIVATE_STYLE'); await preference(f, 'DRAGON_PRIVATE_STYLE', dragon);
  const room = await newRoom(f, [whale]); await roomSend(f, room, whale, 'ONLY_SELECTED_PUBLIC_WORDS', 'chosen'); await settledRoom(f, room);
  const foreign = await newRoom(f, [dragon], '另一个房间', 'other'); await roomSend(f, foreign, dragon, 'FOREIGN_ROOM_WORDS', 'other-message'); await settledRoom(f, foreign);
  const info = await get(f, room), source = info.choices.find(q => q.ref.kind === 'user').ref;
  assert.equal((await f.request('chat-discussion', { action: 'add', roomId: room.roomId, epoch: info.epoch, discussionRevision: 0,
    requestId: 'reviewed', title: 'REVIEWED_ROOM_DISCUSSION', status: 'confirmed', source, evidence: source })).status, 200);
  const before = (await roomState(f, room)).room, memoryBefore = (await f.request('memory')).value;
  const answer = await generate(f, await generateBody(f, room)); assert.equal(answer.status, 200); assert.match(answer.value.draft, /草图/);
  const call = f.calls.at(-1), input = bodyOf(call);
  assert.equal(input.quotes[0].text, 'ONLY_SELECTED_PUBLIC_WORDS'); assert.match(JSON.stringify(input), /REVIEWED_ROOM_DISCUSSION/);
  assert.doesNotMatch(JSON.stringify(call), /WHALE_PRIVATE_STYLE|DRAGON_PRIVATE_STYLE|FOREIGN_ROOM_WORDS|WORK_SESSION_SECRET/);
  assert.equal(call.provider, 'draft-provider'); assert.equal(call.model, 'draft-model'); assert.equal(call.reasoningEffort, 'off'); assert.equal(call.tools, undefined);
  assert.deepEqual((await roomState(f, room)).room, before);
  const memoryAfter = (await f.request('memory')).value; assert.deepEqual(memoryAfter.entries, memoryBefore.entries); assert.deepEqual(memoryAfter.usage, memoryBefore.usage);
  assert.equal(f.storage.tables.get('sessions')?.size ?? 0, 0);
  const usage = (await f.request('model-usage')).value.purposes.find(p => p.purpose === 'chat-draft');
  assert.equal(usage.calls, 1); assert.equal(usage.inputTokens, 12); assert.equal(usage.outputTokens, 7);
});

test('invalid work draft evidence is refused before dispatch and fake client metadata cannot supply missing words', async t => {
  const f = fixture(t, { script }); await f.ready(); const room = await newRoom(f, [whale]);
  await roomSend(f, room, whale, '合法原话', 'origin'); await settledRoom(f, room);
  const body = await generateBody(f, room), before = f.calls.length;
  for (const patch of [{ scopeKey: 'forged-scope' }, { discussionRevision: 999 }, { refs: [{ ...body.refs[0], roomId: 'another-room', text: 'FORGED' }] },
    { refs: [{ ...body.refs[0], messageId: 'missing', text: 'FORGED', author: { role: 'user' } }] }, { refs: [body.refs[0], body.refs[0]] }]) {
    assert.notEqual((await generate(f, { ...body, ...patch })).status, 200);
  }
  assert.equal(f.calls.length, before);
});

test('work draft routing follows the current chat thinking policy without changing the formal rewrite route', async t => {
  const f = fixture(t, { script, config: { reasoningEffort: 'high', chatThinking:false }, modelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }],defaultEffort:'low' } }) });
  await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room); await settledRoom(f, room);
  assert.equal((await generate(f, await generateBody(f, room))).status, 200);
  assert.equal(f.calls.at(-1).provider, 'p'); assert.equal(f.calls.at(-1).model, 'm'); assert.equal(f.calls.at(-1).reasoningEffort, 'off');
  assert.equal((await f.request('settings', { chatProvider: 'chat-p', chatModel: 'chat-m', chatThinking: true })).status, 200);
  assert.equal((await generate(f, await generateBody(f, room, { requestId: 'thinking-draft' }))).status, 200);
  assert.equal(f.calls.at(-1).provider, 'chat-p'); assert.equal(f.calls.at(-1).model, 'chat-m'); assert.equal(f.calls.at(-1).reasoningEffort, 'low');
  const settings = (await f.request('settings')).value.settings;
  assert.equal(settings.provider, 'p'); assert.equal(settings.model, 'm'); assert.equal(settings.reasoningEffort, 'high');
});

test('incomplete or malformed draft replies do not become usable drafts or chat history', async t => {
  let finish = 'max-tokens'; const f = fixture(t, { script: options => isDraft(options) ? draft('不能采用的草稿', finish) : reply() }); await f.ready();
  const room = await newRoom(f, [whale]); await roomSend(f, room); await settledRoom(f, room);
  const before = (await roomState(f, room)).room, body = await generateBody(f, room);
  assert.notEqual((await generate(f, body)).status, 200); finish = 'tool-calls';
  assert.notEqual((await generate(f, { ...body, requestId: 'tool-finish' })).status, 200);
  assert.deepEqual((await roomState(f, room)).room, before);
});

test('same canonical generation request shares one model call while changed content with the same id conflicts', async t => {
  const waiting = gate(t), signals = []; const f = fixture(t, { script: options => !isDraft(options) ? reply() : (async function* () {
    signals.push(options.signal); await waiting.promise; yield* draft();
  })() }); await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room); await settledRoom(f, room);
  const body = await generateBody(f, room), before = f.calls.length;
  const one = generate(f, body); await flush(); const replay = generate(f, { ...body, refs: body.refs.map(ref => ({ ...ref, ignoredText: 'not evidence' })) }); await flush();
  assert.equal(f.calls.length, before + 1);
  assert.equal((await generate(f, { ...body, instruction: '同一编号下不同的要求' })).status, 409);
  waiting.open(); const results = await Promise.all([one, replay]); assert.ok(results.every(r => r.status === 200));
  assert.deepEqual(results[0].value, results[1].value); assert.equal(signals.length, 1);
  assert.equal((await generate(f, body)).status, 200); assert.equal(f.calls.length, before + 1, 'completed replay does not spend another call');
});

test('a newer work draft replaces only the same room request and exact cancel ids cannot cancel its successor', async t => {
  const waiting = gate(t), signals = []; const f = fixture(t, { script: options => !isDraft(options) ? reply() : (async function* () {
    signals.push(options.signal); await waiting.promise; yield* draft();
  })() }); await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room); await settledRoom(f, room);
  const body = await generateBody(f, room), first = generate(f, body); await flush();
  const second = generate(f, { ...body, requestId: 'newer-work-draft' }); await flush();
  assert.notEqual((await first).status, 200); assert.equal(signals[0].aborted, true);
  assert.equal((await generate(f, { action: 'cancel', roomId: room.roomId, requestId: body.requestId })).value.cancelled, false);
  assert.equal(signals[1].aborted, false);
  assert.equal((await generate(f, { action: 'cancel', roomId: room.roomId, requestId: 'newer-work-draft' })).value.cancelled, true);
  assert.notEqual((await second).status, 200); waiting.open();
});

test('an exact cancel arriving before generation blocks that late request without affecting a successor or another room', async t => {
  let modelLists = 0;
  const f = fixture(t, { script, config: { model: '' }, listModels: async () => { modelLists++; return [{ id: 'm' }]; } }); await f.ready();
  const a = await newRoom(f, [whale], '甲', 'cancel-first-a'), b = await newRoom(f, [dragon], '乙', 'cancel-first-b');
  await roomSend(f, a, whale, '甲的原话', 'a-source'); await settledRoom(f, a);
  await roomSend(f, b, dragon, '乙的原话', 'b-source'); await settledRoom(f, b);
  const ba = await generateBody(f, a, { requestId: 'cancel-before-request' }), before = f.calls.length, beforeLists = modelLists;
  assert.equal((await generate(f, { action: 'cancel', roomId: a.roomId, requestId: ba.requestId })).status, 200);
  assert.equal((await generate(f, ba)).status, 409); assert.equal(f.calls.length, before); assert.equal(modelLists, beforeLists);
  assert.equal((await generate(f, { ...ba, requestId: 'later-distinct-request' })).status, 200);
  assert.equal((await generate(f, await generateBody(f, b, { requestId: ba.requestId }))).status, 200);
  assert.equal(f.calls.length, before + 2);
});

test('new unrelated room messages do not cancel a draft whose selected words and discussion version remain valid', async t => {
  const waiting = gate(t); let signal;
  const f = fixture(t, { script: options => !isDraft(options) ? reply() : (async function* () {
    signal = options.signal; await waiting.promise; yield* draft();
  })() }); await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room, whale, '被选择的原话', 'origin'); await settledRoom(f, room);
  const task = generate(f, await generateBody(f, room)); await flush();
  await roomSend(f, room, whale, '后来另聊一句，不改变已选原话', 'later'); await settledRoom(f, room);
  assert.equal(signal.aborted, false); waiting.open(); assert.equal((await task).status, 200);
});

test('discussion changes reject old draft results in that room without canceling another room draft', async t => {
  const waiting = gate(t), signals = [];
  const f = fixture(t, { script: options => !isDraft(options) ? reply() : (async function* () { signals.push(options.signal); await waiting.promise; yield* draft(); })() });
  await f.ready(); const a = await newRoom(f, [whale], '甲', 'a'), b = await newRoom(f, [dragon], '乙', 'b');
  await roomSend(f, a, whale, '甲的原话', 'a-source'); await settledRoom(f, a); await roomSend(f, b, dragon, '乙的原话', 'b-source'); await settledRoom(f, b);
  const ba = await generateBody(f, a), bb = await generateBody(f, b), taskA = generate(f, ba), taskB = generate(f, bb); await flush();
  assert.equal((await f.request('chat-discussion', { action: 'add', roomId: a.roomId, epoch: ba.epoch, discussionRevision: ba.discussionRevision,
    requestId: 'new-state', title: '新的房间标注', status: 'discussing', source: ba.refs[0] })).status, 200);
  waiting.open(); assert.notEqual((await taskA).status, 200); assert.equal((await taskB).status, 200);
});

test('changing the room work reference scope invalidates the selected draft basis and rejects its late result', async t => {
  const waiting = gate(t), f = fixture(t, { script: options => !isDraft(options) ? reply() : (async function* () { await waiting.promise; yield* draft(); })() });
  await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room); await settledRoom(f, room);
  const body = await generateBody(f, room), task = generate(f, body); await flush();
  const detached = await f.request('chat-context', { ...room, action: 'detach', sessionId: 'work', revision: Number(room.contextKey.split(':').at(-1)) });
  assert.equal(detached.status, 200); waiting.open(); assert.notEqual((await task).status, 200);
  assert.notEqual((await generate(f, { ...body, action: 'validate' })).status, 200);
});

test('retrying a failed directed seat preserves an independent successful quoted reply and its work draft basis', async t => {
  const waiting = gate(t); let whaleCalls = 0, draftSignal;
  const f = fixture(t, { script: options => isDraft(options) ? (async function* () { draftSignal = options.signal; await waiting.promise; yield* draft(); })()
    : bodyOf(options).speaker.id === whale ? reply(['首位的完整回应'], ++whaleCalls === 1 ? 'max-tokens' : 'stop') : reply(['后位原先的公开方案']) });
  await f.ready(); const room = await newRoom(f, [whale, dragon]), initial = await roomState(f, room);
  assert.equal((await f.request('chat-rooms', { ...room, action: 'update', targetPersonaIds: [whale, dragon], configRevision: initial.room.configRevision, epoch: initial.epoch })).status, 200);
  await roomSend(f, room, whale, '请两位依次讨论', 'both'); const settled = await settledRoom(f, room);
  assert.deepEqual(settled.room.turns.filter(turn=>turn.phase!=='anchor').map(turn => turn.status), ['failed', 'ready']);
  const info = await get(f, room), assistant = info.choices.find(q => q.ref.kind === 'assistant' && q.author.id === dragon);
  const body = await generateBody(f, room, { refs: [assistant.ref] }), task = generate(f, body); await flush();
  const first = settled.room.turns.find(turn=>turn.phase!=='anchor');
  assert.equal((await f.request('chat', { ...room, action: 'retry', personaId: whale, id: first.id, attemptId: 'regenerated-primary',
    revision: settled.room.revision, epoch: settled.epoch })).status, 200);
  assert.equal(draftSignal.aborted, false); waiting.open();assert.equal((await task).status,200);await settledRoom(f, room);
  assert.equal((await generate(f, { ...body, action: 'validate' })).status, 200);
});

test('work drafting rejects tool activity and does not expose provider error text as a usable draft', async t => {
  let mode = 'tool';
  const f = fixture(t, { script: options => !isDraft(options) ? reply() : (async function* () {
    if (mode === 'error') { yield { type: 'error', error: new Error('PROVIDER_PRIVATE_ERROR_TOKEN') }; return; }
    yield { type: 'text-delta', text: '{"draft":"不应采用这份草稿"}' };
    yield { type: 'tool-call-delta', id: 'unexpected', name: 'send_message', argumentsDelta: '{}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })() }); await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room); await settledRoom(f, room);
  const body = await generateBody(f, room);
  assert.notEqual((await generate(f, body)).status, 200); mode = 'error';
  const failed = await generate(f, { ...body, requestId: 'provider-error' }); assert.notEqual(failed.status, 200);
  assert.doesNotMatch(JSON.stringify(failed.value), /PROVIDER_PRIVATE_ERROR_TOKEN|不应采用这份草稿/);
});

test('cropping a selected original message rejects the old draft without manufacturing durable memory', async t => {
  const waiting = gate(t), f = fixture(t, { script: options => !isDraft(options) ? reply() : (async function* () { await waiting.promise; yield* draft('CROPPED_LATE_DRAFT'); })() });
  await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room, whale, 'ORIGINAL_QUOTE_TO_CROP', 'original'); await settledRoom(f, room);
  const task = generate(f, await generateBody(f, room)); await flush();
  for (let i = 0; i < 40; i++) { await roomSend(f, room, whale, '后来一句 ' + i, 'new-' + i); await settledRoom(f, room); }
  waiting.open(); assert.notEqual((await task).status, 200);
  assert.doesNotMatch(JSON.stringify((await f.request('memory')).value.entries), /ORIGINAL_QUOTE_TO_CROP|CROPPED_LATE_DRAFT/);
  assert.doesNotMatch(JSON.stringify((await roomState(f, room)).room.turns), /CROPPED_LATE_DRAFT/);
});

test('work draft text is never persisted as chat, memory or a source workflow report and is not injected into formal rewriting', async t => {
  const storage = domain(), f = fixture(t, { storage, script: options => isDraft(options) ? draft('UNSENT_EDITABLE_WORK_DRAFT') : reply() });
  await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room, whale, 'ROOM_ONLY_DISCUSSION', 'origin'); await settledRoom(f, room);
  assert.equal((await generate(f, await generateBody(f, room))).status, 200);
  const before = f.calls.length, session = { id: 'formal', header: {}, append() { assert.fail('drafts cannot submit to work sessions'); } };
  f.bus.emit('session/event', session, { seq: 1, type: 'turn/start', data: { turn: 1 } });
  f.bus.emit('session/event', session, { seq: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '原工作流程的正式汇报。' }] } } });
  await flush(); assert.equal(f.calls.length, before + 1);
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1)), /ROOM_ONLY_DISCUSSION|UNSENT_EDITABLE_WORK_DRAFT|discussionState|quotes/);
  await f.dispose(); assert.doesNotMatch(JSON.stringify([...storage.tables].map(([name, table]) => [name, [...table]])), /UNSENT_EDITABLE_WORK_DRAFT/);
});

test('clearing or deleting a room makes its prior draft basis invalid without appending draft output anywhere', async t => {
  for (const action of ['clear', 'delete']) await t.test(action, async sub => {
    const waiting = gate(sub), f = fixture(sub, { script: options => !isDraft(options) ? reply() : (async function* () { await waiting.promise; yield* draft('LATE_DRAFT_NEVER_SAVED'); })() });
    await f.ready(); const room = await newRoom(f, [whale]); await roomSend(f, room); await settledRoom(f, room);
    const body = await generateBody(f, room), task = generate(f, body); await flush(); const state = await roomState(f, room);
    const changed = action === 'clear' ? await f.request('chat', { action, ...room, personaId: whale, revision: state.room.revision, epoch: state.epoch })
      : await f.request('chat-rooms', { action, roomId: room.roomId, revision: state.room.revision, epoch: state.epoch });
    assert.equal(changed.status, 200); waiting.open(); assert.notEqual((await task).status, 200);
    assert.notEqual((await generate(f, { ...body, action: 'validate' })).status, 200);
    assert.doesNotMatch(JSON.stringify(f.storage.tables.get('profile').get('personaChats')), /LATE_DRAFT_NEVER_SAVED/);
  });
});

async function restoredWithPendingCatalog(t, mockedTransport = false) {
  const storage = domain(), first = fixture(t, { storage }); await first.ready();
  const room = await newRoom(first, [whale]); await roomSend(first, room); if(mockedTransport)t.mock.timers.tick(0); await settledRoom(first, room); await first.dispose();
  const catalog = gate(t), f = fixture(t, { storage, config: { model: '', timeoutMs: 1000 }, listModels: () => catalog.promise }); await f.ready(); await f.state();
  return { f, room, catalog, body: await generateBody(f, room) };
}

test('draft deadline includes default-model lookup and late lookup completion cannot dispatch a model', async t => {
  // Restore/profile-save and request deadlines share one controlled timer realm.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { f, body, catalog } = await restoredWithPendingCatalog(t, true);
  const task = generate(f, body); await flush();
  t.mock.timers.tick(1001); await flush(); assert.notEqual((await task).status, 200);
  catalog.open([{ id: 'late-model' }]); await flush(); assert.equal(f.calls.length, 0); await f.dispose();
});

test('unloading while draft route lookup is pending cancels and drains without dispatching after shutdown', async t => {
  const { f, body, catalog } = await restoredWithPendingCatalog(t), task = generate(f, body); await flush();
  await f.dispose(); assert.notEqual((await task).status, 200); catalog.open([{ id: 'late-model' }]); await flush(); assert.equal(f.calls.length, 0);
});

test('unloading after the POST ready check but before its body finishes cannot create an untracked draft task', async t => {
  const storage = domain(), seed = fixture(t, { storage }); await seed.ready();
  const room = await newRoom(seed, [whale]); await roomSend(seed, room); await settledRoom(seed, room); await seed.dispose();
  let modelLists = 0, shutdown;
  const f = fixture(t, { storage, config: { model: '' }, listModels: async () => { modelLists++; return [{ id: 'should-not-dispatch' }]; } });
  await f.ready(); await f.state();
  const body = await generateBody(f, room);
  // The fixture serializes this object in the request iterator, after the route's
  // initial ready check. Unload can happen at that point for a slow request body.
  Object.defineProperty(body, 'action', { enumerable: true, get() { shutdown ??= f.dispose(); return 'generate'; } });
  const result = await generate(f, body); await shutdown; await flush();
  assert.notEqual(result.status, 200); assert.equal(modelLists, 0); assert.equal(f.calls.length, 0);
});
