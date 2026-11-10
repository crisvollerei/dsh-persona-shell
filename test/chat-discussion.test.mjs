import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaChat, CHAT_LIMITS } from '../lib/persona-chat.js';

const people = count => Array.from({ length: count }, (_, index) => ({ id: 'persona-' + index, name: '角色' + index }));
async function setup({ count = 4, selected = 2, persist } = {}) {
  const chat = createPersonaChat({ persist }), members = people(count), recipients = members.slice(0, selected);
  const room = await chat.create({ requestId: 'create-room', name: '一起聊聊', memberIds: members.map(p => p.id),
    targetPersonaIds: recipients.map(p => p.id) });
  const started = await chat.send({ roomId: room.id, personaId: recipients[0].id, name: recipients[0].name,
    recipients, requestId: 'message-one', content: '你们觉得这个想法怎么样？', revision: room.revision, epoch: chat.epoch(),
    contextKey: 'connection-one', scopeKey: 'scope-one' });
  return { chat, room, members, recipients, primary: started.turns };
}
const finish = (f, turn, status = 'ready', messages = ['公开的看法。']) => f.chat.finish({ roomId: f.room.id,
  id: turn.id, attemptId: turn.attemptId, status, messages: status === 'ready' ? messages : [],
  ...(status === 'ready' ? {} : { failure: 'length' }) });
const decision = (f, recipients = f.members.slice(f.recipients.length, f.recipients.length + 2), extra = {}) => ({
  roomId: f.room.id, messageId: 'message-one', planId: 'plan-one',
  primaryAttempts: f.primary.map(turn => ({ id: turn.id, attemptId: turn.attemptId })), recipients,
  epoch: f.chat.epoch(), contextKey: 'connection-one', scopeKey: 'scope-one', valid: () => true, ...extra,
});
const append = (f, recipients, extra) => {
  assert.equal(typeof f.chat.appendReactions, 'function');
  return f.chat.appendReactions(decision(f, recipients, extra));
};
const retry = (f, turn, extra = {}) => f.chat.retry({ roomId: f.room.id, personaId: turn.recipientId,
  id: turn.id, attemptId: 'retry-' + turn.id, name: turn.speakerName, revision: f.chat.read(f.room.id).revision,
  epoch: f.chat.epoch(), contextKey: 'connection-one', scopeKey: 'scope-one', ...extra });
const settledPrimary = async f => { for (const turn of f.primary) await finish(f, turn); };
async function refusedWithoutChange(f, action) {
  const before = f.chat.snapshot();
  try { await action(); } catch (error) { assert.match(error.message, /^(chat-|invalid-chat)/); }
  assert.deepEqual(f.chat.snapshot(), before);
}

test('send creates only unique user-selected primary slots, without a fixed extra exchange', async () => {
  for (let count = 1; count <= CHAT_LIMITS.members; count++) {
    const selected=Math.min(count,2), f = await setup({ count, selected });
    assert.equal(f.primary.length, selected);
    assert.ok(f.primary.every(turn => turn.phase === 'primary' && turn.messageId === 'message-one'));
    assert.deepEqual(f.primary.map(turn => turn.recipientId), f.recipients.map(p => p.id));
    assert.ok(f.primary.every(turn => turn.recipients.length === selected && new Set(turn.recipients.map(p => p.id)).size === selected));
    assert.equal(f.chat.list()[0].turnCount, 1);
  }
});

test('one decision can add at most two unselected room members without changing the original addressees', async () => {
  const f = await setup();
  await finish(f, f.primary[0]);
  await finish(f, f.primary[1], 'failed');
  await append(f);
  const turns = f.chat.read(f.room.id).turns;
  assert.equal(turns.length, 4);
  assert.deepEqual(turns.map(turn => turn.phase), ['primary', 'primary', 'reaction', 'reaction']);
  assert.deepEqual(turns.slice(2).map(turn => turn.recipientId), ['persona-2', 'persona-3']);
  assert.ok(turns.every(turn => turn.messageId === 'message-one' && turn.user === f.primary[0].user));
  for (const turn of turns.slice(2)) {
    assert.deepEqual(turn.recipients, f.recipients);
    assert.ok(!turn.recipients.some(p => p.id === turn.recipientId));
    assert.equal(turn.scopeKey, 'scope-one');
    assert.equal(turn.status, 'pending');
  }
  assert.equal(f.chat.list()[0].turnCount, 1);
});

test('reaction decisions cannot run before primaries settle or when none has completed a reply', async () => {
  const f = await setup();
  await refusedWithoutChange(f, () => append(f));
  await finish(f, f.primary[0], 'failed');
  await refusedWithoutChange(f, () => append(f));
  await finish(f, f.primary[1], 'failed');
  await refusedWithoutChange(f, () => append(f));
});

