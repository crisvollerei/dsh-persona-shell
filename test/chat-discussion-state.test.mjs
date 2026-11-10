import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeDiscussion, discussionView, discussionContext, restoreDiscussion, chatAssignment } from '../lib/chat-discussion.js';
import { createPersonaChat } from '../lib/persona-chat.js';
import { fixture, domain, flush, reply, preference, newRoom, roomSend, roomState, settledRoom, whale, dragon } from './helpers/persona-chat-host.mjs';

const scope = 'r:sources:1';
const userRef = (messageId, roomId = 'r') => ({ roomId, generation: 0, kind: 'user', messageId });
const assistantRef = (turnId = 't1', roomId = 'r', attemptId = turnId) => ({ roomId, generation: 0, kind: 'assistant', turnId, attemptId, index: 0 });
const turn = (id, user, assistant = ['候选方案原话'], at = 1) => ({ id, messageId: id, attemptId: id, recipientId: whale,
  recipients: [{ id: whale, name: whale }], speakerName: whale, user, assistant, status: 'ready', scopeKey: scope, at, phase: 'primary' });
const room = () => ({ id: 'r', generation: 0, turns: [turn('t1', '原来的问题', ['模型建议，只是候选。']), turn('t2', '我确认采用这个方案。', ['收到。'], 2)] });
const add = (value, extra = {}) => ({ action: 'add', requestId: 'one', discussionRevision: value.discussion?.revision ?? 0,
  source: assistantRef(), title: '用户整理的标签', status: 'proposal', ...extra });
const apply = (value, body) => { value.discussion = changeDiscussion(value, body, scope, 100 + (value.discussion?.revision ?? 0)); return value.discussion; };
const bodyOf = call => readChatInput(call);
const references = async (f, binding) => (await f.request('chat-references?room=' + encodeURIComponent(binding.roomId))).value;
const update = async (f, binding, patch) => {
  const view = await references(f, binding);
  return f.request('chat-discussion', { roomId: binding.roomId, epoch: view.epoch, discussionRevision: view.discussion.revision, ...patch });
};
const actualUserRef = (binding, state, messageId) => ({ roomId: binding.roomId, generation: state.room.generation, kind: 'user', messageId });
const actualAssistantRef = (binding, state, value) => ({ roomId: binding.roomId, generation: state.room.generation,
  kind: 'assistant', turnId: value.id, attemptId: value.attemptId, index: 0 });

test('discussion stores canonical pointers and owner labels; user evidence is required for a decision', () => {
  const r = room();
  apply(r, add(r, { source: { ...assistantRef(), text: '伪造原文', author: { name: dragon } } }));
  const first = discussionView(r, scope).entries[0];
  assert.equal(first.source.text, '模型建议，只是候选。'); assert.equal(first.source.author.id, whale);
  assert.doesNotMatch(JSON.stringify(r.discussion), /伪造原文|模型建议|确认采用|author/);
  assert.equal(first.status, 'proposal');
  assert.throws(() => apply(r, { action: 'update', discussionRevision: 1, id: first.id, version: first.version,
    title: first.title, status: 'confirmed' }), /evidence-required/);
  apply(r, { action: 'update', discussionRevision: 1, id: first.id, version: first.version,
    title: '已确认的房间方案', status: 'confirmed', evidence: { ...userRef('t2'), text: '伪造确认', author: { role: 'assistant' } } });
  const settled = discussionContext(r, scope)[0];
  assert.equal(settled.evidence.text, '我确认采用这个方案。'); assert.equal(settled.evidence.author.role, 'user');
  assert.equal(settled.reviewedBy, 'user-in-settings');
});

test('assistant proposals cannot be confirmed by an assistant, another room, older or same-turn user words', () => {
  for (const evidence of [assistantRef('t2'), userRef('t2', 'foreign'), userRef('t1'), { ...userRef('t2'), generation: 1 }]) {
    const r = room(), before = structuredClone(r);
    assert.throws(() => apply(r, add(r, { status: 'confirmed', evidence })), /evidence-required/);
    assert.deepEqual(r, before);
  }
  const r = room();
  for (const status of ['confirmed', 'deferred', 'rejected']) {
    const copy = structuredClone(r); apply(copy, add(copy, { status, evidence: userRef('t2') }));
    assert.equal(discussionView(copy, scope).entries[0].status, status);
  }
});

