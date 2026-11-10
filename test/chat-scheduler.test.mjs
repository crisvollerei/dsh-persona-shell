import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatScheduler, chatSchedulerEventKey } from '../lib/chat-scheduler.js';

const scope = { generation: 1, sourceScope: 'scope:current' };
const ref = (turnId, extra = {}) => chatSchedulerEventKey({ roomId: 'room', ...scope, turnId, attemptId: null, ...extra });
const make = () => { let at = 0; const scheduler = createChatScheduler({ now: () => at }); scheduler.register('room', ['a', 'b', 'c'], scope); scheduler.reset('room','user-turn-1',[]); return { scheduler, set: value => { at = value; } }; };

test('cooldown belongs to each persona and starts after its complete response, with an exact five-second boundary', () => {
  const { scheduler: s, set } = make(); s.publish('room', { id: ref('u1'), authorId: 'user' });
  const a = s.claim('room', 'a', 'a1'); assert.ok(a); assert.equal(s.readyAt('room', 'a'), null);
  set(100); const b = s.claim('room', 'b', 'b1'); assert.ok(b, 'another persona does not wait behind A');
  set(1000); assert.equal(s.finish('room', 'a', a.token), true); assert.equal(s.readyAt('room', 'a'), 6000);
  set(1500); assert.equal(s.finish('room', 'b', b.token), true); assert.equal(s.readyAt('room', 'b'), 6500);
  set(5999); assert.equal(s.claim('room', 'a', 'a2'), null);
  set(6000); assert.ok(s.claim('room', 'a', 'a2')); assert.equal(s.claim('room', 'b', 'b2'), null);
  set(6500); assert.ok(s.claim('room', 'b', 'b2'));
});

test('stream bubbles are public events rather than separate calls or independent cooldown resets', () => {
  const { scheduler: s, set } = make(); const a = s.claim('room', 'a', 'one-response');
  for (let index = 0; index < 3; index++) {
    set(100 + index * 100); s.publish('room', { id: ref('assistant-turn', { attemptId: 'one-response', index }), authorId: 'a' });
    assert.equal(s.claim('room', 'a', 'premature-' + index), null);
    assert.equal(s.read('room', 'a').inFlight.token, a.token);
  }
  assert.equal(s.pending('room', 'a').length, 0, 'a persona does not answer its own output');
  assert.equal(s.pending('room', 'b').length, 3); assert.equal(s.pending('room', 'c').length, 3);
  set(1200); s.finish('room', 'a', a.token); assert.equal(s.readyAt('room', 'a'), 6200);
  set(6199); assert.equal(s.claim('room', 'a', 'next-response'), null);
  set(6200); assert.ok(s.claim('room', 'a', 'next-response'));
});

test('all new user and peer event refs accumulate fairly while a persona is in flight or cooling down', () => {
  const { scheduler: s, set } = make(), first = { id: ref('user-one'), authorId: 'user' };
  s.publish('room', first); const a = s.claim('room', 'a', 'a1'); assert.deepEqual(a.events, [first]);
  const next = [{ id: ref('user-two'), authorId: 'user' }, { id: ref('b-one', { attemptId: 'b1' }), authorId: 'b' }, { id: ref('c-one', { attemptId: 'c1' }), authorId: 'c' }];
  for (const event of next) s.publish('room', event);
  assert.deepEqual(s.pending('room', 'a'), next); assert.equal(s.read('room', 'a').cursor, first.id);
  assert.equal(s.publish('room', next[0]), false); assert.deepEqual(s.pending('room', 'a'), next);
  set(500); s.finish('room', 'a', a.token); set(1000);
  const final = { id: ref('user-three'), authorId: 'user' }; s.publish('room', final);
  assert.equal(s.claim('room', 'a', 'too-soon'), null); set(5500);
  const second = s.claim('room', 'a', 'a2'); assert.deepEqual(second.events, [...next, final]);
  assert.equal(second.cursor, final.id); assert.deepEqual(s.pending('room', 'a'), []);
  assert.deepEqual(a.events, [first], 'the first immutable inbox snapshot does not absorb later events');
});

test('seen-event deduplication persists after consumption and a duplicate cannot change its author', () => {
  const { scheduler: s } = make(), event = { id: ref('u1'), authorId: 'user' };
  s.publish('room', event); const a = s.claim('room', 'a', 'a1'); s.finish('room', 'a', a.token);
  assert.equal(s.publish('room', event), false); assert.equal(s.publish('room', { ...event, authorId: 'b' }), false);
  assert.deepEqual(s.pending('room', 'a'), []); assert.deepEqual(s.read('room', 'a').seen, [event]);
});

