import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversations } from '../lib/conversations.js';
const context = { knownPersona: (id) => ['a', 'b'].includes(id), currentPersonaId: () => 'a', latestSeq: 10 };
const select = (revision, personaId = 'b', trigger = 'report') => ({ action: 'select', revision, personaId, trigger });

test('session choices inherit by default and restore without changing another session', async () => {
  const c = createConversations();
  assert.equal(c.read('s').personaId, null);
  await c.update('s', select(0), context);
  assert.equal(c.read('other').trigger, 'inherit');
  const next = createConversations(); next.restore(c.snapshot());
  assert.equal(next.read('s').personaId, 'b');
  await next.update('s', select(1, null, 'inherit'), context);
  assert.equal(next.read('s').personaId, null);
});
test('concurrent stale writes conflict and a failed durable write changes no live state', async () => {
  let fail = false;
  const c = createConversations({ persist: async () => { if (fail) throw Error('disk'); } });
  const outcomes = await Promise.allSettled([c.update('s', select(0), context), c.update('s', select(0, 'a'), context)]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.match(outcomes[1].reason.message, /conflict/);
  fail = true;
  await assert.rejects(c.update('s', select(1, 'a'), context), /disk/);
  assert.equal(c.read('s').personaId, 'b');
  assert.equal(c.read('s').revision, 1);
});
test('manual relay waits for a new source, consumes once, and survives restart', async () => {
  const c = createConversations({ id: () => 'relay' });
  await c.update('s', { action: 'relay', revision: 0, toPersonaId: 'b' }, context);
  assert.equal(c.read('s').personaId, null);
  assert.equal(await c.take('s', 10, context.knownPersona), false);
  const results = await Promise.all([c.take('s', 11, context.knownPersona), c.take('s', 11, context.knownPersona)]);
  assert.deepEqual(results, [true, false]);
  const next = createConversations(); next.restore(c.snapshot());
  assert.equal(await next.take('s', 12, context.knownPersona), false);
  assert.equal(next.read('s').relay.consumedSeq, 11);
  assert.equal(next.read('s').personaId, 'b');
});
test('cancel and explicit selection cannot accidentally activate a pending relay', async () => {
  const c = createConversations({ id: () => 'relay' });
  await c.update('s', { action: 'relay', revision: 0, toPersonaId: 'b' }, context);
  await assert.rejects(c.update('s', { action: 'cancel', revision: 1, relayId: 'other' }, context), /conflict/);
  await c.update('s', select(1, 'a'), context);
  assert.equal(await c.take('s', 12, context.knownPersona), false);
  assert.equal(c.read('s').relay.status, 'cancelled');
});
test('deleted target cancels rather than silently handing work to another persona', async () => {
  const c = createConversations({ id: () => 'relay' });
  await c.update('s', { action: 'relay', revision: 0, toPersonaId: 'b' }, context);
  await assert.rejects(c.take('s', 11, () => false), /deleted/);
  assert.equal(c.read('s').personaId, null);
  assert.equal(c.read('s').relay.status, 'cancelled');
});
test('special session keys cannot read or mutate the object prototype', async () => {
  const c = createConversations();
  await c.update('__proto__', select(0), context);
  assert.equal(c.read('__proto__').personaId, 'b');
  assert.equal({}.personaId, undefined);
  const next = createConversations(); next.restore(c.snapshot());
  assert.equal(next.read('__proto__').personaId, 'b');
});

test('a target removed during persistence is cancelled before dispatch can start', async () => {
  let available = true, block = false, release;
  const c = createConversations({ id: () => 'relay', persist: async () => {
    if (block) { block = false; await new Promise((r) => { release = r; }); }
  } });
  await c.update('s', { action: 'relay', revision: 0, toPersonaId: 'b' }, context);
  block = true;
  const taking = c.take('s', 11, () => available);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  available = false; release();
  await assert.rejects(taking, /deleted/);
  assert.equal(c.read('s').relay.status, 'cancelled');
  assert.equal(c.read('s').personaId, null);
});