test('a room state hides old scope labels and stops using replaced, uncommitted or cleared evidence', () => {
  const r = room(); apply(r, add(r, { title: 'OLD_SCOPE_LABEL' }));
  const otherScope = discussionView(r, 'r:sources:2');
  assert.equal(otherScope.entries[0].available, false); assert.doesNotMatch(JSON.stringify(otherScope), /OLD_SCOPE_LABEL|模型建议/);
  assert.deepEqual(discussionContext(r, 'r:sources:2'), []);
  r.turns[0].attemptId = 'replacement'; assert.deepEqual(discussionContext(r, scope), []);
  r.turns[0].attemptId = 't1'; r.turns[0].status = 'pending'; assert.deepEqual(discussionContext(r, scope), []);
  r.turns[0].status = 'ready'; r.generation = 1; assert.deepEqual(discussionContext(r, scope), []);
  r.generation = 0; r.turns = []; assert.deepEqual(discussionContext(r, scope), []);
});

test('restored decisions revalidate confirmation chronology before entering a chat prompt', () => {
  const r = room(); apply(r, add(r, { status: 'confirmed', evidence: userRef('t2') }));
  const saved = structuredClone(r.discussion); saved.entries[0].evidence = userRef('t1');
  r.discussion = restoreDiscussion(saved, r.id);
  assert.equal(discussionView(r, scope).entries[0].available, false);
  assert.deepEqual(discussionContext(r, scope), []);
});

test('correction and undo have monotonic versions without reviving a stale source', () => {
  const r = room(); apply(r, add(r)); const first = r.discussion.entries[0];
  apply(r, { action: 'update', discussionRevision: 1, id: first.id, version: first.version,
    title: '更正后的标签', status: 'rejected', evidence: userRef('t2') });
  const second = r.discussion.entries[0]; assert.equal(second.version, 2);
  assert.throws(() => apply(r, { action: 'remove', discussionRevision: 1, id: first.id, version: first.version }), /conflict/);
  apply(r, { action: 'undo', discussionRevision: 2 });
  const restored = r.discussion.entries[0]; assert.equal(restored.title, first.title); assert.equal(restored.status, 'proposal'); assert.equal(restored.version, 3);
  apply(r, { action: 'remove', discussionRevision: 3, id: restored.id, version: restored.version });
  assert.equal(r.discussion.entries.length, 0);
  r.turns[0].attemptId = 'replacement'; apply(r, { action: 'undo', discussionRevision: 4 });
  assert.equal(r.discussion.entries[0].version, 5); assert.deepEqual(discussionContext(r, scope), []);
});

test('discussion restoration validates pointers and the prompt view is bounded by items and characters', () => {
  const r = { id: 'r', generation: 0, turns: Array.from({ length: 16 }, (_, i) => turn('m' + i, '公开原话 ' + i, ['候选 ' + i], i)) };
  for (let i = 0; i < 16; i++) apply(r, add(r, { requestId: String(i), source: userRef('m' + i), title: '讨论 ' + i, status: 'discussing' }));
  assert.equal(discussionContext(r, scope).length, 8);
  const invalid = structuredClone(r.discussion);
  invalid.entries[0].source.roomId = 'foreign'; invalid.entries[1].status = 'invented'; invalid.entries[2].evidence = assistantRef(); invalid.entries[2].status = 'confirmed';
  assert.equal(restoreDiscussion(invalid, 'r').entries.length, 13);
  r.turns.forEach(t => { t.user = '长原文。'.repeat(800); });
  assert.deepEqual(discussionContext(r, scope), [], 'whole quotes over the budget are omitted rather than falsely summarized');
  assert.throws(() => apply(r, add(r, { requestId: 'extra', source: userRef('m0') })), /capacity/);
});