test('eight members can be selected while legacy reply and listener creation retain their original guards', async () => {
  await assert.rejects(setup({count:8,selected:3}),/chat-primary-limit/);
  const f = await setup({ count: 8, selected: 2 });await settledPrimary(f);
  const before=f.chat.read(f.room.id),three=f.members.slice(0,3);
  const selected=await f.chat.update({roomId:before.id,revision:before.revision,targetPersonaIds:three.map(p=>p.id)});
  assert.deepEqual(selected.targetPersonaIds,three.map(p=>p.id));
  await f.chat.update({roomId:before.id,revision:selected.revision,targetPersonaIds:before.targetPersonaIds});
  before.revision=f.chat.read(before.id).revision;before.configRevision=f.chat.read(before.id).configRevision;
  await assert.rejects(f.chat.send({roomId:before.id,revision:before.revision,recipients:three,personaId:three[0].id,name:'甲',requestId:'new',content:'test'}),/chat-primary-limit/);
  assert.deepEqual(f.chat.read(before.id),before);
  for (const candidates of [[f.members[0]], [f.members[6], f.members[6]], [{ id: 'stranger', name: '房间外的人' }],
    [f.members[5], f.members[6], f.members[7]]]) {
    await assert.rejects(append(f, candidates), /^(Error: )?(chat-|invalid-chat)/);
    assert.equal(f.chat.read(f.room.id).turns.length, 2);
  }
  await append(f, f.members.slice(6));assert.equal(f.chat.read(f.room.id).turns.length, 4);
});

test('decision ids are durable and idempotent even when the decision is to add no speakers', async () => {
  let writes = 0;const f = await setup({ persist: async () => { writes++; } });await settledPrimary(f);
  const before = writes;await append(f, []);assert.equal(writes, before + 1, 'an empty choice is still acknowledged durably');
  const decided = f.chat.snapshot();await append(f, []);assert.deepEqual(f.chat.snapshot(), decided);assert.equal(writes, before + 1);
  await assert.rejects(append(f, [], { planId: 'different-plan' }), /conflict/);
  const restored = createPersonaChat();restored.restore(decided);
  await assert.rejects(restored.appendReactions(decision(f, [], { planId: 'after-restart' })), /conflict/);
  assert.equal(restored.read(f.room.id).turns.length, 2);
});

test('the durable reaction guard rejects both newcomers and departed listeners', async () => {
  const f = await setup({count:3,selected:1});
  await settledPrimary(f);
  const [primary, retained, departed] = f.members, newcomer = {id:'newcomer',name:'新成员'};
  await f.chat.update({roomId:f.room.id, revision:f.chat.read(f.room.id).revision, memberIds:[primary.id, retained.id, newcomer.id]});
  for (const invalid of [newcomer, departed]) await assert.rejects(append(f, [invalid]), /chat-recipient-not-member/);
  const {turns} = await append(f, [retained]);
  assert.deepEqual(turns[0].memberIdsAtSend, f.members.map(p=>p.id));
});

test('a repeated nonempty plan cannot append duplicate reactions or consume a second decision', async () => {
  const f = await setup();await settledPrimary(f);await append(f);
  const before = f.chat.snapshot();await append(f);assert.deepEqual(f.chat.snapshot(), before);
  await assert.rejects(append(f, [f.members[2]], { planId: 'second-plan' }), /conflict/);
  assert.equal(f.chat.read(f.room.id).turns.length, 4);
});

test('a decision with stale primary attempts, epoch or reference scope cannot append speakers', async () => {
  const f = await setup();await settledPrimary(f);
  const staleAttempts = f.primary.map(turn => ({ id: turn.id, attemptId: 'old-' + turn.attemptId }));
  await refusedWithoutChange(f, () => append(f, undefined, { primaryAttempts: staleAttempts }));
  await refusedWithoutChange(f, () => append(f, undefined, { epoch: f.chat.epoch() + 1 }));
  await refusedWithoutChange(f, () => append(f, undefined, { scopeKey: 'different-scope' }));
  await append(f);assert.equal(f.chat.read(f.room.id).turns.length, 4);
});

test('invalidated, cleared or deleted decisions cannot create late reactions', async () => {
  const f = await setup();await settledPrimary(f);
  await refusedWithoutChange(f, () => append(f, undefined, { valid: () => false }));
  const late = decision(f);
  await f.chat.clear({ roomId: f.room.id, revision: f.chat.read(f.room.id).revision, epoch: f.chat.epoch() });
  await refusedWithoutChange(f, () => f.chat.appendReactions(late));
  await f.chat.remove({ roomId: f.room.id, revision: f.chat.read(f.room.id).revision, epoch: f.chat.epoch() });
  await refusedWithoutChange(f, () => f.chat.appendReactions(late));
});

