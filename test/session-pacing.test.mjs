import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionPacing, restoreSessionPacing } from '../lib/session-pacing.js';

function fixture() {
  let clock = 0;
  let wall = new Date(2026, 9, 31, 14, 0).getTime();
  let seq = 0;
  const pacing = createSessionPacing({ now: () => wall, monotonic: () => clock });
  const session = { id: 'main' };
  return { pacing, session,
    elapse: (ms) => { clock += ms; wall += ms; },
    wall: (value) => { wall = value; },
    emit: (type, turn, override = {}) => pacing.event(session, { type, data: { turn }, seq: ++seq, ...override }),
    read: () => pacing.snapshot(session),
  };
}

test('pacing measures end-to-next-start gaps and never includes the previous turn work', () => {
  const f = fixture(); f.emit('turn/start', 1);
  assert.deepEqual(f.read(), { session_turn_count: 1, local_hour: 14, idle_minutes: null, is_first_report: true });
  f.elapse(3 * 60000); f.emit('turn/end', 1);
  f.elapse(30000); f.emit('turn/start', 2);
  const snapshot = f.read();
  assert.equal(snapshot.idle_minutes, 0.5);
  assert.equal(snapshot.is_first_report, true);
  f.elapse(2 * 60000);
  assert.equal(f.read().idle_minutes, 0.5, 'gap remains a fixed per-turn fact');
  assert.equal(f.read().is_first_report, false, 'only the first source process report can greet a return');
  assert.ok(Object.isFrozen(snapshot));
});

test('a six-hour gap, midnight and wall clock corrections are independent observations', () => {
  const f = fixture(); f.emit('turn/start', 24); f.emit('turn/end', 24);
  f.elapse(360 * 60000); f.emit('turn/start', 25);
  assert.equal(f.read().idle_minutes, 360);
  f.emit('turn/end', 25); f.elapse(45 * 60000);
  f.wall(new Date(2026, 10, 1, 2, 0).getTime());
  f.emit('turn/start', 26);
  const snapshot = f.read();
  assert.deepEqual(snapshot, { session_turn_count: 26, local_hour: 2, idle_minutes: 45, is_first_report: true });
  assert.deepEqual(restoreSessionPacing(snapshot), snapshot);
});

test('duplicates and replayed ends cannot move the gap boundary or count extra turns', () => {
  const f = fixture(); f.emit('turn/start', 7); f.emit('turn/start', 7);
  assert.equal(f.read().session_turn_count, 7, 'runtime ordinal is used without an increment-on-event counter');
  f.emit('turn/end', 7); f.elapse(20 * 60000); f.emit('turn/end', 7);
  f.elapse(25 * 60000); f.emit('turn/start', 8);
  assert.equal(f.read().idle_minutes, 45);
  f.emit('turn/start', 7, { seq: 1 });
  assert.equal(f.read().session_turn_count, 8);
});

test('missing boundaries, clear, session replacements and skipped turns remain unknown', () => {
  const f = fixture();
  assert.equal(f.read().session_turn_count, null);
  f.emit('turn/start', 5); f.emit('turn/start', 6);
  assert.equal(f.read().idle_minutes, null, 'missing end cannot be treated as zero');
  f.emit('turn/end', 6); f.emit('turn/start', 8);
  assert.equal(f.read().idle_minutes, null, 'an unobserved turn breaks continuity');
  f.pacing.clear('main'); f.emit('turn/start', 9);
  assert.equal(f.read().idle_minutes, null);
  assert.equal(f.pacing.snapshot({ id: 'main' }).session_turn_count, null);
  f.pacing.event({ id: 'other' }, { type: 'turn/start', data: { turn: 1 }, seq: 1 });
  assert.equal(f.read().session_turn_count, 9);
});

test('pacing restoration accepts only bounded primitive facts, without profile or text', () => {
  const base = { session_turn_count: 25, local_hour: 2, idle_minutes: 45, is_first_report: true };
  for (const patch of [{ local_hour: 24 }, { local_hour: '2' }, { idle_minutes: -1 }, { idle_minutes: Infinity },
    { session_turn_count: 0 }, { session_turn_count: null }, { secret: 'do not keep' }]) {
    assert.equal(restoreSessionPacing({ ...base, ...patch }), undefined);
  }
  assert.deepEqual(restoreSessionPacing({ ...base, session_turn_count: null, idle_minutes: null, is_first_report: false }),
    { session_turn_count: null, local_hour: 2, idle_minutes: null, is_first_report: false });
});