test('temporary duties use frozen @ order and actual public predecessors, independently of persona identity', () => {
  const recipients = [{ id: dragon, name: dragon }, { id: whale, name: whale }];
  const second = { recipientId: whale, recipients, phase: 'primary' };
  assert.deepEqual(chatAssignment({ ...second, recipientId: dragon }), { kind: 'respond', order: 1, primaryCount: 2 });
  assert.deepEqual(chatAssignment(second, []), { kind: 'respond', order: 2, primaryCount: 2 });
  assert.deepEqual(chatAssignment(second, [{ speaker: { id: dragon }, messages: ['公开回应'] }]), { kind: 'complement', order: 2, primaryCount: 2 });
  assert.equal(chatAssignment({ ...second, phase: 'reaction', recipientId: 'listener' }).kind, 'contribute');
  assert.equal(chatAssignment({ ...second, phase: 'followup' }).kind, 'answer-peer');
});

test('a failed selected speaker lets the next selected speaker answer through the director without a fabricated predecessor', async t => {
  const f = fixture(t, { script: (_, n) => reply([n === 1 ? '截断不可用' : '我直接回应用户。'], n === 1 ? 'max-tokens' : 'stop') });
  await f.ready(); const binding = await newRoom(f, [whale, dragon]); const s = await roomState(f, binding);
  await f.request('chat-rooms', { ...binding, action: 'update', targetPersonaIds: [dragon, whale], configRevision: s.room.configRevision, epoch: s.epoch });
  await roomSend(f, binding, dragon, '两位依次谈一下', 'two'); const done = await settledRoom(f, binding);
  assert.deepEqual(done.room.turns.filter(turn=>turn.phase!=='anchor').map(t => t.status), ['failed', 'ready']); assert.equal(f.calls.length, 2);
  assert.equal(f.plans.length+f.continuations.length,0); assert.equal(f.directors.length,2);
  assert.equal(f.requests.length, 4, 'two actual next-speaker decisions and two replies need no empty judgement once the remaining actor has consumed the user event');
  const second = bodyOf(f.calls[1]); assert.equal(second.responsePlan.kind,'normal');assert.equal(second.responsePlan.to,'user');
  assert.deepEqual(second.exchange, []); assert.deepEqual(second.recipients.map(p => p.id), [dragon, whale]);
  assert.deepEqual(bodyOf(f.directors[1]).events.filter(event=>event.author.role==='assistant'), [], 'failed streamed words are not a completed public predecessor');
  assert.equal(bodyOf(f.directors[1]).states.find(state=>state.id===dragon).normalReady,false,'the failed actor is retired for this automatic round');
  assert.deepEqual(done.room.turns.find(turn=>turn.recipientId===dragon).assistant,[]);
  assert.deepEqual(done.room.turns.find(turn=>turn.recipientId===whale).assistant,['我直接回应用户。']);
});

test('discussion inspection remains lazy, owner-only and free of project reads or model calls', async t => {
  const reads = []; let projects = 0;
  const f = fixture(t, { storage: domain(Promise.resolve(), { onGet: key => reads.push(key) }),
    extraServices: [['workspaceRegistry', { list() { projects++; return []; } }]] }); await f.ready();
  assert.equal((await f.request('chat-references')).value.initialized, false);
  assert.equal((await f.request('chat-discussion', { roomId: 'foreign', action: 'add' }, false)).status, 403);
  assert.ok(!reads.includes('personaChats')); assert.equal(projects, 0); assert.equal(f.calls.length, 0); assert.equal(f.judgements.length, 0);
});