test('room, generation and source scope are part of event identity and stale refs are rejected', () => {
  const { scheduler: s } = make();
  const keys = [ref('same'), ref('same', { roomId: 'other' }), ref('same', { generation: 2 }), ref('same', { sourceScope: 'new-scope' }), ref('same', { attemptId: 'other-attempt' })];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(s.publish('room', { id: keys[1], authorId: 'user' }), false);
  assert.equal(s.publish('room', { id: keys[2], authorId: 'user' }), false);
  assert.equal(s.publish('room', { id: keys[3], authorId: 'user' }), false);
  assert.equal(s.publish('room', { id: keys[0], authorId: 'user' }), true);
  assert.equal(s.publish('room', { id: keys[4], authorId: 'user' }), true);
  assert.equal(s.publish('room', { id: 'opaque-missing-scope', authorId: 'user' }), false);
  assert.equal(s.publish('room', { id: keys[0], authorId: 'outside' }), false);
});

test('changing the registered reference scope clears the old inbox and invalidates a late completion', () => {
  const { scheduler: s, set } = make(); s.publish('room', { id: ref('old'), authorId: 'user' }); const old = s.claim('room', 'a', 'old');
  set(200); const nextScope = { generation: 2, sourceScope: 'scope:new' }; s.register('room', ['a', 'b'], nextScope);
  assert.equal(s.finish('room', 'a', old.token), false); assert.deepEqual(s.pending('room', 'a'), []); assert.equal(s.read('room', 'a').cursor, null);
  assert.equal(s.publish('room', { id: ref('late-old'), authorId: 'user' }), false);
  const current = { id: ref('new', nextScope), authorId: 'user' }; assert.equal(s.publish('room', current), true);
  assert.equal(s.read('room','a').level,0,'invalidating an unfinished call does not count as completed speech');
  assert.equal(s.readyAt('room','a'),0);assert.deepEqual(s.claim('room', 'a', 'new').events, [current]);
});

test('failure and cancellation preserve pending new input but require the same cooldown and token ownership', () => {
  for (const method of ['fail', 'cancel']) {
    const { scheduler: s, set } = make(); s.publish('room', { id: ref('first'), authorId: 'user' }); const old = s.claim('room', 'a', 'old');
    const newer = { id: ref('newer'), authorId: 'user' }; s.publish('room', newer); set(300);
    assert.equal(s[method]('room', 'a', 'wrong-token'), false); assert.equal(s[method]('room', 'a', old.token), true);
    set(5299); assert.equal(s.claim('room', 'a', 'next'), null); set(5300); const current = s.claim('room', 'a', 'next');
    assert.deepEqual(current.events, [{id:ref('first'),authorId:'user'},newer], 'a failed unacknowledged inbox is available to an explicit retry'); assert.notEqual(current.token, old.token);
    assert.equal(s.finish('room', 'a', old.token), false); assert.equal(s.read('room', 'a').inFlight.token, current.token);
  }
});

test('member removal and room clearing cannot let old releases unlock a new attempt or affect another room', () => {
  const { scheduler: s, set } = make(); s.register('other', ['a', 'b'], scope);s.reset('other','other-turn',[]);
  const otherEvent = { id: ref('other-user', { roomId: 'other' }), authorId: 'user' }; s.publish('other', otherEvent); const other = s.claim('other', 'a', 'other');
  const old = s.claim('room', 'a', 'removed'); set(100); assert.equal(s.removeMember('room', 'a'), true);
  s.register('room', ['a', 'b'], scope); assert.equal(s.finish('room', 'a', old.token), false);assert.equal(s.claim('room','a','before-new-user'),null);
  s.reset('room','user-turn-2',[]);set(5100); const current = s.claim('room', 'a', 'rejoined'); assert.ok(current);
  assert.equal(s.clearRoom('room'), true); assert.equal(s.publish('room', { id: ref('late'), authorId: 'user' }), false);
  s.register('room', ['a'], { generation: 2, sourceScope: 'scope:new' });s.reset('room','fresh-turn',[]); set(10100); const recreated = s.claim('room', 'a', 'recreated');
  assert.ok(recreated); assert.equal(s.finish('room', 'a', current.token), false);
  assert.equal(s.read('other', 'a').inFlight.token, other.token); assert.deepEqual(other.events, [otherEvent]);
});