test('a plan invalidated while persistence is pending is repaired without publishing reactions', async () => {
  let gate, entered, block = false, valid = true;
  const f = await setup({ persist: async () => { if (block) { block = false;entered();await new Promise(resolve => { gate = resolve; }); } } });
  await settledPrimary(f);const before = f.chat.snapshot();
  const began = new Promise(resolve => { entered = resolve; });block = true;
  const write = append(f, undefined, { valid: () => valid });await began;valid = false;gate();
  await write;assert.deepEqual(f.chat.snapshot(), before);
});

test('retrying a primary resets its dependent primary tail and discards reactions plus the old decision', async () => {
  const f = await setup({ count: 5, selected: 2 });
  await finish(f, f.primary[0], 'ready', ['保留的首条观点']);await finish(f, f.primary[1], 'failed');
  await append(f);const reactions = f.chat.read(f.room.id).turns.slice(2);for (const turn of reactions) await finish(f, turn);
  const staleDecision = decision(f);
  const { reactionPlanId: oldDecision, ...prefix } = f.chat.read(f.room.id).turns[0];
  const retried = await retry(f, f.primary[1]);
  assert.deepEqual(retried.turns.map(turn => turn.id), f.primary.slice(1).map(turn => turn.id));
  const { reactionPlanId: clearedDecision, ...retained } = f.chat.read(f.room.id).turns[0];
  assert.deepEqual(retained, prefix, 'clearing the decision does not alter the completed primary speech');
  assert.equal(f.chat.read(f.room.id).turns.length, 2);
  assert.ok(retried.turns.every(turn => turn.phase === 'primary' && turn.status === 'pending' && !turn.assistant.length));
  assert.notEqual(retried.turns[0].attemptId, f.primary[1].attemptId);
  assert.equal(await finish(f, f.primary[1]), false);for (const old of reactions) assert.equal(await finish(f, old), false);
  f.primary = f.chat.read(f.room.id).turns;for (const turn of f.primary.slice(1)) await finish(f, turn);
  await refusedWithoutChange(f, () => f.chat.appendReactions(staleDecision));
  await append(f, undefined, { planId: 'replanned-after-retry' });
  assert.equal(f.chat.read(f.room.id).turns.length, 4);
});

test('retrying a reaction changes only that reaction and its reaction tail', async () => {
  const f = await setup();await settledPrimary(f);await append(f);
  const original = f.chat.read(f.room.id).turns, [first, second] = original.slice(2);
  await finish(f, first, 'failed');await finish(f, second, 'ready', ['需要随前一位重试更新的插话']);
  const prefix = f.chat.read(f.room.id).turns.slice(0, 2), retried = await retry(f, first);
  assert.deepEqual(retried.turns.map(turn => turn.id), [first.id, second.id]);
  assert.deepEqual(f.chat.read(f.room.id).turns.slice(0, 2), prefix);
  assert.ok(retried.turns.every(turn => turn.phase === 'reaction' && turn.status === 'pending' && !turn.assistant.length));
  assert.notEqual(retried.turns[1].attemptId, second.attemptId);
  assert.equal(await finish(f, second), false);
  await assert.rejects(append(f, [], { planId: 'cannot-decide-again' }), /conflict/);
});

test('retry cannot cut into pending primary or reaction work without explicit orphan recovery', async () => {
  const f = await setup();await finish(f, f.primary[0], 'failed');
  const before = f.chat.snapshot();await assert.rejects(retry(f, f.primary[0]), /chat-busy/);assert.deepEqual(f.chat.snapshot(), before);
  const recovered = await retry(f, f.primary[0], { allowOrphan: true });assert.equal(recovered.turns.length, 2);
  const g = await setup();await settledPrimary(g);await append(g);
  const [first] = g.chat.read(g.room.id).turns.slice(2);await finish(g, first, 'failed');
  const reactionBefore = g.chat.snapshot();await assert.rejects(retry(g, first), /chat-busy/);assert.deepEqual(g.chat.snapshot(), reactionBefore);
  assert.equal((await retry(g, first, { allowOrphan: true })).turns.length, 2);
});

test('cancelled reactions reject late results while completed primary speech remains intact', async () => {
  const f = await setup();await settledPrimary(f);await append(f);
  const original = f.chat.read(f.room.id).turns, reactions = original.slice(2), prefix = original.slice(0, 2);
  await f.chat.cancel({ roomId: f.room.id, id: reactions[0].id, attemptId: reactions[0].attemptId, messageId: 'message-one',
    attempts: reactions.map(turn => ({ id: turn.id, attemptId: turn.attemptId })), epoch: f.chat.epoch() });
  for (const turn of reactions) assert.equal(await finish(f, turn), false);
  assert.deepEqual(f.chat.read(f.room.id).turns.slice(0, 2), prefix);
  assert.ok(f.chat.read(f.room.id).turns.slice(2).every(turn => turn.status === 'cancelled' && !turn.assistant.length));
});