test('owner annotations commit durably, keep only pointers, and clearing rejects stale restoration writes', async t => {
  const storage = domain(), f = fixture(t, { storage }); await f.ready(); const binding = await newRoom(f, [whale]);
  await roomSend(f, binding, whale, 'RAW_WORDS_MUST_NOT_BE_COPIED', 'origin'); const s = await settledRoom(f, binding);
  const source = actualUserRef(binding, s, 'origin'), before = f.calls.length;
  assert.equal((await update(f, binding, { action: 'add', requestId: 'keep', title: '房间主题', status: 'discussing', source })).status, 200);
  const view = await references(f, binding); assert.equal(view.discussion.entries[0].source.text, 'RAW_WORDS_MUST_NOT_BE_COPIED'); assert.equal(f.calls.length, before);
  const stored = storage.tables.get('profile').get('personaChats'), saved = stored.rooms.find(r => r.id === binding.roomId).discussion;
  assert.doesNotMatch(JSON.stringify(saved), /RAW_WORDS_MUST_NOT_BE_COPIED|assistant|speakerName/);
  const recreated = createPersonaChat(); recreated.restore(stored); assert.equal(recreated.read(binding.roomId).discussion.entries.length, 1);
  const latest = await roomState(f, binding);
  await f.request('chat', { ...binding, action: 'clear', personaId: whale, revision: latest.room.revision, epoch: latest.epoch });
  assert.equal((await references(f, binding)).discussion.entries.length, 0);
  assert.equal((await f.request('chat-discussion', { roomId: binding.roomId, epoch: view.epoch, discussionRevision: view.discussion.revision,
    action: 'add', requestId: 'late', title: '旧页', status: 'discussing', source })).status, 409);
});

test('failed saves leave board and active request revisions unchanged, and stale edits conflict', async t => {
  let fail = false;
  const f = fixture(t, { storage: domain(Promise.resolve(), { fail: key => fail && key === 'personaChats' }) }); await f.ready();
  const binding = await newRoom(f, [whale]); await roomSend(f, binding, whale, '原话依据', 'origin'); const s = await settledRoom(f, binding);
  const first = await references(f, binding), patch = { roomId: binding.roomId, epoch: first.epoch, discussionRevision: first.discussion.revision,
    action: 'add', requestId: 'save', title: '标签', status: 'discussing', source: actualUserRef(binding, s, 'origin') };
  fail = true; assert.equal((await f.request('chat-discussion', patch)).status, 503); fail = false;
  const failed = await references(f, binding); assert.equal(failed.discussion.revision, first.discussion.revision); assert.equal(failed.referenceRevision, first.referenceRevision);
  assert.equal((await f.request('chat-discussion', patch)).status, 200);
  assert.equal((await f.request('chat-discussion', { ...patch, requestId: 'stale' })).status, 409);
  const current = await references(f, binding); assert.equal(current.discussion.entries.length, 1);
});

test('undo keeps a new version across restart and cannot resurrect an older request’s discussion text', async t => {
  const storage = domain(), f = fixture(t, { storage }); await f.ready(); const binding = await newRoom(f, [whale]);
  await roomSend(f, binding, whale, '这个原话用来整理房间主题', 'origin'); const original = await settledRoom(f, binding);
  await update(f, binding, { action: 'add', requestId: 'durable', title: '原来的整理标签', status: 'discussing', source: actualUserRef(binding, original, 'origin') });
  await roomSend(f, binding, whale, '基于这个主题继续', 'using-v1'); await settledRoom(f, binding);
  const firstView = await references(f, binding), used = firstView.records.find(r => r.messageId === 'using-v1'), item = firstView.discussion.entries[0];
  assert.equal(used.discussion[0].version, 1); assert.equal(used.discussion[0].available, true);
  await update(f, binding, { action: 'update', id: item.id, version: item.version, title: '更正后的整理标签', status: 'discussing' });
  await update(f, binding, { action: 'undo' });
  const afterUndo = await references(f, binding), restored = afterUndo.discussion.entries[0];
  assert.equal(restored.title, '原来的整理标签'); assert.equal(restored.version, 3);
  assert.equal(afterUndo.records.find(r => r.id === used.id).discussion[0].available, false);
  await roomSend(f, binding, whale, '按撤销后的状态继续', 'using-v3'); await settledRoom(f, binding);
  assert.equal(bodyOf(f.calls.at(-1)).discussionState[0].version, 3);
  await f.dispose();
  const g = fixture(t, { storage }); await g.ready(); await roomState(g, binding);
  const reopened = await references(g, binding); assert.equal(reopened.discussion.entries[0].version, 3);
  assert.equal(reopened.records.find(r => r.id === used.id).discussion[0].available, false);
  assert.equal(reopened.records.find(r => r.messageId === 'using-v3').discussion[0].available, true);
  assert.equal(g.calls.length, 0, 'restoring state and evidence does not start a model request');
});