test('registering a later member does not replay events from before she joined', () => {
  const { scheduler: s } = make(); s.removeMember('room', 'c'); const old = { id: ref('before-join'), authorId: 'user' }; s.publish('room', old);
  s.register('room', ['a', 'b', 'c'], scope); assert.deepEqual(s.pending('room', 'c'), []); assert.equal(s.publish('room', old), false);
  const next = { id: ref('after-join'), authorId: 'user' }; s.publish('room', next); assert.deepEqual(s.pending('room', 'c'), [next]);
});

test('all exposed snapshots are clones, contain only refs, and no timer or model work is scheduled', async () => {
  const { scheduler: s } = make(); const event = { id: ref('u1'), authorId: 'user' }; s.publish('room', event);
  const pending = s.pending('room', 'a'); pending[0].authorId = 'changed'; pending.push({ id: 'injected' });
  const read = s.read('room', 'a'); read.seen[0].authorId = 'changed'; read.nextEligibleAt = 999999;
  assert.deepEqual(s.pending('room', 'a'), [event]); assert.equal(s.readyAt('room', 'a'), 0);
  assert.equal(s.publish('room', { id: ref('secret'), authorId: 'user', text: 'PRIVATE_BODY' }), false);
  const claim = s.claim('room', 'a', 'a1'); claim.events[0].authorId = 'changed';
  assert.deepEqual(s.read('room', 'a').inFlight.events, [event]); assert.doesNotMatch(JSON.stringify(s.read('room', 'a')), /PRIVATE_BODY|changed|injected/);
  await s.drain(); assert.equal(s.read('room', 'a').inFlight.token, claim.token);
});

test('retention prunes only refs missing from the actual timeline and preserves a running model snapshot', () => {
  const { scheduler: s } = make();
  const old = { id: ref('expired'), authorId: 'user' }, kept = { id: ref('kept'), authorId: 'user' }, newer = { id: ref('newer'), authorId: 'b' };
  s.publish('room', old); const active = s.claim('room', 'a', 'active'); s.publish('room', kept); s.publish('room', newer);
  assert.equal(s.retain('room', new Set([kept.id, newer.id])), true);
  const current = s.read('room', 'a');
  assert.deepEqual(current.pending, [kept, newer]); assert.deepEqual(current.seen, [kept, newer]); assert.equal(current.cursor, null);
  assert.deepEqual(current.inFlight.events, [old], 'retention cannot change context already delivered to an in-flight model');
  assert.equal(current.inFlight.token, active.token);
  assert.equal(s.publish('room', kept), false, 'still-existing consumed or pending refs stay deduplicated');
  assert.deepEqual(s.pending('room', 'c'), [kept, newer]);
});

test('retention is room-local, can empty retired refs, and rejects malformed authority lists without deleting data', () => {
  const { scheduler: s } = make(); s.register('other', ['a'], scope);s.reset('other','other-turn',[]);
  const event = { id: ref('kept'), authorId: 'user' }, other = { id: ref('other', { roomId: 'other' }), authorId: 'user' };
  s.publish('room', event); s.publish('other', other);
  assert.equal(s.retain('room', null), false); assert.equal(s.retain('room', [other.id]), false);
  assert.deepEqual(s.pending('room', 'a'), [event]);
  assert.equal(s.retain('room', []), true); assert.deepEqual(s.pending('room', 'a'), []); assert.deepEqual(s.read('room', 'a').seen, []);
  assert.deepEqual(s.pending('other', 'a'), [other]);
});

test('deleting a room releases its cooldown records while reference-scope changes keep persona cooldowns', () => {
  const { scheduler: s, set } = make(); const first = s.claim('room', 'a', 'first'); set(100); s.finish('room', 'a', first.token);
  s.register('room', ['a'], { generation: 2, sourceScope: 'new-scope' }); assert.equal(s.readyAt('room', 'a'), 5100);
  s.clearRoom('room'); s.register('room', ['a'], { generation: 3, sourceScope: 'fresh-room' });
  assert.equal(s.readyAt('room', 'a'), null);s.reset('room','fresh-turn',[]);assert.equal(s.readyAt('room', 'a'), 100);const next = s.claim('room', 'a', 'new-room-attempt'); assert.ok(next);
  assert.equal(s.finish('room', 'a', first.token), false);
});