test('settings rejects forged, foreign and premature confirmation evidence without adding entries', async t => {
  const f = fixture(t); await f.ready(); const a = await newRoom(f, [whale], '甲', 'a'), b = await newRoom(f, [dragon], '乙', 'b');
  await roomSend(f, a, whale, '甲房间原问题', 'same'); const original = await settledRoom(f, a);
  await roomSend(f, b, dragon, '乙房间原问题', 'same'); const foreign = await settledRoom(f, b);
  await roomSend(f, a, whale, '我确认采用原方案。', 'confirmed'); const latest = await settledRoom(f, a);
  const sourceTurn=original.room.turns.find(turn=>turn.phase!=='anchor');
  const source = actualAssistantRef(a, original, sourceTurn), sameTurn = actualUserRef(a, original, 'same');
  const assistantEvidence = actualAssistantRef(a, latest, latest.room.turns.at(-1));
  const before = f.calls.length;
  for (const evidence of [sameTurn, assistantEvidence, actualUserRef(b, foreign, 'same'), { ...actualUserRef(a, latest, 'confirmed'), generation: latest.room.generation + 1 }]) {
    const r = await update(f, a, { action: 'add', requestId: 'bad', title: '不应确认', status: 'confirmed', source, evidence });
    assert.equal(r.status, 400); assert.equal((await references(f, a)).discussion.entries.length, 0);
  }
  assert.equal((await update(f, a, { action: 'add', requestId: 'good', title: '有效确认', status: 'confirmed',
    source: { ...source, text: 'FORGED_SOURCE_BODY', author: { id: dragon } }, evidence: { ...actualUserRef(a, latest, 'confirmed'), text: 'FORGED_EVIDENCE' } })).status, 200);
  const view = await references(f, a); assert.equal(view.discussion.entries[0].source.text, sourceTurn.assistant[0]);
  assert.equal(view.discussion.entries[0].evidence.text, '我确认采用原方案。'); assert.equal(f.calls.length, before);
  assert.doesNotMatch(JSON.stringify(view), /FORGED_SOURCE_BODY|FORGED_EVIDENCE|乙房间原问题/);
});

test('queued discussion edits recheck the committed reference scope after a source save', async t => {
  let release, began, blockNext = false;
  const blocked = new Promise(resolve => { began = resolve; }), gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = fixture(t, { storage: domain(Promise.resolve(), { async beforePut(key) {
    if (key === 'personaChats' && blockNext) { blockNext = false; began(); await gate; }
  } }) }); await f.ready(); const binding = await newRoom(f, [whale]);
  await roomSend(f, binding, whale, 'SOURCE_CHANGE_RACE', 'origin'); const s = await settledRoom(f, binding), view = await references(f, binding);
  blockNext = true;
  const detaching = f.request('chat-context', { ...binding, action: 'detach', sessionId: 'work', revision: Number(binding.contextKey.split(':').at(-1)) });
  await blocked;
  const annotating = f.request('chat-discussion', { roomId: binding.roomId, epoch: view.epoch, discussionRevision: view.discussion.revision,
    action: 'add', requestId: 'late-scope', title: '旧来源标签', status: 'discussing', source: actualUserRef(binding, s, 'origin') });
  release(); assert.equal((await detaching).status, 200); assert.equal((await annotating).status, 400);
  assert.equal((await references(f, binding)).discussion.entries.length, 0);
});

test('room annotations reach only that room while each speaker retains her own private preferences', async t => {
  const f = fixture(t); await f.ready(); await preference(f, 'WHALE_ONLY_PREFERENCE', whale); await preference(f, 'DRAGON_ONLY_PREFERENCE', dragon);
  const a = await newRoom(f, [whale, dragon], '甲', 'a'), b = await newRoom(f, [whale], '乙', 'b');
  await roomSend(f, a, whale, 'ROOM_A_PRIVATE_PUBLIC_WORDS', 'origin'); const s = await settledRoom(f, a);
  assert.equal((await update(f, a, { action: 'add', requestId: 'topic', title: 'ONLY_ROOM_A_LABEL', status: 'discussing', source: actualUserRef(a, s, 'origin') })).status, 200);
  const latest = await roomState(f, a); await f.request('chat-rooms', { ...a, action: 'update', configRevision: latest.room.configRevision, epoch: latest.epoch, targetPersonaIds: [whale, dragon] });
  const before = f.calls.length; await roomSend(f, a, whale, '继续讨论', 'next'); await settledRoom(f, a);
  const ownCalls = f.calls.slice(before); assert.equal(ownCalls.length, 2);
  assert.ok(ownCalls.every(c => bodyOf(c).discussionState[0].title === 'ONLY_ROOM_A_LABEL'));
  assert.match(ownCalls[0].system, /WHALE_ONLY_PREFERENCE/); assert.doesNotMatch(ownCalls[0].system, /DRAGON_ONLY_PREFERENCE/);
  assert.match(ownCalls[1].system, /DRAGON_ONLY_PREFERENCE/); assert.doesNotMatch(ownCalls[1].system, /WHALE_ONLY_PREFERENCE/);
  assert.ok(ownCalls.every(call=>bodyOf(call).responsePlan.kind==='normal'&&bodyOf(call).responsePlan.to==='user'));
  const used = (await references(f, a)).records[0]; assert.equal(used.discussion[0].title, 'ONLY_ROOM_A_LABEL');
  const board = (await references(f, a)).discussion, item = board.entries[0];
  await update(f, a, { action: 'update', id: item.id, version: item.version, title: '更正后的房间标签', status: 'discussing' });
  const oldUsage = (await references(f, a)).records.find(record => record.id === used.id);
  assert.equal(oldUsage.discussion[0].available, false); assert.doesNotMatch(JSON.stringify(oldUsage.discussion), /ONLY_ROOM_A_LABEL/);
  await roomSend(f, b, whale, '乙房间继续', 'other'); await settledRoom(f, b);
  assert.doesNotMatch(JSON.stringify(bodyOf(f.calls.at(-1))), /ONLY_ROOM_A_LABEL|ROOM_A_PRIVATE_PUBLIC_WORDS/);
  assert.equal((await references(f, b)).discussion.entries.length, 0);
});

test('a discussion correction cancels only its own room and rejects delayed old-state replies', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = fixture(t, { script: options => bodyOf(options).message.endsWith('_RUN') ? (async function* () { await gate; yield* reply(['LATE_OLD_STATE']); })() : reply(['原回应']) });
  await f.ready(); const a = await newRoom(f, [whale], '甲', 'a'), b = await newRoom(f, [dragon], '乙', 'b');
  await roomSend(f, a, whale, '讨论原话', 'origin'); const original = await settledRoom(f, a);
  await roomSend(f, a, whale, 'A_RUN', 'a-run'); await roomSend(f, b, dragon, 'B_RUN', 'b-run'); await flush();
  assert.equal((await update(f, a, { action: 'add', requestId: 'state', title: '新的讨论状态', status: 'discussing', source: actualUserRef(a, original, 'origin') })).status, 200);
  release(); const [doneA, doneB] = await Promise.all([settledRoom(f, a), settledRoom(f, b)]);
  assert.equal(doneA.room.turns.at(-1).status, 'cancelled'); assert.equal(doneB.room.turns.at(-1).status, 'ready');
  assert.doesNotMatch(JSON.stringify(doneA.room.turns), /LATE_OLD_STATE/);
});

test('changing work source does not carry reviewed room decisions into the new reference scope', async t => {
  const f = fixture(t); await f.ready(); const binding = await newRoom(f, [whale]);
  await roomSend(f, binding, whale, 'OLD_SCOPE_DISCUSSION_WORDS', 'origin'); const s = await settledRoom(f, binding);
  assert.equal((await update(f, binding, { action: 'add', requestId: 'old', title: 'OLD_SCOPE_DISCUSSION_LABEL', status: 'confirmed',
    source: actualUserRef(binding, s, 'origin'), evidence: actualUserRef(binding, s, 'origin') })).status, 200);
  const opened = (await f.request('chat-context', { ...binding, action: 'detach', sessionId: 'work', revision: Number(binding.contextKey.split(':').at(-1)) })).value;
  const next = { ...binding, contextKey: opened.id + ':' + opened.revision };
  const view = await references(f, binding); assert.equal(view.discussion.entries[0].available, false);
  assert.doesNotMatch(JSON.stringify(view.discussion), /OLD_SCOPE_DISCUSSION_LABEL|OLD_SCOPE_DISCUSSION_WORDS/);
  await roomSend(f, next, whale, '新来源下的问题', 'new'); await settledRoom(f, next);
  assert.doesNotMatch(JSON.stringify(bodyOf(f.calls.at(-1))), /OLD_SCOPE_DISCUSSION_LABEL|OLD_SCOPE_DISCUSSION_WORDS/);
});

test('cropped original words leave an unavailable annotation rather than an invented lasting memory', async t => {
  const f = fixture(t); await f.ready(); const binding = await newRoom(f, [whale]);
  await roomSend(f, binding, whale, 'ORIGINAL_WORDS_TO_BE_CROPPED', 'origin'); const s = await settledRoom(f, binding);
  await update(f, binding, { action: 'add', requestId: 'age', title: 'CROPPED_SOURCE_LABEL', status: 'discussing', source: actualUserRef(binding, s, 'origin') });
  for (let i = 0; i < 40; i++) { await roomSend(f, binding, whale, '后来的话题 ' + i, 'age-' + i); await settledRoom(f, binding); }
  const view = await references(f, binding); assert.equal(view.discussion.entries[0].available, false);
  assert.equal(new Set((await roomState(f, binding)).room.turns.map(turn=>turn.messageId)).size, 40);
  await roomSend(f, binding, whale, '现在继续', 'after-crop'); await settledRoom(f, binding);
  assert.equal(f.calls.length, 42); assert.equal(f.plans.length+f.continuations.length,0);assert.equal(f.directors.length,42);
  assert.equal(f.requests.length,84,'each accepted solo user turn has one real director and one reply, without an empty follow-on call');
  const cropped=await roomState(f,binding);assert.equal(new Set(cropped.room.turns.map(turn=>turn.messageId)).size,40);
  assert.equal(cropped.room.turns.some(turn=>turn.messageId==='origin'),false,'the unavailable annotation refers to an actually cropped source');
  assert.doesNotMatch(JSON.stringify(bodyOf(f.calls.at(-1))), /ORIGINAL_WORDS_TO_BE_CROPPED|CROPPED_SOURCE_LABEL/);
  assert.doesNotMatch(JSON.stringify((await f.request('memory')).value.entries), /ORIGINAL_WORDS_TO_BE_CROPPED|CROPPED_SOURCE_LABEL/);
});

test('discussion labels and duties never become formal report input or lasting expression memory', async t => {
  const f = fixture(t); await f.ready(); const binding = await newRoom(f, [whale]);
  await roomSend(f, binding, whale, 'CHAT_ONLY_SOURCE', 'origin'); const s = await settledRoom(f, binding);
  await update(f, binding, { action: 'add', requestId: 'local', title: 'CHAT_ONLY_DECISION_LABEL', status: 'confirmed',
    source: actualUserRef(binding, s, 'origin'), evidence: actualUserRef(binding, s, 'origin') });
  const session = { id: 'work', header: {}, append() { assert.fail('annotations cannot write to the source workflow'); } }, before = f.calls.length;
  f.bus.emit('session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
  f.bus.emit('session/event', session, { type: 'assistant/message', seq: 2, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '真实工作的原始汇报。' }] } } });
  await flush(); assert.equal(f.calls.length, before + 1);
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1)), /CHAT_ONLY_DECISION_LABEL|CHAT_ONLY_SOURCE|discussionState|assignment/);
  assert.doesNotMatch(JSON.stringify((await f.request('memory')).value.entries), /CHAT_ONLY_DECISION_LABEL|CHAT_ONLY_SOURCE/);
});
